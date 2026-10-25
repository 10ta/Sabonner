#!/usr/bin/env node
// 本地测量 cron 每种任务花多少 CPU、花在哪些函数上。不部署，只在自己电脑上跑。
//
// 原理：Worker 里拿不到自己用了多少 CPU（计时器在执行代码时不走），所以在本地用同样的代码、同样的数据重放：
//   record：读线上网页接口拿到当前订阅（tier / 队伍 / 星级 / 斗鱼房间），用真实网络按 cron 的节奏跑一轮（20 分钟，
//           时间是模拟的，几秒钟跑完），把 bo3 / 斗鱼的响应存进 tools/fixtures/。Telegram 一律不真发
//   回放（默认）：从 fixtures 读响应（不走网络），跑 4 轮：第 1 轮当作冷启动，后 3 轮是预热后的稳态。
//           每次 cron 计时，减掉本地数据库（SQLite 代替 D1）花的时间，剩下的就是 Worker 里会算进 CPU 的部分
//   --prof：另外抓一份 V8 CPU profile，列出最耗时的函数，并存成 tools/fixtures/cron.cpuprofile
//   --cold：每种任务另外在一个全新的 Node 进程里只跑一次（没预热过的 V8，最接近线上每分钟可能是新实例的情况）
//
// 用法（在 worker/ 目录；需要 Node 22.5+，版本不够就把 node 换成 npx -y node@22）：
//   node tools/profile.mjs record https://sabonner.<你的子域>.workers.dev
//   node tools/profile.mjs --prof --cold
// 结果同时写进 tools/fixtures/report.txt。fixtures 里只有 bo3 / 斗鱼的公开数据和公开接口返回的订阅，没有 secret。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(`需要 Node 22.5+（当前 ${process.version}，要用内置的 node:sqlite）。可以用：npx -y node@22 tools/profile.mjs ${process.argv.slice(2).join(' ')}`);
  process.exit(1);
}
process.removeAllListeners('warning'); // 不显示 node:sqlite 的实验性提示
const { DatabaseSync } = await import('node:sqlite');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures');
const args = process.argv.slice(2);
const RECORD = args[0] === 'record';
const PROF = args.includes('--prof');
const COLD = args.includes('--cold');
const CHILD = args[0] === '--child' ? Number(args[1]) : null;   // 内部用：新进程里只跑第几分钟
const LIMIT = 10;
fs.mkdirSync(FIX, { recursive: true });

const out = [];
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

// ---------- D1 代替品：内存 SQLite，记下花了多少时间（D1 在 Worker 里是外部服务，不算 Worker 的 CPU） ----------
const STATE = path.join(FIX, 'state.db');   // 第 1 轮跑完后的数据库，给 --cold 的子进程用
let sql;
if (CHILD != null) {
  const tmp = path.join(FIX, `state-${process.pid}.db`);
  fs.copyFileSync(STATE, tmp);
  sql = new DatabaseSync(tmp);
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch { /* 忽略 */ } });
} else {
  sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(path.join(ROOT, 'migrations')).sort()) sql.exec(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8'));
}
let dbMs = 0;
class Stmt {
  constructor(s) { this.s = s; this.a = []; }
  bind(...a) { this.a = a; return this; }
  _x() {
    const t = performance.now();
    try {
      const st = sql.prepare(this.s);
      const a = this.a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
      if (/^\s*(SELECT|WITH)/i.test(this.s)) return { results: st.all(...a), meta: {} };
      return { results: [], meta: { changes: Number(st.run(...a).changes) } };
    } finally { dbMs += performance.now() - t; }
  }
  async all() { return this._x(); }
  async first() { return this._x().results[0] || null; }
  async run() { return this._x(); }
}
const DB = { prepare: (s) => new Stmt(s), batch: async (ss) => ss.map((s) => s._x()) };

// ---------- 模拟时钟 ----------
const realNow = Date.now.bind(Date);
let clock = realNow();
Date.now = () => clock;

// ---------- 网络：录制 / 回放 ----------
const HTTP = path.join(FIX, 'http.json');
const META = path.join(FIX, 'meta.json');
const http = RECORD ? {} : JSON.parse(fs.readFileSync(HTTP, 'utf8'));
let missing = 0, bytes = 0;
const fakeRes = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => JSON.parse(body), text: async () => body,
});
let tgId = 1000;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  if (url.includes('api.telegram.org')) return fakeRes(200, JSON.stringify({ ok: true, result: { message_id: ++tgId } })); // 不真发
  if (!RECORD) {
    const r = http[url];
    if (!r) { missing++; return fakeRes(404, '{}'); }
    bytes += r.body.length;
    return fakeRes(r.status, r.body);
  }
  if (!http[url]) {
    const r = await realFetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Sabonner profile)' } });
    http[url] = { status: r.status, body: await r.text() };
  }
  return fakeRes(http[url].status, http[url].body);
};

// ---------- 载入 Worker 代码 ----------
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'src', f)).href);
const { runCron } = await imp('engine.js');
const { makeCtx } = await imp('util.js');
const { handleApi, clearPublicCache } = await imp('api.js');

// ---------- 初始状态：线上当前的订阅 ----------
let meta;
if (RECORD) {
  const base = (args[1] || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) { console.error('用法：node tools/profile.mjs record https://sabonner.<子域>.workers.dev'); process.exit(1); }
  const ov = await (await realFetch(`${base}/api/overview`)).json();
  const minute = Math.floor(realNow() / 60000);
  // 从一轮（20 分钟）的开头开始，正好覆盖每一种任务
  const start = (minute - (minute % 20)) * 60000 + 5000;
  meta = { start, tz: ov.tz, subs: ov.subs, rooms: (ov.rooms || []).map((r) => ({ room_id: r.room_id, owner: r.owner, title: r.title, live: r.live ? 1 : 0 })) };
  fs.writeFileSync(META, JSON.stringify(meta, null, 1));
} else {
  meta = JSON.parse(fs.readFileSync(META, 'utf8'));
}
if (CHILD == null) for (const t of meta.subs.tiers) sql.prepare('INSERT INTO sub_tiers (tier) VALUES (?)').run(t);
if (CHILD == null) for (const t of meta.subs.teams) sql.prepare('INSERT INTO sub_teams (team_id, name, cc, logo) VALUES (?, ?, ?, ?)').run(t.id, t.name, t.cc ?? null, t.logo ?? null);
if (CHILD == null && meta.subs.stars) sql.prepare("INSERT INTO kv (k, v) VALUES ('sub_stars', ?)").run(String(meta.subs.stars));
if (CHILD == null) for (const r of meta.rooms) sql.prepare('INSERT INTO streamers (room_id, owner, title, live) VALUES (?, ?, ?, ?)').run(r.room_id, r.owner, r.title, r.live);
const env = { DB, TG_TOKEN: 'x', OWNER_ID: '1', TZ: meta.tz || 'Asia/Shanghai', ADMIN_TOKEN: 'x' };

// ---------- 跑一轮 20 分钟，每次 cron 记下 [cron] 那行和耗时 ----------
const origLog = console.log, origErr = console.error;
async function cycle(only = null) {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    if (only != null && i !== only) continue;
    clock = meta.start + i * 60000;
    let line = '', errs = 0;
    console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[cron]')) line = s; };
    console.error = () => { errs++; };
    const d0 = dbMs, t0 = performance.now();
    try { await runCron(makeCtx(env)); } finally { console.log = origLog; console.error = origErr; }
    const ms = performance.now() - t0 - (dbMs - d0);
    rows.push({ minute: i, line: line.replace('[cron] ', ''), ms, db: dbMs - d0, errs });
  }
  return rows;
}
const jobKey = (l) => l.split(' ').map((w) => w.replace(/\(.*\)$/, '').replace(/[:+]\d+/g, '')).sort().join(' ') || 'idle';
const f = (v) => v.toFixed(2);

if (CHILD != null) {   // 子进程：只跑这一分钟，把结果交给父进程
  // 先让测量工具自己的部分（假响应、本地数据库）跑一遍，免得它们第一次初始化的开销算到 Worker 代码头上
  await fakeRes(200, '{"a":1}').json();
  await DB.prepare('SELECT 1').all();
  const [r] = await cycle(CHILD);
  process.stdout.write(`\n@@${JSON.stringify(r)}\n`);
  process.exit(0);
}

if (RECORD) {
  await cycle();
  fs.writeFileSync(HTTP, JSON.stringify(http));
  const n = Object.keys(http).length;
  const size = Object.values(http).reduce((a, r) => a + r.body.length, 0);
  console.log(`已录制 ${n} 个响应，共 ${(size / 1024).toFixed(0)} KB → ${path.relative(process.cwd(), FIX)}/`);
  console.log('接着运行：node tools/profile.mjs --prof --cold');
  process.exit(0);
}

// ---------- 回放 ----------
say(`Sabonner cron CPU 测量 · Node ${process.version} · ${new Date().toISOString()}`);
say(`订阅：tier ${meta.subs.tiers.join(',') || '无'} · 队伍 ${meta.subs.teams.length} 支 · 星级 ${meta.subs.stars || '关'} · 斗鱼房间 ${meta.rooms.length} 个`);
say('数值 = 每次 cron 的 JS 执行时间（已减去本地数据库耗时，近似 Worker 里算进 CPU 的部分）。机器不同绝对值会有差别，看各任务之间的比例\n');

const cold = await cycle();
fs.rmSync(STATE, { force: true });
sql.exec(`VACUUM INTO '${STATE.replace(/'/g, "''")}'`);
let session = null;
if (PROF) {
  const { Session } = await import('node:inspector/promises');
  session = new Session(); session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 100 });
  await session.post('Profiler.start');
}
const warm = [];
for (let k = 0; k < 3; k++) warm.push(...await cycle());

say('每一分钟（第 1 轮 = 冷启动，预热后 = 后 3 轮的中位数）');
say(['分钟', '任务', '冷启动ms', '预热后ms', '数据库ms'].join('\t'));
for (let i = 0; i < 20; i++) {
  const w = warm.filter((r) => r.minute === i).map((r) => r.ms).sort((a, b) => a - b);
  say([`:${String(i).padStart(2, '0')}`, cold[i].line.padEnd(34), f(cold[i].ms), f(w[1]), f(cold[i].db)].join('\t')
    + (cold[i].errs ? `\t⚠️ ${cold[i].errs} 个错误` : ''));
}

say('\n按任务汇总（预热后）');
const groups = new Map();
for (const r of warm) { const k = jobKey(r.line); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r.ms); }
for (const [k, v] of [...groups].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))) {
  v.sort((a, b) => a - b);
  say(`${k.padEnd(30)}\t${v.length} 次\t中位 ${f(v[Math.floor(v.length / 2)])}ms\t最大 ${f(v[v.length - 1])}ms`);
}

// 网页接口
const api = [];
for (let k = 0; k < 6; k++) {
  clearPublicCache();
  const t0 = performance.now(), d0 = dbMs;
  const r = await handleApi(new Request('https://x/api/overview'), env, '/api/overview', makeCtx(env));
  const body = await r.text();
  api.push({ ms: performance.now() - t0 - (dbMs - d0), size: body.length });
}
say(`\n/api/overview：冷 ${f(api[0].ms)}ms，预热后 ${f(api.slice(1).map((a) => a.ms).sort((a, b) => a - b)[2])}ms，响应 ${(api[0].size / 1024).toFixed(0)} KB`);

// 每个 bo3 响应的大小（解析的主要成本）
say('\n回放用到的外部响应（按大小）');
for (const [u, r] of Object.entries(http).sort((a, b) => b[1].body.length - a[1].body.length).slice(0, 12)) {
  const short = u.replace('https://api.bo3.gg/api/v1/', 'bo3:').replace(/filter%5B|%5D|%5B/g, (m) => (m === 'filter%5B' ? '' : m === '%5D' ? ']' : '[')).slice(0, 110);
  say(`${(r.body.length / 1024).toFixed(0).padStart(5)} KB  ${short}`);
}
if (missing) say(`\n⚠️ 有 ${missing} 次请求在录制里没有（比赛状态变了），这几次按「没数据」处理`);

if (session) {
  const { profile } = await session.post('Profiler.stop');
  fs.writeFileSync(path.join(FIX, 'cron.cpuprofile'), JSON.stringify(profile));
  const dt = [];
  for (let i = 0; i < profile.samples.length; i++) dt[i] = profile.timeDeltas[i] || 0;
  const self = new Map(), byNode = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const n = byNode.get(id); const cf = n.callFrame;
    const file = cf.url ? cf.url.split('/').slice(-2).join('/') : '(native)';
    const k = `${cf.functionName || '(匿名)'}  ${file}:${cf.lineNumber + 1}`;
    self.set(k, (self.get(k) || 0) + dt[i]);
  });
  // 测量工具自己的开销（inspector、本地数据库）不算；fakeRes 里的 json 就是解析响应，相当于 Worker 里的 r.json()
  const harness = (k) => /node:inspector|^(\(idle\)|\(program\))|^_x |^(prepare|all|run|get) +\(native\)|^now +perf/.test(k)
    || (k.includes('tools/profile.mjs') && !k.startsWith('json '));
  const rows = [...self].filter(([k]) => !harness(k)).sort((a, b) => b[1] - a[1]);
  const workerUs = rows.reduce((a, [, us]) => a + us, 0);
  say(`\n最耗时的函数（预热后 3 轮，只算 Worker 代码，共 ${(workerUs / 1000).toFixed(1)}ms，占比是自身耗时）`);
  for (const [k, us] of rows.slice(0, 20)) {
    const label = k.startsWith('json ') ? 'JSON.parse（解析 bo3 / 斗鱼的响应，相当于 Worker 里的 r.json()）' : k;
    say(`${(us / workerUs * 100).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(1).padStart(7)}ms  ${label}`);
  }
  say(`\nCPU profile 已存：${path.relative(process.cwd(), path.join(FIX, 'cron.cpuprofile'))}（可以拖进 Chrome DevTools → Performance 查看火焰图）`);
}
if (COLD) {
  const { execFileSync } = await import('node:child_process');
  say('\n每种任务在全新进程里第一次跑（没预热过的 V8；每个子进程只跑这一分钟，数据库是第 1 轮之后的状态）');
  say('这是上限：线上实例如果一直没被回收，实际会接近上面「预热后」的数');
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const k = jobKey(cold[i].line);
    if (seen.has(k) || k === 'idle') continue;
    seen.add(k);
    const times = [];
    for (let n = 0; n < 3; n++) {
      const o = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child', String(i)], { encoding: 'utf8' });
      const m = o.match(/@@(.*)/);
      if (m) times.push(JSON.parse(m[1]).ms);
    }
    times.sort((a, b) => a - b);
    say(`${k.padEnd(30)}\t:${String(i).padStart(2, '0')}\t中位 ${f(times[1] ?? times[0])}ms\t（3 次：${times.map(f).join(' / ')}）`);
  }
}

fs.writeFileSync(path.join(FIX, 'report.txt'), out.join('\n') + '\n');
say(`\n报告已存：${path.relative(process.cwd(), path.join(FIX, 'report.txt'))}`);
process.exit(0);
