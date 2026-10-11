// cron 调度与事件引擎
//
// 每分钟一次：
//   斗鱼开播检查          每分钟（房间多于 12 个时分组轮转）
//   赛程刷新              每 10 分钟（这一分钟不做直播轮询，错开 CPU）
//   直播轮询              其余分钟，且只在有比赛进行或即将开始时
//   赛前提醒（1 天 / 30 分） 每分钟，只查 D1，不发外部请求
//   清理                  每小时一次
//   发件队列              最后，用掉剩余的子请求预算
//
// 所有事件都先 claim 去重键，再入队，保证同一事件只推一次。

import { now } from './util.js';
import { getSubs, getKV, setKVStmt, recipients, upsertMatchStmt, matchChanged, parseMatchRow, cleanup } from './db.js';
import { matchesByTiers, matchesByTeams, matchesByIds, gamesOf } from './bo3.js';
import { roomInfo } from './douyu.js';
import { preMsg, liveCard, mapEndMsg, endMsg, streamerLiveMsg, dailyMsg } from './format.js';
import { enqueue, fanout, flush } from './outbox.js';

const WINDOW = 7 * 86400;        // 只跟踪 7 天内的比赛
const OUTBOX_RESERVE = 0;
const LIVE_RESERVE = 12;         // 直播轮询时给发件队列至少留这么多子请求
const MAX_ROOMS_PER_TICK = 12;

// 批量领取去重键，返回本次新领到的键
export async function claim(db, keys) {
  if (!keys.length) return new Set();
  const t = now();
  const res = await db.batch(keys.map((k) => db.prepare('INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)').bind(k, t)));
  return new Set(keys.filter((_, i) => res[i].meta.changes > 0));
}

async function step(name, fn) {
  try { return await fn(); } catch (e) { console.error(`[${name}]`, e?.stack || e); return null; }
}

export async function runCron(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const minute = Math.floor(t / 60);

  await step('douyu', () => douyuTick(ctx, minute));

  const lastRefresh = Number(await getKV(db, 'last_refresh')) || 0;
  if (minute % 10 === 0 || t - lastRefresh > 15 * 60) {
    await step('refresh', () => refreshSchedule(ctx));
  } else {
    await step('live', () => liveTick(ctx, minute));
  }

  await step('remind', () => remindTick(ctx));
  await step('daily', () => dailyTick(ctx));
  if (minute % 60 === 7) await step('cleanup', () => cleanup(db));
  await step('flush', () => flush(ctx, OUTBOX_RESERVE));
}

// ---------- 赛程刷新 ----------

export async function refreshSchedule(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const subs = await getSubs(db);
  const teamIds = subs.teams.map((x) => x.team_id);

  const [byTier, byTeam] = await Promise.all([
    matchesByTiers(ctx, subs.tiers),
    matchesByTeams(ctx, teamIds),
  ]);

  const map = new Map();
  for (const m of [...byTier, ...byTeam]) {
    if (!m.start_ts) continue;
    if (!m.team1_id && !m.team2_id) continue; // 两队都未定（TBD vs TBD）不跟踪；对阵确定后下次刷新自动补上
    if (m.status === 'current' || (m.status === 'upcoming' && m.start_ts <= t + WINDOW)) map.set(m.id, m);
  }

  // 只写有变化的比赛：先把库里现有的这些行读出来对比（读的额度比写宽得多）
  const existing = new Map();
  const ids = [...map.keys()].map(Number).filter(Number.isFinite);
  if (ids.length) {
    const { results } = await db.prepare(`SELECT * FROM matches WHERE id IN (${ids.join(',')})`).all();
    for (const r of results) existing.set(r.id, r);
  }
  const stmts = [];
  for (const m of map.values()) {
    const old = existing.get(m.id);
    if (m.status === 'current') { if (!old) stmts.push(upsertMatchStmt(db, m, true)); continue; }
    if (matchChanged(old, m)) stmts.push(upsertMatchStmt(db, m));
  }
  // 不再命中订阅的未来比赛（退订、改期出窗口）删掉；10 分钟内要开的保留，避免误删
  const keep = [...map.keys()];
  stmts.push(db.prepare(
    `DELETE FROM matches WHERE status = 'upcoming' AND start_ts > ?${keep.length ? ` AND id NOT IN (${keep.join(',')})` : ''}`,
  ).bind(t + 600));
  // 旧版订阅的队伍没有国旗 / 队徽，从比赛数据里补上
  for (const st of subs.teams) {
    if (st.cc && st.logo) continue;
    const m = byTeam.find((x) => x.team1_id === st.team_id || x.team2_id === st.team_id);
    if (!m) continue;
    const side = m.team1_id === st.team_id ? 1 : 2;
    stmts.push(db.prepare('UPDATE sub_teams SET cc = COALESCE(cc, ?), logo = COALESCE(logo, ?) WHERE team_id = ?')
      .bind(m[`team${side}_cc`], m[`team${side}_logo`], st.team_id));
  }
  stmts.push(setKVStmt(db, 'last_refresh', t));
  await db.batch(stmts);
  return { tracked: map.size };
}

// ---------- 赛前提醒 ----------

export async function remindTick(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const { results } = await db.prepare(
    "SELECT * FROM matches WHERE status = 'upcoming' AND start_ts > ? AND start_ts <= ? ORDER BY start_ts",
  ).bind(t - 60, t + 86400 + 60).all();
  if (!results.length) return;

  const plan = [];
  for (const m of results) {
    const left = m.start_ts - t;
    // 进入 24 小时窗口时发一次预告；如果发现时已不足 31 分钟，就只发 30 分钟提醒
    if (left > 31 * 60) plan.push([`d1:${m.id}`, m]);
    else plan.push([`m30:${m.id}:${m.start_ts}`, m]);
  }
  const got = await claim(db, plan.map((p) => p[0]));
  if (!got.size) return;

  const to = await recipients(ctx.env);
  const items = [];
  for (const [key, m] of plan) if (got.has(key)) items.push(...fanout(to, 'send', preMsg(m, ctx.tz), m.id));
  await enqueue(db, items);
}

// ---------- 每日预报（UTC 0 点） ----------

// 当天（UTC）的比赛 + 之后最近一场；也给 /today 用
export async function buildDaily(ctx, dayStart) {
  const db = ctx.env.DB;
  const end = dayStart + 86400;
  const [today, next, subs] = await db.batch([
    db.prepare(`SELECT * FROM matches WHERE status = 'current'
      OR (status IN ('upcoming', 'finished') AND start_ts >= ? AND start_ts < ?) ORDER BY start_ts`).bind(dayStart, end),
    db.prepare("SELECT * FROM matches WHERE status = 'upcoming' AND start_ts >= ? ORDER BY start_ts LIMIT 1").bind(end),
    db.prepare('SELECT team_id FROM sub_teams'),
  ]);
  const stars = new Set(subs.results.map((r) => r.team_id));
  return dailyMsg(dayStart, today.results.map(parseMatchRow), next.results[0] || null, stars, ctx.tz);
}

export async function dailyTick(ctx) {
  const t = now();
  const dayStart = t - (t % 86400);
  if (t - dayStart > 3600) return; // 只在 UTC 0 点后的第一个小时内发（正常是 00:00 那一分钟）
  const day = new Date(dayStart * 1000).toISOString().slice(0, 10);
  const got = await claim(ctx.env.DB, [`daily:${day}`]);
  if (!got.size) return;
  const text = await buildDaily(ctx, dayStart);
  const to = await recipients(ctx.env);
  await enqueue(ctx.env.DB, to.map((chat_id) => ({ chat_id, kind: 'daily', text, meta: day })));
}

// ---------- 直播轮询 ----------

const TERMINAL = (s) => s !== 'upcoming' && s !== 'current';

export async function liveTick(ctx, minute) {
  const db = ctx.env.DB;
  const t = now();
  const { results } = await db.prepare(
    "SELECT * FROM matches WHERE status = 'current' OR (status = 'upcoming' AND start_ts <= ?)",
  ).bind(t + 1800).all(); // 开赛前 30 分钟起就纳入轮询（按 id 一次查完，不多花请求），提前开赛也能及时发现
  if (!results.length) return;

  const olds = results.map(parseMatchRow);
  const fresh = new Map((await matchesByIds(ctx, olds.map((m) => m.id))).map((m) => [m.id, m]));
  const to = await recipients(ctx.env);
  const items = [];
  const stmts = [];

  for (const old of olds) {
    const f = fresh.get(old.id);
    if (!f) {
      // bo3 上找不到了（取消 / 删除），开赛 6 小时后放弃跟踪
      if (old.start_ts < t - 6 * 3600) stmts.push(db.prepare("UPDATE matches SET status = 'missing' WHERE id = ?").bind(old.id));
      continue;
    }

    const live = f.status === 'current';
    const done = TERMINAL(f.status);
    const m = { ...old, ...f, maps: old.maps };

    if (!live && !done) { // 仍是 upcoming（延迟开赛），只同步时间等字段
      if (matchChanged(old, m)) stmts.push(upsertMatchStmt(db, m));
      continue;
    }

    const claims = [];
    if (live) claims.push(`open:${m.id}`);
    if (done) claims.push(`end:${m.id}`);
    const got0 = await claim(db, claims);
    const opening = got0.has(`open:${m.id}`);
    const ending = got0.has(`end:${m.id}`);

    const scoreChanged = f.s1 !== old.s1 || f.s2 !== old.s2;
    const needGames = opening || ending || scoreChanged || minute % 3 === 0;
    if (needGames && ctx.left() > LIVE_RESERVE) {
      try { m.maps = await gamesOf(ctx, m); } catch (e) { console.error('games', m.id, e); }
    }

    // 新打完的地图
    const finishedMaps = (m.maps || []).filter((g) => g.status === 'finished');
    const mapKeys = finishedMaps.map((g) => `map:${m.id}:${g.n}`);
    const gotMaps = await claim(db, mapKeys);
    // 中途才开始跟踪（opening）时，已结束的地图静默补记；整场结束时由结束消息统一说明
    if (!opening && !done) {
      for (const g of finishedMaps) if (gotMaps.has(`map:${m.id}:${g.n}`)) items.push(...fanout(to, 'send', mapEndMsg(m, g), m.id));
    }

    const changed = scoreChanged || JSON.stringify(m.maps) !== JSON.stringify(old.maps) || old.status !== f.status;
    if (opening) items.push(...fanout(to, 'live_open', liveCard(m, m.maps), m.id));
    else if (changed) items.push(...fanout(to, 'live_edit', liveCard(m, m.maps, done), m.id));
    if (ending) items.push(...fanout(to, 'send', endMsg(m), m.id));

    if (matchChanged(old, m)) stmts.push(upsertMatchStmt(db, m));
  }

  if (stmts.length) await db.batch(stmts);
  await enqueue(db, items);
}

// ---------- 斗鱼 ----------

export async function douyuTick(ctx, minute) {
  const db = ctx.env.DB;
  const t = now();
  const { results: all } = await db.prepare('SELECT * FROM streamers ORDER BY room_id').all();
  if (!all.length) return;

  let rooms = all;
  if (all.length > MAX_ROOMS_PER_TICK) {
    const groups = Math.ceil(all.length / MAX_ROOMS_PER_TICK);
    rooms = all.filter((_, i) => i % groups === minute % groups);
  }

  const infos = await Promise.allSettled(rooms.map((r) => roomInfo(ctx, r.room_id)));
  const stmts = [];
  const went = [];

  rooms.forEach((r, i) => {
    const res = infos[i];
    if (res.status !== 'fulfilled' || !res.value.ok) return;
    const info = res.value;
    const wasLive = !!r.live;
    if (info.live !== wasLive) {
      // 下播不到 10 分钟又开播（断流重连）不算新开播
      const flap = info.live && r.changed_at && t - r.changed_at < 600;
      // 同一场直播（开播时间没变）只推一次
      const sameShow = info.live && info.showTime && info.showTime === r.show_time;
      // 之前没记录过开播时间（刚升级、刚添加）且这场已经开了半小时以上：说明不是刚开播，只记录不推
      const stale = info.live && !r.show_time && info.showTime && t - info.showTime > 1800;
      if (info.live && !flap && !sameShow && !stale) went.push({ ...r, ...info });
      stmts.push(db.prepare('UPDATE streamers SET live = ?, changed_at = ?, show_time = COALESCE(?, show_time) WHERE room_id = ?')
        .bind(info.live ? 1 : 0, t, info.live ? info.showTime : null, r.room_id));
    }
    // 资料有变化才写（热度每分钟都变，不存）
    if (info.title !== r.title || info.owner !== r.owner || info.category !== r.category || info.avatar !== r.avatar) {
      stmts.push(db.prepare('UPDATE streamers SET owner = ?, title = ?, category = ?, avatar = ? WHERE room_id = ?')
        .bind(info.owner, info.title, info.category, info.avatar, r.room_id));
    }
  });

  if (stmts.length) await db.batch(stmts);
  if (went.length) {
    const to = await recipients(ctx.env);
    await enqueue(db, went.flatMap((s) => fanout(to, 'send', streamerLiveMsg(s))));
  }
}
