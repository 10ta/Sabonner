// Sabonner Worker 入口
//   POST /tg        Telegram webhook（校验 secret header）
//   GET  /setup     注册 webhook 和命令菜单（需要 ?token=ADMIN_TOKEN）
//   GET  /api/*     网页用的只读接口；/api/admin/* 需要 Authorization: Bearer ADMIN_TOKEN
//   GET  /relay     VPS 运行器的备用出口：运行器直连 bo3 / 斗鱼被拦截时经这里转发（需要 x-relay-key: ADMIN_TOKEN，只放行这两个站）
//   cron            每 10 分钟：检查 VPS 运行器的心跳（watch.js）；改成每分钟（"* * * * *"）就是不用运行器、由 Worker 自己跑（engine.js）

import { makeCtx, json, safeEqual, CORS } from './util.js';
import { handleUpdate, setup } from './bot.js';
import { handleApi } from './api.js';
import { runCron } from './engine.js';
import { watchRunner } from './watch.js';

const RELAY_HOSTS = new Set(['api.bo3.gg', 'm.douyu.com']);

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

    // 队徽 / 赛事图片中转：只给网页分析配色用（判断浅色 / 深色背景下看不看得清），
    // 只放行 bo3 的图片域名，浏览器缓存 30 天
    if (path === '/img' && req.method === 'GET') {
      const u = url.searchParams.get('u') || '';
      let target;
      try { target = new URL(u); } catch { return new Response('bad url', { status: 400 }); }
      if (target.protocol !== 'https:' || target.hostname !== 'files.bo3.gg') return new Response('forbidden', { status: 403 });
      const r = await fetch(target.toString(), { headers: { Accept: 'image/*' }, cf: { cacheTtl: 30 * 86400, cacheEverything: true } });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !type.startsWith('image/')) return new Response('not found', { status: 404, headers: CORS });
      return new Response(r.body, {
        headers: { 'content-type': type, 'cache-control': 'public, max-age=2592000, immutable', 'access-control-allow-origin': '*' },
      });
    }

    if (path === '/relay' && req.method === 'GET') {
      if (!safeEqual(req.headers.get('x-relay-key'), env.ADMIN_TOKEN)) return new Response('forbidden', { status: 403 });
      let target;
      try { target = new URL(url.searchParams.get('u') || ''); } catch { return new Response('bad url', { status: 400 }); }
      if (target.protocol !== 'https:' || !RELAY_HOSTS.has(target.hostname)) return new Response('forbidden', { status: 403 });
      const headers = {};
      for (const k of ['accept', 'user-agent', 'referer']) if (req.headers.get(k)) headers[k] = req.headers.get(k);
      const r = await fetch(target.toString(), { headers });
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' } });
    }

    if (path === '/') return new Response('Sabonner is running.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  },

  async scheduled(event, env, execCtx) {
    // wrangler.toml 里 cron 是每分钟时 Worker 自己跑全部定时工作（不用 VPS 运行器的部署方式）；否则只检查运行器还活着没有
    if (event.cron === '* * * * *') execCtx.waitUntil(runCron(makeCtx(env)));
    else execCtx.waitUntil(watchRunner(makeCtx(env)).catch((e) => console.error('[watch]', e?.stack || e)));
  },
};
