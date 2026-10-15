// bo3.gg 非官方 API 适配器
// 已验证可用的参数：status in、tier in、id in、team1_id/team2_id in、sort=start_date、
// with=teams,tournament,stage,round,ai_predictions,games、stars in、page[limit]≤100、teams 的 name eq/like、id eq、
// /countries、/tournaments（event_type、hltv_url）
// 不支持：按 start_date 过滤（会被忽略）

const BASE = 'https://api.bo3.gg/api/v1';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Sabonner; personal notifier)' };

// filters: [['matches.status', 'in', 'upcoming,current'], ...]
function buildUrl(path, filters = [], extra = {}) {
  const parts = filters.map(([field, op, val]) => `filter[${field}][${op}]=${encodeURIComponent(val)}`);
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${encodeURIComponent(v)}`);
  return `${BASE}/${path}?${parts.join('&')}`;
}

async function get(ctx, url) {
  const r = await ctx.fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`bo3 ${r.status} ${url}`);
  const b = await r.json();
  return b.results || [];
}

const ts = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

// ---------- 国家代码 ----------
// bo3 的队伍只给 country_id，对应表从 /countries 取（约 250 条，3 页），缓存在 D1 kv 里 30 天

const COUNTRY_TTL = 30 * 86400;

// 同一次调用里只加载一次：赛程刷新会并行发 4 个比赛请求，都要用国家表，
// 以前各自去读缓存，缓存过期时会把 /countries 重复拉 4 遍
export function ensureCountries(ctx) {
  if (!ctx.countriesP) ctx.countriesP = loadCountries(ctx);
  return ctx.countriesP;
}

async function loadCountries(ctx) {
  const db = ctx.env.DB;
  const row = await db.prepare("SELECT v FROM kv WHERE k = 'countries'").first();
  let cached = null;
  try { cached = row ? JSON.parse(row.v) : null; } catch { /* 坏缓存当没有 */ }
  if (cached && cached.at > Date.now() / 1000 - COUNTRY_TTL) return cached.map;
  const map = cached?.map || {};
  try {
    for (let offset = 0; offset < 400; offset += 100) {
      const list = await get(ctx, buildUrl('countries', [], { 'page[limit]': 100, 'page[offset]': offset }));
      for (const c of list) if (c.id && c.code) map[c.id] = String(c.code).toUpperCase();
      if (list.length < 100) break;
    }
    await db.prepare("INSERT INTO kv (k, v) VALUES ('countries', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .bind(JSON.stringify({ at: Math.floor(Date.now() / 1000), map })).run();
  } catch (e) {
    console.error('countries', e?.message || e); // 拿不到就先不显示国旗，不影响其它功能
  }
  return map;
}

// "ESL Pro League Season 24 Decider" + "3rd place" -> "decider / 3rd place"
function stageText(m) {
  const tour = m.tournament?.name || '';
  let stage = String(m.stage?.title || '').trim();
  if (tour && stage.toLowerCase().startsWith(tour.toLowerCase())) stage = stage.slice(tour.length).trim();
  const round = String(m.round?.name || '').trim();
  return [stage, round].filter(Boolean).join(' / ').toLowerCase() || null;
}

export function normalizeMatch(m, countries = {}) {
  const ai = Array.isArray(m.ai_predictions) ? m.ai_predictions[0] : m.ai_predictions;
  const out = {
    id: m.id,
    slug: m.slug,
    team1_id: m.team1_id,
    team2_id: m.team2_id,
    team1: m.team1?.name || (m.team1_id ? `#${m.team1_id}` : 'TBD'),
    team2: m.team2?.name || (m.team2_id ? `#${m.team2_id}` : 'TBD'),
    team1_cc: countries[m.team1?.country_id] || null,
    team2_cc: countries[m.team2?.country_id] || null,
    team1_logo: m.team1?.image_url || null,
    team2_logo: m.team2?.image_url || null,
    team1_rank: m.team1?.rank || null,
    team2_rank: m.team2?.rank || null,
    tournament: m.tournament?.name || '',
    tournament_slug: m.tournament?.slug || null,
    tournament_id: m.tournament_id ?? m.tournament?.id ?? null,
    prize: m.tournament?.prize || null,
    stage: stageText(m),
    tier: m.tier || '',
    stars: m.stars ?? null,
    bo: m.bo_type || 1,
    start_ts: ts(m.start_date),
    status: m.status,
    s1: m.team1_score ?? 0,
    s2: m.team2_score ?? 0,
    winner_id: m.winner_team_id ?? null,
    ai_winner_id: ai?.prediction_winner_team_id ?? null,
    ai_s1: ai?.prediction_team1_score ?? null,
    ai_s2: ai?.prediction_team2_score ?? null,
  };
  if (Array.isArray(m.games)) out.maps = mapsFromGames(m.games, out);
  return out;
}

const WITH = 'teams,tournament,stage,round,ai_predictions';
const MATCH_EXTRA = { with: WITH, sort: 'start_date' };
const ACTIVE = ['matches.status', 'in', 'upcoming,current'];

async function matches(ctx, url) {
  const [raw, countries] = await Promise.all([get(ctx, url), ensureCountries(ctx)]);
  return raw.map((m) => normalizeMatch(m, countries));
}

// 补上线下 / 线上、HLTV 赛事页、奖金（只在赛事接口里有，按赛事 id 查，缓存一天）。
// 赛程刷新把几路请求合并之后调用一次；直播轮询不调用——这些字段库里已有，合并时沿用旧值
export async function attachTournaments(ctx, list) {
  const tours = await ensureTournaments(ctx, [...new Set(list.map((m) => m.tournament_id).filter(Boolean))]);
  for (const m of list) {
    const t = tours.get(m.tournament_id);
    m.event_type = t?.event_type || null;
    m.tournament_hltv = t?.hltv_url || null;
    if (!m.prize && t?.prize) m.prize = t.prize;
  }
  return list;
}

export async function matchesByTiers(ctx, tiers, limit = 50) {
  if (!tiers.length) return [];
  return matches(ctx, buildUrl('matches', [ACTIVE, ['matches.tier', 'in', tiers.join(',')]], { ...MATCH_EXTRA, 'page[limit]': limit }));
}

// 星级 ≥ min 的比赛（bo3 不支持 gte，用 in 列出 min..5）
export async function matchesByStars(ctx, min, limit = 50) {
  if (!min || min < 1 || min > 5) return [];
  const list = Array.from({ length: 6 - min }, (_, i) => min + i).join(',');
  return matches(ctx, buildUrl('matches', [ACTIVE, ['matches.stars', 'in', list]], { ...MATCH_EXTRA, 'page[limit]': limit }));
}

export async function matchesByTeams(ctx, teamIds, limit = 30) {
  if (!teamIds.length) return [];
  const ids = teamIds.join(',');
  const [a, b] = await Promise.all([
    matches(ctx, buildUrl('matches', [ACTIVE, ['matches.team1_id', 'in', ids]], { ...MATCH_EXTRA, 'page[limit]': limit })),
    matches(ctx, buildUrl('matches', [ACTIVE, ['matches.team2_id', 'in', ids]], { ...MATCH_EXTRA, 'page[limit]': limit })),
  ]);
  return [...a, ...b];
}

// 直播轮询用：连同每张图的数据一起取，省掉逐场查地图的请求
export async function matchesByIds(ctx, ids) {
  if (!ids.length) return [];
  return matches(ctx, buildUrl('matches', [['matches.id', 'in', ids.join(',')]], { with: `${WITH},games`, 'page[limit]': Math.min(ids.length, 100) }));
}

// ---------- 赛事缓存 ----------

const TOUR_TTL = 86400;
export async function ensureTournaments(ctx, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const db = ctx.env.DB;
  const nums = ids.map(Number).filter(Number.isFinite);
  const { results } = await db.prepare(`SELECT * FROM tournaments WHERE id IN (${nums.join(',')})`).all();
  const fresh = Date.now() / 1000 - TOUR_TTL;
  for (const r of results) out.set(r.id, r);
  const missing = nums.filter((id) => !out.has(id) || out.get(id).updated_at < fresh);
  if (!missing.length) return out;
  try {
    const list = await get(ctx, buildUrl('tournaments', [['tournaments.id', 'in', missing.join(',')]], { 'page[limit]': Math.min(missing.length, 100) }));
    const t = Math.floor(Date.now() / 1000);
    const stmts = [];
    for (const x of list) {
      const row = { id: x.id, prize: x.prize || null, event_type: x.event_type || null, hltv_url: x.hltv_url || null, updated_at: t };
      out.set(x.id, row);
      stmts.push(db.prepare(`INSERT INTO tournaments (id, prize, event_type, hltv_url, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET prize = excluded.prize, event_type = excluded.event_type, hltv_url = excluded.hltv_url, updated_at = excluded.updated_at`)
        .bind(row.id, row.prize, row.event_type, row.hltv_url, row.updated_at));
    }
    if (stmts.length) await db.batch(stmts);
  } catch (e) {
    console.error('tournaments', e?.message || e); // 拿不到就先不显示线下 / 线上，下次再试
  }
  return out;
}

// "Chinggis Warriors" -> "cw"
const initials = (s) => String(s || '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toLowerCase();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// 地图胜者名字可能是简称（"CW"），尽量对应到 team1 / team2
function whichSide(name, m) {
  const n = norm(name);
  if (!n) return 0;
  const check = (team) => {
    const t = norm(team);
    return t && (t === n || t.startsWith(n) || n.startsWith(t) || initials(team) === n);
  };
  const a = check(m.team1);
  const b = check(m.team2);
  if (a && !b) return 1;
  if (b && !a) return 2;
  return 0;
}

// games → [{ n, map, status, sc1, sc2, side, winner }]，sc1/sc2 是 team1/team2 视角的回合分
// 胜者优先用 winner_team_clan.team_id 判断属于哪队，没有时再按名字（可能是简称）猜
export function mapsFromGames(games, match) {
  return [...games]
    .sort((x, y) => (x.number ?? 0) - (y.number ?? 0))
    .map((g) => {
      const out = {
        n: g.number,
        map: String(g.map_name || '').replace(/^de_/, '') || null,
        status: g.status,
        winner: g.winner_clan_name || null,
      };
      if (g.status === 'finished' && g.winner_clan_score != null) {
        const wid = g.winner_team_clan?.team_id;
        let side = wid && wid === match.team1_id ? 1 : wid && wid === match.team2_id ? 2 : 0;
        if (!side) side = whichSide(g.winner_clan_name, match);
        const w = g.winner_clan_score;
        const l = g.loser_clan_score;
        if (side === 2) { out.sc1 = l; out.sc2 = w; } else { out.sc1 = w; out.sc2 = l; }
        out.side = side;
      }
      return out;
    });
}

const teamOut = (t, countries) => ({ id: t.id, name: t.name, slug: t.slug, cc: countries[t.country_id] || null, logo: t.image_url || null });

export async function searchTeams(ctx, q, limit = 8) {
  const url = buildUrl('teams', [['teams.name', 'like', q]], { 'page[limit]': 20 });
  const [rs, countries] = await Promise.all([get(ctx, url), ensureCountries(ctx)]);
  const ql = q.toLowerCase();
  return rs
    .map((t) => ({ ...teamOut(t, countries), rank: t.rank ?? null, acronym: t.acronym || '' }))
    .sort((a, b) => {
      const ea = a.name.toLowerCase() === ql ? 0 : 1;
      const eb = b.name.toLowerCase() === ql ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return (a.rank ?? 1e9) - (b.rank ?? 1e9);
    })
    .slice(0, limit);
}

export async function teamById(ctx, id) {
  const [rs, countries] = await Promise.all([get(ctx, buildUrl('teams', [['teams.id', 'eq', id]], { 'page[limit]': 1 })), ensureCountries(ctx)]);
  return rs[0] ? teamOut(rs[0], countries) : null;
}

export const matchUrl = (m) => `https://bo3.gg/matches/${m.slug}`;
export const stagesUrl = (m) => (m.tournament_slug ? `https://bo3.gg/tournaments/${m.tournament_slug}#tab-stages` : null);

// "RU" -> 🇷🇺；非两位字母代码（国际队等）返回空
export function flag(cc) {
  const c = String(cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
