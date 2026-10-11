# Sabonner

CS2 比赛订阅与斗鱼开播提醒：Cloudflare Worker 后端 + Telegram bot + 网页（CF Pages / Vercel，沿用 1999 主题风格）。

- 按 **tier**（S/A/B/C）或 **队伍** 订阅比赛：开赛前 1 天、前 30 分钟各提醒一次
- 比赛进行中：一张可原地更新的比分卡片；每张图打完单独推送；结束时推送胜者
- 每天 **UTC 0 点**发今日赛程并自动置顶，第二天替换；没有比赛时告诉你下一场是什么
- 消息里带队伍国旗和赛段（如 [decider / 3rd place](https://bo3.gg/tournaments/esl-pro-league-season-24#tab-stages)，链接到 bo3 的赛段页）
- **斗鱼主播开播**提醒（断流 10 分钟内重连不重复推）
- 只有管理员能改订阅；其他人 `/start` 申请，管理员批准后只能接收推送和查看
- 网页任何人可看；管理员输入管理密码后可在网页上改订阅、审批用户

数据来自 [bo3.gg](https://bo3.gg) 的公开接口和斗鱼开放接口，均为非官方、可能随时变化。

## 目录

```
worker/
  wrangler.toml   Worker 配置（cron、D1 绑定）
  migrations/     D1 表结构（按编号依次执行，init.sh 自动处理）
  src/
    index.js      入口：/tg webhook、/setup、/api/*、cron
    engine.js     cron 调度、赛程刷新、提醒、直播轮询、斗鱼检查
    bo3.js        bo3.gg 适配器
    douyu.js      斗鱼适配器
    bot.js        TG 命令、按钮、用户审批
    outbox.js     发件队列（超出子请求预算的消息顺延到下一分钟）
    format.js     消息文案
    api.js        网页接口：公开只读 + /api/admin/*（管理密码）
    db.js / tgapi.js / util.js
web/              静态网页，CF Pages / Vercel 直接托管，无需构建
  config.js       Worker 地址（init.sh 写入）
  theme.css       1999 主题的配色与字体（MIT）
  app.css / app.js
init.sh           一键部署 / 更新
```

## 一键部署

在你自己的电脑或 Debian 服务器上，需要 **Node.js 20+**、`git`、`curl`：

```bash
git clone https://github.com/10ta/Sabonner.git
cd Sabonner
./init.sh
```

脚本会依次问你：是否继续 → Cloudflare 登录方式（浏览器 / API token）→ 时区 → bot token → 你的 Telegram user id，其余全部自动完成：建 D1 数据库并建表、部署 Worker、生成并设置 secret、注册 webhook 和命令菜单。

- 配置保存在仓库根目录的 `.sabonner.env`（权限 600、已加入 `.gitignore`），**管理密码 `ADMIN_TOKEN` 也在里面**。
- **以后更新**：`git pull && ./init.sh`，不会再提问。
- **换 bot 或换管理员**：`./init.sh --reset`，会重新问 token 和 user id，并重新生成 webhook 密钥和管理密码。
- 首次运行后 `worker/wrangler.toml` 会写入 database_id 和时区、`web/config.js` 会写入 Worker 地址，按脚本最后的提示提交即可（都不是机密）。网页部署见下面「网页」一节。

部署完成后照下面「在 Telegram 里测试」一节验证。

## 手动部署（init.sh 做的事，排错时参考）

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

npm run db:migrate                 # 在线上 D1 建表（按 migrations/ 依次执行）
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
npm run db:migrate  # 只执行还没跑过的迁移，重复执行是安全的
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

Cloudflare 控制台 → Workers & Pages → Create → Import a repository，选这个仓库，**Root directory 填 `worker`**。D1 在控制台 Storage & Databases → D1 里创建，把 `migrations/` 里的 SQL 按编号依次贴进 Console 执行，并把 database_id 写进 `wrangler.toml` 再 push；secret 在 Worker 的 Settings → Variables and Secrets 里加；之后照第 6、7 步做。每次 push 自动部署。

### 时区

推送里的时间默认是北京时间。改 `wrangler.toml` 的 `[vars]` 里的 `TZ`（如 `America/New_York`），然后 `npm run deploy`。

## 网页

`web/` 是纯静态页面，Cloudflare Pages 和 Vercel 都能直接托管，不需要构建。两边都只是展示，数据都来自同一个 Worker，所以可以同时部署、互为备用。

**前提**：先跑过一次 `./init.sh`，并按它最后的提示提交 `web/config.js`（里面是 Worker 地址）。

**Cloudflare Pages**：控制台 → Workers & Pages → Create → Pages → 连接 GitHub 仓库 →
Framework preset 选 **None**，Build command **留空**，Build output directory 填 **`web`** → 部署。

**Vercel**：Add New → Project → 导入仓库 → Root Directory 选 **`web`**，Framework Preset 选 **Other**，Build Command 留空 → Deploy。

之后每次 `git push` 两边都会自动更新。

- 页面右上角 **配色按钮** 可选 19 套配色（与 1999 主题相同），记在浏览器本地。
- 一页看完：左栏「进行中 + 赛程」，右栏「主播 + 赛果」（宽屏时右栏跟随滚动），窄屏自动变成上下排列。顶部导航条点一下滚到对应分栏，右下角 TOP 按钮回到顶部。
- 两队都未定（TBD vs TBD）的比赛不显示也不推送，对阵确定后自动出现。
- 右上角 **管理** → 输入管理密码（`.sabonner.env` 里的 `ADMIN_TOKEN`）后页面底部出现「管理」分栏：tier、队伍搜索订阅、斗鱼房间、TG 用户审批、立即刷新。密码只存在这个浏览器里。
- 临时指定别的 Worker：网址后加 `?api=https://xxx.workers.dev`。

## 命令

| 所有已批准用户 | 管理员额外 |
|---|---|
| `/today` 今日赛程 | |
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
| 每日预报 | UTC 0 点那一分钟 | 每人 3 个（发送、置顶、取消旧置顶），人多时顺延 |
| 国家代码表 | 30 天一次 | 3 个 |
| 发件 | 每分钟 | 用掉剩余预算，免费版每次调用上限 50 |

## 已知限制

- 只到**地图级**比分，没有回合级（bo3 的公开接口不提供）。
- 地图胜者在 bo3 里有时是简称（如 "CW"），程序会尽量对应到队伍；对不上时显示「XX 胜」。
- 斗鱼 `room_status` 只把 `"1"` 当作直播中，等实际开播时再核对一次。
- 每日预报的「今天」是 UTC 的一天，北京时间就是早 8 点到次日早 8 点；列表包含订阅范围内的全部比赛（tier + 队伍），订阅的队伍带 ⭐。
- 国旗来自 bo3 的队伍国籍；国际混编队伍可能显示所在地区旗帜（如 🇪🇺）或不显示。
- **自定义 emoji（如队徽贴纸）没有用上**：Telegram 只允许「创建者账号开了 Premium」的 bot（或绑定了 Fragment 用户名的 bot）发自定义 emoji，普通账号建的 bot 发不了。
- 免费版每次调用 CPU 上限 10ms。订阅 C tier 会让每次刷新的数据量变大，可能接近上限；如果日志里出现 `Exceeded CPU`，先关掉 C tier。
