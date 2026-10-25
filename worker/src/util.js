// 通用工具：时间、转义、响应、子请求预算

export const now = () => Math.floor(Date.now() / 1000);

// Telegram HTML parse_mode 只需要转义这三个字符
export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 没有夏令时的常见时区直接按固定偏移算，不用 Intl：线上每次 cron 都是新的 isolate（日志里 n=1），
// 第一次 new Intl.DateTimeFormat 要加载时区和中文的日期数据，本地实测 13ms（之后每次只要几微秒，但线上用不到「之后」）。
// 其他时区（如 America/New_York，有夏令时）照旧用 Intl
const FIXED_TZ = {
  'Asia/Shanghai': 480, 'Asia/Chongqing': 480, 'Asia/Harbin': 480, 'Asia/Urumqi': 480, 'PRC': 480,
  'Asia/Hong_Kong': 480, 'Asia/Macau': 480, 'Asia/Taipei': 480, 'Asia/Singapore': 480, 'Asia/Kuala_Lumpur': 480, 'Asia/Manila': 480,
  'Asia/Tokyo': 540, 'Asia/Seoul': 540, 'UTC': 0, 'Etc/UTC': 0, 'Etc/GMT': 0, 'GMT': 0,
};
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad2 = (n) => String(n).padStart(2, '0');

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }));
  }
  return fmtCache.get(tz);
}

// 1791700000 -> "10/11 周日 19:30"
export function fmtTime(ts, tz = 'Asia/Shanghai') {
  const p = parts(ts, tz);
  return `${p.month}/${p.day} ${p.weekday} ${p.hour}:${p.minute}`;
}

function parts(ts, tz) {
  const off = FIXED_TZ[tz];
  if (off == null) return Object.fromEntries(fmt(tz).formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  const d = new Date((ts + off * 60) * 1000);
  return { month: pad2(d.getUTCMonth() + 1), day: pad2(d.getUTCDate()), weekday: WEEKDAY[d.getUTCDay()], hour: pad2(d.getUTCHours()), minute: pad2(d.getUTCMinutes()) };
}

// "10/11 周日"
export function fmtDate(ts, tz = 'Asia/Shanghai') {
  const p = parts(ts, tz);
  return `${p.month}/${p.day} ${p.weekday}`;
}

// "10/24"
export function fmtMD(ts, tz = 'Asia/Shanghai') {
  const p = parts(ts, tz);
  return `${p.month}/${p.day}`;
}

// "19:30"
export function fmtClock(ts, tz = 'Asia/Shanghai') {
  const p = parts(ts, tz);
  return `${p.hour}:${p.minute}`;
}

// 秒数差 -> "2小时15分" / "35分" / "1天3小时"
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}天${h ? h + '小时' : ''}`;
  if (h) return `${h}小时${m ? m + '分' : ''}`;
  return `${m}分`;
}

export const TIER_LABEL = { s: 'S', a: 'A', b: 'B', c: 'C', d: 'D' };
export const tierLabel = (t) => TIER_LABEL[t] || String(t || '?').toUpperCase();

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-max-age': '86400',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

// 免费版每次调用最多 50 个子请求；留一点余量
export const SUBREQ_MAX = 45;

// 外部请求按去向计数（cron 日志里带上，tools/tail-cpu.mjs 据此看每分钟各有几次往返）
const hostOf = (url) => {
  const h = String(url).replace(/^https?:\/\//, '').split('/')[0];
  return h.endsWith('bo3.gg') ? 'bo3' : h.endsWith('douyu.com') ? 'douyu' : h === 'api.telegram.org' ? 'tg' : 'other';
};

// 每次调用一个上下文：带计数的 fetch
export function makeCtx(env) {
  const ctx = {
    env,
    tz: env.TZ || 'Asia/Shanghai',
    used: 0,
    net: {},           // 各去向的外部请求数
    d1: 0,             // D1 往返次数（只有 cron 里计数，见 countD1）
    cap: SUBREQ_MAX,   // 这一次调用最多用到第几个子请求（轻活分钟会调低，见 engine.js 的 TRIPS）
    left() { return Math.min(SUBREQ_MAX, ctx.cap) - ctx.used; },
    async fetch(url, init) {
      if (ctx.used >= SUBREQ_MAX) throw new Error('subrequest budget exhausted');
      ctx.used++;
      const h = hostOf(url);
      ctx.net[h] = (ctx.net[h] || 0) + 1;
      return fetch(url, init);
    },
  };
  return ctx;
}

// 给 ctx.env.DB 包一层，数 D1 往返次数（一次 batch、或一条语句的 all / first / run / raw 各算一次）。
// 线上每次往返和每个外部请求都要 1–3ms CPU，是 cron 每分钟 CPU 时间的主要来源
export function countD1(ctx) {
  const db = ctx.env.DB;
  const hit = (p) => { ctx.d1++; return p; };
  const wrap = (s) => ({
    _s: s,
    bind: (...a) => wrap(s.bind(...a)),
    all: () => hit(s.all()),
    first: (c) => hit(s.first(c)),
    run: () => hit(s.run()),
    raw: (o) => hit(s.raw(o)),
  });
  ctx.env = {
    ...ctx.env,
    DB: { prepare: (sql) => wrap(db.prepare(sql)), batch: (ss) => hit(db.batch(ss.map((x) => x._s ?? x))) },
  };
  return ctx;
}
// 日志后缀，如「d1=2 bo3=1 tg=3」
export const tripsText = (ctx) => [`d1=${ctx.d1}`, ...Object.entries(ctx.net).map(([k, v]) => `${k}=${v}`)].join(' ');

export const isOwner = (env, id) => String(id) === String(env.OWNER_ID);

// 定长比较，避免按字符逐个比较泄露信息
export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
