// GET /api/calendar.ics：有运行器时原样返回它写好的那份，否则 Worker 现场生成。在 worker/ 目录运行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleApi, clearPublicCache } from '../src/api.js';
import { ICS_KEY, icsStmts, icsFrom } from '../src/ics.js';
import { makeCtx, now } from '../src/util.js';
import { calText } from '../src/bot.js';

// 内存 SQLite 冒充 D1（只实现用到的 prepare / bind / all / first / run / batch）
function fakeD1() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of fs.readdirSync(dir).sort()) sql.exec(fs.readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, a = []) => ({
    bind: (...b) => stmt(q, b),
    all: async () => ({ results: sql.prepare(q).all(...a) }),
    first: async () => sql.prepare(q).get(...a) ?? null,
    run: async () => { const r = sql.prepare(q).run(...a); return { meta: { changes: Number(r.changes) } }; },
    _all: () => (/^\s*select/i.test(q) ? { results: sql.prepare(q).all(...a) } : (sql.prepare(q).run(...a), { results: [] })),
  });
  return { sql, prepare: (q) => stmt(q), batch: async (ss) => ss.map((s) => s._all()) };
}

function setup() {
  const db = fakeD1();
  const t = now();
  db.sql.prepare(`INSERT INTO matches (id, slug, team1, team2, team1_id, team2_id, tournament, tier, bo, start_ts, status, s1, s2, updated_at)
    VALUES (1, 'navi-vs-g2', 'NAVI', 'G2', 5, 6, 'Major', 's', 3, ?, 'upcoming', 0, 0, ?)`).run(t + 3600, t);
  db.sql.prepare("INSERT INTO sub_teams (team_id, name) VALUES (5, 'NAVI')").run();
  const env = { DB: db, ADMIN_TOKEN: 'secret' };
  const get = () => handleApi(new Request('https://w.example/api/calendar.ics'), env, '/api/calendar.ics', makeCtx(env));
  const kv = (k, v) => db.sql.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  return { db, env, get, kv, t };
}

test('没有运行器：现场生成，响应头正确', async () => {
  clearPublicCache();
  const { get } = setup();
  const r = await get();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
  const body = await r.text();
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(body.includes('SUMMARY:⭐NAVI vs G2\r\n'));
  assert.ok(body.includes('UID:match-1@sabonner\r\n'));
});

test('运行器在线：原样返回 kv 里的那份；心跳超过 15 分钟后改为现场生成', async () => {
  const { db, get, kv, t } = setup();
  const snap = 'BEGIN:VCALENDAR\r\nX-TEST:from-runner\r\nEND:VCALENDAR\r\n';
  kv(ICS_KEY, snap);
  kv('runner', JSON.stringify({ at: t - 60, host: 'vps' }));
  clearPublicCache();
  assert.equal(await (await get()).text(), snap);

  kv('runner', JSON.stringify({ at: t - 16 * 60, host: 'vps' }));
  clearPublicCache();
  const body = await (await get()).text();
  assert.equal(body, icsFrom(await db.batch(icsStmts(db))));
  assert.ok(body.includes('UID:match-1@sabonner'));
});

test('网页上改订阅后：运行器写的那两份都删掉', async () => {
  const { db, env, kv, t } = setup();
  kv(ICS_KEY, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  kv('snap_overview', '{"tz":"x"}');
  kv('runner', JSON.stringify({ at: t }));
  const req = new Request('https://w.example/api/admin/rooms/123', { method: 'DELETE', headers: { authorization: 'Bearer secret' } });
  const r = await handleApi(req, env, '/api/admin/rooms/123', makeCtx(env));
  assert.equal(r.status, 200);
  assert.deepEqual(db.sql.prepare("SELECT k FROM kv WHERE k LIKE 'snap_%'").all(), []);
});

test('/cal 的文案带订阅地址', () => {
  assert.ok(calText('https://w.example').includes('<code>https://w.example/api/calendar.ics</code>'));
  assert.equal(calText('').includes('calendar.ics'), false);
});
