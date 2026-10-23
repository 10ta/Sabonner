// Telegram 消息文本（HTML parse_mode）
//
// 排版约定（所有消息统一）：
//   赛事行   🟥 S  ESL Pro League Season 24        tier 色块和网页一致：S 红 / A 橙 / B 蓝 / C 绿
//   信息行   decider / 3rd place · 💰 $1M · 🏟 LAN · ★★★★   （赛段斜体，链接到 bo3 赛段页）
//   对阵     放在引用块里（左侧色条），比分、时间用等宽字体
//   ⭐ 订阅的队伍   🤖2:1 AI 预测的胜者和比分（结束后带 ✅ / ❌）   🏆 胜者

import { esc, fmtTime, fmtDate, fmtClock, fmtDur, now, fmtMD } from './util.js';
import { matchUrl, stagesUrl, flag } from './bo3.js';
import { roomUrl } from './douyu.js';

const CIRCLED = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦'];
const TIER_ICON = { s: '🟥', a: '🟧', b: '🟦', c: '🟩' };
const EVENT = { lan: '🏟 LAN', online: '🌐 ONLINE' };

const quote = (text) => `<blockquote>${text}</blockquote>`;
const mono = (text) => `<code>${text}</code>`;

// $1,000,000 -> "$1M"，31500 -> "$31.5K"
export function fmtPrize(n) {
  if (!n) return '';
  if (n >= 1e6) return `$${+(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${+(n / 1e3).toFixed(1)}K`;
  return `$${n}`;
}
const starsText = (n) => (n > 0 ? '★'.repeat(n) : '');

// ---------- 队伍 ----------

// stars：订阅队伍 id 集合，命中时前面加 ⭐
// ai：false 不标；true 只标 🤖；'score' 带预测比分「🤖2:0」；'verdict' 结束后再带 ✅/❌
const aiScore = (m, side) => (m.ai_s1 != null && m.ai_s2 != null ? (side === 1 ? `${m.ai_s1}:${m.ai_s2}` : `${m.ai_s2}:${m.ai_s1}`) : '');
const winnerSide = (m) => {
  if (m.winner_id && m.winner_id === m.team1_id) return 1;
  if (m.winner_id && m.winner_id === m.team2_id) return 2;
  if (m.status === 'finished' && m.s1 !== m.s2) return m.s1 > m.s2 ? 1 : 2;
  return 0;
};
const teamTag = (m, side, stars, ai = false) => {
  const name = side === 1 ? m.team1 : m.team2;
  const id = side === 1 ? m.team1_id : m.team2_id;
  const f = flag(side === 1 ? m.team1_cc : m.team2_cc);
  const rank = side === 1 ? m.team1_rank : m.team2_rank;
  let mark = '';
  if (ai && m.ai_winner_id && m.ai_winner_id === id) {
    mark = ' 🤖';
    if (ai !== true) mark += aiScore(m, side);
    if (ai === 'verdict' && winnerSide(m)) mark += winnerSide(m) === side ? '✅' : '❌';
  }
  return `${stars?.has(id) ? '⭐' : ''}${f ? f + ' ' : ''}<b>${esc(name || 'TBD')}</b>${rank ? ` <i>#${rank}</i>` : ''}${mark}`;
};

// 一行对阵：「🇦🇷 9z #17  vs  🇷🇺 Aurora #9 🤖2:1」；有比分时 vs 换成等宽比分
const vsLine = (m, stars, ai) => {
  const mid = m.status === 'upcoming' ? '<i>vs</i>' : mono(`${m.s1 ?? 0}:${m.s2 ?? 0}`);
  return `${teamTag(m, 1, stars, ai)}  ${mid}  ${teamTag(m, 2, stars, ai)}`;
};

// 两行比分（单场消息用）：比分在前，等宽对齐；胜者带 🏆
const scoreBlock = (m, stars, ai) => {
  const w = m.status === 'finished' ? winnerSide(m) : 0;
  const row = (side) => `${mono(` ${side === 1 ? m.s1 ?? 0 : m.s2 ?? 0} `)} ${teamTag(m, side, stars, ai)}${w === side ? ' 🏆' : ''}`;
  return quote(`${row(1)}\n${row(2)}`);
};

// ---------- 赛事 ----------

const tierBadge = (t) => {
  const k = String(t || '').toLowerCase();
  return `${TIER_ICON[k] || '⬜'} ${mono(esc(k.toUpperCase() || '?'))}`;
};
const tourTitle = (m) => `${tierBadge(m.tier)} <b>${esc(m.tournament || '未知赛事')}</b>`;

// "decider / 3rd place"（斜体），链接到 bo3 赛事的赛段页
const stage = (m) => {
  if (!m.stage) return '';
  const url = stagesUrl(m);
  return `<i>${url ? `<a href="${url}">${esc(m.stage)}</a>` : esc(m.stage)}</i>`;
};
const tourMeta = (m) => [m.prize ? `💰 ${fmtPrize(m.prize)}` : '', EVENT[m.event_type] || ''].filter(Boolean).join(' · ');

// 单场消息的头两行
const head = (m) => [tourTitle(m), [stage(m), tourMeta(m), starsText(m.stars)].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
const links = (m) => `🔗 <a href="${matchUrl(m)}">bo3.gg</a>${m.tournament_hltv ? ` · <a href="${esc(m.tournament_hltv)}">HLTV 赛事页</a>` : ''}`;

// ---------- 地图 ----------

const mapName = (g) => (g.map ? g.map.charAt(0).toUpperCase() + g.map.slice(1) : '待定'); // 还没选图
export function mapLine(m, g) {
  const no = CIRCLED[g.n] || `${g.n}.`;
  const name = esc(mapName(g));
  if (g.status === 'finished' && g.sc1 != null) {
    const winner = g.side === 1 ? m.team1 : g.side === 2 ? m.team2 : g.winner || '?';
    return `${no} <b>${name}</b>  ${mono(`${g.sc1}:${g.sc2}`)}  ✓ ${esc(winner)}`;
  }
  if (g.status === 'current') return `${no} <b>${name}</b>  ▶️ <i>进行中</i>`;
  return `${no} <i>${name}</i>`;
}
const mapsBlock = (m, maps, onlyDone = false) => {
  const list = (maps || []).filter((g) => !onlyDone || (g.status === 'finished' && g.sc1 != null));
  return list.map((g) => mapLine(m, g)).join('\n');
};

// ---------- 单场消息 ----------

export function preMsg(m, tz) {
  const left = m.start_ts - now();
  const when = left <= 45 * 60 ? `⏰ <b>${fmtDur(left)}后开赛</b>` : `📅 <b>${fmtDur(left)}后开赛</b>`;
  return [
    `${when} · BO${m.bo}`,
    head(m),
    quote(vsLine(m, null, 'score')),
    `🕓 ${mono(fmtTime(m.start_ts, tz))}`,
    links(m),
  ].join('\n');
}

// 直播中的可编辑消息；finished=true 时变成结束版
export function liveCard(m, maps, finished = false) {
  return [
    finished ? `🏁 <b>已结束</b> · BO${m.bo}` : `🔴 <b>LIVE</b> · BO${m.bo}`,
    head(m),
    scoreBlock(m, null, finished ? 'verdict' : 'score'),
    mapsBlock(m, maps, finished), // 结束后不再列没打的图
    links(m),
  ].filter(Boolean).join('\n');
}

// 地图结束：列出到目前为止所有打完的图和比分
export function mapEndMsg(m, g, maps = [g]) {
  const done = (maps || []).filter((x) => x.status === 'finished' && x.sc1 != null);
  const winner = g.side === 1 ? m.team1 : g.side === 2 ? m.team2 : g.winner;
  const title = `🗺 <b>地图 ${g.n} 结束</b>${winner && g.sc1 != null ? ` · ${esc(winner)} 拿下 ${esc(mapName(g))}` : ''}`;
  return [title, head(m), scoreBlock({ ...m, status: 'current' }, null, 'score'), mapsBlock(m, done.length ? done : [g])].filter(Boolean).join('\n');
}

// ---------- 记分板（赛后数据） ----------
// 等宽表格，手机上一行约 32 个字符：选手 K D A +/- ADR
const padR = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length));
const padL = (s, n) => ' '.repeat(Math.max(0, n - String(s).length)) + s;
const signed = (n) => (n > 0 ? `+${n}` : String(n));
export function statsRows(stats, side) {
  return stats.filter((p) => p.side === side).sort((a, b) => b.k - a.k || a.d - b.d);
}
function scoreboard(m) {
  if (!Array.isArray(m.stats) || !m.stats.length) return '';
  const row = (n, k, d, a, pm, adr) => `${padR(n, 11)}${padL(k, 3)}${padL(d, 4)}${padL(a, 4)}${padL(pm, 5)}${padL(adr, 5)}`;
  return [1, 2].map((side) => {
    const ps = statsRows(m.stats, side);
    if (!ps.length) return '';
    const lines = [
      row('', 'K', 'D', 'A', '+/-', 'ADR'),
      ...ps.map((p) => row(p.n, p.k, p.d, p.a, signed(p.k - p.d), p.adr ?? '-')),
    ];
    const f = flag(side === 1 ? m.team1_cc : m.team2_cc);
    return `📊 ${f ? f + ' ' : ''}<b>${esc(side === 1 ? m.team1 : m.team2)}</b>\n<pre>${esc(lines.join('\n'))}</pre>`;
  }).filter(Boolean).join('\n');
}

// 赛后数据到了之后会把已发出的结束消息编辑成带记分板的版本（见 engine.js statsTick）
export function endMsg(m) {
  const w = winnerSide(m);
  const name = w === 1 ? m.team1 : w === 2 ? m.team2 : '';
  return [
    `🏆 <b>比赛结束</b>${name ? ` · <b>${esc(name)}</b> 胜` : ''}`,
    head(m),
    scoreBlock({ ...m, status: 'finished' }, null, 'verdict'),
    mapsBlock(m, m.maps, true),
    scoreboard(m),
    links(m),
  ].filter(Boolean).join('\n');
}

export function streamerLiveMsg(s) {
  return [
    `📺 <b>${esc(s.owner || `斗鱼 ${s.room_id}`)}</b> 开播了！`,
    s.title ? quote(esc(s.title)) : '',
    [s.category ? `🎮 ${esc(s.category)}` : '', `🔗 <a href="${roomUrl(s.room_id)}">douyu.com/${esc(s.room_id)}</a>`].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n');
}

// ---------- 列表（每日预报、/next、/live、/results） ----------
//
// 一天一节，节内按赛事分组（组的顺序按该赛事第一场的时间），每个赛事一个引用块：
//   🟥 S  Thunderpick World Championship 2026
//   💰 $1M · 🏟 LAN
//   ┃ 16:30 · BO3 · ★★★★ · group a / opening matches
//   ┃ 🇦🇷 9z #17  vs  🇷🇺 Aurora #9 🤖2:1
//   ┃
//   ┃ 19:00 · ...

const LIMIT = 3800; // Telegram 单条消息上限 4096 个可见字符，留点余量
const visibleLen = (html) => html.replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot|#39);/g, '_').length;

// show：这一场要不要单独写赛段 / 星级（同组都一样时已经写在赛事头里了）
function matchEntry(m, tz, stars, day, show = { stage: true, stars: true }) {
  const nextDay = day && fmtDate(m.start_ts, tz) !== day ? '次日 ' : '';
  const time = `${nextDay}${fmtClock(m.start_ts, tz)}`;
  const status = m.status === 'current' ? ' 🔴 <b>LIVE</b>' : m.status === 'finished' ? ' 🏁' : '';
  const line1 = [`${mono(time)}${status}`, `BO${m.bo}`, show.stars ? starsText(m.stars) : '', show.stage ? stage(m) : ''].filter(Boolean).join(' · ');
  const ai = m.status === 'finished' ? 'verdict' : 'score';
  return `${line1}\n${vsLine(m, stars, ai)}`;
}

// 返回一组赛事块 { text, block, count }；同一赛事的比赛合在一个引用块里
function tourBlocks(list, tz, stars, day) {
  const groups = new Map();
  for (const m of list) {
    const k = `${m.tier}|${m.tournament}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  return [...groups.values()].map((ms) => {
    const same = (f) => ms.every((m) => (m[f] ?? null) === (ms[0][f] ?? null));
    const sameStage = same('stage'), sameStars = same('stars');
    const meta = [sameStage ? stage(ms[0]) : '', tourMeta(ms[0]), sameStars ? starsText(ms[0].stars) : ''].filter(Boolean).join(' · ');
    const show = { stage: !sameStage, stars: !sameStars };
    const body = ms.map((m) => matchEntry(m, tz, stars, day, show)).join('\n\n');
    return { text: `${tourTitle(ms[0])}${meta ? `\n${meta}` : ''}\n${quote(body)}`, block: true, count: ms.length };
  });
}

// 把若干段拼成一条消息，超长时丢掉后面的赛事块并提示
function compose(parts, more) {
  const out = [];
  let len = 0, dropped = 0;
  for (const p of parts) {
    const size = visibleLen(p.text) + 2;
    if (p.block && (dropped || len + size > LIMIT)) { dropped += p.count || 1; continue; }
    out.push(p.text);
    len += size;
  }
  if (dropped) out.push(`<i>……还有 ${dropped} 场放不下，${more}</i>`);
  return out;
}

const dayHead = (icon, title, ts, tz) => `${icon} <b>${title}</b> · <i>${fmtDate(ts, tz)}</i>`;

// 每日预报：今日 + 明日赛程（取代了提前 1 天的单条预告）
//   today / tomorrow 按开赛时间排序；两天都没有比赛时用 next（之后最近的一场）
// 赛事：进行中 + 即将开始（和订阅有交集的），每个一两行，放在每日预报末尾
const EVENTS_MAX = 10;
export function eventsBlock(events, tz) {
  if (!events?.length) return '';
  const range = (e) => {
    const a = fmtMD(e.start, tz);
    const b = e.end ? fmtMD(e.end, tz) : '';
    return b && b !== a ? `${a}–${b}` : a;
  };
  const lines = events.slice(0, EVENTS_MAX).map((e) => {
    const meta = [mono(range(e)), e.prize ? `💰 ${fmtPrize(e.prize)}` : '', EVENT[e.event_type] || '',
      e.subTeams?.length ? `⭐ ${e.subTeams.map((x) => esc(x.name)).join('、')}` : ''].filter(Boolean).join(' · ');
    return `${TIER_ICON[String(e.tier).toLowerCase()] || '⬜'} <b>${esc(e.name)}</b>${e.status === 'current' ? ' 🔴 <i>进行中</i>' : ''}\n${meta}`;
  });
  const more = events.length > EVENTS_MAX ? `\n<i>……还有 ${events.length - EVENTS_MAX} 个，去网页查看</i>` : '';
  return `🏟 <b>赛事</b>\n${quote(lines.join('\n\n'))}${more}`;
}

export function dailyMsg(dayStart, today, tomorrow, next, stars, tz, events = []) {
  const parts = [];
  const section = (icon, title, ts, list, emptyText) => {
    parts.push({ text: dayHead(icon, title, ts, tz) });
    if (!list.length) { parts.push({ text: `<i>${emptyText}</i>` }); return; }
    parts.push(...tourBlocks(list, tz, stars, fmtDate(ts, tz)));
  };
  section('📋', '今日赛程', dayStart, today, '今天没有比赛 😴');
  section('📅', '明日赛程', dayStart + 86400, tomorrow, '明天没有比赛');

  if (!today.length && !tomorrow.length) {
    parts.push({
      text: next
        ? [`⏭ <b>下一场</b> · ${mono(fmtTime(next.start_ts, tz))} <i>（${fmtDur(next.start_ts - now())}后）</i>`,
          tourTitle(next), quote(matchEntry(next, tz, stars, null))].join('\n')
        : '<i>暂时也没有已安排的比赛</i>',
    });
    const ev = eventsBlock(events, tz);
    return [...parts.map((p) => p.text), ...(ev ? [ev] : [])].join('\n\n');
  }
  const out = compose(parts, '发送 /next 查看');
  // 赛事块放在末尾；比赛很多、放不下时就不带
  const ev = eventsBlock(events, tz);
  if (ev && visibleLen(out.join('\n\n')) + visibleLen(ev) < LIMIT) out.push(ev);
  out.push(`<i>📊 今天 ${today.length} 场 · 明天 ${tomorrow.length} 场 · 开赛前 30 分钟再提醒\n⭐ 订阅的队伍 · 🤖 AI 预测胜者和比分</i>`);
  return out.join('\n\n');
}

// /next /live /results：按天分节（赛果按时间倒序）
export function matchList(title, list, tz, mode) {
  if (!list.length) return `${title}\n\n<i>（暂无）</i>`;
  const days = [];
  for (const m of list) {
    const d = fmtDate(m.start_ts, tz);
    let g = days.find((x) => x.d === d);
    if (!g) { g = { d, ts: m.start_ts, items: [] }; days.push(g); }
    g.items.push(m);
  }
  const parts = [{ text: title }];
  for (const g of days) {
    if (mode !== 'live') parts.push({ text: `📆 <b>${g.d}</b>` });
    const items = mode === 'results' ? [...g.items].sort((a, b) => a.start_ts - b.start_ts) : g.items;
    parts.push(...tourBlocks(items, tz, null, null));
  }
  return compose(parts, '去网页查看').join('\n\n');
}
