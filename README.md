# Sabonner

CS2 比赛订阅与斗鱼开播提醒：Cloudflare Worker 后端 + Telegram bot，网页前端（第二期）部署在 CF Pages / Vercel。

- 按 **tier**（S/A/B/C）或 **队伍** 订阅比赛：开赛前 1 天、前 30 分钟各提醒一次
- 比赛进行中：一张可原地更新的比分卡片；每张图打完单独推送；结束时推送胜者
- **斗鱼主播开播**提醒（断流 10 分钟内重连不重复推）
- 只有管理员能改订阅；其他人 `/start` 申请，管理员批准后只能接收推送和查看

数据来自 [bo3.gg](https://bo3.gg) 的公开接口和斗鱼开放接口，均为非官方、可能随时变化。

## 目录

```
worker/
  wrangler.toml   Worker 配置（cron、D1 绑定）
  schema.sql      D1 表结构
  src/
    index.js      入口：/tg webhook、/setup、/api/*、cron
    engine.js     cron 调度、赛程刷新、提醒、直播轮询、斗鱼检查
    bo3.js        bo3.gg 适配器
    douyu.js      斗鱼适配器
    bot.js        TG 命令、按钮、用户审批
    outbox.js     发件队列（超出子请求预算的消息顺延到下一分钟）
    format.js     消息文案
    db.js / tgapi.js / util.js / api.js
web/              （第二期）
```

## 部署

需要：Cloudflare 账号、一个**新的** Telegram bot token（找 [@BotFather](https://t.me/BotFather) 创建）、你自己的 Telegram user id（找 [@userinfobot](https://t.me/userinfobot) 查）。

> ⚠️ 这个 Worker 会占用 Cloudflare 账户 **5 个免费 cron 名额中的 1 个**，每天约 1440 次 cron 调用和若干 webhook 请求，计入账户共享的每日 10 万次请求额度。

```bash
cd worker
npm install
npx wrangler login                      # 无浏览器的服务器上改用 CLOUDFLARE_API_TOKEN 环境变量

npx wrangler d1 create sabonner         # 把输出的 database_id 填进 wrangler.toml
npm run db:init                         # 建表

npx wrangler secret put TG_TOKEN            # bot token
npx wrangler secret put TG_WEBHOOK_SECRET   # 随便一串，只能用 A-Z a-z 0-9 _ -
npx wrangler secret put ADMIN_TOKEN         # 你的管理密码
npx wrangler secret put OWNER_ID            # 你的 Telegram user id

npm run deploy
```

部署后在浏览器打开一次（注册 webhook 和命令菜单）：

```
https://sabonner.<你的子域>.workers.dev/setup?token=<ADMIN_TOKEN>
```

返回里 `webhook.ok` 为 `true` 就行。然后在 Telegram 里给 bot 发：

```
/tier           勾选要订阅的 tier
/team spirit    搜索并订阅队伍
/room 6657      添加斗鱼主播
```

`TZ`（推送里的时区）在 `wrangler.toml` 的 `[vars]` 里改，默认 `Asia/Shanghai`。

### 不用命令行的部署方式

Cloudflare 控制台 → Workers & Pages → Create → Import a repository，选这个仓库，**Root directory 填 `worker`**。D1 在控制台 Storage & Databases → D1 里创建，把 `schema.sql` 的内容贴进 Console 执行；secret 在 Worker 的 Settings → Variables and Secrets 里加。之后每次 push 自动部署。

## 命令

| 所有已批准用户 | 管理员额外 |
|---|---|
| `/next` 即将开始 | `/team 名字` 搜索订阅；不带参数列出并可退订 |
| `/live` 进行中 | `/tier` 切换 tier |
| `/results` 最近赛果 | `/room 房间号` 添加；不带参数列出并可删除 |
| `/subs` 当前订阅 | `/users` 审批 / 撤销 |
| `/rooms` 主播状态 | `/refresh` 立即刷新赛程 |
| `/stop` 不再接收推送 | `/status` 运行状态 |

## 运行方式

cron 每分钟一次：

| 任务 | 频率 | 外部请求 |
|---|---|---|
| 斗鱼开播检查 | 每分钟 | 每个房间 1 个（多于 12 个时分组轮转） |
| 赛程刷新 | 每 10 分钟 | 3 个（tier 1 + 队伍 2） |
| 直播轮询 | 其他分钟，且有比赛在 30 分钟内开赛或进行中 | 1 个 + 每场 0–1 个（比分变化或每 3 分钟） |
| 赛前提醒 | 每分钟 | 0（只查 D1） |
| 发件 | 每分钟 | 用掉剩余预算，免费版每次调用上限 50 |

## 已知限制

- 只到**地图级**比分，没有回合级（bo3 的公开接口不提供）。
- 地图胜者在 bo3 里有时是简称（如 "CW"），程序会尽量对应到队伍；对不上时显示「XX 胜」。
- 斗鱼 `room_status` 只把 `"1"` 当作直播中，等实际开播时再核对一次。
- 免费版每次调用 CPU 上限 10ms。订阅 C tier 会让每次刷新的数据量变大，可能接近上限；如果日志里出现 `Exceeded CPU`，先关掉 C tier。
