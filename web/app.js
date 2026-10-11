// Sabonner 网页：公开浏览 + 管理（需要 ADMIN_TOKEN）
// API 地址来自 config.js（init.sh 生成），也可以用 ?api=https://... 临时覆盖
(() => {
  'use strict';

  const API = (new URLSearchParams(location.search).get('api') || window.SABONNER_API || '').replace(/\/+$/, '');
  const REFRESH_MS = 30_000;

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

  async function load() {
    try {
      state.data = await api('/api/overview');
      state.error = null;
    } catch (e) {
      state.error = e.message;
    }
    render();
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
    let cls = 'team';
    if (stars.has(id)) cls += ' star';
    if (m.status === 'finished') {
      const won = m.winner_id ? m.winner_id === id : score > other;
      cls += won ? ' win' : ' lose';
    }
    const f = flag(cc);
    return `<div class="${cls}">
      <span class="team-logo">${logo ? `<img src="${esc(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${esc(initials(name))}'))">` : esc(initials(name))}</span>
      <span class="team-name" title="${esc(name)}">${f ? `<span class="flag">${f}</span>` : ''}${esc(name)}</span>
      ${showScore ? `<span class="team-score">${score ?? 0}</span>` : ''}
    </div>`;
  }

  function mapRows(m) {
    const maps = (m.maps || []).filter((g) => m.status !== 'finished' || g.status === 'finished');
    if (!maps.length) return '';
    return `<div class="maps">${maps.map((g) => {
      const name = g.map || '?';
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

  function matchCard(m, stars) {
    const tier = String(m.tier || '').toLowerCase();
    const stage = m.stage
      ? (m.stage_url ? `<a class="tour-stage" href="${esc(m.stage_url)}" target="_blank" rel="noopener">${esc(m.stage)}</a>` : `<span class="tour-stage">${esc(m.stage)}</span>`)
      : '';
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
        <span class="tour"><span class="tour-name" title="${esc(m.tournament)}">${esc(m.tournament || '未知赛事')}</span>${stage}</span>
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

  function roomList(rooms) {
    if (!rooms.length) return '<div class="mini"><p class="mini-empty">管理员还没有添加斗鱼房间</p></div>';
    const sorted = [...rooms].sort((a, b) => Number(b.live) - Number(a.live));
    const t = nowSec();
    return `<div class="mini">${sorted.map((r) => {
      const name = r.owner || `斗鱼 ${r.room_id}`;
      const since = r.live
        ? (r.show_time ? `已播 ${dur(t - r.show_time)}` : '直播中')
        : (r.changed_at ? `${dur(t - r.changed_at)}前下播` : '未开播');
      const meta = [r.category, since, r.room_id].filter(Boolean).map(esc).join(' · ');
      return `<a class="mini-row room-row ${r.live ? 'live' : ''}" href="https://www.douyu.com/${esc(r.room_id)}" target="_blank" rel="noopener" title="${esc(r.title || '')}">
        <span class="room-avatar">${r.avatar ? `<img src="${esc(r.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${esc(initials(name))}'))">` : esc(initials(name))}<i class="room-dot" aria-hidden="true"></i></span>
        <span class="mini-main"><span class="mini-title">${esc(name)}${r.live ? ' <span class="badge badge-live">LIVE</span>' : ''}</span>
          ${r.title ? `<span class="mini-sub room-sub">${esc(r.title)}</span>` : ''}
          <span class="mini-sub">${meta}</span></span>
        <span class="mini-arrow">↗</span></a>`;
    }).join('')}</div>`;
  }

  function resultList(list) {
    if (!list.length) return '<div class="mini"><p class="mini-empty">最近 7 天没有已结束的比赛</p></div>';
    const stars = subTeamIds();
    return `<div class="mini">${list.map((m) => {
      const w1 = m.winner_id ? m.winner_id === m.team1_id : m.s1 > m.s2;
      const name = (side) => {
        const f = flag(side === 1 ? m.team1_cc : m.team2_cc);
        const id = side === 1 ? m.team1_id : m.team2_id;
        return `${f ? f + ' ' : ''}${esc(side === 1 ? m.team1 : m.team2)}${stars.has(id) ? ' ★' : ''}`;
      };
      const lbl = dayLabel(m.start);
      return `<a class="mini-row" href="${esc(m.url)}" target="_blank" rel="noopener" title="${esc(m.tournament)}${m.stage ? ' · ' + esc(m.stage) : ''}">
        <span class="res-date">${esc(lbl.rel || lbl.main.split(' ')[0])}</span>
        <span class="mini-main"><span class="res-score"><span class="t1 ${w1 ? '' : 'lose'}">${name(1)}</span><b>${m.s1}:${m.s2}</b><span class="${w1 ? 'lose' : ''}">${name(2)}</span></span>
          <span class="mini-sub">${esc(String(m.tier || '').toUpperCase())} · ${esc(m.tournament)}${m.stage ? ' · ' + esc(m.stage) : ''}</span></span>
        <span class="mini-arrow">↗</span></a>`;
    }).join('')}</div>`;
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
      <section class="admin-block"><h3>Tier 订阅</h3><div class="admin-body">
        <div class="tier-toggles">${['s', 'a', 'b', 'c'].map((t) => `<button class="chip-btn" data-act="tier" data-tier="${t}" aria-pressed="${tiers.has(t)}">${t.toUpperCase()}</button>`).join('')}</div>
        <p class="admin-hint">订阅某个 tier 会推送该级别全部比赛。C 档比赛很多，可能超出免费版 CPU 上限。</p>
      </div></section>

      <section class="admin-block"><h3>队伍 <span class="muted">${teams.length}</span></h3><div class="admin-body">
        <div class="field"><input type="search" id="team-q" placeholder="搜索队伍，如 Spirit" value="${esc(state.admin.q)}" autocomplete="off"></div>
        ${state.admin.search.length ? `<div class="rows">${state.admin.search.map((t) => `<div class="row">
          <span class="row-main">${t.logo ? `<img src="${esc(t.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="row-title">${flag(t.cc)} ${esc(t.name)}</span>${t.rank ? `<span class="row-sub">#${t.rank}</span>` : ''}</span>
          ${subIds.has(t.id) ? '<span class="badge badge-approved">已订阅</span>' : `<button class="btn btn-sm" data-act="team-add" data-id="${t.id}">订阅</button>`}
        </div>`).join('')}</div>` : ''}
        <div class="rows">${teams.length ? teams.map((t) => `<div class="row">
          <span class="row-main">${t.logo ? `<img src="${esc(t.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="row-title">${flag(t.cc)} ${esc(t.name)}</span></span>
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
    const d = state.data;
    const admin = !!state.token;
    $('#sec-admin').hidden = !admin;
    $('#jump-admin').hidden = !admin;
    $('#btn-admin-label').textContent = admin ? '已登录' : '管理';

    if (!d) {
      if (state.error) $('#live-body').innerHTML = empty('连不上服务', state.error);
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
    setCount('#jc-live', live.length, true);
    setCount('#jc-upcoming', upcoming.length);
    setCount('#jc-rooms', roomsLive, true);
    $('#sc-live').textContent = live.length || '';
    $('#sc-upcoming').textContent = upcoming.length || '';
    $('#sc-rooms').textContent = d.rooms.length ? `${roomsLive}/${d.rooms.length}` : '';
    $('#sc-results').textContent = results.length || '';
    $('#updated').textContent = d.last_refresh ? `赛程更新于 ${dur(t - d.last_refresh)}前` : '';

    // 订阅条
    const subs = d.subs || { tiers: [], teams: [] };
    $('#subs').innerHTML = `<span class="subs-label">订阅</span>${
      subs.tiers.map((x) => `<span class="chip chip-tier">TIER ${esc(x.toUpperCase())}</span>`).join('')}${
      subs.teams.map((x) => `<span class="chip">${x.logo ? `<img src="${esc(x.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}${flag(x.cc)} ${esc(x.name)}</span>`).join('')}${
      !subs.tiers.length && !subs.teams.length ? '<span class="muted">还没有订阅</span>' : ''}`;

    const stars = subTeamIds();
    keepFocus(() => {
      $('#live-body').innerHTML = live.length ? `<div class="grid">${live.map((m) => matchCard(m, stars)).join('')}</div>` : idleLine(upcoming);
      $('#upcoming-body').innerHTML = grouped(upcoming) || empty('暂无赛程', '订阅范围内 7 天内没有比赛');
      $('#rooms-body').innerHTML = roomList(d.rooms);
      $('#results-body').innerHTML = resultList(results);
      if (admin) $('#admin-body').innerHTML = adminPanel();
    });
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
    // 宽屏时侧栏吸顶、一直在视野里，不参与高亮判断（否则滚赛程时会一直亮「主播」）
    const sideSticky = getComputedStyle($('.col-side')).position === 'sticky';
    let cur = null;
    for (const b of document.querySelectorAll('.jump')) {
      const sec = document.getElementById(b.dataset.jump);
      if (!sec || sec.hidden) continue;
      if (sideSticky && sec.closest('.col-side')) continue;
      const r = sec.getBoundingClientRect();
      if (r.top <= bar && r.bottom > bar) cur = b.dataset.jump;
    }
    if (!cur && window.scrollY < 10) cur = 'sec-live'; // 在页面顶部时高亮第一个
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
  window.addEventListener('resize', updateCurrent);
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
      await load();
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
    load();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  if (state.token) loadUsers();
  store.set('sabonner.tab', null); // 旧版选项卡的残留
  updateCurrent();
})();
