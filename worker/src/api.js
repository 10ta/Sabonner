// 网页用的接口
//   GET  /api/overview                公开：赛程 / 进行中 / 赛果 / 订阅 / 主播
//   GET  /api/matches?scope=...       公开
//   /api/admin/*                      需要 Authorization: Bearer <ADMIN_TOKEN>
//     GET    me                       校验密码
//     GET    teams/search?q=          搜索队伍
//     POST   teams        {id}        订阅队伍
//     DELETE teams/:id                退订
//     PUT    tiers        {tiers}     设置 tier 订阅
//     PUT    stars        {stars}     星级订阅（≥ 几星，0 关闭）
//     POST   rooms        {room}      添加斗鱼房间
//     DELETE rooms/:id                删除
//     GET    users                    用户列表
//     POST   users/:id/approve|revoke 批准 / 撤销
//     POST   refresh                  立即刷新赛程

import { json, now, safeEqual, CORS } from './util.js';
import { getSubs, matchesStmt, subsStmts, subsFrom, eventsStmts, pickEvents } from './db.js';
import { matchUrl, stagesUrl, searchTeams, teamById } from './bo3.js';
import { roomInfo } from './douyu.js';
import { refreshSchedule, eventsTick } from './engine.js';
import { addTeam, addRoom } from './bot.js';
import { sendMessage } from './tgapi.js';

const TIERS = ['s', 'a', 'b', 'c'];

// ---------- 响应里的 maps / stats 原样拼进去 ----------
// 这两列在库里本来就是 JSON 字符串（我们自己 JSON.stringify 写进去的）。以前先 JSON.parse 再随整个响应
// JSON.stringify 一遍，是这个接口最耗 CPU 的部分（赛果的记分板最大）；现在先放一个占位符，序列化后再把原文换进去
const RAW = '\u0001R';
const rawJsonArray = (v) => (typeof v === 'string' && v.startsWith('[') && v.endsWith(']') ? v : null);
function withRaw(data, raws) {
  return JSON.stringify(data).replace(/"\\u0001R(\d+)"/g, (_, i) => raws[Number(i)]);
}

// r：matches 表里的一行（没解析过）；raws：收集原文的数组
const pubMatch = (r, raws) => {
  const raw = (v) => { raws.push(v); return `${RAW}${raws.length - 1}`; };
  const maps = rawJsonArray(r.maps) ?? '[]';
  const stats = r.status === 'finished' ? rawJsonArray(r.stats) : null; // 赛后记分板；null 表示还没出
  return {
    id: r.id, url: matchUrl(r), stage_url: stagesUrl(r),
    team1: r.team1, team2: r.team2, team1_id: r.team1_id, team2_id: r.team2_id,
    team1_cc: r.team1_cc, team2_cc: r.team2_cc, team1_logo: r.team1_logo, team2_logo: r.team2_logo,
    team1_rank: r.team1_rank, team2_rank: r.team2_rank,
    tournament: r.tournament, tournament_hltv: r.tournament_hltv, prize: r.prize, event_type: r.event_type,
    stage: r.stage, tier: r.tier, stars: r.stars, bo: r.bo, start: r.start_ts,
    status: r.status, s1: r.s1, s2: r.s2, winner_id: r.winner_id, maps: raw(maps),
    ai: r.ai_winner_id ? { winner_id: r.ai_winner_id, s1: r.ai_s1, s2: r.ai_s2 } : null,
    stats: stats ? raw(stats) : null,
  };
};

// ---------- 公开接口的短时缓存 ----------
// 网页每 30 秒（有比赛时）/ 2 分钟拉一次，多人同时看时内容都一样。缓存在 Worker 实例的内存里 20 秒
// （workers.dev 域名上 Cache API 不起作用，内存缓存哪里都能用）；管理操作成功后清掉，改完立即能看到
const PUBLIC_TTL = 20_000;
const memo = new Map(); // key -> { at, body }
export const clearPublicCache = () => memo.clear();
function cached(key, build) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < PUBLIC_TTL) return hit.body;
  return build().then((body) => { memo.set(key, { at: Date.now(), body }); return body; });
}
const rawResponse = (body) => new Response(body, {
  headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, 'cache-control': 'public, max-age=20, stale-while-revalidate=60' },
});

const pubSubs = (s) => ({
  tiers: s.tiers,
  stars: s.stars,
  teams: s.teams.map((t) => ({ id: t.team_id, name: t.name, cc: t.cc, logo: t.logo })),
});

export async function handleApi(req, env, path, ctx) {
  if (path.startsWith('/api/admin/')) {
    const res = await handleAdmin(req, env, path.slice('/api/admin/'.length), ctx);
    // 写操作成功后：删掉运行器生成的概览、清内存缓存（handleAdmin 开头也清过一次，这里防止中途又被旧数据填上）
    if (req.method !== 'GET' && res.ok) {
      clearPublicCache();
      await dropSnapshot(env.DB).catch((e) => console.error('[api] drop snapshot', e?.message || e));
    }
    return res;
  }

  const db = env.DB;

  if (path === '/api/matches') {
    const scope = new URL(req.url).searchParams.get('scope') || 'upcoming';
    if (!['upcoming', 'live', 'results'].includes(scope)) return json({ error: 'bad scope' }, 400);
    return rawResponse(await cached(`matches:${scope}`, async () => {
      const { results } = await matchesStmt(db, scope, 50).all();
      const raws = [];
      return withRaw({ scope, now: now(), matches: results.map((r) => pubMatch(r, raws)) }, raws);
    }));
  }
  if (path === '/api/overview') {
    return rawResponse(await cached('overview', async () => withNow(await readSnapshot(db) ?? await buildOverview(db, env))));
  }
  return json({ error: 'not found' }, 404);
}

// ---------- 概览 ----------
// 内容（不含 now）由 overviewStmts 的查询结果拼成。两种来源：
//   运行器（VPS）每轮直播轮询后生成一份，内容变了才写进 kv 'snap_overview'。Worker 读到就原样返回，只多拼一个 now：
//     一行字符串，没有逐行组装和序列化，刷新页面时 Worker 几乎不用 CPU
//   没有运行器（Worker 自己跑 cron 的部署方式）、运行器停了（心跳超过 15 分钟）、或刚改完订阅：Worker 现场生成（以前的做法）
export const SNAP_KEY = 'snap_overview';
const SNAP_STALE = 15 * 60;   // 和 watch.js 的心跳超时一致

export const overviewStmts = (db) => [
  matchesStmt(db, 'upcoming', 40), matchesStmt(db, 'live'), matchesStmt(db, 'results', 30),
  db.prepare('SELECT * FROM streamers ORDER BY live DESC, room_id'),
  db.prepare("SELECT v FROM kv WHERE k = 'last_refresh'"),
  ...subsStmts(db),
  ...eventsStmts(db),
];

// res：overviewStmts 那一批查询的结果。返回 JSON 字符串（不含 now）
export function overviewBody(res, env) {
  const raws = [];
  const [upcoming, live, results] = res.slice(0, 3).map((r) => r.results.map((m) => pubMatch(m, raws)));
  const rooms = res[3].results;
  const last = res[4].results[0]?.v;
  const subs = subsFrom(res.slice(5, 8));
  const events = pickEvents(res.slice(8, 10), subs);
  return withRaw({
    tz: env.TZ || 'Asia/Shanghai',
    last_refresh: Number(last) || null,
    upcoming, live, results,
    subs: pubSubs(subs),
    events: events.map((e) => ({ ...e, url: `https://bo3.gg/tournaments/${e.slug}` })),
    rooms: rooms.map((r) => ({
      room_id: r.room_id, owner: r.owner, title: r.title, category: r.category, avatar: r.avatar,
      live: !!r.live, changed_at: r.changed_at, show_time: r.show_time,
    })),
  }, raws);
}

// 一次 batch 发完所有查询（以前是 6 次 D1 往返）
export async function buildOverview(db, env) {
  return overviewBody(await db.batch(overviewStmts(db)), env);
}

const withNow = (body) => `{"now":${now()},${body.slice(1)}`;

// 运行器生成的那份；运行器心跳过期或没有时返回 null
async function readSnapshot(db) {
  const { results } = await db.prepare('SELECT k, v FROM kv WHERE k IN (?, ?)').bind(SNAP_KEY, 'runner').all();
  const snap = results.find((r) => r.k === SNAP_KEY)?.v;
  const hb = results.find((r) => r.k === 'runner')?.v;
  if (typeof snap !== 'string' || !snap.startsWith('{"') || !hb) return null;
  const at = Number((hb.match(/"at":(\d+)/) || [])[1]) || 0;   // 心跳是一小段 JSON，取 at 不用整个解析
  return now() - at <= SNAP_STALE ? snap : null;
}

// 改了订阅 / 房间 / 用户：删掉运行器那份，网页立即看到 Worker 现场生成的新数据；运行器下一轮（≤ 1 分钟）发现没了会重新写
const dropSnapshot = (db) => db.prepare('DELETE FROM kv WHERE k = ?').bind(SNAP_KEY).run();

async function handleAdmin(req, env, sub, ctx) {
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(auth, env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
  if (req.method !== 'GET') clearPublicCache(); // 改了订阅 / 房间 / 用户：网页下一次读到的是新数据

  const db = env.DB;
  const method = req.method;
  const body = method === 'POST' || method === 'PUT' ? await req.json().catch(() => ({})) : {};
  const parts = sub.split('/').filter(Boolean);
  const refresh = () => refreshSchedule(ctx).catch((e) => ({ error: String(e?.message || e) }));

  // GET me
  if (parts[0] === 'me' && method === 'GET') return json({ ok: true });

  // 队伍
  if (parts[0] === 'teams') {
    if (parts[1] === 'search' && method === 'GET') {
      const q = (new URL(req.url).searchParams.get('q') || '').trim();
      if (q.length < 2) return json({ teams: [] });
      return json({ teams: await searchTeams(ctx, q, 12) });
    }
    if (!parts[1] && method === 'POST') {
      const team = await teamById(ctx, Number(body.id)).catch(() => null);
      if (!team) return json({ error: '找不到这支队伍' }, 404);
      await addTeam(db, team);
      return json({ ok: true, team, refresh: await refresh(), subs: pubSubs(await getSubs(db)) });
    }
    if (parts[1] && method === 'DELETE') {
      await db.prepare('DELETE FROM sub_teams WHERE team_id = ?').bind(Number(parts[1])).run();
      return json({ ok: true, refresh: await refresh(), subs: pubSubs(await getSubs(db)) });
    }
  }

  // tier
  if (parts[0] === 'tiers' && method === 'PUT') {
    const tiers = [...new Set((body.tiers || []).map(String).filter((t) => TIERS.includes(t)))];
    await db.batch([
      db.prepare('DELETE FROM sub_tiers'),
      ...tiers.map((t) => db.prepare('INSERT INTO sub_tiers (tier) VALUES (?)').bind(t)),
    ]);
    return json({ ok: true, refresh: await refresh(), subs: pubSubs(await getSubs(db)) });
  }

  // 星级
  if (parts[0] === 'stars' && method === 'PUT') {
    const n = Math.max(0, Math.min(5, Number(body.stars) || 0));
    await db.prepare("INSERT INTO kv (k, v) VALUES ('sub_stars', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(n)).run();
    return json({ ok: true, refresh: await refresh(), subs: pubSubs(await getSubs(db)) });
  }

  // 斗鱼
  if (parts[0] === 'rooms') {
    if (!parts[1] && method === 'POST') {
      const id = (String(body.room || '').match(/(\d{2,})/) || [])[1];
      if (!id) return json({ error: '房间号格式不对' }, 400);
      const info = await roomInfo(ctx, id).catch(() => null);
      if (!info?.ok) return json({ error: `房间 ${id} 不存在或无法读取` }, 404);
      await addRoom(db, id, info);
      return json({ ok: true, room: { room_id: id, ...info } });
    }
    if (parts[1] && method === 'DELETE') {
      await db.prepare('DELETE FROM streamers WHERE room_id = ?').bind(parts[1]).run();
      return json({ ok: true });
    }
  }

  // 用户
  if (parts[0] === 'users') {
    if (!parts[1] && method === 'GET') {
      const { results } = await db.prepare(`SELECT tg_id, name, username, status, created_at FROM users ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at`).all();
      return json({ users: results.map((u) => ({ ...u, tg_id: String(u.tg_id) })) });
    }
    if (parts[1] && method === 'POST' && (parts[2] === 'approve' || parts[2] === 'revoke')) {
      const id = Number(parts[1]);
      const u = await db.prepare('SELECT status FROM users WHERE tg_id = ?').bind(id).first();
      if (!u) return json({ error: '用户不存在' }, 404);
      const approve = parts[2] === 'approve';
      await db.batch([
        db.prepare('UPDATE users SET status = ? WHERE tg_id = ?').bind(approve ? 'approved' : 'denied', id),
        ...(approve ? [] : [db.prepare('DELETE FROM outbox WHERE chat_id = ?').bind(id)]), // 撤销后排队的推送也不再发
      ]);
      if (approve && u.status !== 'approved') await sendMessage(ctx, id, '✅ 申请已通过，之后会收到比赛和开播推送。发送 /help 查看命令。').catch(() => null);
      if (!approve && u.status === 'approved') await sendMessage(ctx, id, '你的推送权限已被撤销。').catch(() => null);
      return json({ ok: true });
    }
  }

  if (parts[0] === 'refresh' && method === 'POST') {
    const events = await eventsTick(ctx, true).catch(() => null);
    return json({ ok: true, refresh: await refresh(), events });
  }

  return json({ error: 'not found' }, 404);
}
