// 用 Cloudflare 的 D1 HTTP 接口实现 Worker 里 env.DB 的那套写法（prepare / bind / all / first / run / batch），
// 这样 worker/src 里的代码不用改就能在 VPS 上读写同一个 D1。
// 一次 batch = 一次 HTTP 请求（接口支持一次提交多条语句）。顺带统计读写行数（D1 免费额度按行算）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch：运行器的 fetch（可能走代理）；api：测试时可以换成本地地址
export function makeD1({ accountId, databaseId, token, fetch, api = 'https://api.cloudflare.com/client/v4' }) {
  const url = `${api}/accounts/${accountId}/d1/database/${databaseId}/query`;
  const stats = { calls: 0, statements: 0, rowsRead: 0, rowsWritten: 0, errors: 0 };
  let stringParams = false;   // 接口要求参数是字符串时自动切换（文档里写的是字符串数组，实际一般也接受数字）

  const conv = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    return stringParams && typeof v === 'number' ? String(v) : v;
  };

  async function send(stmts) {
    const payload = () => JSON.stringify({ batch: stmts.map((s) => ({ sql: s.sql, params: s.params.map(conv) })) });
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      let r, j = null;
      try {
        r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload() });
        j = await r.json().catch(() => null);
      } catch (e) {
        lastErr = e; await sleep(1000 * 2 ** attempt); continue;   // 网络错误：重试
      }
      if (r.ok && j?.success !== false && Array.isArray(j?.result)) {
        stats.calls++; stats.statements += stmts.length;
        return j.result.map((x) => {
          const meta = x.meta || {};
          stats.rowsRead += Number(meta.rows_read) || 0;
          stats.rowsWritten += Number(meta.rows_written) || 0;
          return { results: x.results || [], meta: { ...meta, changes: Number(meta.changes) || 0 }, success: x.success !== false };
        });
      }
      const msg = (j?.errors || []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || `HTTP ${r.status}`;
      if (!stringParams && /param/i.test(msg) && /type|string/i.test(msg)) { stringParams = true; attempt--; continue; }
      lastErr = new Error(`D1 ${r.status}: ${msg}`);
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }   // 限流 / 服务端错误：重试
      break;                                                                                 // SQL 错误等：不重试
    }
    stats.errors++;
    throw lastErr;
  }

  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...a) { return new Stmt(this.sql, a); }
    async all() { return (await send([this]))[0]; }
    async first(col) { const row = (await send([this]))[0].results[0] ?? null; return col ? row?.[col] ?? null : row; }
    async run() { return (await send([this]))[0]; }
    async raw() { return (await send([this]))[0].results.map((r) => Object.values(r)); }
  }

  return {
    prepare: (sql) => new Stmt(sql),
    batch: (stmts) => (stmts.length ? send(stmts) : Promise.resolve([])),
    stats,
    takeStats() { const o = { ...stats }; for (const k of Object.keys(stats)) stats[k] = 0; return o; },
  };
}
