#!/usr/bin/env node
// 统计线上每种任务的 CPU 时间：读 `wrangler tail --format json` 的输出，
// 每次调用的 CPU 时间和这次调用里打的 [cron] 日志（或网页请求的路径）对上，按任务分组。
//
// 用法（在 worker/ 目录）：
//   npx wrangler tail sabonner --format json > tail.json     # 至少录 25 分钟（cron 一轮 20 分钟），Ctrl+C 结束
//   node tools/tail-cpu.mjs tail.json
//
// 输出每种任务的次数、CPU 中位数 / P90 / 最大值、超过 10ms 的次数、平均往返次数（D1 + 外部请求，
// 来自 [cron] 日志末尾的「| d1=2 bo3=1 tg=3」），CPU 和往返次数的线性拟合，以及每一次超过 10ms 的调用明细。
// 录下来的内容只有本 Worker 的日志和请求路径，不含 secret；可以把输出直接贴回来。

import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/tail-cpu.mjs tail.json');
  process.exit(1);
}
const LIMIT = Number(process.env.CPU_LIMIT_MS || 10);

// wrangler 输出的是一个接一个的 JSON 对象（可能跨多行），按括号配对切开
function* objects(text) {
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) {
      try { yield JSON.parse(text.slice(start, i + 1)); } catch { /* 不完整的一段（比如 Ctrl+C 时截断）跳过 */ }
    }
  }
}

// 不同版本的字段名可能不同，都试一下
const cpuOf = (e) => e.cpuTime ?? e.cpuTimeMs ?? e.cpu_time ?? e.CPUTimeMs ?? null;
const wallOf = (e) => e.wallTime ?? e.wallTimeMs ?? e.wall_time ?? null;

const cronLine = (e) => (e.logs || []).map((l) => (Array.isArray(l.message) ? l.message.join(' ') : String(l.message ?? '')))
  .find((m) => m.startsWith('[cron]'));
// 往返次数：「| d1=2 bo3=1 tg=3 n=5 first=flush」里 d1 和各外部请求相加；旧版本没有这一段时为 null。
// cold：这个 isolate 的第一次 cron（n=1），或者这次有步骤是这个 isolate 里第一次跑（first=…，代码要先编译、缓存是空的）
const TRIP_KEYS = new Set(['d1', 'bo3', 'douyu', 'tg', 'other']);
function tripsOf(e) {
  const tail = cronLine(e)?.split(' | ')[1];
  if (!tail) return null;
  const kv = Object.fromEntries(tail.split(' ').map((w) => w.split('=')));
  const total = Object.entries(kv).reduce((n, [k, v]) => n + (TRIP_KEYS.has(k) ? Number(v) || 0 : 0), 0);
  return { total, cold: kv.n === '1' || 'first' in kv, known: 'n' in kv };
}

// 任务名：[cron] 那行去掉数字和往返次数，如 "[cron] live:2+3 douyu | d1=2 bo3=1" → "douyu live"，"refresh:tier:a(41)" → "refresh:tier:a"
function jobOf(e) {
  const cron = cronLine(e);
  if (cron) {
    return cron.slice(7).split(' | ')[0].split(' ').map((w) => w.replace(/\(.*\)$/, '').replace(/[:+]\d+/g, '')).sort().join(' ') || 'idle';
  }
  const req = e.event?.request;
  if (req?.url) {
    const u = new URL(req.url);
    return `${req.method || 'GET'} ${u.pathname}`;
  }
  if (e.event?.cron) return 'cron（没有 [cron] 日志：旧版本或中途出错）';
  return '其他';
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const f = (v) => (v == null ? '–' : v.toFixed(1));

const groups = new Map();
const slow = [];
const pts = [];   // [往返次数, CPU]，拟合用（只用热的调用）
const coldCpu = [], warmCpu = [];
const span = [Infinity, -Infinity];
let total = 0, noCpu = 0, sample = null;
for (const e of objects(fs.readFileSync(file, 'utf8'))) {
  if (!e || typeof e !== 'object' || !('outcome' in e || 'event' in e || 'logs' in e)) continue;
  total++;
  const cpu = cpuOf(e);
  if (cpu == null) { noCpu++; sample ??= e; continue; }
  const job = jobOf(e);
  const tr = tripsOf(e);
  if (tr?.known) (tr.cold ? coldCpu : warmCpu).push(Number(cpu));
  if (!groups.has(job)) groups.set(job, { cpu: [], wall: [], trips: [], bad: 0 });
  const g = groups.get(job);
  g.cpu.push(Number(cpu));
  const w = wallOf(e);
  if (w != null) g.wall.push(Number(w));
  if (e.outcome && e.outcome !== 'ok') g.bad++;
  if (tr) { g.trips.push(tr.total); if (!tr.cold) pts.push([tr.total, Number(cpu)]); }
  const ts = Number(e.eventTimestamp) || null;
  if (ts) { span[0] = Math.min(span[0], ts); span[1] = Math.max(span[1], ts); }
  if (Number(cpu) > LIMIT) slow.push({ cpu: Number(cpu), wall: w, line: cronLine(e) || job, outcome: e.outcome, t: e.eventTimestamp });
}

const hhmm = (ts) => new Date(ts).toISOString().slice(11, 19);
console.log(`共 ${total} 次调用${noCpu ? `，其中 ${noCpu} 次没有 CPU 时间字段` : ''}${span[0] < Infinity ? `（UTC ${hhmm(span[0])} – ${hhmm(span[1])}）` : ''}`);
if (noCpu === total) {
  console.log('这份 tail 输出里没有每次调用的 CPU 时间。顶层字段有：', Object.keys(sample || {}).join(', '));
  console.log('请改用本地测量：node tools/profile.mjs record <网址> && node tools/profile.mjs');
  process.exit(2);
}
const rows = [...groups.entries()].sort((a, b) => pct(b[1].cpu, 0.9) - pct(a[1].cpu, 0.9));
const all = rows.flatMap(([, g]) => g.cpu);
console.log(`全部：P50 ${f(pct(all, 0.5))}ms  P90 ${f(pct(all, 0.9))}ms  最大 ${f(Math.max(...all))}ms  超过 ${LIMIT}ms 的 ${all.filter((v) => v > LIMIT).length} 次\n`);
console.log(['任务'.padEnd(28), '次数', 'CPU中位', 'CPU P90', 'CPU最大', `>${LIMIT}ms`, '墙钟中位', '往返', '非ok'].join('\t'));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
for (const [job, g] of rows) {
  console.log([job.padEnd(28), g.cpu.length, f(pct(g.cpu, 0.5)), f(pct(g.cpu, 0.9)), f(Math.max(...g.cpu)),
    g.cpu.filter((v) => v > LIMIT).length, f(pct(g.wall, 0.5)), f(mean(g.trips)), g.bad].join('\t'));
}

if (coldCpu.length || warmCpu.length) {
  const line = (name, a) => `${name} ${a.length} 次：P50 ${f(pct(a, 0.5))}ms  P90 ${f(pct(a, 0.9))}ms  最大 ${a.length ? f(Math.max(...a)) : '–'}ms  超过 ${LIMIT}ms 的 ${a.filter((v) => v > LIMIT).length} 次`;
  console.log(`\n${line('冷（isolate 第一次 cron，或有步骤第一次跑）', coldCpu)}\n${line('热', warmCpu)}`);
}
// CPU ≈ a + b × 往返次数（最小二乘，只用热的调用）：b 就是每次往返的 CPU 成本
if (pts.length >= 5) {
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  if (sxx > 0) {
    const b = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx;
    console.log(`\n拟合（热的 ${pts.length} 次）：CPU ≈ ${f(my - b * mx)} + ${f(b)} × 往返次数 ms`);
  }
}
if (slow.length) {
  console.log(`\n超过 ${LIMIT}ms 的调用（最多列 20 次，时间是 UTC）：`);
  for (const s of slow.sort((a, b) => b.cpu - a.cpu).slice(0, 20)) {
    console.log(`  ${f(s.cpu)}ms  墙钟 ${f(s.wall)}ms  ${s.t ? hhmm(s.t) : ''}  ${s.outcome !== 'ok' ? s.outcome + '  ' : ''}${s.line}`);
  }
}
