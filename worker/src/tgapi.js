// Telegram Bot API 薄封装（全部走 ctx.fetch，计入子请求预算）

export async function tg(ctx, method, body) {
  const r = await ctx.fetch(`https://api.telegram.org/bot${ctx.env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, error_code: r.status, description: 'bad json' }));
  return j;
}

const BASE_OPTS = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

export const sendMessage = (ctx, chat_id, text, extra = {}) =>
  tg(ctx, 'sendMessage', { chat_id, text, ...BASE_OPTS, ...extra });

export const editMessage = (ctx, chat_id, message_id, text, extra = {}) =>
  tg(ctx, 'editMessageText', { chat_id, message_id, text, ...BASE_OPTS, ...extra });

export const answerCallback = (ctx, callback_query_id, text = '', show_alert = false) =>
  tg(ctx, 'answerCallbackQuery', { callback_query_id, text, show_alert });

// [[{text, data}], ...] -> inline_keyboard
export const kb = (rows) => ({
  reply_markup: { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) },
});
