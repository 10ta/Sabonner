// 运行器的网络层：
//   · 可选走 SOCKS5 代理（RUNNER_PROXY=socks5://主机:端口，支持用户名密码），不依赖第三方包
//   · 对 bo3 / 斗鱼「守规矩」：同一个站点两次请求至少隔 1 秒；被拦截（429 / 403 / 503 / 返回网页而不是数据）时
//     暂停直连、按 15 分钟起翻倍退避（最长 4 小时），期间改走 Worker 中转（RUNNER_RELAY=1 时），并通知管理员
// 对外只有一个 makeFetch()，返回和全局 fetch 用法一样的函数（返回标准 Response）

import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';

const TIMEOUT = 25_000;

// ---------- SOCKS5 ----------

// 从 socket 里按需读出 n 个字节（握手阶段用）
function reader(sock) {
  let buf = Buffer.alloc(0);
  let want = null;
  const onData = (d) => { buf = Buffer.concat([buf, d]); pump(); };
  const pump = () => {
    if (want && buf.length >= want.n) {
      const out = buf.subarray(0, want.n);
      buf = buf.subarray(want.n);
      const w = want; want = null; w.resolve(out);
    }
  };
  sock.on('data', onData);
  return {
    read: (n) => new Promise((resolve) => { want = { n, resolve }; pump(); }),
    done: () => { sock.off('data', onData); if (buf.length) sock.unshift(buf); },
  };
}

export function socksConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(proxy.port) || 1080, proxy.hostname);
    const fail = (e) => { sock.destroy(); reject(e instanceof Error ? e : new Error(String(e))); };
    sock.setTimeout(TIMEOUT, () => fail(new Error('SOCKS5 连接超时')));
    sock.once('error', fail);
    sock.once('connect', async () => {
      try {
        const r = reader(sock);
        const user = decodeURIComponent(proxy.username || ''), pass = decodeURIComponent(proxy.password || '');
        sock.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
        const [ver, method] = await r.read(2);
        if (ver !== 5) throw new Error('不是 SOCKS5 代理');
        if (method === 2) {
          const u = Buffer.from(user), p = Buffer.from(pass);
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          const [, st] = await r.read(2);
          if (st !== 0) throw new Error('SOCKS5 用户名或密码不对');
        } else if (method !== 0) throw new Error('SOCKS5 代理不接受无认证连接');
        const h = Buffer.from(host);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
        const [, rep, , atyp] = await r.read(4);
        if (rep !== 0) throw new Error(`SOCKS5 连接目标失败（代码 ${rep}）`);
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : (await r.read(1))[0];
        await r.read(len + 2);
        r.done();
        sock.setTimeout(0);
        sock.off('error', fail);
        resolve(sock);
      } catch (e) { fail(e); }
    });
  });
}

// 经 SOCKS5 的 https Agent：TLS 在代理隧道里做，证书照常校验
class SocksAgent extends https.Agent {
  constructor(proxy) { super({ keepAlive: true, maxSockets: 4 }); this.proxy = proxy; }
  createConnection(opts, cb) {
    socksConnect(this.proxy, opts.host, Number(opts.port) || 443)
      .then((sock) => {
        const t = tls.connect({ socket: sock, servername: opts.servername || opts.host, ALPNProtocols: ['http/1.1'] });
        t.once('secureConnect', () => cb(null, t));
        t.once('error', (e) => cb(e));
      })
      .catch((e) => cb(e));
  }
}

// 用 node:https 发请求，包成标准 Response
function nodeFetch(agent, url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const headers = { ...(init.headers || {}) };
    const body = init.body == null ? null : Buffer.from(String(init.body));
    if (body) headers['content-length'] = body.length;
    const req = mod.request(u, { method: init.method || 'GET', headers, agent: u.protocol === 'http:' ? undefined : agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        const empty = [101, 204, 205, 304].includes(res.statusCode);
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, headers: h }));
      });
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT, () => req.destroy(new Error(`请求超时：${u.hostname}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- 防拦截 ----------

const WATCH = { 'api.bo3.gg': 'bo3 接口', 'm.douyu.com': '斗鱼接口' };
const GAP = 1000;                  // 同一站点两次请求的最小间隔
const BACKOFF = 15 * 60 * 1000;    // 第一次被拦截后暂停直连多久，之后每次翻倍
const BACKOFF_MAX = 4 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// opts：
//   proxy     'socks5://user:pass@127.0.0.1:7050' 或空（直连）
//   relay     { url: Worker 地址, key: ADMIN_TOKEN } 或 null：被拦截时改走 Worker 的 /relay
//   onBlock(name, reason, untilMs, viaRelay, level) / onRecover(name)：通知（不在这里发 Telegram，避免互相依赖）
//   log(line)
export function makeFetch({ proxy = '', relay = null, onBlock = () => {}, onRecover = () => {}, log = () => {} } = {}) {
  let raw;
  if (proxy) {
    const p = new URL(proxy);
    if (!/^socks5h?:$/.test(p.protocol)) throw new Error(`只支持 socks5 代理：${proxy}`);
    const agent = new SocksAgent(p);
    raw = (url, init) => nodeFetch(agent, url, init);
  } else {
    raw = (url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  }

  const state = new Map();   // 站点 -> { last, level, until }
  const stats = new Map();   // 站点 -> 请求次数（运行器每小时汇总一次后清零）
  const st = (h) => { if (!state.has(h)) state.set(h, { last: 0, level: 0, until: 0 }); return state.get(h); };

  const viaRelay = async (url, init) => {
    const u = new URL('/relay', relay.url);
    u.searchParams.set('u', url);
    const headers = { ...(init?.headers || {}), 'x-relay-key': relay.key };
    return raw(u.toString(), { headers });
  };

  // 被拦截的样子：限流 / 禁止 / 服务不可用，或者该给数据的地方给了一个网页（人机验证页）
  const looksBlocked = async (r) => {
    if (r.status === 429 || r.status === 403 || r.status === 503) return true;
    if (!r.ok) return false;
    const head = (await r.clone().text()).slice(0, 200).trimStart();
    return head.startsWith('<');
  };

  async function fetchFn(url, init = {}) {
    const host = new URL(url).hostname;
    stats.set(host, (stats.get(host) || 0) + 1);
    const name = WATCH[host];
    if (!name) return raw(url, init);

    const s = st(host);
    const wait = s.last + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    s.last = Date.now();

    if (s.until > Date.now()) {
      if (relay) return viaRelay(url, init);
      throw new Error(`${name}暂停直连中（被拦截，${Math.ceil((s.until - Date.now()) / 60000)} 分钟后重试）`);
    }
    const r = await raw(url, init);
    if (await looksBlocked(r)) {
      s.level++;
      s.until = Date.now() + Math.min(BACKOFF * 2 ** (s.level - 1), BACKOFF_MAX);
      const reason = r.ok ? '返回了网页而不是数据（多半是人机验证页）' : `返回 HTTP ${r.status}`;
      log(`[guard] ${name}${reason}，暂停直连到 ${new Date(s.until).toISOString()}${relay ? '，改走 Worker 中转' : ''}`);
      onBlock(name, reason, s.until, !!relay, s.level);
      if (relay) return viaRelay(url, init);
      return r;
    }
    if (s.level) {
      log(`[guard] ${name} 直连恢复`);
      s.level = 0; s.until = 0;
      onRecover(name);
    }
    return r;
  }
  fetchFn.blocked = () => [...state.entries()].filter(([, s]) => s.until > Date.now()).map(([h]) => WATCH[h]);
  fetchFn.takeStats = () => { const o = Object.fromEntries(stats); stats.clear(); return o; };
  return fetchFn;
}
