// 发件队列：所有推送先入队，再在预算内发出；发不完的留到下一分钟
// kind:
//   send       普通消息
//   live_open  直播卡片首发，记下 message_id 以便后续编辑
//   live_edit  编辑直播卡片（同一场同一聊天只保留最新一条）
//   daily      每日预报：发出后置顶，并取消前一天的置顶

import { now } from './util.js';
import { sendMessage, editMessage, tg } from './tgapi.js';

export async function enqueue(db, items) {
  if (!items.length) return;
  const t = now();
  const stmts = [];
  for (const it of items) {
    if (it.kind === 'live_edit') {
      stmts.push(db.prepare("DELETE FROM outbox WHERE kind = 'live_edit' AND match_id = ? AND chat_id = ?").bind(it.match_id, it.chat_id));
    }
    stmts.push(db.prepare('INSERT INTO outbox (chat_id, kind, text, match_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(it.chat_id, it.kind, it.text, it.match_id ?? null, it.meta ?? null, t));
  }
  await db.batch(stmts);
}

// 同一组接收人各发一份
export const fanout = (chatIds, kind, text, match_id) => chatIds.map((chat_id) => ({ chat_id, kind, text, match_id }));

export async function flush(ctx, reserve = 0) {
  const db = ctx.env.DB;
  const budget = ctx.left() - reserve;
  if (budget <= 0) return { sent: 0, pending: true };

  const { results: rows } = await db.prepare('SELECT * FROM outbox ORDER BY id LIMIT ?').bind(budget).all();
  if (!rows.length) return { sent: 0, pending: false };

  // 需要的可编辑消息 id
  const editIds = [...new Set(rows.filter((r) => r.kind === 'live_edit').map((r) => r.match_id))];
  const msgMap = new Map();
  if (editIds.length) {
    const { results } = await db.prepare(`SELECT * FROM live_msgs WHERE match_id IN (${editIds.map(() => '?').join(',')})`).bind(...editIds).all();
    for (const r of results) msgMap.set(`${r.match_id}:${r.chat_id}`, r.message_id);
  }

  const pins = new Map();
  if (rows.some((r) => r.kind === 'daily')) {
    const { results } = await db.prepare('SELECT * FROM pins').all();
    for (const p of results) pins.set(p.chat_id, p);
  }

  const done = [];
  const retry = [];
  const opened = [];
  const pinned = [];
  const openPending = new Set(rows.filter((r) => r.kind === 'live_open').map((r) => `${r.match_id}:${r.chat_id}`));
  let sent = 0;

  for (const row of rows) {
    if (ctx.left() <= reserve + (row.kind === 'daily' ? 2 : 0)) break; // 日报要 3 个请求：发送、置顶、取消旧置顶
    const key = `${row.match_id}:${row.chat_id}`;
    let res;
    try {
      res = row.kind === 'daily'
        ? await sendDaily(ctx, row, pins.get(row.chat_id), pinned)
        : await sendRow(ctx, row, key, msgMap, openPending, opened, done);
    } catch (e) {
      // 网络异常：这条记一次失败，其余留到下一分钟（Telegram 大概率整体不可达）
      console.error('[outbox]', e?.message || e);
      retry.push(row.id);
      break;
    }
    if (res === null) continue;

    if (res.ok) { done.push(row.id); sent++; continue; }
    if (res.error_code === 429) { retry.push(row.id); break; } // 被限流，下分钟再来
    if (res.error_code === 403 || res.error_code === 400) { done.push(row.id); continue; } // 用户拉黑 / 消息已删，丢弃
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
  if (stmts.length) await db.batch(stmts);
  return { sent, pending: rows.length > done.length };
}

// 发日报 → 静默置顶 → 取消上一条日报的置顶（失败都不影响消息本身）
async function sendDaily(ctx, row, oldPin, pinned) {
  const res = await sendMessage(ctx, row.chat_id, row.text);
  if (!res.ok) return res;
  const mid = res.result.message_id;
  const pin = await tg(ctx, 'pinChatMessage', { chat_id: row.chat_id, message_id: mid, disable_notification: true });
  if (pin.ok) {
    if (oldPin && oldPin.message_id !== mid) {
      await tg(ctx, 'unpinChatMessage', { chat_id: row.chat_id, message_id: oldPin.message_id });
    }
    pinned.push([row.chat_id, mid, row.meta || '']);
  }
  return res;
}

// 发一条；返回 Telegram 响应，或 null 表示本次跳过（需要丢弃时已自行放进 done）
async function sendRow(ctx, row, key, msgMap, openPending, opened, done) {
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
  if (res.ok && row.kind === 'live_open') {
    opened.push([row.match_id, row.chat_id, res.result.message_id]);
    msgMap.set(key, res.result.message_id);
    openPending.delete(key);
  }
  return res;
}
