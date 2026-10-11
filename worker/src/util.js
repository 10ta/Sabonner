// 通用工具：时间、转义、响应、子请求预算

export const now = () => Math.floor(Date.now() / 1000);

// Telegram HTML parse_mode 只需要转义这三个字符
export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }));
  }
  return fmtCache.get(tz);
}

// 1791700000 -> "10/11 周日 19:30"
export function fmtTime(ts, tz = 'Asia/Shanghai') {
  const p = parts(ts, tz);
  return `${p.month}/${p.day} ${p.weekday} ${p.hour}:${p.minute}`;
}

const parts = (ts, tz) => Object.fromEntries(fmt(tz).formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));

// "10/11 周日"
export function fmtDate(ts, tz = 'Asia/Shanghai') {
  const p = parts(ts, tz);
  return `${p.month}/${p.day} ${p.weekday}`;
}

// "19:30"
export function fmtClock(ts, tz = 'Asia/Shanghai') {
  const p = parts(ts, tz);
  return `${p.hour}:${p.minute}`;
}

// 秒数差 -> "2小时15分" / "35分" / "1天3小时"
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}天${h ? h + '小时' : ''}`;
  if (h) return `${h}小时${m ? m + '分' : ''}`;
  return `${m}分`;
}

export const TIER_LABEL = { s: 'S', a: 'A', b: 'B', c: 'C', d: 'D' };
export const tierLabel = (t) => TIER_LABEL[t] || String(t || '?').toUpperCase();

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-max-age': '86400',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

// 免费版每次调用最多 50 个子请求；留一点余量
export const SUBREQ_MAX = 45;

// 每次调用一个上下文：带计数的 fetch
export function makeCtx(env) {
  const ctx = {
    env,
    tz: env.TZ || 'Asia/Shanghai',
    used: 0,
    left() { return SUBREQ_MAX - ctx.used; },
    async fetch(url, init) {
      if (ctx.used >= SUBREQ_MAX) throw new Error('subrequest budget exhausted');
      ctx.used++;
      return fetch(url, init);
    },
  };
  return ctx;
}

export const isOwner = (env, id) => String(id) === String(env.OWNER_ID);

// 定长比较，避免按字符逐个比较泄露信息
export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
