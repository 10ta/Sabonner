// 网页用的接口
//   GET  /api/overview                公开：赛程 / 进行中 / 赛果 / 订阅 / 主播
//   GET  /api/matches?scope=...       公开
//   /api/admin/*                      需要 Authorization: Bearer <ADMIN_TOKEN>
//     GET    me                       校验密码
//     GET    teams/search?q=          搜索队伍
//     POST   teams        {id}        订阅队伍
//     DELETE teams/:id                退订
//     PUT    tiers        {tiers}     设置 tier 订阅
//     POST   rooms        {room}      添加斗鱼房间
//     DELETE rooms/:id                删除
//     GET    users                    用户列表
//     POST   users/:id/approve|revoke 批准 / 撤销
//     POST   refresh                  立即刷新赛程

import { json, now, safeEqual } from './util.js';
import { getSubs, getStreamers, listMatches, getKV } from './db.js';
import { matchUrl, stagesUrl, searchTeams, teamById } from './bo3.js';
import { roomInfo } from './douyu.js';
import { refreshSchedule } from './engine.js';
import { addTeam } from './bot.js';
import { sendMessage } from './tgapi.js';

const TIERS = ['s', 'a', 'b', 'c'];

const pubMatch = (m) => ({
  id: m.id, url: matchUrl(m), stage_url: stagesUrl(m),
  team1: m.team1, team2: m.team2, team1_id: m.team1_id, team2_id: m.team2_id,
  team1_cc: m.team1_cc, team2_cc: m.team2_cc, team1_logo: m.team1_logo, team2_logo: m.team2_logo,
  tournament: m.tournament, stage: m.stage, tier: m.tier, bo: m.bo, start: m.start_ts,
  status: m.status, s1: m.s1, s2: m.s2, winner_id: m.winner_id, maps: m.maps,
});

const pubSubs = (s) => ({
  tiers: s.tiers,
  teams: s.teams.map((t) => ({ id: t.team_id, name: t.name, cc: t.cc, logo: t.logo })),
});

export async function handleApi(req, env, path, ctx) {
  if (path.startsWith('/api/admin/')) return handleAdmin(req, env, path.slice('/api/admin/'.length), ctx);

  const db = env.DB;
  const cache = { 'cache-control': 'public, max-age=20' };

  if (path === '/api/matches') {
    const scope = new URL(req.url).searchParams.get('scope') || 'upcoming';
    if (!['upcoming', 'live', 'results'].includes(scope)) return json({ error: 'bad scope' }, 400);
    const list = await listMatches(db, scope, 50);
    return json({ scope, now: now(), matches: list.map(pubMatch) }, 200, cache);
  }
  if (path === '/api/overview') {
    const [upcoming, live, results, subs, rooms, last] = await Promise.all([
      listMatches(db, 'upcoming', 40), listMatches(db, 'live'), listMatches(db, 'results', 30),
      getSubs(db), getStreamers(db), getKV(db, 'last_refresh'),
    ]);
    return json({
      now: now(),
      tz: env.TZ || 'Asia/Shanghai',
      last_refresh: Number(last) || null,
      upcoming: upcoming.map(pubMatch),
      live: live.map(pubMatch),
      results: results.map(pubMatch),
      subs: pubSubs(subs),
      rooms: rooms.map((r) => ({ room_id: r.room_id, owner: r.owner, title: r.title, live: !!r.live, changed_at: r.changed_at })),
    }, 200, cache);
  }
  return json({ error: 'not found' }, 404);
}

async function handleAdmin(req, env, sub, ctx) {
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(auth, env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);

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

  // 斗鱼
  if (parts[0] === 'rooms') {
    if (!parts[1] && method === 'POST') {
      const id = (String(body.room || '').match(/(\d{2,})/) || [])[1];
      if (!id) return json({ error: '房间号格式不对' }, 400);
      const info = await roomInfo(ctx, id).catch(() => null);
      if (!info?.ok) return json({ error: `房间 ${id} 不存在或无法读取` }, 404);
      await db.prepare(`INSERT INTO streamers (room_id, owner, title, live, changed_at, added_at) VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT(room_id) DO UPDATE SET owner = excluded.owner, title = excluded.title`)
        .bind(id, info.owner, info.title, info.live ? 1 : 0, now()).run();
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
      await db.prepare('UPDATE users SET status = ? WHERE tg_id = ?').bind(approve ? 'approved' : 'denied', id).run();
      if (approve && u.status !== 'approved') await sendMessage(ctx, id, '✅ 申请已通过，之后会收到比赛和开播推送。发送 /help 查看命令。').catch(() => null);
      if (!approve && u.status === 'approved') await sendMessage(ctx, id, '你的推送权限已被撤销。').catch(() => null);
      return json({ ok: true });
    }
  }

  if (parts[0] === 'refresh' && method === 'POST') return json({ ok: true, refresh: await refresh() });

  return json({ error: 'not found' }, 404);
}
