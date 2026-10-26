// VPS 运行器的看门狗（Worker 的 cron，每 10 分钟一次）：
// 运行器每 5 分钟往 kv 'runner' 写一次心跳；超过 STALE 没更新就给管理员发一条 Telegram（之后每 6 小时最多再提醒一次），
// 恢复后再发一条。运行器停了的时候推送会停，网页数据也停在最后一次更新，所以要尽快知道。

import { now } from './util.js';
import { setKVStmt } from './db.js';
import { sendMessage } from './tgapi.js';

const STALE = 15 * 60;
const REPEAT = 6 * 3600;

export async function watchRunner(ctx) {
  const db = ctx.env.DB;
  const t = now();
  const [hb, al] = await db.batch([
    db.prepare("SELECT v FROM kv WHERE k = 'runner'"),
    db.prepare("SELECT v FROM kv WHERE k = 'runner_alert'"),
  ]);
  let info = null;
  try { info = JSON.parse(hb.results[0]?.v || 'null'); } catch { /* 坏数据当没有 */ }
  const age = info?.at ? t - info.at : Infinity;
  const alerted = Number(al.results[0]?.v) || 0;
  const owner = Number(ctx.env.OWNER_ID);
  console.log(`[watch] runner ${Number.isFinite(age) ? `${age}s ago` : 'never'}${alerted ? ' (alerted)' : ''}`);

  if (age > STALE) {
    if (alerted && t - alerted < REPEAT) return;
    const when = Number.isFinite(age) ? `${Math.round(age / 60)} 分钟没有心跳` : '从没上报过心跳';
    await sendMessage(ctx, owner, `⚠️ <b>Sabonner 运行器</b>${info?.host ? `（${info.host}）` : ''}${when}，比赛和开播推送暂停中。\n在那台机器上看看：<code>systemctl status sabonner-runner</code>`);
    await db.batch([setKVStmt(db, 'runner_alert', t)]);
  } else if (alerted) {
    await sendMessage(ctx, owner, `✅ <b>Sabonner 运行器</b>${info?.host ? `（${info.host}）` : ''}恢复了。`);
    await db.prepare("DELETE FROM kv WHERE k = 'runner_alert'").run();
  }
}
