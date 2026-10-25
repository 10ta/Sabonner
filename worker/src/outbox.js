// 发件队列：所有推送先入队，再在预算内发出；发不完的留到下一次（cron 每 2 分钟发一次）
// kind:
//   send       普通消息
//   live_open  直播卡片首发，记下 message_id 以便后续编辑
//   live_edit  编辑直播卡片（同一场同一聊天只保留最新一条）
//   end_edit   赛后数据到了，给已发出的结束消息补上记分板
//   daily      每日预报：发出后置顶
//
// 自动删除（发出成功后立即执行，和触发它的消息一起；Telegram 只能删 48 小时内的消息）：
//   直播卡片发出       → 删这场的 30 分钟提醒
//   比赛结束发出       → 删这场的 30 分钟提醒、直播卡片、各张地图结束消息
//   每日预报发出       → 删之前的每日预报、置顶产生的「已置顶」提示，以及已经不在进行的比赛留下的上述消息
// 赛果和斗鱼开播提醒保留

import { now } from './util.js';
import { sendMessage, editMessage, tg } from './tgapi.js';

// extra：调用方别的写入（如比赛状态），和入队放在同一个 batch 里提交，少一次 D1 往返
export async function enqueue(db, items, extra = []) {
  if (!items.length) { if (extra.length) await db.batch(extra); return; }
  const t = now();
  const stmts = [...extra];
  for (const it of items) {
    if (it.kind === 'live_edit') {
      stmts.push(db.prepare("DELETE FROM outbox WHERE kind = 'live_edit' AND match_id = ? AND chat_id = ?").bind(it.match_id, it.chat_id));
    }
    stmts.push(db.prepare('INSERT INTO outbox (chat_id, kind, text, match_id, meta, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(it.chat_id, it.kind, it.text, it.match_id ?? null, it.meta ?? null, it.tag ?? null, t));
  }
  await db.batch(stmts);
}

// 同一组接收人各发一份
// tag：pre / map / end，见文件开头的自动删除规则
export const fanout = (chatIds, kind, text, match_id, tag) => chatIds.map((chat_id) => ({ chat_id, kind, text, match_id, tag }));

// ---------- 自动删除 ----------

const DELETABLE = 47 * 3600;           // Telegram 只能删 48 小时内的消息，留 1 小时余量
const MATCH_TAGS = ['pre', 'live', 'map'];

// 一次 flush 里的消息簿：库里已有的记录 + 本次新发出的
class Book {
  constructor(rows, active) { this.rows = rows; this.active = active; this.added = []; this.gone = new Set(); }
  add(chat_id, message_id, tag, match_id) {
    const r = { chat_id, message_id, tag, match_id: match_id ?? null, sent_at: now() };
    this.rows.push(r); this.added.push(r);
  }
  // 选出这个聊天里符合条件的消息，调用 deleteMessages（一次请求最多 100 条）
  async purge(ctx, reserve, chat_id, pick, extra = []) {
    const key = (r) => `${r.chat_id}:${r.message_id}`;
    const list = this.rows.filter((r) => r.chat_id === chat_id && !this.gone.has(key(r)) && pick(r));
    const limit = now() - DELETABLE;
    const ids = [...new Set([...list.filter((r) => r.sent_at > limit).map((r) => r.message_id), ...extra])].slice(0, 100);
    if (ids.length) {
      if (ctx.left() <= reserve) return; // 没预算了：记录留着，下次每日预报时一起清
      const res = await tg(ctx, 'deleteMessages', { chat_id, message_ids: ids });
      if (!res.ok && res.error_code !== 400) return; // 限流等：下次再删
    }
    for (const r of list) this.gone.add(key(r)); // 删掉了，或者已经超过 48 小时删不了
  }
  stmts(db) {
    const out = [];
    const gone = [...this.gone].map((k) => `(${k.replace(':', ',')})`);
    if (gone.length) out.push(db.prepare(`DELETE FROM tg_msgs WHERE (chat_id, message_id) IN (VALUES ${gone.join(',')})`));
    const add = this.added.filter((r) => !this.gone.has(`${r.chat_id}:${r.message_id}`));
    if (add.length) {
      out.push(db.prepare(`INSERT OR REPLACE INTO tg_msgs (chat_id, message_id, tag, match_id, sent_at) VALUES ${add.map((r) =>
        `(${Number(r.chat_id)}, ${Number(r.message_id)}, '${r.tag}', ${r.match_id == null ? 'NULL' : Number(r.match_id)}, ${r.sent_at})`).join(', ')}`));
    }
    return out;
  }
}

// 发件前要读的东西（队列、要编辑的卡片和结束消息的 message_id、置顶记录、会触发自动删除的聊天的发送记录、
// 还在进行 / 未开始的比赛）一次 batch 读完。按队列内容用子查询筛，队列里没有对应的消息时这些查询都是空的
const TRIGGER = "(kind IN ('live_open', 'daily') OR tag = 'end')";
export async function flush(ctx, reserve = 0) {
  const db = ctx.env.DB;
  const budget = ctx.left() - reserve;
  if (budget <= 0) return { sent: 0, pending: true };

  const [out, live, pinRows, ends, msgs, act] = await db.batch([
    db.prepare('SELECT * FROM outbox ORDER BY id LIMIT ?').bind(budget),
    db.prepare("SELECT * FROM live_msgs WHERE match_id IN (SELECT match_id FROM outbox WHERE kind = 'live_edit')"),
    db.prepare("SELECT * FROM pins WHERE EXISTS (SELECT 1 FROM outbox WHERE kind = 'daily')"),
    db.prepare("SELECT chat_id, message_id, match_id FROM tg_msgs WHERE tag = 'end' AND match_id IN (SELECT match_id FROM outbox WHERE kind = 'end_edit')"),
    db.prepare(`SELECT * FROM tg_msgs WHERE chat_id IN (SELECT chat_id FROM outbox WHERE ${TRIGGER})`),
    db.prepare(`SELECT id FROM matches WHERE status IN ('current', 'upcoming') AND EXISTS (SELECT 1 FROM outbox WHERE ${TRIGGER})`),
  ]);
  const rows = out.results;
  if (!rows.length) return { sent: 0, pending: false };

  // 可编辑的直播卡片、置顶、结束消息（编辑加记分板用）的 message_id
  const msgMap = new Map(live.results.map((r) => [`${r.match_id}:${r.chat_id}`, r.message_id]));
  const pins = new Map(pinRows.results.map((p) => [p.chat_id, p]));
  const endIds = new Map(ends.results.map((r) => [`${r.match_id}:${r.chat_id}`, r.message_id]));
  // 会触发删除的消息（直播卡片首发、日报、结束消息）：相关聊天的发送记录
  const book = new Book(msgs.results, new Set(act.results.map((r) => r.id)));

  const done = [];
  const retry = [];
  const blocked = new Set(); // 拉黑了 bot / 注销了的用户：本次剩下的直接跳过，结束后移出接收名单
  const opened = [];
  const pinned = [];
  const openPending = new Set(rows.filter((r) => r.kind === 'live_open').map((r) => `${r.match_id}:${r.chat_id}`));
  let sent = 0;

  for (const row of rows) {
    if (ctx.left() <= reserve + (row.kind === 'daily' ? 2 : 0)) break; // 日报要 3 个请求：发送、置顶、删旧消息
    const key = `${row.match_id}:${row.chat_id}`;
    if (blocked.has(Number(row.chat_id))) { done.push(row.id); continue; }
    let res;
    try {
      res = row.kind === 'daily'
        ? await sendDaily(ctx, reserve, row, pins.get(row.chat_id), pinned, book)
        : await sendRow(ctx, reserve, row, key, msgMap, openPending, opened, done, book, endIds);
    } catch (e) {
      // 网络异常：这条记一次失败，其余留到下一次（Telegram 大概率整体不可达）
      console.error('[outbox]', e?.message || e);
      retry.push(row.id);
      break;
    }
    if (res === null) continue;

    if (res.ok) { done.push(row.id); sent++; continue; }
    if (res.error_code === 429) { retry.push(row.id); break; } // 被限流，下次再来
    if (res.error_code === 403) { blocked.add(Number(row.chat_id)); done.push(row.id); continue; } // 用户拉黑 / 注销
    if (res.error_code === 400) { done.push(row.id); continue; } // 消息已删等，丢弃
    retry.push(row.id);
  }

  const stmts = [];
  if (done.length) stmts.push(db.prepare(`DELETE FROM outbox WHERE id IN (${done.join(',')})`));
  if (retry.length) stmts.push(db.prepare(`UPDATE outbox SET tries = tries + 1 WHERE id IN (${retry.join(',')})`));
  for (const [match_id, chat_id, message_id] of opened) {
    stmts.push(db.prepare('INSERT OR REPLACE INTO live_msgs (match_id, chat_id, message_id) VALUES (?, ?, ?)').bind(match_id, chat_id, message_id));
  }
  for (const [chat_id, message_id, day] of pinned) {
    stmts.push(db.prepare('INSERT OR REPLACE INTO pins (chat_id, message_id, day) VALUES (?, ?, ?)').bind(chat_id, message_id, day));
  }
  stmts.push(...book.stmts(db));
  // 拉黑的用户等同于 /stop：移出名单、清掉排队的消息（以后每条推送都不用再白发一次）；重新 /start 可再申请
  if (blocked.size) {
    const ids = [...blocked].join(',');
    stmts.push(db.prepare(`DELETE FROM users WHERE tg_id IN (${ids})`));
    stmts.push(db.prepare(`DELETE FROM outbox WHERE chat_id IN (${ids})`));
  }
  if (stmts.length) await db.batch(stmts);
  return { sent, pending: rows.length > done.length };
}

// 发日报 → 静默置顶 → 一次删掉：前一天的日报（置顶随之消失）、刚产生的「已置顶」提示、
// 已经结束 / 取消的比赛留下的提醒和直播卡片（正常流程漏删的兜底）
async function sendDaily(ctx, reserve, row, oldPin, pinned, book) {
  const chat = Number(row.chat_id);
  const res = await sendMessage(ctx, chat, row.text);
  if (!res.ok) return res;
  const mid = res.result.message_id;
  book.add(chat, mid, 'daily');
  const pin = await tg(ctx, 'pinChatMessage', { chat_id: chat, message_id: mid, disable_notification: true });
  const extra = [];
  if (pin.ok) {
    pinned.push([chat, mid, row.meta || '']);
    // 私聊里置顶会紧跟着产生一条「xx pinned …」的服务消息，id 就是下一个
    extra.push(mid + 1);
  }
  // 旧置顶已经超过 48 小时（比如中间停过几天）删不掉了，就只取消置顶
  if (oldPin && oldPin.message_id !== mid && oldPin.day && Date.parse(oldPin.day) / 1000 < now() - 2 * 86400 && ctx.left() > reserve + 1) {
    await tg(ctx, 'unpinChatMessage', { chat_id: chat, message_id: oldPin.message_id });
  }
  // 升级前的日报没有发送记录，用置顶表里的那条补上
  if (oldPin && oldPin.message_id !== mid && !book.rows.some((r) => r.chat_id === chat && r.message_id === oldPin.message_id)) {
    extra.push(oldPin.message_id);
  }
  await book.purge(ctx, reserve, chat,
    (r) => (r.tag === 'daily' && r.message_id !== mid) || (MATCH_TAGS.includes(r.tag) && !book.active.has(r.match_id)), extra);
  return res;
}

// 发一条；返回 Telegram 响应，或 null 表示本次跳过（需要丢弃时已自行放进 done）
async function sendRow(ctx, reserve, row, key, msgMap, openPending, opened, done, book, endIds) {
  if (row.kind === 'end_edit') { // 给已发出的结束消息补上记分板；找不到（太久、已删）就算了
    const mid = endIds.get(key);
    if (!mid) { done.push(row.id); return null; }
    const res = await editMessage(ctx, row.chat_id, mid, row.text);
    if (!res.ok && /not modified/i.test(res.description || '')) return { ok: true };
    return res;
  }
  if (row.kind === 'live_edit') {
    const mid = msgMap.get(key);
    if (!mid) {
      if (!openPending.has(key)) done.push(row.id); // 卡片从没发出去，丢弃
      return null; // 卡片还在队列里没发成，这条编辑留着下次
    }
    const res = await editMessage(ctx, row.chat_id, mid, row.text);
    if (!res.ok && /not modified/i.test(res.description || '')) return { ok: true };
    return res;
  }
  const res = await sendMessage(ctx, row.chat_id, row.text);
  if (!res.ok) return res;
  const chat = Number(row.chat_id);
  const mid = res.result.message_id;
  const m = row.match_id;
  if (row.kind === 'live_open') {
    opened.push([m, chat, mid]);
    msgMap.set(key, mid);
    openPending.delete(key);
    book.add(chat, mid, 'live', m);
    await book.purge(ctx, reserve, chat, (r) => r.match_id === m && r.tag === 'pre'); // 开赛了，30 分钟提醒没用了
  } else if (row.tag === 'pre' || row.tag === 'map') {
    book.add(chat, mid, row.tag, m);
  } else if (row.tag === 'end') {
    book.add(chat, mid, 'end', m); // 记下来：赛后数据出来后要编辑这条，加上记分板
    endIds.set(`${m}:${chat}`, mid);
    // 结束消息里已经有全部地图比分，之前的提醒、直播卡片、地图消息都删掉
    await book.purge(ctx, reserve, chat, (r) => r.match_id === m && MATCH_TAGS.includes(r.tag));
  }
  return res;
}
