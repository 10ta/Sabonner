// cron 调度与事件引擎
//
// 每分钟一次：
//   斗鱼开播检查          每分钟（房间多于 12 个时分组轮转）
//   赛程刷新              每 10 分钟（这一分钟不做直播轮询，错开 CPU）
//   直播轮询              其余分钟，且只在有比赛进行或即将开始时
//   赛前提醒（30 分）     每分钟，只查 D1，不发外部请求（提前 1 天的预告并进了每日预报）
//   清理                  每小时一次
//   发件队列              最后，用掉剩余的子请求预算
//
// 所有事件都先 claim 去重键，再入队，保证同一事件只推一次。

import { now } from './util.js';
import { getSubs, getKV, setKVStmt, recipients, upsertMatchStmt, matchChanged, parseMatchRow, cleanup, KEEP_OLD, eventsStmts, pickEvents, subsStmts, subsFrom } from './db.js';
import { matchesByTiers, matchesByTeams, matchesByStars, matchesByIds, attachTournaments, matchStats, eventList } from './bo3.js';
import { roomInfo } from './douyu.js';
import { preMsg, liveCard, mapEndMsg, endMsg, streamerLiveMsg, dailyMsg } from './format.js';
import { enqueue, fanout, flush } from './outbox.js';
import { tg } from './tgapi.js';

const WINDOW = 7 * 86400;        // 只跟踪 7 天内的比赛
const OUTBOX_RESERVE = 0;
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

  if (minute % 10 === 3) await step('stats', () => statsTick(ctx));
  await step('remind', () => remindTick(ctx));
  await step('daily', () => dailyTick(ctx));
  if (minute % 60 === 7) await step('cleanup', () => cleanup(db));
  if (minute % 10 === 7) await step('events', () => eventsTick(ctx));
  await step('flush', () => flush(ctx, OUTBOX_RESERVE));
  await step('expire', () => expireTick(ctx));
}

// ---------- 赛程刷新 ----------

export async function refreshSchedule(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const subs = await getSubs(db);
  const teamIds = subs.teams.map((x) => x.team_id);

  // tier、队伍、星级三种订阅取并集（OR）
  const [byTier, byTeam, byStars] = await Promise.all([
    matchesByTiers(ctx, subs.tiers),
    matchesByTeams(ctx, teamIds),
    matchesByStars(ctx, subs.stars),
  ]);

  const map = new Map();
  for (const m of [...byTier, ...byTeam, ...byStars]) {
    if (!m.start_ts) continue;
    if (!m.team1_id && !m.team2_id) continue; // 两队都未定（TBD vs TBD）不跟踪；对阵确定后下次刷新自动补上
    if (m.status === 'current' || (m.status === 'upcoming' && m.start_ts <= t + WINDOW)) map.set(m.id, m);
  }
  await attachTournaments(ctx, [...map.values()]); // 合并去重之后只查一次赛事信息

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

// ---------- 赛前提醒（开赛前 30 分钟） ----------
// 提前 1 天的单条预告已经取消，由每日预报的「明日赛程」代替

export async function remindTick(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const { results } = await db.prepare(
    "SELECT * FROM matches WHERE status = 'upcoming' AND start_ts > ? AND start_ts <= ? ORDER BY start_ts",
  ).bind(t - 60, t + 30 * 60 + 60).all();
  if (!results.length) return;

  // 键里带开赛时间：改期后会在新时间前 30 分钟再提醒一次
  const plan = results.map((m) => [`m30:${m.id}:${m.start_ts}`, m]);
  const got = await claim(db, plan.map((p) => p[0]));
  if (!got.size) return;

  const to = await recipients(ctx.env);
  const items = [];
  for (const [key, m] of plan) if (got.has(key)) items.push(...fanout(to, 'send', preMsg(m, ctx.tz), m.id, 'pre'));
  await enqueue(db, items);
}

// ---------- 每日预报（UTC 0 点）：今日 + 明日赛程 ----------

// 当天（UTC）的比赛、第二天的比赛，两天都没有时再带上之后最近的一场；也给 /today 用
export async function buildDaily(ctx, dayStart) {
  const db = ctx.env.DB;
  const end = dayStart + 86400;
  const [today, tomorrow, next, subs, ...rest] = await db.batch([
    db.prepare(`SELECT * FROM matches WHERE status = 'current'
      OR (status IN ('upcoming', 'finished') AND start_ts >= ? AND start_ts < ?) ORDER BY start_ts`).bind(dayStart, end),
    db.prepare("SELECT * FROM matches WHERE status = 'upcoming' AND start_ts >= ? AND start_ts < ? ORDER BY start_ts").bind(end, end + 86400),
    db.prepare("SELECT * FROM matches WHERE status = 'upcoming' AND start_ts >= ? ORDER BY start_ts LIMIT 1").bind(end + 86400),
    db.prepare('SELECT team_id FROM sub_teams'),
    ...eventsStmts(db),
    ...subsStmts(db),
  ]);
  const stars = new Set(subs.results.map((r) => r.team_id));
  const events = pickEvents(rest.slice(0, 2), subsFrom(rest.slice(2)));
  return dailyMsg(dayStart, today.results.map(parseMatchRow), tomorrow.results.map(parseMatchRow),
    next.results[0] || null, stars, ctx.tz, events);
}

export async function dailyTick(ctx) {
  const t = now();
  const dayStart = t - (t % 86400);
  if (t - dayStart > 3600) return; // 只在 UTC 0 点后的第一个小时内发（正常是 00:00 那一分钟）
  const day = new Date(dayStart * 1000).toISOString().slice(0, 10);
  const key = `daily:${day}`;
  if (await ctx.env.DB.prepare('SELECT 1 FROM sent WHERE key = ?').bind(key).first()) return;
  // 先生成再领取：生成时出错的话这一分钟不算数，下一分钟重试，不会丢掉当天的预报
  const text = await buildDaily(ctx, dayStart);
  const got = await claim(ctx.env.DB, [key]);
  if (!got.size) return;
  const to = await recipients(ctx.env);
  await enqueue(ctx.env.DB, to.map((chat_id) => ({ chat_id, kind: 'daily', text, meta: day })));
}

// ---------- 直播轮询 ----------

const TERMINAL = (s) => s !== 'upcoming' && s !== 'current';

// 大比分已经分出胜负（BO3 有人拿到 2 图、BO2 打满 2 图……）。
// bo3 在决胜图打完后往往要过好几分钟才把比赛标成 finished，这期间按比分直接判定结束，
// 网页和 TG 不用跟着它一起「还在进行中」
export function seriesDecided(m) {
  const bo = Number(m.bo) || 0;
  const s1 = Number(m.s1) || 0, s2 = Number(m.s2) || 0;
  if (!bo) return false;
  return Math.max(s1, s2) > bo / 2 || s1 + s2 >= bo;
}

// 开赛 6 小时后 bo3 还标着「未开始」的比赛（多半是取消了没更新），每 10 分钟才查一次，
// 免得一场「僵尸比赛」让直播轮询每分钟都去请求 bo3
const STALE_UPCOMING = 6 * 3600;

// 比赛已结束但最后一张图比分迟迟不来时，最多等这么久再发结束消息
const MAP_WAIT = 20 * 60;

// 第一次发现「已结束但缺比分」时记下时间（借用去重表），之后对比是否等够了
async function waitedTooLong(db, id, t) {
  const key = `endwait:${id}`;
  await db.prepare('INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)').bind(key, t).run();
  const r = await db.prepare('SELECT at FROM sent WHERE key = ?').bind(key).first();
  return !r || t - r.at >= MAP_WAIT;
}

export async function liveTick(ctx, minute) {
  const db = ctx.env.DB;
  const t = now();
  // 开赛前 30 分钟起就纳入轮询（按 id 一次查完，不多花请求），提前开赛也能及时发现
  const { results } = await db.prepare(
    `SELECT * FROM matches WHERE status = 'current'
      OR (status = 'upcoming' AND start_ts <= ?${minute % 10 === 5 ? '' : ' AND start_ts > ?'})`,
  ).bind(...(minute % 10 === 5 ? [t + 1800] : [t + 1800, t - STALE_UPCOMING])).all();
  if (!results.length) return;

  const olds = results.map(parseMatchRow);
  const fresh = new Map((await matchesByIds(ctx, olds.map((m) => m.id))).map((m) => [m.id, m]));
  const stmts = [];

  // 第一遍：算出每场的新状态和要领取的去重键
  const plans = [];
  for (const old of olds) {
    const f = fresh.get(old.id);
    if (!f) {
      // bo3 上找不到了（取消 / 删除），开赛 6 小时后放弃跟踪
      if (old.start_ts < t - 6 * 3600) stmts.push(db.prepare("UPDATE matches SET status = 'missing' WHERE id = ?").bind(old.id));
      continue;
    }

    // 结束消息要带上每张图的比分。bo3 打完决胜图后，比赛状态和最后一张图的比分谁先更新不一定：
    //   ① 状态还是进行中、大比分已分出胜负 → 等最后一张图比分到了就当作结束（不用等 bo3 改状态）
    //   ② 状态已经是 finished、最后一张图比分还没到 → 先按进行中处理，等比分到了再发结束
    // 完全没有地图数据的比赛（bo3 没做逐图直播）不等；比分一直不来的，最多等 MAP_WAIT 后照常发
    const mapsNow = f.maps ?? old.maps ?? [];
    const scored = mapsNow.filter((g) => g.status === 'finished' && g.sc1 != null).length;
    const mapsComplete = !mapsNow.length || scored >= (Number(f.s1) || 0) + (Number(f.s2) || 0);
    if (f.status === 'current' && seriesDecided(f) && mapsComplete) {
      f.status = 'finished';
      if (!f.winner_id && f.s1 !== f.s2) f.winner_id = f.s1 > f.s2 ? f.team1_id : f.team2_id;
    } else if (f.status === 'finished' && !mapsComplete && !(await waitedTooLong(db, f.id, t))) {
      f.status = 'current'; // 库里保持进行中，下一分钟继续轮询
    }
    // 地图、赛事信息（线下 / 线上、HLTV、奖金）这次没拿到时沿用库里的
    const m = { ...old, ...f };
    for (const k of KEEP_OLD) if (f[k] == null) m[k] = old[k];

    const live = m.status === 'current';
    const done = TERMINAL(m.status);
    if (!live && !done) { // 仍是 upcoming（延迟开赛），只同步时间等字段
      if (matchChanged(old, m)) stmts.push(upsertMatchStmt(db, m));
      continue;
    }
    // 新打完的地图：bo3 会先把地图标成 finished、过一会儿才填比分，比分到了才算（否则消息里只有「—」）
    const finishedMaps = (m.maps || []).filter((g) => g.status === 'finished' && g.sc1 != null);
    const keys = [...(live ? [`open:${m.id}`] : []), ...(done ? [`end:${m.id}`] : []), ...finishedMaps.map((g) => `map:${m.id}:${g.n}`)];
    plans.push({ old, m, live, done, finishedMaps, keys });
  }

  // 所有比赛的去重键一次领完（以前每场两次 D1 往返）
  const got = await claim(db, plans.flatMap((p) => p.keys));
  const to = plans.length ? await recipients(ctx.env) : [];
  const items = [];

  // 第二遍：按领到的键生成消息
  for (const { old, m, done, finishedMaps } of plans) {
    const opening = got.has(`open:${m.id}`);
    const ending = got.has(`end:${m.id}`);
    // 中途才开始跟踪（opening）时，已结束的地图静默补记；整场结束时由结束消息统一说明
    if (!opening && !done) {
      for (const g of finishedMaps) if (got.has(`map:${m.id}:${g.n}`)) items.push(...fanout(to, 'send', mapEndMsg(m, g, m.maps), m.id, 'map'));
    }
    const changed = m.s1 !== old.s1 || m.s2 !== old.s2 || JSON.stringify(m.maps) !== JSON.stringify(old.maps) || old.status !== m.status;
    if (opening) items.push(...fanout(to, 'live_open', liveCard(m, m.maps), m.id));
    // 结束时直播卡片会被删掉（结束消息里有全部信息），不用再编辑
    else if (changed && !ending) items.push(...fanout(to, 'live_edit', liveCard(m, m.maps, done), m.id));
    if (ending) items.push(...fanout(to, 'send', endMsg(m), m.id, 'end'));
    if (matchChanged(old, m)) stmts.push(upsertMatchStmt(db, m));
  }

  if (stmts.length) await db.batch(stmts);
  await enqueue(db, items);
}

// ---------- 赛后数据（每 10 分钟） ----------
// bo3 解析完 demo（通常赛后几小时）才有每名选手的数据。拿到后：存进库（网页赛果详情用），
// 并把已经发出的结束消息编辑成带记分板的版本；顺便用最新的地图数据补全赛后才填上的比分。
// bo3 解析有时要一天多（实测 Legacy vs FURIA 超过 5 小时还在排队），开赛 3 天后还没有才放弃
const STATS_GIVEUP = 3 * 86400;
const STATS_PER_TICK = 3;

export async function statsTick(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const { results } = await db.prepare(
    "SELECT * FROM matches WHERE status = 'finished' AND stats IS NULL AND start_ts > ? ORDER BY start_ts DESC LIMIT 10",
  ).bind(t - STATS_GIVEUP - 86400).all();
  if (!results.length) return;

  const olds = results.map(parseMatchRow);
  const fresh = new Map((await matchesByIds(ctx, olds.map((m) => m.id))).map((m) => [m.id, m]));
  const stmts = [];
  const items = [];
  let fetched = 0;
  let to = null;
  for (const old of olds) {
    const f = fresh.get(old.id);
    if (f?.parsed === 'done' && fetched < STATS_PER_TICK && ctx.left() > 2) {
      fetched++;
      const stats = await matchStats(ctx, old).catch(() => null);
      if (stats?.length) {
        const maps = (f.maps || []).filter((g) => g.sc1 != null).length >= (old.maps || []).filter((g) => g.sc1 != null).length ? f.maps : old.maps;
        const m = { ...old, maps, stats };
        stmts.push(db.prepare('UPDATE matches SET stats = ?, maps = ? WHERE id = ?').bind(JSON.stringify(stats), JSON.stringify(maps || []), old.id));
        to ??= await recipients(ctx.env);
        items.push(...fanout(to, 'end_edit', endMsg(m), m.id));
        continue;
      }
    }
    if (old.start_ts < t - STATS_GIVEUP) stmts.push(db.prepare("UPDATE matches SET stats = '[]' WHERE id = ?").bind(old.id));
  }
  if (stmts.length) await db.batch(stmts);
  await enqueue(db, items);
}

// ---------- 赛事列表（每 6 小时） ----------
// 每 10 分钟看一眼缓存时间，过期才请求 bo3（一天 4 次）
const EVENTS_TTL = 6 * 3600;
export async function eventsTick(ctx, force = false) {
  const db = ctx.env.DB;
  const t = now();
  if (!force) {
    const row = await db.prepare("SELECT v FROM kv WHERE k = 'events'").first();
    let at = 0;
    try { at = JSON.parse(row?.v || '{}').at || 0; } catch { /* 当没有 */ }
    if (t - at < EVENTS_TTL) return;
  }
  const list = await eventList(ctx);
  await setKVStmt(db, 'events', JSON.stringify({ at: t, list })).run();
  return list.length;
}

// ---------- 短时消息到期删除（每分钟） ----------
// 「地图 X 结束」只是提醒：比分已经同步到直播卡片上，发出 5 分钟后删掉。
// Telegram 没有给单条消息设定时删除的接口（聊天级的自动删除最短 1 天，而且只能用户自己开），所以由 cron 来删
const EXPIRE = { map: 5 * 60 };

export async function expireTick(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const { results } = await db.prepare("SELECT chat_id, message_id FROM tg_msgs WHERE tag = 'map' AND sent_at <= ?").bind(t - EXPIRE.map).all();
  if (!results.length) return;
  const byChat = new Map();
  for (const r of results) {
    if (!byChat.has(r.chat_id)) byChat.set(r.chat_id, []);
    byChat.get(r.chat_id).push(r.message_id);
  }
  const gone = [];
  for (const [chat_id, ids] of byChat) {
    if (ctx.left() <= 0) break; // 预算用完了，下一分钟接着删
    const res = await tg(ctx, 'deleteMessages', { chat_id, message_ids: ids.slice(0, 100) });
    if (res.ok || res.error_code === 400 || res.error_code === 403) gone.push(...ids.slice(0, 100).map((id) => `(${Number(chat_id)},${Number(id)})`));
  }
  if (gone.length) await db.prepare(`DELETE FROM tg_msgs WHERE (chat_id, message_id) IN (VALUES ${gone.join(',')})`).run();
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
