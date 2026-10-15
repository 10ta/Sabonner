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
  const [tiers, teams, stars] = await db.batch([
    db.prepare('SELECT tier FROM sub_tiers ORDER BY tier'),
    db.prepare('SELECT team_id, name, slug, cc, logo FROM sub_teams ORDER BY name COLLATE NOCASE'),
    db.prepare("SELECT v FROM kv WHERE k = 'sub_stars'"),
  ]);
  return {
    tiers: tiers.results.map((r) => r.tier),
    teams: teams.results,
    stars: Number(stars.results[0]?.v) || 0, // 星级 ≥ 这个数的比赛都订阅；0 表示不按星级订阅
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
const COLS = ['id', 'slug', 'team1_id', 'team2_id', 'team1', 'team2', 'team1_cc', 'team2_cc', 'team1_logo', 'team2_logo',
  'team1_rank', 'team2_rank', 'tournament', 'tournament_slug', 'tournament_hltv', 'prize', 'event_type', 'stage', 'tier', 'stars',
  'bo', 'start_ts', 'status', 's1', 's2', 'winner_id', 'ai_winner_id', 'ai_s1', 'ai_s2', 'maps', 'updated_at'];
// maps 为空时保留旧值；其余字段以新数据为准
// 这些字段拿不到时（如赛事接口偶尔失败）保留旧值，不用 null 覆盖
const KEEP_OLD = new Set(['maps', 'event_type', 'tournament_hltv', 'prize']);
const UPSERT_UPDATE = `ON CONFLICT(id) DO UPDATE SET ${COLS.filter((c) => c !== 'id').map((c) =>
  (KEEP_OLD.has(c) ? `${c} = COALESCE(excluded.${c}, matches.${c})` : `${c} = excluded.${c}`)).join(', ')}`;
const UPSERT_SQL = `INSERT INTO matches (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `?${i + 1}`).join(', ')})`;

// 和库里那行比，有没有需要写回的变化（D1 免费版每天只有 10 万行写入额度，而且索引也算写入）
const CMP = COLS.filter((c) => c !== 'id' && c !== 'maps' && c !== 'updated_at');
export function matchChanged(old, m) {
  if (!old) return true;
  for (const c of CMP) {
    if (KEEP_OLD.has(c) && m[c] == null) continue; // 新值缺失不算变化
    if ((old[c] ?? null) !== (m[c] ?? null)) return true;
  }
  if (m.maps !== undefined) {
    const oldMaps = typeof old.maps === 'string' ? old.maps : JSON.stringify(old.maps ?? []);
    if (oldMaps !== JSON.stringify(m.maps ?? [])) return true;
  }
  return false;
}

export function upsertMatchStmt(db, m, insertOnly = false) {
  const row = { ...m, maps: m.maps ? JSON.stringify(m.maps) : null, updated_at: now(), winner_id: m.winner_id ?? null };
  return db.prepare(`${UPSERT_SQL} ${insertOnly ? 'ON CONFLICT(id) DO NOTHING' : UPSERT_UPDATE}`)
    .bind(...COLS.map((c) => row[c] ?? null));
}

// 清理（每小时）：
//   比赛：开赛超过 7 天的删掉；另外最多保留 MAX_MATCHES 行（按开赛时间留最新的），防止订阅范围太大时无限增长
//   去重记录 30 天、发件队列 6 小时、没人引用的赛事缓存 30 天、消息记录 48 小时
const MAX_MATCHES = 3000;
export async function cleanup(db) {
  const t = now();
  await db.batch([
    db.prepare('DELETE FROM matches WHERE start_ts < ?').bind(t - 7 * 86400),
    db.prepare(`DELETE FROM matches WHERE id IN (SELECT id FROM matches ORDER BY start_ts DESC LIMIT -1 OFFSET ${MAX_MATCHES})`),
    db.prepare('DELETE FROM tournaments WHERE updated_at < ?').bind(t - 30 * 86400),
    db.prepare('DELETE FROM sent WHERE at < ?').bind(t - 30 * 86400),
    db.prepare('DELETE FROM tg_msgs WHERE sent_at < ?').bind(t - 48 * 3600), // 超过 48 小时 Telegram 不让删了
    db.prepare(`DELETE FROM live_msgs WHERE match_id NOT IN (SELECT id FROM matches)
      OR match_id IN (SELECT id FROM matches WHERE status != 'current' AND updated_at < ?)`).bind(t - 3600),
    db.prepare('DELETE FROM outbox WHERE tries >= 5 OR created_at < ?').bind(t - 6 * 3600),
  ]);
}
