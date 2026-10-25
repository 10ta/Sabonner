// Sabonner 网页：公开浏览 + 管理（需要 ADMIN_TOKEN）
// API 地址来自 config.js（init.sh 生成），也可以用 ?api=https://... 临时覆盖
(() => {
  'use strict';

  const API = (new URLSearchParams(location.search).get('api') || window.SABONNER_API || '').replace(/\/+$/, '');
  // 有比赛进行中或 30 分钟内开赛时每 30 秒拉一次数据，否则 2 分钟一次（后台赛程本来就 10 分钟才刷新）；
  // 倒计时等文字每 30 秒在本地重绘，不用请求服务器
  const FAST_MS = 30_000;
  const SLOW_MS = 120_000;
  const TICK_MS = 30_000;

  // ---------- 存储（隐私模式下可能不可用） ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 忽略 */ } },
  };

  // ---------- 配色（与 1999 主题相同的 19 套） ----------
  const SCHEMES = {
    'yellow-light': ['Yellow', '#ffffff', '#FFE600'], 'red-light': ['Red', '#ffffff', '#FF3333'],
    'blue-light': ['Blue', '#ffffff', '#0d6eff'], 'green-light': ['Green', '#ffffff', '#00CC66'],
    'purple-light': ['Purple', '#ffffff', '#9B5DE5'], 'solarized-light': ['Solarized', '#fdf6e3', '#e3bd4f'],
    'github-light': ['GitHub', '#ffffff', '#54aeff'], 'gruvbox-light': ['Gruvbox', '#fbf1c7', '#d79921'],
    'catppuccin-light': ['Catppuccin Latte', '#eff1f5', '#bfa0f5'], 'tokyonight-light': ['Tokyo Night Day', '#e9e9ed', '#8fb0f3'],
    'chelsea-light': ['Chelsea', '#ffffff', '#034694'],
    'tokyonight-dark': ['Tokyo Night', '#24283b', '#7aa2f7'], 'dracula-dark': ['Dracula', '#282a36', '#ff79c6'],
    'monokai-dark': ['Monokai', '#272822', '#e6db74'], 'nord-dark': ['Nord', '#3b4252', '#88c0d0'],
    'gruvbox-dark': ['Gruvbox', '#282828', '#fe8019'], 'catppuccin-dark': ['Catppuccin Mocha', '#1e1e2e', '#cba6f7'],
    'psg-dark': ['PSG', '#0e2a4a', '#DA291C'], 'samalive-dark': ['samalive', '#1f333d', '#e0913a'],
  };
  const DEFAULT_SCHEME = 'yellow-light';

  // ---------- 工具 ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowSec = () => Math.floor(Date.now() / 1000);
  const flag = (cc) => {
    const c = String(cc || '').toUpperCase();
    return /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : '';
  };
  const dayFmt = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' });
  const clockFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayKey = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const dayLabel = (ts) => {
    const today = dayKey(nowSec());
    const tomorrow = dayKey(nowSec() + 86400);
    const yesterday = dayKey(nowSec() - 86400);
    const k = dayKey(ts);
    const rel = k === today ? '今天' : k === tomorrow ? '明天' : k === yesterday ? '昨天' : '';
    const p = Object.fromEntries(dayFmt.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
    return { main: `${p.month}/${p.day} ${p.weekday}`, rel };
  };
  const clock = (ts) => clockFmt.format(new Date(ts * 1000));
  const dur = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}天${h ? h + '小时' : ''}`;
    if (h) return `${h}小时${m ? m + '分' : ''}`;
    return `${m}分`;
  };
  const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();

  // ---------- 状态 ----------
  const state = {
    data: null,
    token: store.get('sabonner.token'),
    admin: { users: null, search: [], q: '', busy: false },
    resultsOpen: store.get('sabonner.resultsOpen') === '1',
    error: null,
  };

  // ---------- 网络 ----------
  async function api(path, opts = {}) {
    if (!API) throw new Error('没有配置 API 地址（config.js）');
    const headers = { ...(opts.body ? { 'content-type': 'application/json' } : {}) };
    if (opts.admin) headers.authorization = `Bearer ${state.token}`;
    const r = await fetch(API + path, { method: opts.method || 'GET', headers, cache: 'no-store', body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && opts.admin) { logout(); throw new Error('管理密码无效，已退出'); }
    if (!r.ok) throw new Error(j.error || `请求失败（${r.status}）`);
    return j;
  }

  let lastLoad = 0;
  let lastSig = '';
  let lastPaint = 0;
  async function load(force = false) {
    lastLoad = Date.now();
    try {
      const d = await api('/api/overview');
      // 数据没变、而且还在同一分钟内（倒计时文字也不变）就不重绘，避免队徽闪一下
      const sig = JSON.stringify({ ...d, now: 0 });
      const same = sig === lastSig && !state.error && Math.floor(Date.now() / 60000) === lastPaint;
      lastSig = sig;
      state.data = d;
      state.error = null;
      if (same && !force) return;
    } catch (e) {
      state.error = e.message;
    }
    render();
  }

  // 现在是不是「热」时段：有比赛进行中，或 30 分钟内有比赛开始
  function busy() {
    const d = state.data;
    if (!d) return true;
    if (visible(d.live).length) return true;
    const t = nowSec();
    return visible(d.upcoming).some((m) => m.start - t < 1800);
  }

  const bothTbd = (m) => !m.team1_id && !m.team2_id;
  const visible = (list) => (list || []).filter((m) => !bothTbd(m));

  // ---------- 渲染：卡片 ----------
  const subTeamIds = () => new Set((state.data?.subs?.teams || []).map((t) => t.id));

  function teamRow(m, side, stars) {
    const name = side === 1 ? m.team1 : m.team2;
    const id = side === 1 ? m.team1_id : m.team2_id;
    const cc = side === 1 ? m.team1_cc : m.team2_cc;
    const logo = side === 1 ? m.team1_logo : m.team2_logo;
    const score = side === 1 ? m.s1 : m.s2;
    const other = side === 1 ? m.s2 : m.s1;
    const showScore = m.status !== 'upcoming';
    const rank = side === 1 ? m.team1_rank : m.team2_rank;
    const aiPick = m.ai && m.ai.winner_id === id;
    let cls = 'team';
    if (stars.has(id)) cls += ' star';
    if (aiPick) cls += ' ai';
    if (m.status === 'finished') {
      const won = m.winner_id ? m.winner_id === id : score > other;
      cls += won ? ' win' : ' lose';
    }
    const f = flag(cc);
    return `<div class="${cls}">
      <span class="team-logo${logo ? '' : ' no-img'}">${logo ? `<img src="${esc(logo)}" alt="" data-logo loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${esc(initials(name))}'))">` : esc(initials(name))}${aiPick ? aiTag(m, side) : ''}</span>
      <span class="team-name" title="${esc(name)}${rank ? ` · 世界排名 #${rank}` : ''}">${f ? `<span class="flag">${f}</span>` : ''}${esc(name)}${rank ? `<span class="rank">#${rank}</span>` : ''}</span>
      ${showScore ? `<span class="team-score">${score ?? 0}</span>` : ''}
    </div>`;
  }

  function mapRows(m) {
    const maps = (m.maps || []).filter((g) => m.status !== 'finished' || g.status === 'finished');
    if (!maps.length) return '';
    return `<div class="maps">${maps.map((g) => {
      const name = g.map || '待定';
      let score = '', win = '';
      if (g.status === 'finished' && g.sc1 != null) {
        score = `${g.sc1}:${g.sc2}`;
        win = g.side === 1 ? m.team1 : g.side === 2 ? m.team2 : (g.winner || '');
        win = win ? `✓ ${win}` : '';
      } else if (g.status === 'current') {
        score = '··'; win = '进行中';
      } else {
        score = '—';
      }
      return `<div class="map ${esc(g.status)}"><span class="map-n">${g.n}</span><span class="map-name">${esc(name)}</span><span class="map-score">${score}</span><span class="map-win">${esc(win)}</span></div>`;
    }).join('')}</div>`;
  }

  const fmtPrize = (n) => (!n ? '' : n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${+(n / 1e3).toFixed(1)}K` : `$${n}`);
  const starRow = (n) => `<span class="stars" title="bo3 星级 ${n}/5">${'<b>★</b>'.repeat(n)}${'<i>★</i>'.repeat(5 - n)}</span>`;

  // AI 预测：挂在预测胜者队徽左上角的小标「AI 2:0」（比分按预测胜者的视角）；
  // 比赛结束后猜中变绿、没猜中变红并划掉
  function aiVerdict(m) {
    if (!m.ai || m.status !== 'finished') return null;
    const w = m.winner_id || (m.s1 !== m.s2 ? (m.s1 > m.s2 ? m.team1_id : m.team2_id) : null);
    return w ? w === m.ai.winner_id : null;
  }
  function aiTag(m, side) {
    const sc = m.ai.s1 != null && m.ai.s2 != null ? (side === 1 ? `${m.ai.s1}:${m.ai.s2}` : `${m.ai.s2}:${m.ai.s1}`) : '';
    const v = aiVerdict(m);
    const name = side === 1 ? m.team1 : m.team2;
    const tip = `AI 预测 ${name}${sc ? ' ' + sc : ''} 胜${v === true ? ' · 猜中' : v === false ? ' · 没猜中' : ''}`;
    return `<i class="ai-tag${v === true ? ' ai-ok' : v === false ? ' ai-miss' : ''}" title="${esc(tip)}">AI${sc ? `<span>${sc}</span>` : ''}</i>`;
  }

  // 头部第二行：赛段 · 奖金 · LAN · 星级 · HLTV
  function tourSub(m) {
    const parts = [];
    if (m.stage) parts.push(m.stage_url
      ? `<a class="tour-stage" href="${esc(m.stage_url)}" target="_blank" rel="noopener">${esc(m.stage)}</a>`
      : `<span class="tour-stage">${esc(m.stage)}</span>`);
    if (m.prize) parts.push(`<span class="tm-prize" title="总奖金">${fmtPrize(m.prize)}</span>`);
    if (m.event_type === 'lan') parts.push('<span class="tm-tag tm-lan" title="线下赛">LAN</span>');
    else if (m.event_type === 'online') parts.push('<span class="tm-tag tm-online" title="线上赛">ONLINE</span>');
    if (m.stars) parts.push(starRow(m.stars));
    if (m.tournament_hltv) parts.push(`<a class="tm-link" href="${esc(m.tournament_hltv)}" target="_blank" rel="noopener" title="HLTV 赛事页">HLTV↗</a>`);
    return parts.length ? `<span class="tour-sub">${parts.join('')}</span>` : '';
  }

  function matchCard(m, stars) {
    const tier = String(m.tier || '').toLowerCase();
    const t = nowSec();
    let when;
    if (m.status === 'current') when = `<span class="when-time">${clock(m.start)}</span><span class="countdown">已开赛 ${dur(t - m.start)}</span>`;
    else if (m.status === 'upcoming') {
      const left = m.start - t;
      when = `<span class="when-time">${clock(m.start)}</span><span class="countdown">${left > 0 ? dur(left) + '后' : '即将开始'}</span>`;
    } else when = `<span class="when-time">${clock(m.start)}</span><span class="countdown">已结束</span>`;
    return `<article class="card match ${esc(m.status)}">
      ${m.status === 'current' ? '<div class="live-band"><span class="live-dot"></span>LIVE</div>' : ''}
      <div class="card-top">
        <span class="tier tier-${esc(tier)}" title="Tier ${esc(tier.toUpperCase())}">${esc(tier.toUpperCase() || '?')}</span>
        <span class="tour"><span class="tour-name" title="${esc(m.tournament)}">${esc(m.tournament || '未知赛事')}</span>${tourSub(m)}</span>
        <span class="bo">BO${m.bo}</span>
      </div>
      <div class="teams">${teamRow(m, 1, stars)}${teamRow(m, 2, stars)}</div>
      ${mapRows(m)}
      <div class="card-foot"><span class="when">${when}</span><a class="ext" href="${esc(m.url)}" target="_blank" rel="noopener">bo3.gg ↗</a></div>
    </article>`;
  }

  // 按日期分组
  function grouped(list, desc = false) {
    if (!list.length) return null;
    const stars = subTeamIds();
    const groups = [];
    for (const m of list) {
      const k = dayKey(m.start);
      let g = groups.find((x) => x.k === k);
      if (!g) { g = { k, ts: m.start, items: [] }; groups.push(g); }
      g.items.push(m);
    }
    if (desc) groups.sort((a, b) => b.ts - a.ts);
    return groups.map((g) => {
      const lbl = dayLabel(g.ts);
      return `<section class="day"><div class="day-head"><h2>${esc(lbl.main)}</h2><span class="muted">${lbl.rel ? lbl.rel + ' · ' : ''}${g.items.length} 场</span></div>
        <div class="grid">${g.items.map((m) => matchCard(m, stars)).join('')}</div></section>`;
    }).join('');
  }

  const empty = (title, text) => `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;

  // 主播：紧凑小条，在播的排前面；放在「直播」分栏顶部
  function streamerStrip(rooms) {
    if (!rooms.length) return '';
    const sorted = [...rooms].sort((a, b) => Number(b.live) - Number(a.live));
    const t = nowSec();
    return `<div class="streamers">${sorted.map((r) => {
      const name = r.owner || `斗鱼 ${r.room_id}`;
      const since = r.live
        ? (r.show_time ? `已播 ${dur(t - r.show_time)}` : '直播中')
        : (r.changed_at ? `${dur(t - r.changed_at)}前下播` : '未开播');
      const sub = [r.live ? r.title : '', r.category, since].filter(Boolean).map(esc).join(' · ');
      return `<a class="streamer${r.live ? ' live' : ''}" href="https://www.douyu.com/${esc(r.room_id)}" target="_blank" rel="noopener" title="${esc(`${name}${r.title ? ' · ' + r.title : ''} · 斗鱼 ${r.room_id}`)}">
        <span class="room-avatar">${r.avatar ? `<img src="${esc(r.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${esc(initials(name))}'))">` : esc(initials(name))}<i class="room-dot" aria-hidden="true"></i></span>
        <span class="st-main"><span class="st-name">${esc(name)}${r.live ? '<i class="live-tag">LIVE</i>' : ''}</span><span class="st-sub">${sub}</span></span>
      </a>`;
    }).join('')}</div>`;
  }

  // 赛果：紧凑小卡网格，默认只显示前两行，可展开
  function resultTile(m, stars) {
    const w1 = m.winner_id ? m.winner_id === m.team1_id : m.s1 > m.s2;
    const v = aiVerdict(m);
    const row = (side) => {
      const id = side === 1 ? m.team1_id : m.team2_id;
      const name = side === 1 ? m.team1 : m.team2;
      const logo = side === 1 ? m.team1_logo : m.team2_logo;
      const f = flag(side === 1 ? m.team1_cc : m.team2_cc);
      const rank = side === 1 ? m.team1_rank : m.team2_rank;
      const won = side === 1 ? w1 : !w1;
      const ai = m.ai && m.ai.winner_id === id && v != null
        ? `<i class="ai-tag ${v ? 'ai-ok' : 'ai-miss'}" title="AI 预测 ${esc(name)} 胜 · ${v ? '猜中' : '没猜中'}">AI${v ? '✓' : '✗'}</i>` : '';
      return `<span class="res-team${won ? ' win' : ' lose'}${stars.has(id) ? ' star' : ''}">
        <span class="res-logo${logo ? '' : ' no-img'}">${logo ? `<img src="${esc(logo)}" alt="" data-logo loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${esc(initials(name))}'))">` : esc(initials(name))}</span>
        <span class="res-name">${f ? `<span class="flag">${f}</span>` : ''}<span class="nm">${esc(name)}</span>${rank ? `<span class="rank">#${rank}</span>` : ''}${ai}</span>
        <b class="res-s">${side === 1 ? m.s1 : m.s2}</b></span>`;
    };
    const tier = String(m.tier || '').toLowerCase();
    const lbl = dayLabel(m.start);
    // 点击打开详情（地图 + 记分板）；新标签打开 / 中键仍然直达 bo3.gg
    return `<a class="res" href="${esc(m.url)}" target="_blank" rel="noopener" data-detail="${m.id}" title="${esc(m.tournament)}${m.stage ? ' · ' + esc(m.stage) : ''} · 点击查看详情">
      <span class="res-head"><span class="tier tier-sm tier-${esc(tier)}">${esc(tier.toUpperCase() || '?')}</span>
        <span class="res-tour">${esc(m.tournament || '')}${m.stage ? ` · ${esc(m.stage)}` : ''}</span>
        <span class="res-when">${esc(lbl.rel || lbl.main.split(' ')[0])} ${clock(m.start)}</span></span>
      ${row(1)}${row(2)}
    </a>`;
  }

  function resultGrid(list) {
    if (!list.length) return '<div class="idle">最近 7 天没有已结束的比赛</div>';
    const stars = subTeamIds();
    return `<div class="res-grid${state.resultsOpen ? '' : ' collapsed'}" id="res-grid">${list.map((m) => resultTile(m, stars)).join('')}</div>`;
  }

  // ---------- 赛事 ----------
  const md = (ts) => { const d = new Date(ts * 1000); return `${d.getMonth() + 1}/${d.getDate()}`; };
  function eventList(events) {
    const t = nowSec();
    return `<div class="ev-list">${events.map((e) => {
      const tier = String(e.tier || '').toLowerCase();
      const range = e.end && md(e.end) !== md(e.start) ? `${md(e.start)}–${md(e.end)}` : md(e.start);
      const live = e.status === 'current';
      const when = live ? '进行中' : e.start - t < 86400 ? `${dur(e.start - t)}后` : `${Math.ceil((e.start - t) / 86400)} 天后`;
      const meta = [
        e.prize ? `<span class="tm-prize">${fmtPrize(e.prize)}</span>` : '',
        e.event_type === 'lan' ? '<span class="tm-tag tm-lan">LAN</span>' : e.event_type === 'online' ? '<span class="tm-tag tm-online">ONLINE</span>' : '',
        e.subTeams?.length ? `<span class="ev-subs" title="参赛的订阅队伍">★ ${e.subTeams.map((x) => `${flag(x.cc)}${esc(x.name)}`).join('、')}</span>` : '',
      ].filter(Boolean).join('');
      return `<a class="ev${live ? ' live' : ''}" href="${esc(e.url)}" target="_blank" rel="noopener" title="${esc(e.name)} · bo3.gg">
        <span class="ev-logo">${e.image ? `<img src="${esc(e.image)}" alt="" data-logo loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>
        <span class="ev-main"><span class="ev-name"><span class="tier tier-sm tier-${esc(tier)}">${esc(tier.toUpperCase() || '?')}</span>${esc(e.name)}</span>
          ${meta ? `<span class="ev-meta">${meta}</span>` : ''}</span>
        <span class="ev-date"><b>${range}</b><span class="${live ? 'ev-live' : ''}">${when}</span></span>
      </a>`;
    }).join('')}</div>`;
  }

  // ---------- 队徽可读性 ----------
  // 透明底的队徽放在卡片底色上可能看不清（浅色主题里的黄色 / 浅绿队徽，深色主题里的黑色队徽）。
  // 和 Liquipedia 一样：算队徽像素和背景的对比度，大部分都看不清时，浅色主题画成全黑、深色主题画成全白。
  // 读像素需要图片允许跨域：先直接读，不行就经 Worker 的 /img 中转（只放行 bo3 的图片域名）。
  // 结果按「背景色 + 图片地址」存在本机，每个队徽在每套配色下只算一次。
  const LOGO_KEY = 'sabonner.logo.v1';
  let logoMemo = {};
  try { logoMemo = JSON.parse(store.get(LOGO_KEY) || '{}'); } catch { logoMemo = {}; }
  const logoJobs = new Map();
  let logoSaveTimer;
  const saveLogos = () => {
    clearTimeout(logoSaveTimer);
    logoSaveTimer = setTimeout(() => {
      const keys = Object.keys(logoMemo);
      if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete logoMemo[k];
      store.set(LOGO_KEY, JSON.stringify(logoMemo));
    }, 500);
  };
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const probe = document.createElement('canvas');
  function cssRgb(color) {
    const c = probe.getContext('2d', { willReadFrequently: true });
    c.clearRect(0, 0, 1, 1); c.fillStyle = '#000'; c.fillStyle = color; c.fillRect(0, 0, 1, 1);
    return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }
  function cardBg() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--card-bg').trim() || '#fff';
    return cssRgb(v);
  }
  function loadCors(src) {
    return new Promise((ok, fail) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.referrerPolicy = 'no-referrer';
      im.onload = () => ok(im);
      im.onerror = fail;
      im.src = src;
    });
  }
  // 返回 true 表示要改成单色
  function judge(im, bg) {
    const N = 40;
    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const c = cv.getContext('2d', { willReadFrequently: true });
    const s = Math.min(N / im.naturalWidth, N / im.naturalHeight) || 1;
    const w = im.naturalWidth * s, h = im.naturalHeight * s;
    c.drawImage(im, (N - w) / 2, (N - h) / 2, w, h);
    const d = c.getImageData(0, 0, N, N).data; // 跨域读不了会在这里抛错
    const bgL = lum(...bg);
    let cover = 0, good = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (a < 0.1) continue;
      // 半透明像素按实际显示的颜色（和背景混合后）算
      const L = lum(d[i] * a + bg[0] * (1 - a), d[i + 1] * a + bg[1] * (1 - a), d[i + 2] * a + bg[2] * (1 - a));
      const ratio = (Math.max(L, bgL) + 0.05) / (Math.min(L, bgL) + 0.05);
      cover += a;
      if (ratio >= 1.8) good += a;
    }
    if (!cover) return false;
    if (cover / (N * N) > 0.85) return false; // 自带底色的方形队徽，本来就看得清
    return good / cover < 0.35; // 看得清的部分不到 35%
  }
  async function verdict(src, bg) {
    const key = `${bg.join(',')}|${src}`;
    if (key in logoMemo) return logoMemo[key];
    if (!logoJobs.has(key)) {
      logoJobs.set(key, (async () => {
        let mono = false;
        try {
          try { mono = judge(await loadCors(src), bg); } catch {
            if (!API) throw new Error('no api');
            mono = judge(await loadCors(`${API}/img?u=${encodeURIComponent(src)}`), bg);
          }
          logoMemo[key] = mono;
          saveLogos();
        } catch { /* 读不到像素就保持原样 */ }
        return mono;
      })());
    }
    return logoJobs.get(key);
  }
  function fixLogos(root = document) {
    const bg = cardBg();
    const dark = lum(...bg) < 0.4;
    document.documentElement.style.setProperty('--logo-mono', dark ? 'brightness(0) invert(1)' : 'brightness(0)');
    for (const img of root.querySelectorAll('img[data-logo]')) {
      const src = img.getAttribute('src');
      if (!src) continue;
      const key = `${bg.join(',')}|${src}`;
      if (img.dataset.logoKey === key) continue;
      img.dataset.logoKey = key;
      if (key in logoMemo) { img.classList.toggle('logo-mono', !!logoMemo[key]); continue; }
      verdict(src, bg).then((mono) => { if (img.dataset.logoKey === key) img.classList.toggle('logo-mono', mono); });
    }
  }

  // ---------- 赛果详情 ----------
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  function scoreTable(m, side) {
    const ps = (m.stats || []).filter((p) => p.side === side).sort((a, b) => b.k - a.k || a.d - b.d);
    if (!ps.length) return '';
    const name = side === 1 ? m.team1 : m.team2;
    const logo = side === 1 ? m.team1_logo : m.team2_logo;
    const won = m.winner_id ? m.winner_id === (side === 1 ? m.team1_id : m.team2_id) : (side === 1 ? m.s1 > m.s2 : m.s2 > m.s1);
    const pm = (n) => `<td class="pm ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${signed(n)}</td>`;
    return `<section class="sb${won ? ' won' : ''}">
      <h4>${logo ? `<img src="${esc(logo)}" alt="" data-logo referrerpolicy="no-referrer" onerror="this.remove()">` : ''}${esc(name)}${won ? '<i class="sb-win">WIN</i>' : ''}</h4>
      <table><thead><tr><th>选手</th><th>K</th><th>D</th><th>A</th><th>+/-</th><th>ADR</th></tr></thead><tbody>
      ${ps.map((p) => {
        const f = flag(p.cc);
        return `<tr><td class="pl">${f ? `<span class="flag">${f}</span>` : ''}${esc(p.n)}</td><td>${p.k}</td><td>${p.d}</td><td>${p.a}</td>${pm(p.k - p.d)}<td>${p.adr ?? '–'}</td></tr>`;
      }).join('')}
      </tbody></table>
    </section>`;
  }

  function openDetail(id) {
    const m = (state.data?.results || []).find((x) => String(x.id) === String(id));
    if (!m) return false;
    const tier = String(m.tier || '').toLowerCase();
    const lbl = dayLabel(m.start);
    const w1 = m.winner_id ? m.winner_id === m.team1_id : m.s1 > m.s2;
    const team = (side) => {
      const f = flag(side === 1 ? m.team1_cc : m.team2_cc);
      const rank = side === 1 ? m.team1_rank : m.team2_rank;
      return `<span class="dt-team${(side === 1) === w1 ? ' win' : ''}">${f ? `<span class="flag">${f}</span>` : ''}${esc(side === 1 ? m.team1 : m.team2)}${rank ? `<span class="rank">#${rank}</span>` : ''}</span>`;
    };
    const maps = (m.maps || []).filter((g) => g.status === 'finished');
    const v = aiVerdict(m);
    $('#detail-title').textContent = `${lbl.rel || lbl.main} ${clock(m.start)} · BO${m.bo}`;
    $('#detail-body').innerHTML = `
      <div class="dt-head"><span class="tier tier-${esc(tier)}">${esc(tier.toUpperCase() || '?')}</span>
        <span class="tour"><span class="tour-name">${esc(m.tournament || '')}</span>${tourSub(m)}</span></div>
      <div class="dt-score">${team(1)}<b>${m.s1}<i>:</i>${m.s2}</b>${team(2)}</div>
      ${m.ai && v != null ? `<p class="dt-ai"><i class="ai-tag ${v ? 'ai-ok' : 'ai-miss'}">AI</i> 预测 ${esc(m.ai.winner_id === m.team1_id ? m.team1 : m.team2)} ${m.ai.winner_id === m.team1_id ? `${m.ai.s1}:${m.ai.s2}` : `${m.ai.s2}:${m.ai.s1}`} · ${v ? '猜中' : '没猜中'}</p>` : ''}
      <h3 class="dt-h">地图</h3>
      ${maps.length ? `<div class="maps dt-maps">${maps.map((g) => {
        const win = g.side === 1 ? m.team1 : g.side === 2 ? m.team2 : g.winner || '';
        return `<div class="map finished"><span class="map-n">${g.n}</span><span class="map-name">${esc(g.map || '待定')}</span><span class="map-score">${g.sc1 != null ? `${g.sc1}:${g.sc2}` : '—'}</span><span class="map-win">${win ? '✓ ' + esc(win) : ''}</span></div>`;
      }).join('')}</div>` : '<p class="dt-empty">没有逐图数据</p>'}
      <h3 class="dt-h">记分板</h3>
      ${m.stats && m.stats.length
        ? `<div class="sbs">${scoreTable(m, 1)}${scoreTable(m, 2)}</div><p class="dt-note">整场数据；ADR 为整场平均每回合伤害。</p>`
        : `<p class="dt-empty">${m.stats ? 'bo3 没有这场的选手数据' : '选手数据还在生成中：bo3 赛后解析完 demo（通常一到几小时）后，这里和 TG 结束消息会自动补上；赛后 8 小时还没有就不再等'}</p>`}
      <a class="btn dt-link" href="${esc(m.url)}" target="_blank" rel="noopener">在 bo3.gg 查看 ↗</a>`;
    fixLogos($('#detail-body'));
    const dlg = $('#detail');
    if (!dlg.open) dlg.showModal();
    $('#detail-body').scrollTop = 0;
    return true;
  }

  // 收起时只留两行（手机上一列时留三行），按当前列数算
  function clampResults() {
    const grid = document.getElementById('res-grid');
    const btn = document.getElementById('res-more');
    if (!grid) { if (btn) btn.hidden = true; return; }
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const keep = cols === 1 ? 3 : cols * 2;
    const tiles = grid.children;
    for (let i = 0; i < tiles.length; i++) tiles[i].hidden = !state.resultsOpen && i >= keep;
    if (btn) {
      btn.hidden = tiles.length <= keep;
      btn.textContent = state.resultsOpen ? '收起 ↑' : `全部 ${tiles.length} 场 ↓`;
      btn.setAttribute('aria-expanded', String(state.resultsOpen));
    }
  }

  // 进行中为空时：一行提示 + 下一场
  function idleLine(upcoming) {
    const next = upcoming[0];
    if (!next) return '<div class="idle">现在没有进行中的比赛<span class="muted">· 订阅范围内暂无赛程</span></div>';
    const f1 = flag(next.team1_cc), f2 = flag(next.team2_cc);
    return `<div class="idle">现在没有进行中的比赛<span class="muted">· 下一场 ${esc(dayLabel(next.start).rel || dayLabel(next.start).main)} ${clock(next.start)}（${dur(next.start - nowSec())}后）</span>
      <a href="${esc(next.url)}" target="_blank" rel="noopener">${f1 ? f1 + ' ' : ''}${esc(next.team1)} vs ${f2 ? f2 + ' ' : ''}${esc(next.team2)} ↗</a></div>`;
  }

  // ---------- 渲染：管理 ----------
  function adminPanel() {
    const d = state.data || {};
    const tiers = new Set(d.subs?.tiers || []);
    const teams = d.subs?.teams || [];
    const rooms = d.rooms || [];
    const users = state.admin.users;
    const subIds = new Set(teams.map((t) => t.id));
    const statusText = { pending: '待审批', approved: '已批准', denied: '已拒绝' };

    return `<div class="admin">
      <section class="admin-block"><h3>订阅范围</h3><div class="admin-body">
        <p class="admin-hint">Tier、星级、队伍三项任一命中就推送。</p>
        <div class="tier-toggles">${['s', 'a', 'b', 'c'].map((t) => `<button class="chip-btn" data-act="tier" data-tier="${t}" aria-pressed="${tiers.has(t)}">${t.toUpperCase()}</button>`).join('')}</div>
        <p class="admin-hint">C 档比赛很多，可能超出免费版 CPU 上限。</p>
        <div class="star-toggles">${[0, 1, 2, 3, 4, 5].map((n) => `<button class="chip-btn" data-act="stars" data-stars="${n}" aria-pressed="${(d.subs?.stars || 0) === n}">${n ? `≥${n}★` : '关'}</button>`).join('')}</div>
        <p class="admin-hint">按 bo3 星级订阅（0–5 星，越高越受关注）。</p>
      </div></section>

      <section class="admin-block"><h3>队伍 <span class="muted">${teams.length}</span></h3><div class="admin-body">
        <div class="field"><input type="search" id="team-q" placeholder="搜索队伍，如 Spirit" value="${esc(state.admin.q)}" autocomplete="off"></div>
        ${state.admin.search.length ? `<div class="rows">${state.admin.search.map((t) => `<div class="row">
          <span class="row-main">${t.logo ? `<img src="${esc(t.logo)}" alt="" data-logo referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="row-title">${flag(t.cc)} ${esc(t.name)}</span>${t.rank ? `<span class="row-sub">#${t.rank}</span>` : ''}</span>
          ${subIds.has(t.id) ? '<span class="badge badge-approved">已订阅</span>' : `<button class="btn btn-sm" data-act="team-add" data-id="${t.id}">订阅</button>`}
        </div>`).join('')}</div>` : ''}
        <div class="rows">${teams.length ? teams.map((t) => `<div class="row">
          <span class="row-main">${t.logo ? `<img src="${esc(t.logo)}" alt="" data-logo referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="row-title">${flag(t.cc)} ${esc(t.name)}</span></span>
          <button class="btn btn-sm btn-danger" data-act="team-del" data-id="${t.id}">退订</button></div>`).join('') : '<p class="admin-hint">还没有订阅队伍</p>'}</div>
      </div></section>

      <section class="admin-block"><h3>斗鱼主播 <span class="muted">${rooms.length}</span></h3><div class="admin-body">
        <form class="field" data-form="room"><input type="text" id="room-id" placeholder="房间号或链接，如 6657" autocomplete="off"><button class="btn btn-primary" type="submit">添加</button></form>
        <div class="rows">${rooms.length ? rooms.map((r) => `<div class="row">
          <span class="row-main"><span class="row-title">${esc(r.owner || r.room_id)}</span><span class="row-sub">${esc(r.room_id)}</span>${r.live ? '<span class="badge badge-live">LIVE</span>' : ''}</span>
          <button class="btn btn-sm btn-danger" data-act="room-del" data-id="${esc(r.room_id)}">删除</button></div>`).join('') : '<p class="admin-hint">还没有添加主播</p>'}</div>
      </div></section>

      <section class="admin-block"><h3>TG 用户 <span class="muted">${users ? users.length : '…'}</span></h3><div class="admin-body">
        <div class="rows">${!users ? '<p class="admin-hint">加载中…</p>' : users.length ? users.map((u) => `<div class="row">
          <span class="row-main"><span class="row-title">${esc(u.name || u.tg_id)}</span><span class="row-sub">${u.username ? '@' + esc(u.username) : esc(u.tg_id)}</span></span>
          <span class="badge badge-${esc(u.status)}">${statusText[u.status] || esc(u.status)}</span>
          ${u.status === 'approved'
            ? `<button class="btn btn-sm btn-danger" data-act="user-revoke" data-id="${esc(u.tg_id)}">撤销</button>`
            : `<button class="btn btn-sm" data-act="user-approve" data-id="${esc(u.tg_id)}">批准</button>`}
          ${u.status === 'pending' ? `<button class="btn btn-sm btn-danger" data-act="user-revoke" data-id="${esc(u.tg_id)}">拒绝</button>` : ''}
        </div>`).join('') : '<p class="admin-hint">还没有人申请。别人给 bot 发 /start 后会出现在这里。</p>'}</div>
      </div></section>

      <section class="admin-block"><h3>操作</h3><div class="admin-body">
        <div class="field"><button class="btn" data-act="refresh">立即刷新赛程</button><button class="btn btn-danger" data-act="logout">退出管理</button></div>
        <p class="admin-hint">上次刷新：${d.last_refresh ? dur(nowSec() - d.last_refresh) + '前' : '从未'}</p>
      </div></section>
    </div>`;
  }

  // ---------- 渲染：整页 ----------
  // 输入框聚焦时整块重绘会丢焦点，这里记下再恢复
  function keepFocus(fn) {
    const el = document.activeElement;
    const id = el?.id;
    const caret = el?.selectionStart;
    fn();
    const again = id && document.getElementById(id);
    if (again && again !== document.activeElement && /^(INPUT|TEXTAREA)$/.test(again.tagName)) {
      again.focus({ preventScroll: true });
      try { if (caret != null) again.setSelectionRange(caret, caret); } catch { /* 部分输入框不支持 */ }
    }
  }

  function render() {
    lastPaint = Math.floor(Date.now() / 60000);
    const d = state.data;
    const admin = !!state.token;
    $('#sec-admin').hidden = !admin;
    $('#jump-admin').hidden = !admin;
    $('#btn-admin-label').textContent = admin ? '已登录' : '管理';

    if (!d) {
      if (state.error) $('#results-body').innerHTML = empty('连不上服务', state.error);
      return;
    }

    const live = visible(d.live);
    const upcoming = visible(d.upcoming);
    const results = visible(d.results);
    const roomsLive = d.rooms.filter((r) => r.live).length;

    // 统计 + 计数
    const t = nowSec();
    const dayEnd = new Date(); dayEnd.setHours(24, 0, 0, 0);
    $('#st-live').textContent = live.length;
    $('#st-today').textContent = upcoming.filter((m) => m.start < dayEnd / 1000).length + live.length;
    $('#st-week').textContent = upcoming.filter((m) => m.start < t + 7 * 86400).length;
    $('#st-rooms').textContent = `${roomsLive}/${d.rooms.length}`;
    const setCount = (id, n, hot) => { const el = $(id); el.textContent = n || ''; el.classList.toggle('hot', !!hot && n > 0); };
    setCount('#jc-results', results.length);
    setCount('#jc-live', live.length + roomsLive, true);
    setCount('#jc-upcoming', upcoming.length);
    $('#sc-live').textContent = live.length || '';
    $('#sn-live').textContent = [live.length ? `${live.length} 场比赛` : '', d.rooms.length ? `主播 ${roomsLive}/${d.rooms.length} 在播` : ''].filter(Boolean).join(' · ');
    $('#sc-upcoming').textContent = upcoming.length || '';
    $('#sc-results').textContent = results.length || '';
    $('#sn-results').innerHTML = results.length ? '<span>最近 7 天</span><button class="sec-more" id="res-more" type="button" aria-controls="res-grid" hidden></button>' : '';
    $('#updated').textContent = d.last_refresh ? `赛程更新于 ${dur(t - d.last_refresh)}前` : '';

    // 订阅条
    const subs = d.subs || { tiers: [], teams: [] };
    $('#subs').innerHTML = `<span class="subs-label">订阅</span>${
      subs.tiers.map((x) => `<span class="chip chip-tier">TIER ${esc(x.toUpperCase())}</span>`).join('')}${
      subs.stars ? `<span class="chip chip-tier">★ ≥ ${subs.stars}</span>` : ''}${
      subs.teams.map((x) => `<span class="chip">${x.logo ? `<img src="${esc(x.logo)}" alt="" data-logo referrerpolicy="no-referrer" onerror="this.remove()">` : ''}${flag(x.cc)} ${esc(x.name)}</span>`).join('')}${
      !subs.tiers.length && !subs.teams.length && !subs.stars ? '<span class="muted">还没有订阅</span>' : ''}`;

    const stars = subTeamIds();
    keepFocus(() => {
      $('#results-body').innerHTML = resultGrid(results);
      $('#live-body').innerHTML = streamerStrip(d.rooms)
        + (live.length ? `<div class="grid">${live.map((m) => matchCard(m, stars)).join('')}</div>` : idleLine(upcoming));
      $('#upcoming-body').innerHTML = grouped(upcoming) || empty('暂无赛程', '订阅范围内 7 天内没有比赛');
      const events = d.events || [];
      $('#sec-events').hidden = !events.length; // 和订阅范围没有交集的赛事不展示；一个都没有就整块隐藏
      $('#jump-events').hidden = !events.length;
      $('#events-body').innerHTML = events.length ? eventList(events) : '';
      if (admin) $('#admin-body').innerHTML = adminPanel();
    });
    $('#sc-events').textContent = (d.events || []).length || '';
    $('#jc-events').textContent = (d.events || []).filter((e) => e.status === 'current').length || '';
    clampResults();
    fixLogos();
    updateCurrent();
  }

  // ---------- 分栏导航 ----------
  let pinned = null;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function jumpTo(id) {
    const sec = document.getElementById(id);
    if (!sec || sec.hidden) return;
    sec.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    sec.focus({ preventScroll: true });
    sec.classList.remove('flash');
    void sec.offsetWidth; // 重新触发动画
    sec.classList.add('flash');
    pinned = { id, until: Date.now() + 1200 }; // 平滑滚动期间保持点击的那个高亮
    document.querySelectorAll('.jump').forEach((b) => b.setAttribute('aria-current', String(b.dataset.jump === id)));
  }

  // 滚动时高亮当前分栏：取导航条下方最靠上的那个
  function updateCurrent() {
    $('#to-top').classList.toggle('show', window.scrollY > 500);
    if (pinned && Date.now() < pinned.until) return;
    pinned = null;
    const bar = $('#jumpbar').getBoundingClientRect().bottom + 24;
    let cur = null;
    for (const b of document.querySelectorAll('.jump')) {
      const sec = document.getElementById(b.dataset.jump);
      if (!sec || sec.hidden) continue;
      const r = sec.getBoundingClientRect();
      if (r.top <= bar && r.bottom > bar) cur = b.dataset.jump;
    }
    if (!cur && window.scrollY < 10) cur = 'sec-results'; // 在页面顶部时高亮第一个
    if (!cur) {
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) cur = [...document.querySelectorAll('.jump')].filter((b) => !b.hidden).pop()?.dataset.jump;
    }
    document.querySelectorAll('.jump').forEach((b) => b.setAttribute('aria-current', String(b.dataset.jump === cur)));
  }
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { updateCurrent(); ticking = false; });
  }, { passive: true });
  window.addEventListener('resize', () => { clampResults(); updateCurrent(); });
  $('#to-top').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    $('#header').querySelector('.logo').focus({ preventScroll: true });
  });

  // ---------- 提示 ----------
  let toastTimer;
  function toast(text, error = false) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('error', error);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ---------- 管理操作 ----------
  function logout() {
    state.token = null;
    store.set('sabonner.token', null);
    state.admin.users = null;
    render();
  }

  async function loadUsers() {
    try { state.admin.users = (await api('/api/admin/users', { admin: true })).users; } catch (e) { toast(e.message, true); }
    if (state.token) render();
  }

  async function adminAction(fn, okText) {
    if (state.admin.busy) return;
    state.admin.busy = true;
    try {
      await fn();
      if (okText) toast(okText);
      await load(true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      state.admin.busy = false;
    }
  }

  let searchTimer;
  async function searchTeams(q) {
    state.admin.q = q;
    clearTimeout(searchTimer);
    if (q.trim().length < 2) { state.admin.search = []; render(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/admin/teams/search?q=${encodeURIComponent(q.trim())}`, { admin: true });
        if (state.admin.q === q) { state.admin.search = r.teams; render(); }
      } catch (e) { toast(e.message, true); }
    }, 350);
  }

  document.addEventListener('click', (e) => {
    const jumpBtn = e.target.closest('[data-jump]');
    if (jumpBtn) {
      if (jumpBtn.dataset.jump === 'sec-admin' && !state.admin.users) loadUsers();
      jumpTo(jumpBtn.dataset.jump);
      return;
    }
    const det = e.target.closest('[data-detail]');
    // 普通左键点击打开详情；Ctrl / ⌘ / Shift / 中键照常在新标签打开 bo3.gg
    if (det && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
      if (openDetail(det.dataset.detail)) e.preventDefault();
      return;
    }
    if (e.target.closest('[data-close]')) { $('#detail').close(); return; }
    if (e.target.id === 'detail') { $('#detail').close(); return; } // 点遮罩关闭
    if (e.target.closest('#res-more')) {
      state.resultsOpen = !state.resultsOpen;
      store.set('sabonner.resultsOpen', state.resultsOpen ? '1' : null);
      $('#res-grid')?.classList.toggle('collapsed', !state.resultsOpen);
      clampResults();
      if (!state.resultsOpen) jumpTo('sec-results'); // 收起后回到赛果顶部，不让页面停在半空
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    switch (btn.dataset.act) {
      case 'tier': {
        const cur = new Set(state.data?.subs?.tiers || []);
        const t = btn.dataset.tier;
        cur.has(t) ? cur.delete(t) : cur.add(t);
        adminAction(() => api('/api/admin/tiers', { admin: true, method: 'PUT', body: { tiers: [...cur] } }), `Tier ${t.toUpperCase()} ${cur.has(t) ? '已开启' : '已关闭'}`);
        break;
      }
      case 'stars': {
        const n = Number(btn.dataset.stars);
        adminAction(() => api('/api/admin/stars', { admin: true, method: 'PUT', body: { stars: n } }), n ? `已订阅 ${n} 星及以上` : '已关闭星级订阅');
        break;
      }
      case 'team-add':
        adminAction(() => api('/api/admin/teams', { admin: true, method: 'POST', body: { id: Number(id) } }), '已订阅');
        break;
      case 'team-del':
        adminAction(() => api(`/api/admin/teams/${id}`, { admin: true, method: 'DELETE' }), '已退订');
        break;
      case 'room-del':
        adminAction(() => api(`/api/admin/rooms/${id}`, { admin: true, method: 'DELETE' }), '已删除');
        break;
      case 'user-approve':
        adminAction(async () => { await api(`/api/admin/users/${id}/approve`, { admin: true, method: 'POST' }); await loadUsers(); }, '已批准');
        break;
      case 'user-revoke':
        adminAction(async () => { await api(`/api/admin/users/${id}/revoke`, { admin: true, method: 'POST' }); await loadUsers(); }, '已撤销');
        break;
      case 'refresh':
        adminAction(() => api('/api/admin/refresh', { admin: true, method: 'POST' }), '赛程已刷新');
        break;
      case 'logout':
        logout();
        toast('已退出管理');
        break;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'team-q') searchTeams(e.target.value);
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form="room"]');
    if (!form) return;
    e.preventDefault();
    const room = $('#room-id').value.trim();
    if (!room) return;
    adminAction(() => api('/api/admin/rooms', { admin: true, method: 'POST', body: { room } }), '已添加');
  });

  // ---------- 登录 ----------
  const dlg = $('#login');
  $('#btn-admin').addEventListener('click', () => {
    if (state.token) { if (!state.admin.users) loadUsers(); jumpTo('sec-admin'); return; }
    $('#login-error').hidden = true;
    $('#login-token').value = '';
    dlg.showModal();
  });
  $('#login-cancel').addEventListener('click', () => dlg.close());
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('#login-token').value.trim();
    state.token = token;
    try {
      await api('/api/admin/me', { admin: true });
      store.set('sabonner.token', token);
      dlg.close();
      toast('已登录');
      loadUsers();
      render();
      requestAnimationFrame(() => jumpTo('sec-admin'));
    } catch (e) {
      state.token = null;
      const err = $('#login-error');
      // 401 时 api() 抛「管理密码无效」；其它情况（没配 API 地址、网络不通）照实显示
      err.textContent = /管理密码无效/.test(e.message) ? '密码不对' : e.message;
      err.hidden = false;
    }
  });

  // ---------- 配色菜单 ----------
  const menu = $('#theme-menu');
  const themeBtn = $('#btn-theme');
  const currentScheme = () => document.documentElement.dataset.scheme || DEFAULT_SCHEME;
  function applyScheme(s) {
    document.documentElement.dataset.scheme = s;
    store.set('sabonner.scheme', s);
    requestAnimationFrame(() => fixLogos()); // 换配色后背景变了，重新判断队徽
    renderMenu();
  }
  function renderMenu() {
    const item = (k) => {
      const [label, paper, accent] = SCHEMES[k];
      return `<button class="theme-item" role="menuitemradio" aria-checked="${k === currentScheme()}" data-scheme="${k}">
        <span class="swatch" style="--sw-paper:${paper};--sw-accent:${accent}"><i></i><i></i></span><span>${esc(label)}</span></button>`;
    };
    const keys = Object.keys(SCHEMES);
    menu.innerHTML = `<div class="theme-menu-head">配色</div><div class="theme-menu-cols">
      <div><div class="theme-menu-label">LIGHT</div>${keys.filter((k) => k.endsWith('-light')).map(item).join('')}</div>
      <div><div class="theme-menu-label">DARK</div>${keys.filter((k) => k.endsWith('-dark')).map(item).join('')}</div></div>`;
  }
  function placeMenu() {
    const r = themeBtn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 8}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  }
  themeBtn.addEventListener('click', () => {
    const open = menu.hidden;
    if (open) { renderMenu(); menu.hidden = false; placeMenu(); } else menu.hidden = true;
    themeBtn.setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scheme]');
    if (b) applyScheme(b.dataset.scheme);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('#theme-menu, #btn-theme')) { menu.hidden = true; themeBtn.setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { menu.hidden = true; themeBtn.setAttribute('aria-expanded', 'false'); themeBtn.focus(); }
  });
  window.addEventListener('resize', () => { if (!menu.hidden) placeMenu(); });
  if (!SCHEMES[currentScheme()]) document.documentElement.dataset.scheme = DEFAULT_SCHEME;

  // ---------- 启动 ----------
  load();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    // 正在输入时不自动刷新
    if (document.activeElement?.tagName === 'INPUT') return;
    if (Date.now() - lastLoad >= (busy() ? FAST_MS : SLOW_MS) - 1000) load();
    else if (state.data && Math.floor(Date.now() / 60000) !== lastPaint) render(); // 跨分钟了才在本地重绘倒计时
  }, TICK_MS);
  // 切回页面时补拉一次（10 秒内刚拉过就不重复）
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastLoad > 10_000) load(); });
  if (state.token) loadUsers();
  store.set('sabonner.tab', null); // 旧版选项卡的残留
  updateCurrent();
})();
