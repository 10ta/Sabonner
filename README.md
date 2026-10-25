# Sabonner

CS2 比赛订阅与斗鱼开播提醒：Cloudflare Worker 后端 + Telegram bot + 网页（CF Pages / Vercel，沿用 1999 主题风格）。

- 按 **tier**（S/A/B/C）、**bo3 星级**（≥ N 星）或 **队伍** 订阅比赛，三项任一命中即可：每天的预报里列出今明两天的比赛，开赛前 30 分钟再单独提醒一次
- 比赛进行中：一张可原地更新的比分卡片；每张图打完单独推送；结束时推送胜者（大比分分出胜负就算结束，不等 bo3 改状态）
- 每天 **UTC 0 点**发今日 + 明日赛程并自动置顶，第二天替换；两天都没有比赛时告诉你下一场是什么
- **赛事**：网页「赛事」分栏和每日预报末尾列出进行中、60 天内开始、并且和订阅范围有交集（tier 命中 / 有订阅的队伍参赛 / 有正在跟踪的比赛）的赛事；没有就不显示。列表每 6 小时从 bo3 更新一次，/refresh 会立即更新
- **赛后记分板**：bo3 赛后几小时内解析完 demo 后，自动取每名选手的 K / D / A、+/-、ADR，把已经发出的结束消息编辑成带记分板的版本；网页点开赛果卡片可以看地图比分和记分板（Ctrl / ⌘ 点击仍直接打开 bo3.gg）。bo3 的公开数据里没有选图 / 禁图信息
- **直播卡片**开赛时发一条，之后比分、地图有变化就原地编辑。Telegram 上显示的一直是第一次发出的时间，所以卡片末尾写着这次内容是几点更新的；「地图 X 结束」消息和卡片上的这张图比分是同一次轮询里同时生成的
- **自动清理消息**：「地图 X 结束」发出 5 分钟后删掉（比分已同步到直播卡片）；开赛后删掉 30 分钟提醒；比赛结束后删掉直播卡片和各张地图的消息（结束消息里已有全部比分）；新的每日预报发出后删掉前一天的预报和「已置顶」提示。赛果和开播提醒保留
- 消息里带队伍国旗、世界排名、赛事奖金、LAN / ONLINE、星级、bo3 的 AI 预测和每张图的比分，以及赛段（如 [decider / 3rd place](https://bo3.gg/tournaments/esl-pro-league-season-24#tab-stages)，链接到 bo3 的赛段页）
- **斗鱼主播开播**提醒（每 10 分钟查一次；下播后 20 分钟内又开播算断流重连，不重复推）
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
    outbox.js     发件队列（超出子请求预算的消息顺延到下一次）
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
- **赛前提醒**：订阅后不会补发预告，发 /today 可以马上看今明两天的赛程；之后每天 UTC 0 点自动发，开赛前 30 分钟再单独提醒。
- **直播卡片**：想马上看到效果，可以临时 `/tier` 打开 **B** 或 **C**（这两档几乎随时有比赛在打），几分钟内会收到 🔴 LIVE 卡片；看完再关掉。C 档数据量大，测完记得关。
- **其他用户**：用另一个账号给 bot 发 `/start`，你会收到带「批准 / 拒绝」按钮的申请。

### 8. 看日志

```bash
npx wrangler tail          # 实时日志，Ctrl+C 退出；cron 每分钟一条 [cron] …
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
- 一页看完，从上到下：「赛果」（紧凑小卡，默认显示两行，可展开全部）→「直播」（斗鱼主播小条 + 进行中的比赛）→「赛程」。顶部导航条点一下滚到对应分栏，右下角 TOP 按钮回到顶部。
- 队徽不带框；在当前配色下看不清的队徽（比如浅色主题里的黄色、深色主题里的黑色）会自动画成全黑 / 全白，做法同 Liquipedia
- AI 预测挂在预测胜者队徽左上角（「AI 2:0」），比赛结束后猜中变绿、没猜中变红。
- 页面有比赛进行中或 30 分钟内开赛时每 30 秒刷新一次，其余时间 2 分钟一次（倒计时在本地走，不额外请求）；切到别的标签页时暂停。
- 两队都未定（TBD vs TBD）的比赛不显示也不推送，对阵确定后自动出现。
- 右上角 **管理** → 输入管理密码（`.sabonner.env` 里的 `ADMIN_TOKEN`）后页面底部出现「管理」分栏：tier、队伍搜索订阅、斗鱼房间、TG 用户审批、立即刷新。密码只存在这个浏览器里。
- 临时指定别的 Worker：网址后加 `?api=https://xxx.workers.dev`。

## 命令

| 所有已批准用户 | 管理员额外 |
|---|---|
| `/today` 今明两天赛程 | |
| `/next` 即将开始 | `/team 名字` 搜索订阅；不带参数列出并可退订 |
| `/live` 进行中 | `/tier` 切换 tier；`/stars` 按星级订阅 |
| `/results` 最近赛果 | `/room 房间号` 添加；不带参数列出并可删除 |
| `/subs` 当前订阅 | `/users` 审批 / 撤销 |
| `/rooms` 主播状态 | `/refresh` 立即刷新赛程 |
| `/stop` 不再接收推送 | `/status` 运行状态 |

## 运行方式

cron 每分钟一次。免费版**每次调用最多 10ms CPU**（偶尔超出会被容忍，经常超出会被终止）。最耗 CPU 的是解析 bo3 返回的比赛列表，所以按分钟错开，**一次调用最多发一个 bo3 列表请求**：

| 分钟 | 任务 | 外部请求 |
|---|---|---|
| 偶数分钟，20 分钟一轮 | 依次：tier ① → 作为队伍 1 的比赛 → 赛后数据 → tier ② → 作为队伍 2 的比赛 → 赛事列表（6 小时过期才请求；没过期就清理旧数据）→ tier ③ → 星级 → 赛后数据 → tier ④（顺带删掉不再命中订阅的比赛）。没订阅的 tier / 队伍 / 星级那一格空着 | 每格 0–1 个（+ 新赛事信息 0–1 个；赛后数据最多 3 场） |
| 奇数分钟 | 一次 D1 batch 读完状态（包括直播比赛已经领过的去重键和接收人），没事做的步骤直接跳过：每日预报（UTC 0 点后第一次）、直播轮询（比赛进行中，或已到预定开赛时间；只向 bo3 要比分和每张图，队伍、赛事等沿用库里的；一张图开打后 20 分钟内不问）、赛前 30 分钟提醒、斗鱼开播检查（每 10 分钟一次，只解析返回里的房间信息那一段）、地图消息到期删除、发件。比分没变化时整分钟只有 1 次 D1 往返；有消息要发时，比赛状态和消息一次写入、发件前要读的东西一次读完；**每次总共最多 4 个外部请求**（bo3、斗鱼、Telegram 都算，线上每个约 2–3ms CPU），至少留 1 个给 Telegram，发不完的留到下一次 | 直播 1 个、斗鱼每个房间 1 个（多于 12 个时分组轮转）、发件用剩下的 |
| 30 天一次 | 国家代码表 | 3 个 |

所以直播比分和推送是**每 2 分钟**一次、斗鱼开播每 10 分钟一次（接收人多、同时有好几条消息时，后面的会再晚一两轮，比如 3 个接收人的开赛卡片分 2–3 次发完）；赛程每 20 分钟更新一轮（赛程是提前几天排好的，不需要更快；直播比分和 30 分钟提醒不受影响）。

几处按时间表省掉的请求：
- **到了预定开赛时间才开始问 bo3 比分**（CS 几乎不会提前开赛，推迟倒是常见）。bo3 标成进行中才发直播卡片，推迟的比赛不会先发一张空的 LIVE。
- **一张图开打后 20 分钟内不问**：只报到地图级比分，一张图最快也要二十多分钟。所以「地图 X 结束」和卡片上的比分最多比实际晚 2 分钟左右，偶尔一张特别快的图会晚一点。
- **赛后数据只在比赛结束后 1、2、4、8 小时各查一次**，8 小时后还没有就不再等（bo3 解析 demo 通常一到几小时）。网页、TG 里的「立即刷新」还是一次拉完。

每次 cron 在日志里留一行，如 `[cron] live:2+3 douyu`（轮询 2 场比赛、入队 3 条消息、查了斗鱼）、`[cron] refresh:tier:a(41)`，可以在 Observability 里看每分钟做了什么。CPU 时间不在这条日志上（Workers Logs 只把它记在调用本身），各 Worker 的 CPU P50 / P90 / P99 在 Sonde 的 Workers 卡片或控制台 Metrics 里看。

**存储上限**：比赛数据在 D1 里只保留开赛后 7 天，另外最多 3000 行（超出时删最旧的）；推送去重记录 30 天，发件队列 6 小时，赛事缓存 30 天，已发消息记录 48 小时（用于自动删除）。清理每小时跑一次，数据库通常只有几百 KB。

**D1 用量**：D1 是 Cloudflare 的数据库（SQLite），免费额度每天读 500 万行、写 10 万行、存储 5GB，**整个 Cloudflare 账户共享**；超出后当天查询报错，次日恢复，不会扣费。比赛数据只在有变化时才写，订阅 S tier + 几支队伍时写入通常每天几千行。用量在控制台 Storage & Databases → D1 → sabonner → Metrics 查看。
## 排查 CPU

Worker 里拿不到自己用了多少 CPU（执行代码时计时器不走），控制台只有整体的 P50 / P90 / P99。想知道是哪种任务、哪段代码在耗 CPU，用 `worker/tools/` 下的两个工具（只在本地跑，不部署）：

**线上：每种任务的真实 CPU。** 录 25 分钟以上（cron 一轮 20 分钟），按 `[cron]` 日志把每次调用的 CPU 时间归到任务上：

```bash
cd worker
npx wrangler tail sabonner --format json > tail.json   # 25 分钟后 Ctrl+C
node tools/tail-cpu.mjs tail.json
```

如果提示 tail 输出里没有 CPU 时间字段，就用下面的本地测量。

**本地：每种任务、每个函数的耗时。** 先读线上的公开接口拿到当前订阅，用真实网络按 cron 的节奏模拟一轮，把 bo3 / 斗鱼的响应存到 `tools/fixtures/`；之后不用网络，反复重放同样的数据来测（需要 Node 22.5+，版本不够就把 `node` 换成 `npx -y node@22`）：

```bash
cd worker
node tools/profile.mjs record https://sabonner.<你的子域>.workers.dev
node tools/profile.mjs --prof --cold
```

输出（同时存到 `tools/fixtures/report.txt`）：每一分钟做了什么、各花多少毫秒（冷启动 / 预热后）、D1 往返和外部请求各几次，按任务汇总，`/api/overview` 的耗时，每个外部响应有多大，最耗时的函数（`--prof`），以及每种任务在全新进程里第一次跑的耗时（`--cold`，相当于线上实例刚启动）。本地机器和 Cloudflare 的绝对值不同，看各任务之间的比例；本地数据库的耗时已经减掉，所以 Workers 上每次 D1 往返本身的开销这里看不到，要看 D1 往返次数。回放时如果比赛状态和录制时不同，缺的请求会列在 `tools/fixtures/missing.txt`。Telegram 不会真发；fixtures 里只有 bo3 / 斗鱼的公开数据和公开接口返回的订阅。

## 已知限制

- 有人拉黑或注销 Telegram 后，第一次推送失败就会被自动移出接收名单（等同 /stop），之后不再浪费请求；对方重新 /start 可以再申请。
- **超过 48 小时的消息 bot 删不掉**（Telegram 的限制）。想让聊天里的消息 7 天后自动消失，可以在和 bot 的聊天里打开 Telegram 自带的「自动删除消息 → 1 周」：点 bot 头像 → 右上角 ⋮ → 自动删除。只对打开之后的新消息生效，双方的消息都会删；每个用户在自己的聊天里单独设置。

- 只到**地图级**比分，没有回合级（bo3 的公开接口不提供）。
- 地图胜者在 bo3 里有时是简称（如 "CW"），程序会尽量对应到队伍；对不上时显示「XX 胜」。
- 斗鱼数据来自手机站接口 `m.douyu.com/api/room/info`（从 Cloudflare 海外节点实测可用，靓号如 6657 和真实房间号都认）。旧的 open API 数据已冻结、`betard` 对海外 IP 返回「房间已关闭」，都不再使用。同一场直播（开播时间不变）只推一次。这个接口分不出直播和录播：主播下播后放录播时仍是 `isLive=1`，开播时间还是上一次直播的，所以不会重复推送，只是网页上会显示成直播中；因为分不出来，所以查得不勤（每 10 分钟）。
- 每日预报的「今天」「明天」都按 UTC 划分，北京时间就是早 8 点到次日早 8 点；预报发出后才排进来的比赛（比如当天临时确定对阵）只有 30 分钟提醒；列表包含订阅范围内的全部比赛（tier + 队伍），订阅的队伍带 ⭐。
- 国旗来自 bo3 的队伍国籍；国际混编队伍可能显示所在地区旗帜（如 🇪🇺）或不显示。
- **自定义 emoji（如队徽贴纸）没有用上**：Telegram 只允许「创建者账号开了 Premium」的 bot（或绑定了 Fragment 用户名的 bot）发自定义 emoji，普通账号建的 bot 发不了。
- 免费版每次调用 CPU 上限 10ms。订阅 C tier 会让 tier 那一路刷新的数据量变大，可能接近上限；如果日志里出现 `Exceeded CPU`（或 Sonde 上 sabonner 的 CPU P90 长期超过 10ms），先关掉 C tier（tier 那一格数据量最大）。
- 网页接口（`/api/overview`、`/api/matches`）在 Worker 内存里缓存 20 秒，网页上的管理操作成功后立即清掉；TG 里改订阅后网页最多晚 20 秒看到。
