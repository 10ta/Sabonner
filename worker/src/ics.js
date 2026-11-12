// 日历订阅（.ics，RFC 5545）：GET /api/calendar.ics 的内容
//
// 纯函数、输出是确定的：同样的比赛数据生成同样的文本（时间戳都取自比赛的 updated_at，不用当前时间），
// 这样运行器才能「内容变了才写」。Worker 和 VPS 运行器共用这一份代码。
//
// 每场比赛一个 VEVENT，UID 固定（match-<id>@sabonner）：改期、开打、出比分后日历应用下一次来拉时原地更新同一个事件。
// 不带 VALARM：Telegram 已经有赛前 30 分钟提醒。

import { matchUrl } from './bo3.js';

export const ICS_KEY = 'snap_ics';
// 最多列这么多场（按开赛时间从早到晚：最近 7 天的 + 接下来最近的）。订阅范围特别大时不让文件无限变大
export const ICS_MAX = 500;

// 只取用得到的列（不取 stats：赛后记分板很大）
const COLS = 'id, slug, team1, team2, team1_id, team2_id, tournament, stage, tier, stars, bo, start_ts, status, s1, s2, maps, event_type, updated_at';
// 表里只有命中订阅的比赛，开赛 7 天后清理掉；两队都未定的不出（和网页一致）
export const icsStmts = (db) => [
  db.prepare(`SELECT ${COLS} FROM matches WHERE team1_id IS NOT NULL OR team2_id IS NOT NULL ORDER BY start_ts, id LIMIT ${ICS_MAX}`),
  db.prepare('SELECT team_id FROM sub_teams'),
];
// res：icsStmts 那两条查询的结果
export const icsFrom = ([matches, teams]) => icsBody(matches.results, new Set(teams.results.map((r) => r.team_id)));

const CRLF = '\r\n';
const DURATION = { 1: 60, 2: 120, 3: 150, 5: 240 }; // 按赛制估算的时长（分钟）
const CIRCLED = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦'];
const EVENT = { lan: 'LAN', online: 'ONLINE' };

const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
// 秒 -> "20261114T170000Z"
export function icsTime(ts) {
  const d = new Date((Number(ts) || 0) * 1000);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

// TEXT 类型的值：\ ; , 和换行要转义；其余控制字符去掉
export const icsEscape = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f]/g, '');

const NON_ASCII = /[^\x00-\x7f]/;
// 一行最多 75 字节（不含行尾），超出的折行，续行以一个空格开头（空格也算在 75 字节里）。
// 按 UTF-8 字节数算，不在一个字符中间断开（队名、emoji 是多字节）
export function icsFold(line) {
  if (line.length <= 25) return line; // 一个 UTF-16 单元最多 3 字节，25 个以内不可能超
  if (line.length <= 75 && !NON_ASCII.test(line)) return line; // 大多数行：纯 ASCII、不超长
  let out = '';
  let start = 0;   // 当前这一段从哪里开始
  let bytes = 0;   // 当前这一段已有多少字节
  let limit = 75;
  for (let i = 0; i < line.length;) {
    const cp = line.codePointAt(i);
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > limit) {
      out += `${line.slice(start, i)}${CRLF} `;
      start = i;
      bytes = 0;
      limit = 74; // 续行开头的空格占 1 字节
    }
    bytes += size;
    i += cp > 0xffff ? 2 : 1;
  }
  return out + line.slice(start);
}

const name = (s) => s || 'TBD';

// 标题：未开赛「⭐Vitality vs FaZe」，进行中「🔴 Vitality 1:0 FaZe」，已结束「Vitality 2:1 FaZe」
export function icsSummary(m, stars) {
  const a = name(m.team1), b = name(m.team2);
  if (m.status === 'current') return `🔴 ${a} ${m.s1 ?? 0}:${m.s2 ?? 0} ${b}`;
  if (m.status === 'finished') return `${a} ${m.s1 ?? 0}:${m.s2 ?? 0} ${b}`;
  const star = (id) => (id && stars?.has(id) ? '⭐' : '');
  return `${star(m.team1_id)}${a} vs ${star(m.team2_id)}${b}`;
}

function parseMaps(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.startsWith('[')) return [];
  try { return JSON.parse(v); } catch { return []; }
}

// 说明：赛事名 / 赛段 / tier · 星级 · LAN|ONLINE · BOn；有比分后每张图一行；最后是 bo3 链接
export function icsDescription(m) {
  const tier = String(m.tier || '').toUpperCase();
  const meta = [tier ? `Tier ${tier}` : '', m.stars > 0 ? '★'.repeat(m.stars) : '', EVENT[m.event_type] || '', m.bo ? `BO${m.bo}` : ''].filter(Boolean).join(' · ');
  const lines = [m.tournament || '', m.stage || '', meta].filter(Boolean);
  const maps = m.status === 'upcoming' ? [] : parseMaps(m.maps).map((g) => {
    const no = CIRCLED[g.n] || `${g.n}.`;
    const map = g.map ? g.map.charAt(0).toUpperCase() + g.map.slice(1) : '待定';
    if (g.status === 'finished' && g.sc1 != null) {
      const winner = g.side === 1 ? m.team1 : g.side === 2 ? m.team2 : g.winner;
      return `${no} ${map} ${g.sc1}:${g.sc2}${winner ? ` ✓ ${winner}` : ''}`;
    }
    return g.status === 'current' ? `${no} ${map} 进行中` : '';
  }).filter(Boolean);
  if (maps.length) lines.push('', ...maps);
  lines.push('', matchUrl(m));
  return lines.join('\n');
}

function vevent(m, stars) {
  const stamp = icsTime(m.updated_at || m.start_ts);
  const end = m.start_ts + (DURATION[m.bo] || 150) * 60;
  return [
    'BEGIN:VEVENT',
    `UID:match-${m.id}@sabonner`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SEQUENCE:${Number(m.updated_at) || 0}`,   // 比赛每次有变化 updated_at 都会变大，日历应用靠它判断事件有更新
    `DTSTART:${icsTime(m.start_ts)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsEscape(icsSummary(m, stars))}`,
    `DESCRIPTION:${icsEscape(icsDescription(m))}`,
    `URL:${matchUrl(m)}`,
    'TRANSP:TRANSPARENT',   // 不占用日程的「忙碌」时间
    'END:VEVENT',
  ];
}

// matches：matches 表里的行（maps 可以是 JSON 字符串或数组）；stars：订阅队伍 id 的 Set（可不传）
export function icsBody(matches, stars = null) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//10ta//Sabonner//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Sabonner',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',   // 只是建议值，多久拉一次由日历应用决定
    'X-PUBLISHED-TTL:PT15M',
  ];
  for (const m of matches || []) {
    if (!m || (!m.team1_id && !m.team2_id) || !m.start_ts) continue; // 两队都未定的不出
    lines.push(...vevent(m, stars));
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join(CRLF) + CRLF;
}
