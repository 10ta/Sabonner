// 斗鱼开放接口：open.douyucdn.cn/api/RoomApi/room/<id>
// room_status: "1" = 直播中，其它值都当未开播
// www.douyu.com/betard 对 Cloudflare 出口返回拦截页，不使用

export async function roomInfo(ctx, roomId) {
  const r = await ctx.fetch(`https://open.douyucdn.cn/api/RoomApi/room/${encodeURIComponent(roomId)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Sabonner; personal notifier)' },
  });
  if (!r.ok) throw new Error(`douyu ${r.status}`);
  const b = await r.json();
  if (b.error !== 0 || !b.data) return { ok: false, error: b.data || b.error };
  const d = b.data;
  return {
    ok: true,
    live: String(d.room_status) === '1',
    owner: d.owner_name || '',
    title: d.room_name || '',
    category: d.cate_name || '',
    hot: d.hn ?? d.online ?? null,
  };
}

export const roomUrl = (id) => `https://www.douyu.com/${id}`;
