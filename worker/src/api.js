// 给网页用的只读 API（任何人可读，第二期再加需要 ADMIN_TOKEN 的写接口）

import { json, now } from './util.js';
import { getSubs, getStreamers, listMatches, getKV } from './db.js';
import { matchUrl } from './bo3.js';

const pubMatch = (m) => ({
  id: m.id, url: matchUrl(m), team1: m.team1, team2: m.team2, tournament: m.tournament,
  tier: m.tier, bo: m.bo, start: m.start_ts, status: m.status, s1: m.s1, s2: m.s2,
  winner_id: m.winner_id, team1_id: m.team1_id, team2_id: m.team2_id, maps: m.maps,
});

export async function handleApi(req, env, path) {
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
      listMatches(db, 'upcoming', 30), listMatches(db, 'live'), listMatches(db, 'results', 20),
      getSubs(db), getStreamers(db), getKV(db, 'last_refresh'),
    ]);
    return json({
      now: now(),
      last_refresh: Number(last) || null,
      upcoming: upcoming.map(pubMatch),
      live: live.map(pubMatch),
      results: results.map(pubMatch),
      subs: { tiers: subs.tiers, teams: subs.teams.map((t) => ({ id: t.team_id, name: t.name })) },
      rooms: rooms.map((r) => ({ room_id: r.room_id, owner: r.owner, title: r.title, live: !!r.live, changed_at: r.changed_at })),
    }, 200, cache);
  }
  return json({ error: 'not found' }, 404);
}
