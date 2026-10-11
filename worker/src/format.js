// Telegram 消息文本（HTML parse_mode）

import { esc, fmtTime, fmtDate, fmtClock, fmtDur, tierLabel, now } from './util.js';
import { matchUrl, stagesUrl, flag } from './bo3.js';
import { roomUrl } from './douyu.js';

const CIRCLED = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦'];

// "🇷🇺 <b>Spirit</b> #1"；stars：订阅队伍 id 集合，命中时前面加 ⭐
// ai：AI 预测胜者的标记，不再单独占一行
//   false 不标；true 只标 🤖（列表里用）；'score' 带预测比分「🤖2:0」；'verdict' 结束后再带 ✅/❌
const aiScore = (m, side) => (m.ai_s1 != null && m.ai_s2 != null ? (side === 1 ? `${m.ai_s1}:${m.ai_s2}` : `${m.ai_s2}:${m.ai_s1}`) : '');
const teamTag = (m, side, stars, ai = false) => {
  const name = side === 1 ? m.team1 : m.team2;
  const id = side === 1 ? m.team1_id : m.team2_id;
  const f = flag(side === 1 ? m.team1_cc : m.team2_cc);
  const rank = side === 1 ? m.team1_rank : m.team2_rank;
  let mark = '';
  if (ai && m.ai_winner_id && m.ai_winner_id === id) {
    mark = ' 🤖';
    if (ai !== true) mark += aiScore(m, side);
    if (ai === 'verdict' && m.winner_id) mark += m.winner_id === id ? '✅' : '❌';
  }
  return `${stars?.has(id) ? '⭐' : ''}${f ? f + ' ' : ''}<b>${esc(name)}</b>${rank ? ` #${rank}` : ''}${mark}`;
};

// $1,000,000 -> "$1M"，31500 -> "$31.5K"
export function fmtPrize(n) {
  if (!n) return '';
  if (n >= 1e6) return `$${+(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${+(n / 1e3).toFixed(1)}K`;
  return `$${n}`;
}
const EVENT = { lan: 'LAN', online: 'ONLINE' };
const starsText = (n) => (n > 0 ? '★'.repeat(n) : '');

// 赛事附加信息：奖金 · LAN · ★★★★
const extras = (m) => [fmtPrize(m.prize), EVENT[m.event_type] || '', starsText(m.stars)].filter(Boolean).join(' · ');

const vs = (m, stars, ai = false) => `${teamTag(m, 1, stars, ai)} vs ${teamTag(m, 2, stars, ai)}`;
const score = (m, ai = false) => `${teamTag(m, 1, null, ai)}  ${m.s1} : ${m.s2}  ${teamTag(m, 2, null, ai)}`;
const link = (m) => `<a href="${matchUrl(m)}">bo3.gg</a>${m.tournament_hltv ? ` · <a href="${esc(m.tournament_hltv)}">HLTV 赛事页</a>` : ''}`;

// "decider / 3rd place"，链接到 bo3 赛事的赛段页
const stage = (m) => {
  if (!m.stage) return '';
  const url = stagesUrl(m);
  return url ? `<a href="${url}">${esc(m.stage)}</a>` : esc(m.stage);
};

// 单条消息的头两行："S · ESL Pro League Season 24" + "decider / 3rd place · $1M · LAN · ★★★★"
const head = (m) => [`${tierLabel(m.tier)} · ${esc(m.tournament || '未知赛事')}`, [stage(m), extras(m)].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
// 列表里压成一行（只带星级，奖金和线下线上留给单条消息）
const headInline = (m) => [tierLabel(m.tier), esc(m.tournament || '未知赛事'), stage(m), starsText(m.stars)].filter(Boolean).join(' · ');

export function mapLine(m, g) {
  const no = CIRCLED[g.n] || `${g.n}.`;
  const name = g.map ? g.map.charAt(0).toUpperCase() + g.map.slice(1) : '待定'; // 还没选图
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
  return [when, head(m), `${vs(m, null, 'score')} · BO${m.bo}`, `${fmtTime(m.start_ts, tz)}  ${link(m)}`].filter(Boolean).join('\n');
}

// 直播中的可编辑消息；finished=true 时变成结束版
export function liveCard(m, maps, finished = false) {
  const lines = [finished ? '🏁 已结束' : '🔴 LIVE', head(m), `${score(m, finished ? 'verdict' : 'score')}  · BO${m.bo}`];
  for (const g of maps || []) {
    if (finished && g.status !== 'finished') continue; // 结束后不再列没打的图
    lines.push(mapLine(m, g));
  }
  lines.push(link(m));
  return lines.join('\n');
}

// 地图结束：列出到目前为止所有打完的图和比分
export function mapEndMsg(m, g, maps = [g]) {
  const done = (maps || []).filter((x) => x.status === 'finished' && x.sc1 != null);
  return [`🗺 地图 ${g.n} 结束`, head(m), ...(done.length ? done : [g]).map((x) => mapLine(m, x)), `大比分 ${score(m)}`].join('\n');
}

export function endMsg(m) {
  let side = 0;
  if (m.winner_id && m.winner_id === m.team1_id) side = 1;
  else if (m.winner_id && m.winner_id === m.team2_id) side = 2;
  else if (m.s1 !== m.s2) side = m.s1 > m.s2 ? 1 : 2;
  return [
    '🏆 比赛结束',
    head(m),
    score(m, 'verdict'),
    side ? `胜者：${teamTag(m, side)}` : '',
    ...(m.maps || []).filter((x) => x.status === 'finished' && x.sc1 != null).map((x) => mapLine(m, x)),
    link(m),
  ].filter(Boolean).join('\n');
}

export function streamerLiveMsg(s) {
  return [
    `📺 <b>${esc(s.owner || `斗鱼 ${s.room_id}`)}</b> 开播了`,
    s.title ? esc(s.title) : '',
    `${s.category ? esc(s.category) + ' · ' : ''}<a href="${roomUrl(s.room_id)}">douyu.com/${esc(s.room_id)}</a>`,
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
      lines.push(`\n${fmtTime(m.start_ts, tz)}（${fmtDur(m.start_ts - now())}后）· ${headInline(m)}\n${vs(m, null, true)} · BO${m.bo}`);
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
    lines.push('', `<b>${nextDay}${fmtClock(m.start_ts, tz)}</b>${live} · ${headInline(m)}`, `${vs(m, stars, true)} · BO${m.bo}`);
  }
  if (today.length > DAILY_MAX) lines.push('', `……还有 ${today.length - DAILY_MAX} 场，发送 /next 查看`);
  lines.push('', `共 ${today.length} 场 · ⭐ 订阅的队伍 · 🤖 AI 预测的胜者`);
  return lines.join('\n');
}
