// bo3.gg 非官方 API 适配器
// 已验证可用的参数：status in、tier in、id in、team1_id/team2_id in、sort=start_date、
// with=teams,tournament、page[limit]≤100、teams 的 name eq/like、id eq
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

export function normalizeMatch(m) {
  return {
    id: m.id,
    slug: m.slug,
    team1_id: m.team1_id,
    team2_id: m.team2_id,
    team1: m.team1?.name || (m.team1_id ? `#${m.team1_id}` : 'TBD'),
    team2: m.team2?.name || (m.team2_id ? `#${m.team2_id}` : 'TBD'),
    tournament: m.tournament?.name || '',
    tier: m.tier || '',
    bo: m.bo_type || 1,
    start_ts: ts(m.start_date),
    status: m.status,
    s1: m.team1_score ?? 0,
    s2: m.team2_score ?? 0,
    winner_id: m.winner_team_id ?? null,
  };
}

const MATCH_EXTRA = { with: 'teams,tournament', sort: 'start_date' };
const ACTIVE = ['matches.status', 'in', 'upcoming,current'];

export async function matchesByTiers(ctx, tiers, limit = 50) {
  if (!tiers.length) return [];
  const url = buildUrl('matches', [ACTIVE, ['matches.tier', 'in', tiers.join(',')]], { ...MATCH_EXTRA, 'page[limit]': limit });
  return (await get(ctx, url)).map(normalizeMatch);
}

export async function matchesByTeams(ctx, teamIds, limit = 30) {
  if (!teamIds.length) return [];
  const ids = teamIds.join(',');
  const [a, b] = await Promise.all([
    get(ctx, buildUrl('matches', [ACTIVE, ['matches.team1_id', 'in', ids]], { ...MATCH_EXTRA, 'page[limit]': limit })),
    get(ctx, buildUrl('matches', [ACTIVE, ['matches.team2_id', 'in', ids]], { ...MATCH_EXTRA, 'page[limit]': limit })),
  ]);
  return [...a, ...b].map(normalizeMatch);
}

export async function matchesByIds(ctx, ids) {
  if (!ids.length) return [];
  const url = buildUrl('matches', [['matches.id', 'in', ids.join(',')]], { with: 'teams,tournament', 'page[limit]': Math.min(ids.length, 100) });
  return (await get(ctx, url)).map(normalizeMatch);
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

// 返回 [{ n, map, status, sc1, sc2, winner }]，sc1/sc2 是 team1/team2 视角的回合分
export async function gamesOf(ctx, match) {
  const url = buildUrl('games', [['games.match_id', 'eq', match.id]], { 'page[limit]': 10 });
  const games = await get(ctx, url);
  return games
    .sort((x, y) => (x.number ?? 0) - (y.number ?? 0))
    .map((g) => {
      const out = {
        n: g.number,
        map: String(g.map_name || '').replace(/^de_/, '') || '?',
        status: g.status,
        winner: g.winner_clan_name || null,
      };
      if (g.status === 'finished' && g.winner_clan_score != null) {
        const side = whichSide(g.winner_clan_name, match);
        const w = g.winner_clan_score;
        const l = g.loser_clan_score;
        if (side === 1) { out.sc1 = w; out.sc2 = l; out.side = 1; }
        else if (side === 2) { out.sc1 = l; out.sc2 = w; out.side = 2; }
        else { out.sc1 = w; out.sc2 = l; out.side = 0; }
      }
      return out;
    });
}

export async function searchTeams(ctx, q, limit = 8) {
  const url = buildUrl('teams', [['teams.name', 'like', q]], { 'page[limit]': 20 });
  const rs = await get(ctx, url);
  const ql = q.toLowerCase();
  return rs
    .map((t) => ({ id: t.id, name: t.name, slug: t.slug, rank: t.rank ?? null, acronym: t.acronym || '' }))
    .sort((a, b) => {
      const ea = a.name.toLowerCase() === ql ? 0 : 1;
      const eb = b.name.toLowerCase() === ql ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return (a.rank ?? 1e9) - (b.rank ?? 1e9);
    })
    .slice(0, limit);
}

export async function teamById(ctx, id) {
  const rs = await get(ctx, buildUrl('teams', [['teams.id', 'eq', id]], { 'page[limit]': 1 }));
  const t = rs[0];
  return t ? { id: t.id, name: t.name, slug: t.slug } : null;
}

export const matchUrl = (m) => `https://bo3.gg/matches/${m.slug}`;
