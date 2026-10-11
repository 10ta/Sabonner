// Telegram 消息文本（HTML parse_mode）

import { esc, fmtTime, fmtDur, tierLabel, now } from './util.js';
import { matchUrl } from './bo3.js';
import { roomUrl } from './douyu.js';

const CIRCLED = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦'];

const head = (m) => `${tierLabel(m.tier)} · ${esc(m.tournament || '未知赛事')}`;
const vs = (m) => `<b>${esc(m.team1)}</b> vs <b>${esc(m.team2)}</b>`;
const link = (m) => `<a href="${matchUrl(m)}">bo3.gg</a>`;

export function mapLine(m, g) {
  const no = CIRCLED[g.n] || `${g.n}.`;
  const name = g.map.charAt(0).toUpperCase() + g.map.slice(1);
  if (g.status === 'finished' && g.sc1 != null) {
    if (g.side === 1 || g.side === 2) {
      const winner = g.side === 1 ? m.team1 : m.team2;
      return `${no} ${esc(name)}  ${g.sc1}:${g.sc2}  ✓${esc(winner)}`;
    }
    return `${no} ${esc(name)}  ${g.sc1}:${g.sc2}（${esc(g.winner || '?')} 胜）`;
  }
  if (g.status === 'current') return `${no} ${esc(name)}  ▶ 进行中`;
  return `${no} ${esc(name)}  —`;
}

export function preMsg(m, tz) {
  const left = m.start_ts - now();
  const when = left <= 45 * 60 ? `⏰ ${fmtDur(left)}后开赛` : `📅 ${fmtDur(left)}后开赛`;
  return [
    `${when}`,
    head(m),
    `${vs(m)} · BO${m.bo}`,
    `${fmtTime(m.start_ts, tz)}  ${link(m)}`,
  ].join('\n');
}

// 直播中的可编辑消息；finished=true 时变成结束版
export function liveCard(m, maps, finished = false) {
  const top = finished ? '🏁 已结束' : '🔴 LIVE';
  const lines = [
    `${top} · ${head(m)}`,
    `<b>${esc(m.team1)}</b>  ${m.s1} : ${m.s2}  <b>${esc(m.team2)}</b>  · BO${m.bo}`,
  ];
  for (const g of maps || []) {
    if (finished && g.status !== 'finished') continue; // 结束后不再列没打的图
    lines.push(mapLine(m, g));
  }
  lines.push(link(m));
  return lines.join('\n');
}

export function mapEndMsg(m, g) {
  return [`🗺 地图 ${g.n} 结束 · ${head(m)}`, mapLine(m, g), `大比分 <b>${esc(m.team1)}</b> ${m.s1} : ${m.s2} <b>${esc(m.team2)}</b>`].join('\n');
}

export function endMsg(m) {
  let winner = '';
  if (m.winner_id === m.team1_id) winner = m.team1;
  else if (m.winner_id === m.team2_id) winner = m.team2;
  else if (m.s1 !== m.s2) winner = m.s1 > m.s2 ? m.team1 : m.team2;
  return [
    `🏆 比赛结束 · ${head(m)}`,
    `<b>${esc(m.team1)}</b>  ${m.s1} : ${m.s2}  <b>${esc(m.team2)}</b>`,
    winner ? `胜者：<b>${esc(winner)}</b>` : '',
    link(m),
  ].filter(Boolean).join('\n');
}

export function streamerLiveMsg(s) {
  return [
    `📺 <b>${esc(s.owner || s.room_id)}</b> 开播了`,
    s.title ? esc(s.title) : '',
    `<a href="${roomUrl(s.room_id)}">douyu.com/${esc(s.room_id)}</a>`,
  ].filter(Boolean).join('\n');
}

// 列表：/next /live /results
export function matchList(title, list, tz, mode) {
  if (!list.length) return `${title}\n（暂无）`;
  const lines = [title];
  for (const m of list) {
    if (mode === 'live') {
      lines.push(`\n🔴 ${head(m)}\n<b>${esc(m.team1)}</b> ${m.s1}:${m.s2} <b>${esc(m.team2)}</b> · BO${m.bo}  ${link(m)}`);
    } else if (mode === 'results') {
      lines.push(`\n${fmtTime(m.start_ts, tz)} · ${head(m)}\n<b>${esc(m.team1)}</b> ${m.s1}:${m.s2} <b>${esc(m.team2)}</b>`);
    } else {
      lines.push(`\n${fmtTime(m.start_ts, tz)}（${fmtDur(m.start_ts - now())}后）· ${head(m)}\n${vs(m)} · BO${m.bo}`);
    }
  }
  return lines.join('\n');
}
