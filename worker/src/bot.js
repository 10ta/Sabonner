// Telegram webhook：命令、内联按钮、用户审批
//
// 角色：
//   owner     OWNER_ID，全部功能
//   approved  经 owner 批准，只能查看 + 接收推送
//   pending   已申请，等待批准
//   denied    被拒绝 / 撤销
//   其他人    /start 即提交申请

import { now, esc, isOwner, tierLabel } from './util.js';
import { getSubs, getStreamers, listMatches } from './db.js';
import { searchTeams, teamById, flag } from './bo3.js';
import { roomInfo, roomUrl } from './douyu.js';
import { matchList } from './format.js';
import { refreshSchedule, buildDaily, eventsTick } from './engine.js';
import { tg, sendMessage, editMessage, answerCallback, kb } from './tgapi.js';

const TIERS = ['s', 'a', 'b', 'c'];

const HELP_PUBLIC = [
  '<b>Sabonner</b> · CS2 比赛与斗鱼开播提醒',
  '',
  '/today 今明两天赛程',
  '/next 即将开始的比赛',
  '/live 正在进行的比赛',
  '/results 最近赛果',
  '/subs 当前订阅的队伍和 tier',
  '/rooms 斗鱼主播状态',
  '/stop 不再接收推送',
].join('\n');

const HELP_OWNER = [
  HELP_PUBLIC.replace('\n/stop 不再接收推送', ''),
  '',
  '<b>管理</b>',
  '/team 名字 — 搜索并订阅队伍；不带参数列出已订阅',
  '/tier — 切换订阅的 tier',
  '/stars — 按比赛星级订阅（≥ 几星）',
  '/room 房间号 — 添加斗鱼主播；不带参数列出并可删除',
  '/users — 用户审批与撤销',
  '/refresh — 立即刷新赛程',
  '/status — 运行状态',
].join('\n');

export const PUBLIC_COMMANDS = [
  ['today', '今明两天赛程'], ['next', '即将开始的比赛'], ['live', '正在进行的比赛'], ['results', '最近赛果'],
  ['subs', '订阅的队伍和 tier'], ['rooms', '斗鱼主播状态'], ['help', '帮助'], ['stop', '不再接收推送'],
];
export const OWNER_COMMANDS = [
  ['today', '今明两天赛程'], ['next', '即将开始的比赛'], ['live', '正在进行的比赛'], ['results', '最近赛果'],
  ['subs', '订阅'], ['rooms', '斗鱼主播'], ['team', '搜索/管理队伍'], ['tier', '切换 tier'],
  ['stars', '按星级订阅'], ['room', '添加/管理斗鱼房间'], ['users', '用户审批'], ['refresh', '刷新赛程'], ['status', '运行状态'], ['help', '帮助'],
];

async function roleOf(env, id) {
  if (isOwner(env, id)) return 'owner';
  const r = await env.DB.prepare('SELECT status FROM users WHERE tg_id = ?').bind(id).first();
  return r ? r.status : 'none';
}

const displayName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);

export async function handleUpdate(ctx, update) {
  if (update.callback_query) return handleCallback(ctx, update.callback_query);
  const msg = update.message;
  if (!msg?.text || msg.chat?.type !== 'private') return;

  const env = ctx.env;
  const from = msg.from;
  const chat = msg.chat.id;
  const [rawCmd, ...rest] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.startsWith('/') ? rawCmd.slice(1).split('@')[0].toLowerCase() : '';
  const arg = rest.join(' ').trim();
  const role = await roleOf(env, from.id);
  const reply = (text, extra) => sendMessage(ctx, chat, text, extra);

  // ---------- 未批准的人 ----------
  if (role === 'none') {
    if (cmd !== 'start') return reply('发送 /start 申请使用。');
    await env.DB.prepare('INSERT OR REPLACE INTO users (tg_id, name, username, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(from.id, displayName(from), from.username || null, 'pending', now()).run();
    if (env.OWNER_ID) {
      await sendMessage(ctx, Number(env.OWNER_ID),
        `🆕 新用户申请\n${esc(displayName(from))}${from.username ? ` (@${esc(from.username)})` : ''}\nID <code>${from.id}</code>`,
        kb([[{ text: '✅ 批准', data: `u+:${from.id}` }, { text: '❌ 拒绝', data: `u-:${from.id}` }]]));
    }
    return reply('已提交申请，等待批准。批准后会通知你。');
  }
  if (role === 'pending') return reply('申请审核中，请稍候。');
  if (role === 'denied') return; // 不回应

  // ---------- 已批准用户 + owner ----------
  const owner = role === 'owner';
  switch (cmd) {
    case 'start':
    case 'help':
      // 管理员菜单只能在对方和 bot 有过对话后设置，所以在 owner 发 /start 时补设一次
      if (owner && cmd === 'start') await setOwnerCommands(ctx).catch(() => null);
      return reply(owner ? HELP_OWNER : HELP_PUBLIC);
    case 'today': {
      const t = now();
      return reply(await buildDaily(ctx, t - (t % 86400)));
    }
    case 'next':
      return reply(matchList('📅 <b>即将开始</b>', await listMatches(env.DB, 'upcoming', 15), ctx.tz, 'next'));
    case 'live':
      return reply(matchList('🔴 <b>进行中</b>', await listMatches(env.DB, 'live'), ctx.tz, 'live'));
    case 'results':
      return reply(matchList('🏁 <b>最近赛果</b>', await listMatches(env.DB, 'results', 15), ctx.tz, 'results'));
    case 'subs':
      return reply(await subsText(env.DB));
    case 'rooms':
      return reply(await roomsText(env.DB));
    case 'stop':
      if (owner) return reply('你是管理员，推送无法关闭。');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM users WHERE tg_id = ?').bind(from.id),
        env.DB.prepare('DELETE FROM outbox WHERE chat_id = ?').bind(from.id), // 排队中的推送也不再发
      ]);
      return reply('已停止推送。想恢复的话重新发送 /start 申请。');
  }

  if (!owner) return reply('未知命令，发送 /help 查看可用命令。');

  // ---------- owner 专用 ----------
  switch (cmd) {
    case 'team':
      return arg ? teamSearch(ctx, chat, arg) : reply(...await teamListView(env.DB));
    case 'tier':
      return reply(...await tierView(env.DB));
    case 'stars':
      return reply(...await starsView(env.DB));
    case 'room':
      return arg ? roomAdd(ctx, chat, arg) : reply(...await roomListView(env.DB));
    case 'users':
      return reply(...await usersView(env.DB));
    case 'refresh': {
      const [r, ev] = await Promise.all([refreshSchedule(ctx), eventsTick(ctx, true).catch(() => null)]);
      return reply(`已刷新，正在跟踪 ${r.tracked} 场比赛${ev != null ? `，赛事列表 ${ev} 个` : ''}。`);
    }
    case 'status':
      return reply(await statusText(env));
    default:
      return reply('未知命令，发送 /help 查看。');
  }
}

// ---------- 视图 ----------

async function subsText(db) {
  const s = await getSubs(db);
  const tiers = s.tiers.length ? s.tiers.map(tierLabel).join(' / ') : '无';
  const teams = s.teams.length ? s.teams.map((t) => `${flag(t.cc)}${flag(t.cc) ? ' ' : ''}${esc(t.name)}`).join('、') : '无';
  const stars = s.stars ? `${'★'.repeat(s.stars)} 及以上` : '无';
  return `<b>订阅</b>（三项任一命中就推送）\nTier：${tiers}\n星级：${stars}\n队伍：${teams}`;
}

async function roomsText(db) {
  const rooms = await getStreamers(db);
  if (!rooms.length) return '📺 还没有添加斗鱼主播。';
  return ['📺 <b>斗鱼主播</b>', ...rooms.map((r) =>
    `${r.live ? '🔴' : '⚫'} <a href="${roomUrl(r.room_id)}">${esc(r.owner || `斗鱼 ${r.room_id}`)}</a>${r.category ? ` · ${esc(r.category)}` : ''}${r.live && r.title ? `\n　 ${esc(r.title)}` : ''}`)].join('\n');
}

async function teamListView(db) {
  const { teams } = await getSubs(db);
  if (!teams.length) return ['还没有订阅队伍。用 /team 名字 搜索，例如 /team Spirit'];
  return ['<b>已订阅队伍</b>（点按钮退订）', kb(teams.map((t) => [{ text: `➖ ${flag(t.cc)} ${t.name}`.replace('  ', ' '), data: `t-:${t.team_id}` }]))];
}

async function tierView(db) {
  const { tiers } = await getSubs(db);
  const on = new Set(tiers);
  return [
    '<b>Tier 订阅</b>（点按钮切换）\n订阅某个 tier 会收到该级别所有比赛的预告和比分。',
    kb([TIERS.map((t) => ({ text: `${on.has(t) ? '✅' : '⬜'} ${tierLabel(t)}`, data: `tier:${t}` }))]),
  ];
}

async function starsView(db) {
  const { stars } = await getSubs(db);
  return [
    `<b>按星级订阅</b>（点按钮切换）\n当前：${stars ? `${'★'.repeat(stars)} 及以上` : '关闭'}\nbo3 给比赛打 0–5 星，越高越受关注。和 tier、队伍订阅是「或」的关系。`,
    kb([[1, 2, 3].map((n) => ({ text: `${stars === n ? '✅ ' : ''}≥${n}★`, data: `stars:${n}` })),
      [4, 5].map((n) => ({ text: `${stars === n ? '✅ ' : ''}≥${n}★`, data: `stars:${n}` })).concat([{ text: stars ? '关闭' : '✅ 关闭', data: 'stars:0' }])]),
  ];
}

async function roomListView(db) {
  const rooms = await getStreamers(db);
  if (!rooms.length) return ['还没有斗鱼主播。用 /room 房间号 添加，例如 /room 6657'];
  return ['<b>斗鱼主播</b>（点按钮删除）', kb(rooms.map((r) => [{ text: `➖ ${r.owner || r.room_id} (${r.room_id})`, data: `r-:${r.room_id}` }]))];
}

async function usersView(db) {
  const { results } = await db.prepare(`SELECT * FROM users ORDER BY
    CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at`).all();
  if (!results.length) return ['还没有其他用户。'];
  const icon = { pending: '⏳', approved: '✅', denied: '🚫' };
  const lines = ['<b>用户</b>（⏳ 待审批 ✅ 已批准 🚫 已拒绝）'];
  const rows = [];
  for (const u of results) {
    const label = `${u.name || u.tg_id}${u.username ? ` @${u.username}` : ''}`;
    lines.push(`${icon[u.status] || '?'} ${esc(label)} <code>${u.tg_id}</code>`);
    if (u.status === 'approved') rows.push([{ text: `撤销 ${label}`.slice(0, 40), data: `u-:${u.tg_id}` }]);
    else if (u.status === 'pending') rows.push([{ text: `✅ ${label}`.slice(0, 30), data: `u+:${u.tg_id}` }, { text: '❌', data: `u-:${u.tg_id}` }]);
    else rows.push([{ text: `重新批准 ${label}`.slice(0, 40), data: `u+:${u.tg_id}` }]);
  }
  return [lines.join('\n'), kb(rows)];
}

async function statusText(env) {
  const db = env.DB;
  const [a, b, c, d, e, f] = await db.batch([
    db.prepare("SELECT COUNT(*) n FROM matches WHERE status IN ('upcoming', 'current')"),
    db.prepare("SELECT COUNT(*) n FROM matches WHERE status = 'current'"),
    db.prepare('SELECT COUNT(*) n FROM outbox'),
    db.prepare("SELECT COUNT(*) n FROM users WHERE status = 'approved'"),
    db.prepare("SELECT v FROM kv WHERE k = 'last_refresh'"),
    db.prepare("SELECT v FROM kv WHERE k = 'runner'"),
  ]);
  const last = Number(e.results[0]?.v) || 0;
  let runner = null;
  try { runner = JSON.parse(f.results[0]?.v || 'null'); } catch { /* 当没有 */ }
  const age = runner?.at ? now() - runner.at : null;
  const runnerLine = !runner ? '运行器：没有（由 Worker 的 cron 运行）'
    : `运行器：${age < 15 * 60 ? '在线' : '⚠️ 离线'}（${esc(runner.host || '?')}，${Math.round(age / 60)} 分钟前心跳，版本 ${esc(runner.ver || '?')}）${runner.blocked?.length ? `\n⚠️ 被拦截、改走中转：${runner.blocked.map(esc).join('、')}` : ''}`;
  return [
    '<b>运行状态</b>',
    `跟踪比赛：${a.results[0].n}（进行中 ${b.results[0].n}）`,
    `待发消息：${c.results[0].n}`,
    `已批准用户：${d.results[0].n}`,
    `上次刷新：${last ? `${Math.round((now() - last) / 60)} 分钟前` : '从未'}`,
    runnerLine,
  ].join('\n');
}

// ---------- 操作 ----------

async function teamSearch(ctx, chat, q) {
  let list;
  try { list = await searchTeams(ctx, q); } catch { return sendMessage(ctx, chat, 'bo3 搜索失败，稍后再试。'); }
  if (!list.length) return sendMessage(ctx, chat, `没找到「${esc(q)}」。试试队伍的英文全名或简称。`);
  return sendMessage(ctx, chat, `搜索「${esc(q)}」，点按钮订阅：`,
    kb(list.map((t) => [{ text: `➕ ${flag(t.cc)} ${t.name}${t.rank ? ` #${t.rank}` : ''}`.replace('  ', ' '), data: `t+:${t.id}` }])));
}

async function roomAdd(ctx, chat, arg) {
  const id = (arg.match(/(\d{2,})/) || [])[1];
  if (!id) return sendMessage(ctx, chat, '房间号格式不对，例如 /room 6657 或直接贴 douyu.com/6657。');
  let info;
  try { info = await roomInfo(ctx, id); } catch { return sendMessage(ctx, chat, '斗鱼接口访问失败，稍后再试。'); }
  if (!info.ok) return sendMessage(ctx, chat, `房间 ${id} 不存在或无法读取。`);
  await addRoom(ctx.env.DB, id, info);
  return sendMessage(ctx, chat, `已添加 <b>${esc(info.owner || id)}</b>（${id}${info.category ? ' · ' + esc(info.category) : ''}），当前${info.live ? '🔴 直播中' : '未开播'}。开播时会通知所有人。`);
}

// changed_at 只记真实的开/下播时刻，添加时留空；show_time 记下当前这场，避免刚添加就推「开播了」
export function addRoom(db, id, info) {
  return db.prepare(`INSERT INTO streamers (room_id, owner, title, category, avatar, live, show_time, changed_at, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(room_id) DO UPDATE SET owner = excluded.owner, title = excluded.title, category = excluded.category, avatar = excluded.avatar,
      live = excluded.live, show_time = COALESCE(excluded.show_time, streamers.show_time)`)
    .bind(id, info.owner, info.title, info.category || null, info.avatar || null, info.live ? 1 : 0, info.live ? info.showTime : null, now()).run();
}

export function addTeam(db, team) {
  return db.prepare(`INSERT INTO sub_teams (team_id, name, slug, cc, logo, added_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, slug = excluded.slug, cc = excluded.cc, logo = excluded.logo`)
    .bind(team.id, team.name, team.slug, team.cc ?? null, team.logo ?? null, now()).run();
}

// ---------- 按钮回调（只有 owner 能操作） ----------

async function handleCallback(ctx, cq) {
  const env = ctx.env;
  if (!isOwner(env, cq.from.id)) return answerCallback(ctx, cq.id, '只有管理员能操作');
  const [act, val] = String(cq.data || '').split(':');
  const chat = cq.message?.chat?.id;
  const mid = cq.message?.message_id;
  const db = env.DB;
  const rerender = ([text, extra]) => (chat && mid ? editMessage(ctx, chat, mid, text, extra || { reply_markup: { inline_keyboard: [] } }) : null);

  switch (act) {
    case 't+': {
      const team = await teamById(ctx, Number(val)).catch(() => null);
      if (!team) return answerCallback(ctx, cq.id, '找不到这支队伍', true);
      await addTeam(db, team);
      const r = await refreshSchedule(ctx).catch(() => null);
      await answerCallback(ctx, cq.id, `已订阅 ${team.name}`);
      return sendMessage(ctx, chat, `已订阅 <b>${esc(team.name)}</b>。${r ? `当前跟踪 ${r.tracked} 场比赛。` : ''}`);
    }
    case 't-': {
      await db.prepare('DELETE FROM sub_teams WHERE team_id = ?').bind(Number(val)).run();
      await refreshSchedule(ctx).catch(() => null);
      await answerCallback(ctx, cq.id, '已退订');
      return rerender(await teamListView(db));
    }
    case 'tier': {
      if (!TIERS.includes(val)) return answerCallback(ctx, cq.id);
      const has = await db.prepare('SELECT 1 FROM sub_tiers WHERE tier = ?').bind(val).first();
      await db.prepare(has ? 'DELETE FROM sub_tiers WHERE tier = ?' : 'INSERT INTO sub_tiers (tier) VALUES (?)').bind(val).run();
      await refreshSchedule(ctx).catch(() => null);
      await answerCallback(ctx, cq.id, `${tierLabel(val)} ${has ? '已关闭' : '已开启'}`);
      return rerender(await tierView(db));
    }
    case 'stars': {
      const n = Math.max(0, Math.min(5, Number(val) || 0));
      await db.prepare("INSERT INTO kv (k, v) VALUES ('sub_stars', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(n)).run();
      const r = await refreshSchedule(ctx).catch(() => null);
      await answerCallback(ctx, cq.id, n ? `已订阅 ${n} 星及以上${r ? `，跟踪 ${r.tracked} 场` : ''}` : '已关闭星级订阅');
      return rerender(await starsView(db));
    }
    case 'r-': {
      await db.prepare('DELETE FROM streamers WHERE room_id = ?').bind(val).run();
      await answerCallback(ctx, cq.id, '已删除');
      return rerender(await roomListView(db));
    }
    case 'u+': {
      const id = Number(val);
      const r = await db.prepare("UPDATE users SET status = 'approved' WHERE tg_id = ?").bind(id).run();
      if (!r.meta.changes) return answerCallback(ctx, cq.id, '用户不存在', true);
      await sendMessage(ctx, id, '✅ 申请已通过，之后会收到比赛和开播推送。发送 /help 查看命令。');
      await answerCallback(ctx, cq.id, '已批准');
      return rerender(await usersView(db));
    }
    case 'u-': {
      const id = Number(val);
      const u = await db.prepare('SELECT status FROM users WHERE tg_id = ?').bind(id).first();
      await db.batch([
        db.prepare("UPDATE users SET status = 'denied' WHERE tg_id = ?").bind(id),
        db.prepare('DELETE FROM outbox WHERE chat_id = ?').bind(id),
      ]);
      if (u?.status === 'approved') await sendMessage(ctx, id, '你的推送权限已被撤销。');
      await answerCallback(ctx, cq.id, u?.status === 'approved' ? '已撤销' : '已拒绝');
      return rerender(await usersView(db));
    }
    default:
      return answerCallback(ctx, cq.id);
  }
}

// ---------- 初始化：webhook + 命令菜单 ----------

const toCmds = (list) => list.map(([command, description]) => ({ command, description }));

export function setOwnerCommands(ctx) {
  return tg(ctx, 'setMyCommands', {
    commands: toCmds(OWNER_COMMANDS),
    scope: { type: 'chat', chat_id: Number(ctx.env.OWNER_ID) },
  });
}

export async function setup(ctx, origin) {
  const env = ctx.env;
  const out = {};
  out.webhook = await tg(ctx, 'setWebhook', {
    url: `${origin}/tg`,
    secret_token: env.TG_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  out.publicCommands = await tg(ctx, 'setMyCommands', { commands: toCmds(PUBLIC_COMMANDS) });
  if (env.OWNER_ID) {
    out.ownerCommands = await setOwnerCommands(ctx);
    // 管理员还没给 bot 发过消息时 Telegram 会报 chat not found，不影响使用：发 /start 时会自动补设
    if (!out.ownerCommands.ok && /chat not found/i.test(out.ownerCommands.description || '')) {
      out.ownerCommands.hint = 'send /start to the bot; the admin menu will be set then';
    }
  }
  return out;
}
