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

## 部署（命令行）

在你自己的电脑或 Debian 服务器上操作，需要 **Node.js 20 或更新**（`node -v` 查看）。

> ⚠️ **影响范围**：这个 Worker 会占用 Cloudflare 账户 **5 个免费 cron 名额中的 1 个**；每天约 1440 次 cron 调用加上 webhook 请求，计入整个账户共享的每日 10 万次请求额度。bot 必须是**专用的**——设置 webhook 后，这个 token 不能再被别的程序用轮询方式读取消息。

### 0. 准备三样东西

| 名称 | 怎么得到 |
|---|---|
| bot token | [@BotFather](https://t.me/BotFather) 创建 bot 时给的，形如 `123456:ABC-...` |
| 你的 Telegram user id | 给 [@userinfobot](https://t.me/userinfobot) 发任意消息，回复里的 `Id` |
| 两个随机串 | 运行两次 `openssl rand -hex 24`：一个当 `TG_WEBHOOK_SECRET`，一个当 `ADMIN_TOKEN`（你的管理密码，记下来） |

### 1. 拿到代码、装依赖

```bash
git clone https://github.com/10ta/Sabonner.git    # 或者解压 Sabonner.zip
cd Sabonner/worker
npm install
```

### 2. 登录 Cloudflare

有浏览器的电脑：

```bash
npx wrangler login
npx wrangler whoami          # 能看到账号邮箱和 Account ID 就成功了
```

**没有浏览器的服务器**：在控制台 [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → 选模板 **Edit Cloudflare Workers** → 在权限里**再加一行 Account · D1 · Edit** → 创建。然后：

```bash
export CLOUDFLARE_API_TOKEN=刚创建的token
export CLOUDFLARE_ACCOUNT_ID=你的AccountID     # 控制台 Workers & Pages 页面右侧能看到
npx wrangler whoami
```

### 3. 创建数据库并建表

```bash
npx wrangler d1 create sabonner
```

输出里有一行 `"database_id": "xxxxxxxx-xxxx-..."`。如果 wrangler 问要不要自动写进配置，选 **No**，手动替换（`wrangler.toml` 已经写好了绑定，只差这个 id）：

```bash
sed -i 's/REPLACE_WITH_YOUR_D1_ID/这里粘贴database_id/' wrangler.toml
grep database_id wrangler.toml     # 确认替换成功

npm run db:init                    # 在线上 D1 建表，看到 "executed successfully" 即可
```

### 4. 部署

```bash
npm run deploy
```

成功后最后会打印 Worker 地址，形如 `https://sabonner.<你的子域>.workers.dev`，以及 `schedule: * * * * *`。记下地址，下面用 `$WORKER` 代指：

```bash
export WORKER=https://sabonner.你的子域.workers.dev
curl $WORKER/                      # 应返回 Sabonner is running.
```

> 此时还没有设置 secret，cron 每分钟空跑一次，不会出错也不会发消息。

### 5. 设置 secret

每条命令会提示输入值，粘贴后回车（输入时不显示）：

```bash
npx wrangler secret put TG_TOKEN            # bot token
npx wrangler secret put TG_WEBHOOK_SECRET   # 第一个随机串
npx wrangler secret put ADMIN_TOKEN         # 第二个随机串
npx wrangler secret put OWNER_ID            # 你的 Telegram user id（纯数字）
npx wrangler secret list                    # 应列出这 4 个名字
```

secret 设置后立即生效，不用重新部署。

### 6. 注册 webhook 和命令菜单

```bash
curl "$WORKER/setup?token=你的ADMIN_TOKEN"
```

返回的 JSON 里 `webhook`、`publicCommands`、`ownerCommands` 三项都是 `"ok":true` 就对了。再向 Telegram 确认一次：

```bash
curl "https://api.telegram.org/bot你的BOT_TOKEN/getWebhookInfo"
```

`url` 应是 `$WORKER/tg`，`last_error_message` 不应出现。

> 改了 `TG_WEBHOOK_SECRET` 或换了 Worker 地址后，要重新执行这一步。

### 7. 在 Telegram 里测试

给 bot 发：

| 发送 | 预期 |
|---|---|
| `/start` | 收到带「管理」部分的帮助（说明你被识别为管理员） |
| `/room 6657` | 「已添加 xxx（6657），当前未开播/直播中」 |
| `/tier` → 点 **S** | 按钮变成 ✅ S |
| `/team spirit` → 点 **➕ Spirit** | 「已订阅 Spirit。当前跟踪 N 场比赛」 |
| `/next` | 列出订阅范围内的未来比赛 |
| `/status` | 跟踪比赛数、上次刷新时间 |

验证推送：
- **赛前提醒**：订阅后 1 分钟内，24 小时内开赛的比赛会立刻收到一条预告。
- **直播卡片**：想马上看到效果，可以临时 `/tier` 打开 **B** 或 **C**（这两档几乎随时有比赛在打），1–2 分钟内会收到 🔴 LIVE 卡片；看完再关掉。C 档数据量大，测完记得关。
- **其他用户**：用另一个账号给 bot 发 `/start`，你会收到带「批准 / 拒绝」按钮的申请。

### 8. 看日志

```bash
npx wrangler tail          # 实时日志，Ctrl+C 退出；cron 每分钟一条
```

或者在控制台 Worker → Observability 里看。只要没有 `[refresh]` `[live]` `[douyu]` `[flush]` 开头的报错就是正常的。

直接查数据库：

```bash
npx wrangler d1 execute sabonner --remote --command "SELECT id, team1, team2, status, s1, s2 FROM matches ORDER BY start_ts LIMIT 20"
npx wrangler d1 execute sabonner --remote --command "SELECT * FROM outbox"
```

### 更新代码

```bash
git pull            # 或替换文件
npm run deploy
npm run db:init     # 只在 schema.sql 有改动时需要；重复执行是安全的
```

### 常见问题

| 现象 | 处理 |
|---|---|
| bot 完全不回复 | 看 `getWebhookInfo` 的 `last_error_message`；403 表示 `TG_WEBHOOK_SECRET` 和注册时不一致，重新执行第 6 步 |
| `/start` 只回「已提交申请」 | `OWNER_ID` 填错了，用 `wrangler secret put OWNER_ID` 重新设 |
| 部署报 D1 / database_id 错误 | 第 3 步的 id 没替换成功 |
| 日志出现 `Exceeded CPU` | 免费版每次 10ms CPU 不够，先关掉 C 档 tier |
| 推送延迟很久 | `/status` 看「待发消息」，用户太多时会分几分钟发完 |

### 卸载

```bash
curl "https://api.telegram.org/bot你的BOT_TOKEN/deleteWebhook"
npx wrangler delete                 # 删除 Worker，释放 cron 名额
npx wrangler d1 delete sabonner     # 删除数据库
```

### 不用命令行的部署方式

Cloudflare 控制台 → Workers & Pages → Create → Import a repository，选这个仓库，**Root directory 填 `worker`**。D1 在控制台 Storage & Databases → D1 里创建，把 `schema.sql` 的内容贴进 Console 执行，并把 database_id 写进 `wrangler.toml` 再 push；secret 在 Worker 的 Settings → Variables and Secrets 里加；之后照第 6、7 步做。每次 push 自动部署。

### 时区

推送里的时间默认是北京时间。改 `wrangler.toml` 的 `[vars]` 里的 `TZ`（如 `America/New_York`），然后 `npm run deploy`。

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
