// D1 读写

import { now } from './util.js';

export async function getKV(db, k) {
  const r = await db.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return r ? r.v : null;
}

export function setKVStmt(db, k, v) {
  return db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v));
}

// 事件去重：第一次返回 true，之后都返回 false
export async function markOnce(db, key) {
  const r = await db.prepare('INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)').bind(key, now()).run();
  return r.meta.changes > 0;
}

// 接收推送的人：owner + 已批准用户
export async function recipients(env) {
  const { results } = await env.DB.prepare("SELECT tg_id FROM users WHERE status = 'approved'").all();
  const ids = new Set(results.map((r) => Number(r.tg_id)));
  if (env.OWNER_ID) ids.add(Number(env.OWNER_ID));
  return [...ids];
}

export async function getSubs(db) {
  const [tiers, teams] = await db.batch([
    db.prepare('SELECT tier FROM sub_tiers ORDER BY tier'),
    db.prepare('SELECT team_id, name, slug FROM sub_teams ORDER BY name COLLATE NOCASE'),
  ]);
  return {
    tiers: tiers.results.map((r) => r.tier),
    teams: teams.results,
  };
}

export async function getStreamers(db) {
  const { results } = await db.prepare('SELECT * FROM streamers ORDER BY live DESC, room_id').all();
  return results;
}

export async function getMatch(db, id) {
  return db.prepare('SELECT * FROM matches WHERE id = ?').bind(id).first();
}

// scope: upcoming / live / results
export async function listMatches(db, scope, limit = 30) {
  const t = now();
  let sql;
  if (scope === 'live') {
    sql = "SELECT * FROM matches WHERE status = 'current' ORDER BY start_ts";
  } else if (scope === 'results') {
    sql = `SELECT * FROM matches WHERE status = 'finished' AND start_ts > ${t - 7 * 86400} ORDER BY start_ts DESC LIMIT ${limit}`;
  } else {
    sql = `SELECT * FROM matches WHERE status = 'upcoming' AND start_ts > ${t - 3600} ORDER BY start_ts LIMIT ${limit}`;
  }
  const { results } = await db.prepare(sql).all();
  return results.map(parseMatchRow);
}

export function parseMatchRow(r) {
  if (!r) return r;
  let maps = [];
  try { maps = r.maps ? JSON.parse(r.maps) : []; } catch { /* 坏数据当空 */ }
  return { ...r, maps };
}

// insertOnly：只插入新比赛，不覆盖已有行。赛程刷新遇到进行中的比赛时用——
// 比分变化交给直播轮询自己对比，否则刷新会抢先把新比分写进去，轮询就看不到变化了
const UPSERT_UPDATE = `ON CONFLICT(id) DO UPDATE SET
  slug = excluded.slug, team1_id = excluded.team1_id, team2_id = excluded.team2_id,
  team1 = excluded.team1, team2 = excluded.team2, tournament = excluded.tournament,
  tier = excluded.tier, bo = excluded.bo, start_ts = excluded.start_ts,
  status = excluded.status, s1 = excluded.s1, s2 = excluded.s2, winner_id = excluded.winner_id,
  maps = COALESCE(excluded.maps, matches.maps), updated_at = excluded.updated_at`;

export function upsertMatchStmt(db, m, insertOnly = false) {
  return db.prepare(`
    INSERT INTO matches (id, slug, team1_id, team2_id, team1, team2, tournament, tier, bo, start_ts, status, s1, s2, winner_id, maps, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    ${insertOnly ? 'ON CONFLICT(id) DO NOTHING' : UPSERT_UPDATE}
  `).bind(
    m.id, m.slug, m.team1_id, m.team2_id, m.team1, m.team2, m.tournament, m.tier, m.bo,
    m.start_ts, m.status, m.s1, m.s2, m.winner_id ?? null,
    m.maps ? JSON.stringify(m.maps) : null, now(),
  );
}

// 清理：7 天前的比赛、30 天前的去重记录、和已结束比赛关联的可编辑消息
export async function cleanup(db) {
  const t = now();
  await db.batch([
    db.prepare('DELETE FROM matches WHERE start_ts < ?').bind(t - 7 * 86400),
    db.prepare('DELETE FROM sent WHERE at < ?').bind(t - 30 * 86400),
    db.prepare(`DELETE FROM live_msgs WHERE match_id NOT IN (SELECT id FROM matches)
      OR match_id IN (SELECT id FROM matches WHERE status != 'current' AND updated_at < ?)`).bind(t - 3600),
    db.prepare('DELETE FROM outbox WHERE tries >= 5 OR created_at < ?').bind(t - 6 * 3600),
  ]);
}
