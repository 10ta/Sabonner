// Sabonner Worker 入口
//   POST /tg        Telegram webhook（校验 secret header）
//   GET  /setup     注册 webhook 和命令菜单（需要 ?token=ADMIN_TOKEN）
//   GET  /api/*     网页用的只读接口；/api/admin/* 需要 Authorization: Bearer ADMIN_TOKEN
//   cron            见 engine.js

import { makeCtx, json, safeEqual, CORS } from './util.js';
import { handleUpdate, setup } from './bot.js';
import { handleApi } from './api.js';
import { runCron } from './engine.js';

export default {
  async fetch(req, env, execCtx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS }); // CORS 预检

    if (path === '/tg' && req.method === 'POST') {
      if (!safeEqual(req.headers.get('x-telegram-bot-api-secret-token'), env.TG_WEBHOOK_SECRET)) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await req.json().catch(() => null);
      if (update) {
        // 先回 200 给 Telegram，处理放到后台，避免慢请求导致 Telegram 重发
        execCtx.waitUntil(handleUpdate(makeCtx(env), update).catch((e) => console.error('[tg]', e?.stack || e)));
      }
      return new Response('ok');
    }

    if (path === '/setup') {
      if (!safeEqual(url.searchParams.get('token'), env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
      return json(await setup(makeCtx(env), url.origin));
    }

    if (path.startsWith('/api/')) return handleApi(req, env, path, makeCtx(env));

    if (path === '/') return new Response('Sabonner is running.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  },

  async scheduled(event, env, execCtx) {
    execCtx.waitUntil(runCron(makeCtx(env)));
  },
};
