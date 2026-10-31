#!/usr/bin/env node
// Sabonner 运行器：在 VPS 上常驻，替代 Worker 的每分钟 cron。
//   直播轮询 / 赛前提醒 / 日报 / 发消息 / 删到期消息   每 RUNNER_LIVE_EVERY 秒（默认 60）
//   斗鱼                                            每 RUNNER_DOUYU_EVERY 分钟（默认 2）
//   赛程刷新（所有订阅一次拉完）                       每 RUNNER_REFRESH_EVERY 分钟（默认 10）
//   赛后数据                                        每 RUNNER_STATS_EVERY 分钟（默认 15），比赛结束 20 分钟后开始，8 小时后放弃
//   赛事列表（6 小时过期才请求）/ 清理                 每 30 / 60 分钟
//   心跳（Worker 每 10 分钟检查一次，超过 15 分钟没有就给管理员发 Telegram）   每 5 分钟
//   网页概览（/api/overview 的内容，内容变了才写进 D1；Worker 直接返回它，省掉现场组装的 CPU）  每轮直播轮询之后
// 业务逻辑全部复用 worker/src（同一份代码），数据库通过 D1 的 HTTP 接口读写同一个 D1；网页和 Telegram 命令仍由 Worker 处理。
//
// 配置：仓库根目录的 .sabonner.env（init.sh 生成：bot token、管理员、Cloudflare token……）
//      + .sabonner-runner.env（运行器自己的设置，见 runner/runner.env.example）
// 用法：
//   node runner/main.mjs           常驻运行（systemd 服务 sabonner-runner 就是这样启动的）
//   node runner/main.mjs --check   自检：D1、Telegram、bo3、斗鱼、Worker 中转能不能通，然后退出
//   node runner/main.mjs --once    每项工作各跑一次就退出（调试用）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFetch } from './net.mjs';
import { makeD1 } from './d1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'worker', 'src');

// ---------- 配置 ----------

// 两个 env 文件都是 bash 格式（init.sh 用 printf %q 写的），交给 bash 自己解析最稳妥
const KEYS = ['TG_TOKEN', 'OWNER_ID', 'ADMIN_TOKEN', 'WORKER_URL', 'TZ_NAME', 'SAVED_CF_TOKEN', 'SAVED_CF_ACCOUNT',
  'RUNNER_PROXY', 'RUNNER_RELAY', 'RUNNER_LIVE_EVERY', 'RUNNER_DOUYU_EVERY', 'RUNNER_REFRESH_EVERY', 'RUNNER_STATS_EVERY',
  'RUNNER_CF_TOKEN', 'RUNNER_CF_ACCOUNT', 'RUNNER_CF_API'];
export function loadConfig(files = [path.join(ROOT, '.sabonner.env'), path.join(ROOT, '.sabonner-runner.env')]) {
  const exist = files.filter((f) => fs.existsSync(f));
  const script = `set -a; for f in "$@"; do . "$f"; done; for k in ${KEYS.join(' ')}; do printf '%s=%s\\0' "$k" "\${!k-}"; done`;
  const out = exist.length ? execFileSync('bash', ['-c', script, 'cfg', ...exist], { encoding: 'utf8' }) : '';
  const cfg = {};
  for (const kv of out.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) cfg[kv.slice(0, i)] = kv.slice(i + 1);
  }
  for (const k of KEYS) if (process.env[k]) cfg[k] = process.env[k];   // 环境变量优先（测试用）
  return cfg;
}

const num = (v, def, min, max) => Math.min(max, Math.max(min, Number(v) || def));

// ---------- 运行器 ----------

// deps：测试时注入 { fetch, env, log }；正常运行时按配置创建
export async function createRunner(cfg, deps = {}) {
  const log = deps.log || ((...a) => console.log(...a));
  const src = (f) => import(pathToFileURL(path.join(SRC, f)).href);
  const { makeCtx } = await src('util.js');
  const engine = await src('engine.js');
  const { cleanup, setKVStmt } = await src('db.js');
  const web = await src('api.js');   // 网页概览的生成代码

  const every = {
    tick: num(cfg.RUNNER_LIVE_EVERY, 60, 30, 300) * 1000,
    douyu: num(cfg.RUNNER_DOUYU_EVERY, 2, 1, 30) * 60_000,
    refresh: num(cfg.RUNNER_REFRESH_EVERY, 10, 5, 60) * 60_000,
    stats: num(cfg.RUNNER_STATS_EVERY, 15, 5, 120) * 60_000,
    liveAll: 10 * 60_000,
    events: 30 * 60_000,
    cleanup: 60 * 60_000,
    heartbeat: 5 * 60_000,
    summary: 60 * 60_000,
  };
  every.snapshot = every.tick;
  const opts = { ...engine.WORKER_OPTS, budget: false, pre: 30 * 60, mapQuiet: 0, douyuEvery: every.douyu / 60_000, statsEvery: true, statsPerTick: 10 };

  // 被拦截 / 恢复时直接给管理员发 Telegram（不进发件队列：队列本身也要靠网络）
  let notify = () => {};
  const relay = cfg.RUNNER_RELAY === '0' || !cfg.WORKER_URL ? null : { url: cfg.WORKER_URL, key: cfg.ADMIN_TOKEN };
  const fetch = deps.fetch || makeFetch({
    proxy: cfg.RUNNER_PROXY || '',
    relay,
    log,
    onBlock: (name, reason, until, viaRelay, level) => {
      if (level === 1) notify(`⚠️ <b>Sabonner 运行器</b>：${name}${reason}，疑似被拦截。${viaRelay ? '已改走 Worker 中转，' : '暂停请求，'}${Math.round((until - Date.now()) / 60000)} 分钟后再试直连。`);
    },
    onRecover: (name) => notify(`✅ <b>Sabonner 运行器</b>：${name}直连恢复。`),
  });

  let env = deps.env;
  if (!env) {
    const token = cfg.RUNNER_CF_TOKEN || cfg.SAVED_CF_TOKEN;
    if (!token) throw new Error('没有 Cloudflare token：.sabonner.env 里的 SAVED_CF_TOKEN 为空（init.sh 选 API token 方式登录才会保存），或在 .sabonner-runner.env 里设置 RUNNER_CF_TOKEN');
    const api = cfg.RUNNER_CF_API || 'https://api.cloudflare.com/client/v4';
    const toml = fs.readFileSync(path.join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
    const databaseId = (toml.match(/^database_id\s*=\s*"([^"]+)"/m) || [])[1];
    if (!databaseId) throw new Error('worker/wrangler.toml 里没有 database_id（还没运行过 init.sh？）');
    let accountId = cfg.RUNNER_CF_ACCOUNT || cfg.SAVED_CF_ACCOUNT;
    if (!accountId) {
      const r = await fetch(`${api}/accounts?per_page=5`, { headers: { authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => null);
      accountId = j?.result?.[0]?.id;
      if (!accountId) throw new Error(`查不到 Cloudflare 账户 id（${r.status}），在 .sabonner-runner.env 里设置 RUNNER_CF_ACCOUNT`);
      if (j.result.length > 1) log(`[runner] token 能访问多个账户，用第一个（${j.result[0].name}）；不对的话设置 RUNNER_CF_ACCOUNT`);
    }
    env = { DB: makeD1({ accountId, databaseId, token, fetch, api }), TG_TOKEN: cfg.TG_TOKEN, OWNER_ID: cfg.OWNER_ID, TZ: cfg.TZ_NAME || 'Asia/Shanghai', ADMIN_TOKEN: cfg.ADMIN_TOKEN };
  }

  const newCtx = (flags = {}) => {
    const ctx = makeCtx(env);
    ctx.fetch = (url, init) => { ctx.used++; return fetch(url, init); };
    ctx.left = () => 1e9;   // 没有子请求和 CPU 预算的限制
    ctx.opts = opts;
    ctx.flags = flags;
    return ctx;
  };
  notify = (text) => {
    if (!env.TG_TOKEN || !env.OWNER_ID) return;
    fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(env.OWNER_ID), text, parse_mode: 'HTML' }),
    }).catch((e) => log('[runner] 通知发送失败', e?.message || e));
  };

  const version = (() => { try { return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return '?'; } })();
  const last = {};               // 每项工作上次开始的时间
  let lastSnap = null;           // 上次写进 D1 的概览，内容没变就不再上传
  const totals = { ticks: 0, errors: 0 };
  let lastLine = '';

  // 每项工作：返回日志里的一段描述；出错时记一行日志，不影响别的工作
  const jobs = {
    tick: async (t) => {
      const flags = {
        douyu: !last.douyu || t - last.douyu >= every.douyu - 5000,
        liveAll: !last.liveAll || t - last.liveAll >= every.liveAll - 5000,
      };
      if (flags.douyu) last.douyu = t;
      if (flags.liveAll) last.liveAll = t;
      totals.ticks++;
      return engine.runTick(newCtx(flags));
    },
    refresh: async () => { const r = await engine.refreshAll(newCtx()); return `refresh(${r.parts} 部分 ${r.tracked} 场)`; },
    stats: async () => { const n = await engine.statsTick(newCtx()); return n ? `stats(${n})` : ''; },
    events: async () => { const n = await engine.eventsTick(newCtx()); return n != null ? `events(${n})` : ''; },
    cleanup: async () => { await cleanup(env.DB); return 'cleanup'; },
    // 网页概览：和 Worker 现场生成的是同一份代码（api.js 的 overviewBody）。顺带查一下库里那份还在不在：
    // 网页上改了订阅时 Worker 会删掉它（改由 Worker 现场生成），这时内容没变也要重新写
    snapshot: async () => {
      const db = env.DB;
      const stmts = web.overviewStmts(db);
      const res = await db.batch([...stmts, db.prepare('SELECT 1 AS x FROM kv WHERE k = ?').bind(web.SNAP_KEY)]);
      const body = web.overviewBody(res.slice(0, stmts.length), env);
      if (body === lastSnap && res[stmts.length].results.length) return '';
      await db.batch([setKVStmt(db, web.SNAP_KEY, body)]);
      lastSnap = body;
      return `snapshot(${Math.round(body.length / 1024)}KB)`;
    },
    heartbeat: async (t) => {
      const hb = { at: Math.floor(t / 1000), host: os.hostname(), ver: version, every: { live: every.tick / 1000, douyu: every.douyu / 60_000, refresh: every.refresh / 60_000 }, blocked: fetch.blocked?.() || [] };
      await env.DB.batch([setKVStmt(env.DB, 'runner', JSON.stringify(hb))]);
      return '';
    },
    summary: async () => {
      const d = env.DB.takeStats?.() || {};
      const n = fetch.takeStats?.() || {};
      const hosts = Object.entries(n).map(([h, c]) => `${h.split('.').slice(-2, -1)[0] || h}=${c}`).join(' ');
      log(`[summary] 过去一小时：轮询 ${totals.ticks} 次，出错 ${totals.errors} 次；D1 请求 ${d.calls ?? '?'} 次（语句 ${d.statements ?? '?'}，读 ${d.rowsRead ?? '?'} 行，写 ${d.rowsWritten ?? '?'} 行）；外部请求 ${hosts || '无'}`);
      totals.ticks = 0; totals.errors = 0;
      return '';
    },
  };
  const ORDER = ['tick', 'refresh', 'stats', 'events', 'snapshot', 'cleanup', 'heartbeat', 'summary'];
  // 这几项启动后先等一个间隔再跑（重启时不用把它们全做一遍）；直播轮询、赛程刷新、心跳启动时就跑
  const DEFER_FIRST = new Set(['stats', 'events', 'cleanup', 'summary']);

  // 跑一轮：到期的工作依次执行（不并发，一项一项来）。force：全部都跑（--once 用）
  async function round(t = Date.now(), force = false) {
    const parts = [];
    for (const name of ORDER) {
      if (!force) {
        if (last[name] == null && DEFER_FIRST.has(name)) { last[name] = t; continue; }
        if (last[name] != null && t - last[name] < every[name] - 5000) continue;
      }
      last[name] = t;
      const t0 = Date.now();
      try {
        const out = await jobs[name](t);
        if (out && out !== 'idle') parts.push(`${out} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        totals.errors++;
        log(`[${name}] 出错：${e?.stack || e}`);
      }
    }
    const line = parts.join(' · ');
    if (line && line !== lastLine) log(`[run] ${line}`);
    lastLine = line;
  }

  return { round, every, env, fetch, newCtx, opts };
}

// ---------- 自检 ----------

async function check(cfg) {
  const ok = (s) => console.log(`✔ ${s}`), bad = (s) => console.log(`✘ ${s}`);
  let fails = 0;
  const step = async (name, fn) => { try { ok(`${name}：${await fn()}`); } catch (e) { fails++; bad(`${name}：${e?.message || e}`); } };
  console.log(`代理：${cfg.RUNNER_PROXY || '无（直连）'}；Worker 中转：${cfg.RUNNER_RELAY === '0' || !cfg.WORKER_URL ? '关' : '开'}`);
  let r;
  await step('启动', async () => { r = await createRunner(cfg, { log: () => {} }); return '配置读取正常'; });
  if (!r) return 1;
  const db = r.env.DB;
  await step('D1 读写', async () => {
    const [a, b] = await db.batch([
      db.prepare('SELECT ? AS n, ? AS s, ? AS z').bind(42, 'x', null),
      db.prepare('SELECT COUNT(*) AS n FROM matches WHERE start_ts > ? LIMIT ?').bind(0, 1),
    ]);
    if (a.results[0].n != 42 || a.results[0].z !== null) throw new Error(`参数传递不对：${JSON.stringify(a.results[0])}`);
    return `正常（比赛 ${b.results[0].n} 场）`;
  });
  await step('Telegram', async () => {
    const j = await (await r.fetch(`https://api.telegram.org/bot${cfg.TG_TOKEN}/getMe`)).json();
    if (!j.ok) throw new Error(j.description || '失败');
    return `@${j.result.username}`;
  });
  await step('bo3', async () => {
    const res = await r.fetch('https://api.bo3.gg/api/v1/matches?page[limit]=1', { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Sabonner; personal notifier)' } });
    const text = await res.text();
    if (!res.ok || text.trimStart().startsWith('<')) throw new Error(`HTTP ${res.status}，${text.slice(0, 80)}`);
    return `HTTP ${res.status}，${text.length} 字节`;
  });
  await step('斗鱼', async () => {
    const res = await r.fetch('https://m.douyu.com/api/room/info?rid=6657', { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', Referer: 'https://m.douyu.com/6657' } });
    const text = await res.text();
    if (!res.ok || !text.includes('roomInfo')) throw new Error(`HTTP ${res.status}，${text.slice(0, 80)}`);
    return `HTTP ${res.status}，${text.length} 字节`;
  });
  if (cfg.RUNNER_RELAY !== '0' && cfg.WORKER_URL) {
    // 备用出口，平时用不到：不通只提示、不算失败（第一次安装时 Worker 还是旧版本，部署后就有了）
    try {
      ok(`Worker 中转：${await (async () => {
      const u = new URL('/relay', cfg.WORKER_URL);
      u.searchParams.set('u', 'https://api.bo3.gg/api/v1/matches?page[limit]=1');
      const res = await r.fetch(u.toString(), { headers: { 'x-relay-key': cfg.ADMIN_TOKEN, Accept: 'application/json' } });
      if (res.status === 404) throw new Error('Worker 还是旧版本（没有 /relay），部署新版 Worker 后就有了');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `HTTP ${res.status}`;
    })()}`);
    } catch (e) { console.log(`! Worker 中转（备用，不影响运行）：${e?.message || e}`); }
  }
  console.log(fails ? `\n${fails} 项失败` : '\n全部正常');
  return fails ? 1 : 0;
}

// ---------- 入口 ----------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const arg = process.argv[2] || '';
  if (arg === '--check') process.exit(await check(cfg));
  const runner = await createRunner(cfg);
  if (arg === '--once') { await runner.round(Date.now(), true); process.exit(0); }

  console.log(`[runner] 启动：直播轮询每 ${runner.every.tick / 1000} 秒，斗鱼每 ${runner.every.douyu / 60_000} 分钟，赛程每 ${runner.every.refresh / 60_000} 分钟；代理 ${cfg.RUNNER_PROXY || '无'}`);
  let stopping = false;
  let busy = null;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('[runner] 收到停止信号，等当前这一轮做完');
    await busy;
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // 对齐到整分钟后的第 5 秒（和 bo3 / Telegram 的分钟级更新错开一点），之后每 tick 一轮
  const loop = async () => {
    while (!stopping) {
      busy = runner.round(Date.now());
      await busy;
      const step = runner.every.tick;
      const next = Math.ceil((Date.now() - 5000) / step) * step + 5000;
      await new Promise((r) => setTimeout(r, Math.max(1000, next - Date.now())));
    }
  };
  loop();
}
