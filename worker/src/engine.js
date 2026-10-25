// cron 调度与事件引擎
//
// cron 每分钟一次。免费版每次调用最多 10ms CPU（偶尔超出会被容忍，经常超出会被终止），
// 最耗 CPU 的是解析 bo3 的大响应，所以按分钟错开，一次调用最多发一个 bo3 列表请求：
//   偶数分钟（重活轮换，20 分钟一轮，见 HEAVY）：赛程刷新按 tier 逐个、作为队伍 1 / 队伍 2、星级各占一分钟，
//     一轮最后一个顺带删掉不再命中订阅的比赛；中间穿插赛后数据（只查赛后 1 / 2 / 4 / 8 小时到点的）和赛事列表 / 清理
//   奇数分钟（轻活，每 2 分钟一次；斗鱼每 10 分钟一次）：一次 D1 batch 读完要用的状态，没事做的步骤直接跳过
//     每日预报（UTC 0 点后）、直播轮询（有比赛进行或已到开赛时间）、赛前 30 分钟提醒、斗鱼开播检查、
//     地图消息到期删除、发件队列
// 每次调用写一行「[cron] 做了什么」，Observability 里按这行分组就能看到每种任务各花多少 CPU
//
// 所有事件都先 claim 去重键，再入队，保证同一事件只推一次。

import { now, SUBREQ_MAX } from './util.js';
import { getSubs, getKV, setKVStmt, recipients, recipientsStmt, recipientsFrom, upsertMatchStmt, matchChanged, parseMatchRow, cleanup, KEEP_OLD, eventsStmts, pickEvents, subsStmts, subsFrom } from './db.js';
import { matchesByTiers, matchesByTeams, matchesByTeamSide, matchesByStars, liveByIds, attachTournaments, tournamentIds, tournamentsStmt, countriesStmt, primeCountries, matchStats, eventList } from './bo3.js';
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

// 接收推送的人：轻活分钟已经和别的查询一起读好放在 ctx.to；其余情况再单独查一次
const toOf = async (ctx) => (ctx.to ??= await recipients(ctx.env));

async function step(name, fn) {
  try { return await fn(); } catch (e) { console.error(`[${name}]`, e?.stack || e); return null; }
}

export async function runCron(ctx) {
  const t = now();
  const minute = Math.floor(t / 60);
  const did = [];
  if (minute % 2 === 0) await heavyTick(ctx, minute, did);
  else await lightTick(ctx, minute, t, did);
  console.log(`[cron] ${did.join(' ') || 'idle'}`);
}

// ---------- 偶数分钟：一件重活 ----------
// 20 分钟一轮、10 个偶数分钟。tier 按订阅的顺序取第 0–3 个（没订阅那么多就空着），
// team1 / team2 = 订阅的队伍作为队伍 1 / 队伍 2 的比赛（bo3 不支持 OR，只能分两次查）
const HEAVY = ['tier:0', 'team1', 'stats', 'tier:1', 'team2', 'events', 'tier:2', 'stars', 'stats', 'tier:3'];

async function heavyTick(ctx, minute, did) {
  const job = HEAVY[Math.floor(minute / 2) % HEAVY.length];
  if (job === 'stats') {
    const n = await step('stats', () => statsTick(ctx));
    if (n) did.push(`stats(${n})`);
  } else if (job === 'events') {
    // 赛事列表 6 小时才过期一次，没过期时这一分钟拿来清理旧数据（只用 D1）
    const n = await step('events', () => eventsTick(ctx));
    if (n != null) did.push(`events(${n})`);
    else { await step('cleanup', () => cleanup(ctx.env.DB)); did.push('cleanup'); }
  } else {
    const r = await step(`refresh:${job}`, () => refreshStep(ctx, job, job === HEAVY[HEAVY.length - 1]));
    if (r) did.push(`refresh:${r.part}(${r.tracked})`);
  }
}

// ---------- 奇数分钟：轻活 ----------

const STALE_UPCOMING = 6 * 3600;   // 见 liveRowsStmt
// 轻活分钟最多发几个外部请求（bo3、斗鱼、Telegram 的发送 / 编辑 / 置顶 / 删除都算）。线上每个外部请求约 2–3ms CPU，
// 一次发太多会超过免费版每次 10ms 的上限；Telegram 消息发不完的留在队列里，下一次（2 分钟后）接着发
const FETCH_PER_TICK = 4;
// 斗鱼多久查一次：这个接口分不出直播和录播（放录播时也是 isLive=1），查得勤也没用；开播提醒最多晚 10 分钟
const DOUYU_EVERY = 10;
const EXPIRE = { map: 5 * 60 };    // 见 expireTick

async function lightTick(ctx, minute, t, did) {
  const db = ctx.env.DB;
  const dayStart = t - (t % 86400);
  const dailyKey = `daily:${new Date(dayStart * 1000).toISOString().slice(0, 10)}`;
  // 一次往返读完这一分钟要用的全部状态：直播要看的比赛和它们已经领过的去重键、提醒、斗鱼房间、发件队列、
  // 到期要删的消息、今天的日报发过没有、接收人。比赛没变化时，整分钟只有这一次 D1 往返
  const [live, claimed, remind, rooms, outbox, expire, daily, users] = await db.batch([
    liveRowsStmt(db, minute, t),
    claimedKeysStmt(db, minute, t),
    remindRowsStmt(db, t),
    db.prepare('SELECT * FROM streamers ORDER BY room_id'),
    db.prepare('SELECT * FROM outbox ORDER BY id LIMIT ?').bind(SUBREQ_MAX),
    db.prepare("SELECT chat_id, message_id FROM tg_msgs WHERE tag = 'map' AND sent_at <= ?").bind(t - EXPIRE.map),
    db.prepare('SELECT 1 FROM sent WHERE key = ?').bind(dailyKey),
    recipientsStmt(db),
  ]);
  ctx.to = recipientsFrom(users.results, ctx.env);

  let queued = 0;
  // 日志：做了的步骤都记一笔，入队了消息的带上条数，如 live:2+3 = 轮询 2 场、入队 3 条
  const run = async (label, fn) => {
    const n = await step(label.split(':')[0], fn);
    did.push(n ? `${label}+${n}` : label);
    queued += n || 0;
  };
  // 只在 UTC 0 点后的第一个小时内（正常是 00:01 那一次）
  if (t - dayStart <= 3600 && !daily.results.length) await run('daily', () => dailyTick(ctx, dayStart, dailyKey));
  if (live.results.length) {
    await run(`live:${live.results.length}`, () => liveTick(ctx, minute, live.results, new Set(claimed.results.map((r) => r.key))));
  }
  if (remind.results.length) await run('remind', () => remindTick(ctx, remind.results));
  if (rooms.results.length && minute % DOUYU_EVERY === 1) await run('douyu', () => douyuTick(ctx, minute, rooms.results));
  // 这一次总共最多 FETCH_PER_TICK 个外部请求（至少留 1 个给 Telegram）：先发消息，剩下的额度再删到期的地图消息
  ctx.cap = Math.max(FETCH_PER_TICK, ctx.used + 1);
  if (queued > 0 || outbox.results.length > 0) {
    const r = await step('flush', () => flush(ctx, OUTBOX_RESERVE));
    if (r?.sent) did.push(`sent(${r.sent})`);
    if (r?.pending) did.push('pending');
  }
  if (expire.results.length && ctx.left() > 0) {
    await step('expire', () => expireTick(ctx, expire.results));
    did.push(`expire(${expire.results.length})`);
  }
}

// ---------- 赛程刷新 ----------
// 订阅（tier、队伍、星级）取并集。cron 里每一部分（每个 tier、队伍 1、队伍 2、星级）各占一分钟，
// 每次只解析一份 bo3 响应；每部分记下自己命中的比赛 id（kv rf:<部分>），一轮最后用所有部分的 id 删掉不再命中订阅的未来比赛。
// 网页 / TG 里的「立即刷新」一次拉完

const PART_FRESH = 30 * 60;   // 某一部分的结果超过这么久没更新，这一轮就不删比赛（宁可留着也不误删）

// 当前订阅对应的全部部分
const partsOf = (subs) => [
  ...subs.tiers.map((t) => `tier:${t}`),
  ...(subs.teams.length ? ['team1', 'team2'] : []),
  ...(subs.stars ? ['stars'] : []),
];

function fetchPart(ctx, part, subs) {
  if (part.startsWith('tier:')) return matchesByTiers(ctx, [part.slice(5)]);
  const ids = subs.teams.map((x) => x.team_id);
  if (part === 'team1' || part === 'team2') return matchesByTeamSide(ctx, ids, part === 'team1' ? 1 : 2);
  return matchesByStars(ctx, subs.stars);
}

// 要跟踪的比赛：有开赛时间、至少一队已定，进行中或 7 天内开赛
function pick(list, t) {
  const map = new Map();
  for (const m of list) {
    if (!m.start_ts) continue;
    if (!m.team1_id && !m.team2_id) continue; // 两队都未定（TBD vs TBD）不跟踪；对阵确定后下次刷新自动补上
    if (m.status === 'current' || (m.status === 'upcoming' && m.start_ts <= t + WINDOW)) map.set(m.id, m);
  }
  return map;
}

// 写入有变化的比赛（返回语句，调用方一起 batch）
async function writeStmts(ctx, map, subs, byTeam) {
  const db = ctx.env.DB;
  const list = [...map.values()];
  const tours = tournamentIds(list);
  const ids = [...map.keys()].map(Number).filter(Number.isFinite);
  // 赛事信息缓存和库里现有的这几场比赛一次读完（只写有变化的比赛：先读出来对比，读的额度比写宽得多）
  const reads = await (tours.length || ids.length ? db.batch([
    ...(tours.length ? [tournamentsStmt(db, tours)] : []),
    ...(ids.length ? [db.prepare(`SELECT * FROM matches WHERE id IN (${ids.join(',')})`)] : []),
  ]) : []);
  const stmts = [];   // 新赛事信息的写入也放进来，和比赛一起提交
  await attachTournaments(ctx, list, tours.length ? reads[0].results : [], stmts);
  const existing = new Map();
  if (ids.length) for (const r of reads[tours.length ? 1 : 0].results) existing.set(r.id, r);
  for (const m of map.values()) {
    const old = existing.get(m.id);
    if (m.status === 'current') { if (!old) stmts.push(upsertMatchStmt(db, m, true)); continue; }
    if (matchChanged(old, m)) stmts.push(upsertMatchStmt(db, m));
  }
  // 旧版订阅的队伍没有国旗 / 队徽，从比赛数据里补上
  for (const st of byTeam ? subs.teams : []) {
    if (st.cc && st.logo) continue;
    const m = byTeam.find((x) => x.team1_id === st.team_id || x.team2_id === st.team_id);
    if (!m) continue;
    const side = m.team1_id === st.team_id ? 1 : 2;
    stmts.push(db.prepare('UPDATE sub_teams SET cc = COALESCE(cc, ?), logo = COALESCE(logo, ?) WHERE team_id = ?')
      .bind(m[`team${side}_cc`], m[`team${side}_logo`], st.team_id));
  }
  return stmts;
}

// 不再命中订阅的未来比赛（退订、改期出窗口）删掉；10 分钟内要开的保留，避免误删
const pruneStmt = (db, keep, t) => db.prepare(
  `DELETE FROM matches WHERE status = 'upcoming' AND start_ts > ?${keep.length ? ` AND id NOT IN (${keep.map(Number).filter(Number.isFinite).join(',')})` : ''}`,
).bind(t + 600);
const partStmt = (db, part, t, ids) => setKVStmt(db, `rf:${part}`, JSON.stringify({ at: t, ids }));

// 一次拉完（网页、TG 里的手动刷新用）。tier 合成一个请求、队伍两侧并发，和以前一样
export async function refreshSchedule(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const subs = await getSubs(db);
  const [byTier, byTeam, byStars] = await Promise.all([
    matchesByTiers(ctx, subs.tiers),
    matchesByTeams(ctx, subs.teams.map((x) => x.team_id)),
    matchesByStars(ctx, subs.stars),
  ]);
  const map = pick([...byTier, ...byTeam, ...byStars], t);
  const stmts = await writeStmts(ctx, map, subs, byTeam);
  stmts.push(pruneStmt(db, [...map.keys()], t), setKVStmt(db, 'last_refresh', t));
  // 各部分的 id 也记下来，cron 下一轮删比赛时用得上
  const ids = [...map.keys()];
  for (const p of partsOf(subs)) stmts.push(partStmt(db, p, t, ids));
  await db.batch(stmts);
  return { tracked: map.size };
}

// cron 里的一部分。slot：'tier:0'..'tier:3' / 'team1' / 'team2' / 'stars'；last：这一轮的最后一个，顺带删比赛
export async function refreshStep(ctx, slot, last = false) {
  const db = ctx.env.DB;
  const t = now();
  // 订阅、国家代码表、（一轮最后一格才要的）各部分记下的比赛 id，一次读完
  const res = await db.batch([...subsStmts(db), countriesStmt(db), ...(last ? [db.prepare("SELECT k, v FROM kv WHERE k LIKE 'rf:%'")] : [])]);
  const subs = subsFrom(res);
  primeCountries(ctx, res[3].results[0]); // 国家代码表和订阅一起读了，解析比赛时不用再查一次
  let part = slot;
  if (slot.startsWith('tier:')) {
    const tier = subs.tiers[Number(slot.slice(5))];
    part = tier ? `tier:${tier}` : null;
  } else if ((slot === 'team1' || slot === 'team2') && !subs.teams.length) part = null;
  else if (slot === 'stars' && !subs.stars) part = null;

  const stmts = [];
  let own = [];
  if (part) {
    const list = await fetchPart(ctx, part, subs);
    const map = pick(list, t);
    own = [...map.keys()];
    stmts.push(...await writeStmts(ctx, map, subs, part.startsWith('team') ? list : null));
    stmts.push(partStmt(db, part, t, own), setKVStmt(db, 'last_refresh', t));
  }
  if (last) {
    // 当前订阅的每个部分都要有近 PART_FRESH 内的结果，才用它们的并集删比赛
    const parts = new Set(partsOf(subs).filter((p) => p !== part).map((p) => `rf:${p}`));
    const rows = res[4].results.filter((r) => parts.has(r.k));
    const keep = new Set(own);
    let fresh = rows.length === parts.size;
    for (const r of rows) {
      let v = null;
      try { v = JSON.parse(r.v); } catch { /* 当没有 */ }
      if (!v || t - v.at > PART_FRESH) { fresh = false; break; }
      for (const id of v.ids) keep.add(id);
    }
    if (fresh) stmts.push(pruneStmt(db, [...keep], t));
  }
  if (stmts.length) await db.batch(stmts);
  return part || last ? { part: part || slot, tracked: own.length } : null;
}

// ---------- 赛前提醒（开赛前 30 分钟） ----------
// 提前 1 天的单条预告已经取消，由每日预报的「明日赛程」代替

// 每 2 分钟查一次，窗口前后各多留一点：刚开赛 3 分钟内的也算（去重键保证只提醒一次）
const remindRowsStmt = (db, t) => db.prepare(
  "SELECT * FROM matches WHERE status = 'upcoming' AND start_ts > ? AND start_ts <= ? ORDER BY start_ts",
).bind(t - 180, t + 30 * 60 + 60);

export async function remindTick(ctx, results) {
  const db = ctx.env.DB;
  if (!results.length) return 0;

  // 键里带开赛时间：改期后会在新时间前 30 分钟再提醒一次
  const plan = results.map((m) => [`m30:${m.id}:${m.start_ts}`, m]);
  const got = await claim(db, plan.map((p) => p[0]));
  if (!got.size) return 0;

  const to = await toOf(ctx);
  const items = [];
  for (const [key, m] of plan) if (got.has(key)) items.push(...fanout(to, 'send', preMsg(m, ctx.tz), m.id, 'pre'));
  await enqueue(db, items);
  return items.length;
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

// 是否已发过、是否在 UTC 0 点后第一个小时内，由 lightTick 判断
export async function dailyTick(ctx, dayStart, key) {
  const day = new Date(dayStart * 1000).toISOString().slice(0, 10);
  // 先生成再领取：生成时出错的话这一次不算数，2 分钟后重试，不会丢掉当天的预报
  const text = await buildDaily(ctx, dayStart);
  const got = await claim(ctx.env.DB, [key]);
  if (!got.size) return 0;
  const to = await toOf(ctx);
  await enqueue(ctx.env.DB, to.map((chat_id) => ({ chat_id, kind: 'daily', text, meta: day })));
  return to.length;
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

// 直播轮询要看的比赛：进行中，或已经到了预定开赛时间（CS 几乎不会提前开赛，推迟倒是常见，
// 所以到点才开始问 bo3，确认开打了才发直播卡片，不会在推迟的时候先发一张空的 LIVE）。
// 开赛 6 小时后 bo3 还标着「未开始」的比赛（多半是取消了没更新）每 10 分钟才带上一次，
// 免得一场「僵尸比赛」让直播轮询每次都去请求 bo3
function liveWhere(minute, t) {
  const all = minute % 10 === 5;
  return [`(status = 'current' OR (status = 'upcoming' AND start_ts <= ?${all ? '' : ' AND start_ts > ?'}))`,
    all ? [t] : [t, t - STALE_UPCOMING]];
}
function liveRowsStmt(db, minute, t) {
  const [where, args] = liveWhere(minute, t);
  return db.prepare(`SELECT * FROM matches WHERE ${where}`).bind(...args);
}
// 这些比赛已经领过的去重键（open / end / map:<id>:<n>）。直播轮询只领还没领过的，
// 比分没变的时候就不用再为领键多跑一次 D1（map 键用区间比较，走 sent 的主键索引）
function claimedKeysStmt(db, minute, t) {
  const [where, args] = liveWhere(minute, t);
  return db.prepare(`SELECT s.key FROM sent s JOIN (SELECT id FROM matches WHERE ${where}) m
    ON s.key = 'open:' || m.id OR s.key = 'end:' || m.id OR (s.key > 'map:' || m.id || ':' AND s.key < 'map:' || m.id || ';')`).bind(...args);
}

// 比赛已结束但最后一张图比分迟迟不来时，最多等这么久再发结束消息
const MAP_WAIT = 20 * 60;

// 第一次发现「已结束但缺比分」时记下时间（借用去重表），之后对比是否等够了
async function waitedTooLong(db, id, t) {
  const key = `endwait:${id}`;
  await db.prepare('INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)').bind(key, t).run();
  const r = await db.prepare('SELECT at FROM sent WHERE key = ?').bind(key).first();
  return !r || t - r.at >= MAP_WAIT;
}

// 一张图开打后（第一次看到它「进行中」的时间记在地图数据的 t 上）MAP_QUIET 内不问 bo3：
// 只报到地图级比分，一张图再快也要二十多分钟，这段时间问了也不会有变化
const MAP_QUIET = 20 * 60;
const quiet = (m, t) => m.status === 'current' && (m.maps || []).some((g) => g.status === 'current' && g.t && t - g.t < MAP_QUIET);

// results：liveRowsStmt 查出来的比赛（按 id 一次向 bo3 查完，不多花请求）；
// claimed：这些比赛已经领过的去重键（lightTick 一起查好），不传就全部重新领
export async function liveTick(ctx, minute, results, claimed = null) {
  const db = ctx.env.DB;
  const t = now();
  const olds = results.map(parseMatchRow).filter((m) => !quiet(m, t));
  if (!olds.length) return 0;

  const fresh = new Map((await liveByIds(ctx, olds)).map((m) => [m.id, m]));
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
      f.status = 'current'; // 库里保持进行中，下一次继续轮询
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

  // 所有比赛还没领过的去重键一次领完；都领过了（比分没变）就不跑这一次 D1
  const got = await claim(db, plans.flatMap((p) => p.keys).filter((k) => !claimed?.has(k)));
  const to = plans.length ? await toOf(ctx) : [];
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
    if (opening) items.push(...fanout(to, 'live_open', liveCard(m, m.maps, false, ctx.tz), m.id));
    // 结束时直播卡片会被删掉（结束消息里有全部信息），不用再编辑
    else if (changed && !ending) items.push(...fanout(to, 'live_edit', liveCard(m, m.maps, done, ctx.tz), m.id));
    if (ending) items.push(...fanout(to, 'send', endMsg(m), m.id, 'end'));
    if (matchChanged(old, m)) stmts.push(upsertMatchStmt(db, m));
  }

  await enqueue(db, items, stmts); // 比赛状态和消息一次提交
  return items.length;
}

// ---------- 赛后数据 ----------
// bo3 解析完 demo（通常赛后一到几小时）才有每名选手的数据。拿到后：存进库（网页赛果详情用），
// 并把已经发出的结束消息编辑成带记分板的版本；顺便用最新的地图数据补全赛后才填上的比分。
// 不再每 10 分钟问一次：只在比赛结束后 1、2、4、8 小时各问一次（结束时间取发结束消息的时间，
// 没有就按开赛后 3 小时算），8 小时后还没有就不再等
const STATS_AT = [1, 2, 4, 8].map((h) => h * 3600);
const STATS_WINDOW = 12 * 60;   // 这一格每 8–12 分钟轮到一次：落在检查点之后这段时间里就查
const STATS_GIVEUP = STATS_AT[STATS_AT.length - 1] + STATS_WINDOW;
const STATS_PER_TICK = 3;

export async function statsTick(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const { results } = await db.prepare(
    `SELECT m.*, COALESCE(s.at, m.start_ts + 3 * 3600) AS ended FROM matches m LEFT JOIN sent s ON s.key = 'end:' || m.id
     WHERE m.status = 'finished' AND m.stats IS NULL AND m.start_ts > ?`,
  ).bind(t - 3 * 86400).all();
  if (!results.length) return 0;
  const due = [], giveUp = [];
  for (const r of results) {
    const el = t - r.ended;
    if (el >= STATS_GIVEUP) giveUp.push(Number(r.id));
    else if (STATS_AT.some((c) => el >= c && el < c + STATS_WINDOW)) due.push(r);
  }
  const giveUpStmt = giveUp.length ? [db.prepare(`UPDATE matches SET stats = '[]' WHERE id IN (${giveUp.join(',')})`)] : [];
  if (!due.length) {
    if (giveUpStmt.length) await db.batch(giveUpStmt);
    return 0;
  }

  const olds = due.slice(0, 10).map(parseMatchRow);
  const fresh = new Map((await liveByIds(ctx, olds)).map((m) => [m.id, m]));
  const stmts = [...giveUpStmt];
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
        to ??= await toOf(ctx);
        items.push(...fanout(to, 'end_edit', endMsg(m), m.id));
        continue;
      }
    }
  }
  await enqueue(db, items, stmts);
  return fetched;
}

// ---------- 赛事列表（每 6 小时） ----------
// 每 10 分钟看一眼缓存时间，过期才请求 bo3（一天 4 次）。时间单独存一个键（events_at），
// 不用为了看时间把整份赛事列表读出来解析
const EVENTS_TTL = 6 * 3600;
export async function eventsTick(ctx, force = false) {
  const db = ctx.env.DB;
  const t = now();
  if (!force && t - (Number(await getKV(db, 'events_at')) || 0) < EVENTS_TTL) return null;
  const list = await eventList(ctx);
  await db.batch([setKVStmt(db, 'events', JSON.stringify({ at: t, list })), setKVStmt(db, 'events_at', t)]);
  return list.length;
}

// ---------- 短时消息到期删除（每 2 分钟） ----------
// 「地图 X 结束」只是提醒：比分已经同步到直播卡片上，发出 5 分钟后删掉。
// Telegram 没有给单条消息设定时删除的接口（聊天级的自动删除最短 1 天，而且只能用户自己开），所以由 cron 来删。
// results：到期的消息（lightTick 一起查好）
export async function expireTick(ctx, results) {
  const db = ctx.env.DB;
  if (!results.length) return;
  const byChat = new Map();
  for (const r of results) {
    if (!byChat.has(r.chat_id)) byChat.set(r.chat_id, []);
    byChat.get(r.chat_id).push(r.message_id);
  }
  const gone = [];
  for (const [chat_id, ids] of byChat) {
    if (ctx.left() <= 0) break; // 预算用完了，下一次接着删
    const res = await tg(ctx, 'deleteMessages', { chat_id, message_ids: ids.slice(0, 100) });
    if (res.ok || res.error_code === 400 || res.error_code === 403) gone.push(...ids.slice(0, 100).map((id) => `(${Number(chat_id)},${Number(id)})`));
  }
  if (gone.length) await db.prepare(`DELETE FROM tg_msgs WHERE (chat_id, message_id) IN (VALUES ${gone.join(',')})`).run();
}

// ---------- 斗鱼 ----------

// all：全部房间（lightTick 一起查好）。每 10 分钟一次；房间多于 12 个时分组轮转
export async function douyuTick(ctx, minute, all) {
  const db = ctx.env.DB;
  const t = now();
  if (!all.length) return 0;

  let rooms = all;
  if (all.length > MAX_ROOMS_PER_TICK) {
    const groups = Math.ceil(all.length / MAX_ROOMS_PER_TICK);
    const turn = Math.floor(minute / DOUYU_EVERY);
    rooms = all.filter((_, i) => i % groups === turn % groups);
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
      // 下播后 20 分钟内又开播（断流重连；每 10 分钟查一次，也就是只有一次看到下播）不算新开播
      const flap = info.live && r.changed_at && t - r.changed_at < 2 * DOUYU_EVERY * 60;
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

  const to = went.length ? await toOf(ctx) : [];
  const items = went.flatMap((s) => fanout(to, 'send', streamerLiveMsg(s)));
  await enqueue(db, items, stmts); // 房间状态和开播提醒一次提交
  return items.length;
}
