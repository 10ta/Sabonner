// 日历订阅（src/ics.js）的测试。在 worker/ 目录运行：npm test（即 node --test）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { icsBody, icsFold, icsEscape, icsSummary, icsTime, icsStmts, icsFrom } from '../src/ics.js';

const bytes = (s) => Buffer.byteLength(s, 'utf8');
// 折行的逆操作：去掉「CRLF + 一个空格」
const unfold = (s) => s.replace(/\r\n /g, '');
const base = {
  id: 101, slug: 'vitality-vs-faze-14-11-2026', team1: 'Vitality', team2: 'FaZe', team1_id: 1, team2_id: 2,
  tournament: 'ESL Pro League Season 24', stage: 'decider / 3rd place', tier: 's', stars: 4, bo: 3,
  start_ts: Date.UTC(2026, 10, 14, 17, 0, 0) / 1000, status: 'upcoming', s1: 0, s2: 0, maps: null, event_type: 'lan', updated_at: 1794000000,
};
const URL_LINE = 'https://bo3.gg/matches/vitality-vs-faze-14-11-2026';
// 取某个属性的值（先还原折行）
const prop = (body, name) => unfold(body).split('\r\n').filter((l) => l.startsWith(`${name}:`)).map((l) => l.slice(name.length + 1));

test('行尾都是 CRLF，没有单独的 LF', () => {
  const body = icsBody([base]);
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(body.endsWith('END:VCALENDAR\r\n'));
  const rest = body.replace(/\r\n/g, '');
  assert.equal(rest.includes('\n'), false);
  assert.equal(rest.includes('\r'), false);
});

test('日历头和事件的固定字段', () => {
  const body = icsBody([base]);
  for (const l of ['X-WR-CALNAME:Sabonner', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M']) assert.ok(body.includes(`${l}\r\n`), l);
  assert.deepEqual(prop(body, 'UID'), ['match-101@sabonner']);
  assert.deepEqual(prop(body, 'DTSTART'), ['20261114T170000Z']);
  assert.deepEqual(prop(body, 'DTEND'), ['20261114T193000Z']);   // bo3 加 2.5 小时
  assert.deepEqual(prop(body, 'URL'), [URL_LINE]);
  assert.deepEqual(prop(body, 'SEQUENCE'), ['1794000000']);
  assert.deepEqual(prop(body, 'DTSTAMP'), [icsTime(1794000000)]);
  assert.deepEqual(prop(body, 'LAST-MODIFIED'), [icsTime(1794000000)]);
  assert.equal(body.includes('VALARM'), false);
});

test('时长按赛制估算', () => {
  const end = (bo) => prop(icsBody([{ ...base, bo }]), 'DTEND')[0];
  assert.equal(end(1), '20261114T180000Z');
  assert.equal(end(3), '20261114T193000Z');
  assert.equal(end(5), '20261114T210000Z');
});

test('按字节折行：每行不超过 75 字节，不拆开多字节字符，还原后内容不变', () => {
  const m = {
    ...base, team1: '天禄电子竞技俱乐部一队', team2: '⭐🔥狼队电竞🇨🇳 Wolves Esports Academy', status: 'finished', s1: 2, s2: 1,
    tournament: '完美世界亚洲区 RMR 预选赛第二阶段小组赛与淘汰赛', stage: '决赛 / 季军赛',
    maps: JSON.stringify([
      { n: 1, map: 'mirage', status: 'finished', sc1: 13, sc2: 8, side: 1 },
      { n: 2, map: 'inferno', status: 'finished', sc1: 9, sc2: 13, side: 2 },
      { n: 3, map: 'nuke', status: 'finished', sc1: 16, sc2: 14, side: 1 },
    ]),
  };
  const body = icsBody([m]);
  const lines = body.split('\r\n');
  assert.ok(lines.some((l) => l.startsWith(' ')), '应该有续行');
  for (const l of lines) {
    assert.ok(bytes(l) <= 75, `${bytes(l)} 字节：${l}`);
    // 每一行单独都是完整的文本：没有落单的代理项（emoji 没被拆开）
    assert.equal(l.isWellFormed(), true, l);
  }
  assert.deepEqual(prop(body, 'SUMMARY'), ['天禄电子竞技俱乐部一队 2:1 ⭐🔥狼队电竞🇨🇳 Wolves Esports Academy']);

  // 边界：正好 75 字节不折
  assert.equal(icsFold('A'.repeat(75)), 'A'.repeat(75));
  assert.equal(icsFold('A'.repeat(76)), `${'A'.repeat(75)}\r\n A`);
  assert.equal(icsFold(`${'A'.repeat(74)}中`), `${'A'.repeat(74)}\r\n 中`);
  const long = '🔴'.repeat(60);
  assert.equal(unfold(icsFold(long)), long);
  for (const l of icsFold(long).split('\r\n')) assert.ok(bytes(l) <= 75);
});

test('转义：反斜杠、分号、逗号、换行', () => {
  const BS = String.fromCharCode(92);   // 一个反斜杠
  assert.equal(icsEscape(`a${BS}b;c,d\ne\r\nf`), `a${BS}${BS}b${BS};c${BS},d${BS}ne${BS}nf`);
  const body = icsBody([{ ...base, team1: 'A;B', team2: `C,D${BS}E`, tournament: 'Cup, Season 1; Finals' }]);
  assert.deepEqual(prop(body, 'SUMMARY'), [`A${BS};B vs C${BS},D${BS}${BS}E`]);
  const desc = prop(body, 'DESCRIPTION')[0];
  assert.ok(desc.startsWith(`Cup${BS}, Season 1${BS}; Finals${BS}n`), desc);
  assert.ok(desc.endsWith(`${BS}n${BS}n${URL_LINE}`), desc);
});

test('同样的输入两次输出完全相同', () => {
  const list = [base, {
    ...base, id: 102, status: 'current', s1: 1,
    maps: '[{"n":1,"map":"mirage","status":"finished","sc1":13,"sc2":8,"side":1},{"n":2,"map":"nuke","status":"current"}]',
  }];
  assert.equal(icsBody(list, new Set([1])), icsBody(JSON.parse(JSON.stringify(list)), new Set([1])));
});

test('三种状态的 SUMMARY', () => {
  const stars = new Set([1]);
  assert.equal(icsSummary(base, stars), '⭐Vitality vs FaZe');
  assert.equal(icsSummary(base, new Set([2])), 'Vitality vs ⭐FaZe');
  assert.equal(icsSummary(base, null), 'Vitality vs FaZe');
  assert.equal(icsSummary({ ...base, status: 'current', s1: 1, s2: 0 }, stars), '🔴 Vitality 1:0 FaZe');
  assert.equal(icsSummary({ ...base, status: 'finished', s1: 2, s2: 1 }, stars), 'Vitality 2:1 FaZe');
  assert.equal(icsSummary({ ...base, team2: null, team2_id: null }, stars), '⭐Vitality vs TBD');
});

test('DESCRIPTION：赛事、赛段、tier / 星级 / LAN、每张图的比分、链接', () => {
  const lines = (m) => prop(icsBody([m]), 'DESCRIPTION')[0].split(`${String.fromCharCode(92)}n`);
  assert.deepEqual(lines(base), ['ESL Pro League Season 24', 'decider / 3rd place', 'Tier S · ★★★★ · LAN · BO3', '', URL_LINE]);
  const live = lines({
    ...base, status: 'current', s1: 1, event_type: 'online',
    maps: [{ n: 1, map: 'mirage', status: 'finished', sc1: 13, sc2: 8, side: 1 }, { n: 2, map: 'nuke', status: 'current' }, { n: 3, map: null, status: 'upcoming' }],
  });
  assert.deepEqual(live, ['ESL Pro League Season 24', 'decider / 3rd place', 'Tier S · ★★★★ · ONLINE · BO3', '', '① Mirage 13:8 ✓ Vitality', '② Nuke 进行中', '', URL_LINE]);
});

test('两队都未定的比赛不出现；只定了一队的出现', () => {
  const body = icsBody([
    { ...base, id: 1, team1: 'TBD', team2: 'TBD', team1_id: null, team2_id: null },
    { ...base, id: 2, team2: 'TBD', team2_id: null },
    base,
  ]);
  assert.deepEqual(prop(body, 'UID'), ['match-2@sabonner', 'match-101@sabonner']);
  assert.equal(icsBody([]), icsBody(null));
  assert.equal(icsBody([]).includes('BEGIN:VEVENT'), false);
});

test('查询：排除两队都未定的、不取 stats 列；icsFrom 带上订阅队伍', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of fs.readdirSync(dir).sort()) sql.exec(fs.readFileSync(new URL(f, dir), 'utf8'));
  const ins = sql.prepare(`INSERT INTO matches (id, slug, team1, team2, team1_id, team2_id, tournament, tier, bo, start_ts, status, s1, s2, stats, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`);
  ins.run(3, 'c', 'Spirit', 'TBD', 7, null, 'Major', 's', 3, 300, 'upcoming', null, 1);
  ins.run(1, 'a', 'TBD', 'TBD', null, null, 'Major', 's', 3, 100, 'upcoming', null, 1);
  ins.run(2, 'b', 'NAVI', 'G2', 5, 6, 'Major', 's', 1, 200, 'finished', '[{"big":1}]', 1);
  sql.prepare("INSERT INTO sub_teams (team_id, name) VALUES (7, 'Spirit')").run();
  const db = { prepare: (q) => ({ all: () => ({ results: sql.prepare(q).all() }) }) };
  const res = icsStmts(db).map((s) => s.all());
  assert.deepEqual(res[0].results.map((r) => r.id), [2, 3]);   // 按开赛时间
  assert.equal('stats' in res[0].results[0], false);
  assert.deepEqual(prop(icsFrom(res), 'SUMMARY'), ['NAVI 0:0 G2', '⭐Spirit vs TBD']);
});
