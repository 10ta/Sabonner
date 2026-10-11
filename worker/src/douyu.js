// 斗鱼：手机站接口 m.douyu.com/api/room/info?rid=<房间号>
// 从 Cloudflare（海外）出口实测可用，靓号（如 6657）和真实房间号都能查。
// 不再使用：
//   open.douyucdn.cn/api/RoomApi/room  返回冻结的旧数据（1970 年、旧主播名），靓号查到的是另一个停用房间
//   www.douyu.com/betard               对海外 IP 返回「房间已关闭」提示页

const UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export async function roomInfo(ctx, roomId) {
  const r = await ctx.fetch(`https://m.douyu.com/api/room/info?rid=${encodeURIComponent(roomId)}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA_M, Referer: `https://m.douyu.com/${roomId}` },
  });
  if (!r.ok) throw new Error(`douyu ${r.status}`);
  const b = await r.json();
  const d = b?.data?.roomInfo;
  if (b.code !== 0 || !d || !d.rid) return { ok: false, error: b?.msg || 'room not found' };
  return {
    ok: true,
    live: Number(d.isLive) === 1,
    owner: d.nickname || '',
    title: d.roomName || '',
    category: d.cate2Name || '',
    avatar: d.avatar || '',
    hot: d.hn ?? null,
    rid: String(d.rid),                       // 真实房间号（靓号 6657 → 6979222）
    showTime: Number(d.showTime) || null,     // 本场开播时间，同一场直播不变
  };
}

export const roomUrl = (id) => `https://www.douyu.com/${id}`;
