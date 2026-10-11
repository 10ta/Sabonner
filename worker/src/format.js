// Telegram 消息文本（HTML parse_mode）

import { esc, fmtTime, fmtDate, fmtClock, fmtDur, tierLabel, now } from './util.js';
import { matchUrl, stagesUrl, flag } from './bo3.js';
import { roomUrl } from './douyu.js';

const CIRCLED = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦'];

// "🇷🇺 <b>Spirit</b>"；stars：订阅队伍 id 集合，命中时前面加 ⭐
const teamTag = (m, side, stars) => {
  const name = side === 1 ? m.team1 : m.team2;
  const id = side === 1 ? m.team1_id : m.team2_id;
  const f = flag(side === 1 ? m.team1_cc : m.team2_cc);
  return `${stars?.has(id) ? '⭐' : ''}${f ? f + ' ' : ''}<b>${esc(name)}</b>`;
};
const vs = (m, stars) => `${teamTag(m, 1, stars)} vs ${teamTag(m, 2, stars)}`;
const score = (m) => `${teamTag(m, 1)}  ${m.s1} : ${m.s2}  ${teamTag(m, 2)}`;
const link = (m) => `<a href="${matchUrl(m)}">bo3.gg</a>`;

// "decider / 3rd place"，链接到 bo3 赛事的赛段页
const stage = (m) => {
  if (!m.stage) return '';
  const url = stagesUrl(m);
  return url ? `<a href="${url}">${esc(m.stage)}</a>` : esc(m.stage);
};

// 单条消息的头两行："S · ESL Pro League Season 24" + 赛段
const head = (m) => [`${tierLabel(m.tier)} · ${esc(m.tournament || '未知赛事')}`, stage(m)].filter(Boolean).join('\n');
// 列表里压成一行
const headInline = (m) => [tierLabel(m.tier), esc(m.tournament || '未知赛事'), stage(m)].filter(Boolean).join(' · ');

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
  return [when, head(m), `${vs(m)} · BO${m.bo}`, `${fmtTime(m.start_ts, tz)}  ${link(m)}`].join('\n');
}

// 直播中的可编辑消息；finished=true 时变成结束版
export function liveCard(m, maps, finished = false) {
  const lines = [finished ? '🏁 已结束' : '🔴 LIVE', head(m), `${score(m)}  · BO${m.bo}`];
  for (const g of maps || []) {
    if (finished && g.status !== 'finished') continue; // 结束后不再列没打的图
    lines.push(mapLine(m, g));
  }
  lines.push(link(m));
  return lines.join('\n');
}

export function mapEndMsg(m, g) {
  return [`🗺 地图 ${g.n} 结束`, head(m), mapLine(m, g), `大比分 ${score(m)}`].join('\n');
}

export function endMsg(m) {
  let side = 0;
  if (m.winner_id && m.winner_id === m.team1_id) side = 1;
  else if (m.winner_id && m.winner_id === m.team2_id) side = 2;
  else if (m.s1 !== m.s2) side = m.s1 > m.s2 ? 1 : 2;
  return [
    '🏆 比赛结束',
    head(m),
    score(m),
    side ? `胜者：${teamTag(m, side)}` : '',
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
      lines.push(`\n🔴 ${headInline(m)}\n${score(m)} · BO${m.bo}  ${link(m)}`);
    } else if (mode === 'results') {
      lines.push(`\n${fmtTime(m.start_ts, tz)} · ${headInline(m)}\n${score(m)}`);
    } else {
      lines.push(`\n${fmtTime(m.start_ts, tz)}（${fmtDur(m.start_ts - now())}后）· ${headInline(m)}\n${vs(m)} · BO${m.bo}`);
    }
  }
  return lines.join('\n');
}

// 每日预报：today 为当天比赛（按开赛时间排序），next 为之后最近的一场，stars 为订阅队伍 id
const DAILY_MAX = 25;
export function dailyMsg(dayStart, today, next, stars, tz) {
  const lines = [`📋 <b>今日赛程</b> · ${fmtDate(dayStart, tz)}`];
  if (!today.length) {
    lines.push('', '今天没有比赛！');
    if (next) {
      lines.push(`下一场比赛是 ${fmtTime(next.start_ts, tz)}（${fmtDur(next.start_ts - now())}后）`,
        headInline(next), `${vs(next, stars)} · BO${next.bo}`);
    } else {
      lines.push('暂时也没有已安排的比赛。');
    }
    return lines.join('\n');
  }
  const day = fmtDate(dayStart, tz);
  for (const m of today.slice(0, DAILY_MAX)) {
    const nextDay = fmtDate(m.start_ts, tz) !== day ? '次日 ' : '';
    const live = m.status === 'current' ? ' 🔴' : '';
    lines.push('', `<b>${nextDay}${fmtClock(m.start_ts, tz)}</b>${live} · ${headInline(m)}`, `${vs(m, stars)} · BO${m.bo}`);
  }
  if (today.length > DAILY_MAX) lines.push('', `……还有 ${today.length - DAILY_MAX} 场，发送 /next 查看`);
  lines.push('', `共 ${today.length} 场 · ⭐ 为订阅的队伍`);
  return lines.join('\n');
}
