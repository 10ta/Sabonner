#!/usr/bin/env bash
# Sabonner 一键部署 / 更新
#
# 用法（在仓库根目录）：
#   ./init.sh           首次：登录 → 选定时工作放在哪里（本机运行器 / Worker cron）→ 建库 → 建表
#                       → 部署 → 设置 secret → 注册 webhook → 启动运行器
#                       再次：复用已保存的配置，等于"更新部署"（./update.sh 会调用它）
#   ./init.sh --reset   重新输入 bot token / owner id、重新选定时工作放在哪里，并重新生成 webhook 密钥和管理密码
#
# 配置保存在仓库根目录的 .sabonner.env（权限 600，已在 .gitignore 里），不要提交；
# 选了本机运行器时，运行器自己的设置（代理、间隔）在 .sabonner-runner.env。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$ROOT/worker"
ENV_FILE="$ROOT/.sabonner.env"
DB_NAME="sabonner"
RESET=0
[[ "${1:-}" == "--reset" ]] && RESET=1

# ---------- 输出 ----------
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B='' G='' Y='' R='' N=''; fi
step() { echo; echo "${B}==> $*${N}"; }
ok()   { echo "${G}✔${N} $*"; }
warn() { echo "${Y}!${N} $*"; }
die()  { echo "${R}✘ $*${N}" >&2; exit 1; }
ask()  { local __v; read -r -p "$1" __v; printf '%s' "$__v"; }
ask_secret() { local __v; read -r -s -p "$1" __v; echo >&2; printf '%s' "$__v"; }

cd "$WORKER_DIR" || die "找不到 worker 目录：$WORKER_DIR"
wr() { npx --no-install wrangler "$@"; }

# ---------- 0. 读取已保存的配置 ----------
TG_TOKEN="" OWNER_ID="" TG_WEBHOOK_SECRET="" ADMIN_TOKEN="" WORKER_URL="" TZ_NAME="" RUNNER=""
SAVED_CF_TOKEN="" SAVED_CF_ACCOUNT=""
FIRST_RUN=1
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  FIRST_RUN=0
fi
[[ -n "$SAVED_CF_TOKEN" && -z "${CLOUDFLARE_API_TOKEN:-}" ]] && export CLOUDFLARE_API_TOKEN="$SAVED_CF_TOKEN"
[[ -n "$SAVED_CF_ACCOUNT" && -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && export CLOUDFLARE_ACCOUNT_ID="$SAVED_CF_ACCOUNT"

save_env() {
  local tmp; tmp="$(mktemp)"
  {
    echo "# Sabonner 部署配置（由 init.sh 生成，勿提交）"
    for k in TG_TOKEN OWNER_ID TG_WEBHOOK_SECRET ADMIN_TOKEN WORKER_URL TZ_NAME SAVED_CF_TOKEN SAVED_CF_ACCOUNT RUNNER; do
      printf '%s=%q\n' "$k" "${!k}"
    done
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

rand() { openssl rand -hex 24 2>/dev/null || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }

# ---------- 1. 环境检查 ----------
step "检查环境"
command -v node >/dev/null || die "没有 node，请先安装 Node.js 20 或更新版本"
command -v npm  >/dev/null || die "没有 npm"
command -v curl >/dev/null || die "没有 curl"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node.js 版本是 $(node -v)，需要 20 或更新"
ok "node $(node -v)"

if (( FIRST_RUN )); then
  cat <<EOF

${Y}部署前请确认：${N}
  · 会占用你 Cloudflare 账户 ${B}5 个免费 cron 名额中的 1 个${N}，每天的请求额度与账户里其他 Worker 共用
  · 你提供的 bot token 会被设置 webhook，${B}该 bot 不能再被其他程序用轮询方式读取消息${N}
EOF
  [[ "$(ask '继续？[Y/n] ')" =~ ^[Nn] ]] && exit 0
fi

if [[ ! -d node_modules/wrangler ]]; then
  step "安装依赖（首次较慢）"
  npm install --no-audit --no-fund --loglevel=error
fi
ok "wrangler $(wr --version 2>/dev/null | tail -1)"

# ---------- 2. Cloudflare 登录 ----------
step "检查 Cloudflare 登录"
logged_in() { wr whoami </dev/null 2>&1 | grep -qi "logged in"; }
if ! logged_in; then
  echo "还没有登录 Cloudflare，选择登录方式："
  echo "  1) 浏览器登录（本机有浏览器时）"
  echo "  2) API token（服务器 / 没有浏览器时）"
  case "$(ask '输入 1 或 2：')" in
    1) wr login ;;
    2)
      cat <<'EOF'
创建 token：https://dash.cloudflare.com/profile/api-tokens → Create Token
  → 模板选 "Edit Cloudflare Workers" → 权限里再加一行 "Account · D1 · Edit" → 创建
EOF
      CLOUDFLARE_API_TOKEN="$(ask_secret '粘贴 API token：')"
      export CLOUDFLARE_API_TOKEN
      acct="$(ask 'Account ID（Workers & Pages 页面右侧可见；账户只有一个可直接回车）：')"
      [[ -n "$acct" ]] && export CLOUDFLARE_ACCOUNT_ID="$acct"
      if [[ "$(ask '把 token 保存到 .sabonner.env 方便下次更新？[Y/n] ')" =~ ^[Nn] ]]; then
        SAVED_CF_TOKEN="" SAVED_CF_ACCOUNT=""
      else
        SAVED_CF_TOKEN="$CLOUDFLARE_API_TOKEN" SAVED_CF_ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-}"
      fi
      ;;
    *) die "已取消" ;;
  esac
  logged_in || die "登录失败。API token 方式请检查权限是否包含 Workers Scripts 和 D1"
fi
ok "已登录 Cloudflare"

# ---------- 3. 时区 ----------
if [[ -z "$TZ_NAME" ]]; then
  TZ_NAME="$(ask '推送显示的时区 [Asia/Shanghai]：')"
  TZ_NAME="${TZ_NAME:-Asia/Shanghai}"
fi

# 改写 wrangler.toml 里的某个键（只改第一处）
set_toml() {
  KEY="$1" VAL="$2" node -e '
    const fs = require("fs"); const f = "wrangler.toml";
    const re = new RegExp(`^(${process.env.KEY}\\s*=\\s*).*$`, "m");
    const s = fs.readFileSync(f, "utf8");
    if (!re.test(s)) { console.error("wrangler.toml 里没有 " + process.env.KEY); process.exit(1); }
    fs.writeFileSync(f, s.replace(re, `$1"${process.env.VAL}"`));'
}
set_toml TZ "$TZ_NAME"
ok "时区 $TZ_NAME"

# ---------- 3b. 定时工作放在哪里 ----------
# RUNNER=vps：这台机器上的运行器（runner/，systemd 服务 sabonner-runner），Worker 的 cron 每 10 分钟只检查运行器的心跳
# RUNNER=worker：Worker 每分钟的 cron 自己跑全部定时工作
# RUNNER=remote：运行器装在另一台机器上，这台只用来部署（cron 同样是每 10 分钟检查心跳，本机不装运行器）
# 选择存在 .sabonner.env 的 RUNNER；想换的话把那一行清空（RUNNER=），再运行 ./update.sh 或 ./init.sh 会重新问
RUNNER_ENV="$ROOT/.sabonner-runner.env"
UNIT=/etc/systemd/system/sabonner-runner.service
CAN_ASK=0; [[ -t 0 ]] && CAN_ASK=1
NEW_RUNNER=0
runner_get() { [[ -f "$RUNNER_ENV" ]] && sed -n "s/^$1=//p" "$RUNNER_ENV" | tail -1 | tr -d "'\"" || true; }
runner_set() {   # 键 值：改 .sabonner-runner.env 里的这一行（没有就追加）
  KEY="$1" VAL="$2" node -e '
    const fs = require("fs"); const f = process.argv[1]; const { KEY, VAL } = process.env;
    const line = `${KEY}=${/^[A-Za-z0-9_.:/@%+=,-]*$/.test(VAL) ? VAL : `'"'"'${VAL.replace(/'"'"'/g, `'"'"'\\'"'"''"'"'`)}'"'"'`}`;
    let s = fs.readFileSync(f, "utf8"); const re = new RegExp(`^${KEY}=.*$`, "m");
    s = re.test(s) ? s.replace(re, () => line) : s.replace(/\n?$/, `\n${line}\n`);
    fs.writeFileSync(f, s);' "$RUNNER_ENV"
}
set_crons() {
  VAL="$1" node -e '
    const fs = require("fs"); const f = "wrangler.toml"; const s = fs.readFileSync(f, "utf8");
    const re = /^crons[ \t]*=[ \t]*\[.*\][ \t]*$/m;   // 只匹配这一行（\s 会吃掉后面的空行）
    if (!re.test(s)) { console.error("wrangler.toml 里没有 crons"); process.exit(1); }
    fs.writeFileSync(f, s.replace(re, `crons = ["${process.env.VAL}"]`));'
}

if (( RESET )) || [[ -z "$RUNNER" ]]; then
  step "定时工作放在哪里"
  if (( CAN_ASK )); then
    cat <<EOF
直播轮询、赛前提醒、斗鱼开播检查、发消息这些定时工作：
  1) 放在这台机器上的运行器（推荐）：直播每分钟更新、消息马上发，Cloudflare 上几乎不耗 CPU。
     需要 systemd、root，这台机器要一直开着；它停了推送就停（Worker 会发 Telegram 提醒你）
  2) 放在 Cloudflare Worker 的每分钟 cron：不依赖这台机器，但受免费版每次 10ms CPU 的限制，比分和推送会慢几分钟
  3) 运行器已经装在另一台机器上了，这台只用来部署（不在这里装运行器）
EOF
    case "$(ask '选 1、2 还是 3 [1]：')" in 2) RUNNER=worker ;; 3) RUNNER=remote ;; *) RUNNER=vps ;; esac
    NEW_RUNNER=1
  else
    warn "没有终端可以提问：这次不改定时工作的方式（cron 保持 wrangler.toml 里现在的设置）。在终端里运行 ./update.sh 或 ./init.sh 时会问"
  fi
fi

if [[ "$RUNNER" == vps ]]; then
  step "准备运行器"
  [[ $EUID -eq 0 ]] || die "运行器要装成 systemd 服务，需要用 root 运行（或者把 .sabonner.env 里的 RUNNER 改成 worker）"
  [[ -d /run/systemd/system ]] || die "这台机器没有 systemd，装不了运行器服务（把 .sabonner.env 里的 RUNNER 改成 worker 改用 Worker cron）"
  if [[ ! -f "$RUNNER_ENV" ]]; then
    cp "$ROOT/runner/runner.env.example" "$RUNNER_ENV"
    chmod 600 "$RUNNER_ENV"
    NEW_RUNNER=1
  fi
  if (( NEW_RUNNER && CAN_ASK )); then
    cur="$(runner_get RUNNER_PROXY)"
    echo "运行器的请求（bo3、斗鱼、Telegram、Cloudflare）要不要走代理？"
    echo "  填 socks5://主机:端口（例如 socks5://127.0.0.1:7050），直连就输入 -"
    p="$(ask "代理${cur:+ [$cur]}：")"
    [[ "$p" == "-" ]] && p="" || p="${p:-$cur}"
    [[ -z "$p" || "$p" =~ ^socks5h?:// ]] || die "只支持 socks5:// 开头的代理：$p"
    runner_set RUNNER_PROXY "$p"
  fi
  # 读写 D1 用的 token：默认用上面登录时保存的 SAVED_CF_TOKEN；浏览器登录的话没有，单独要一个
  if [[ -z "$SAVED_CF_TOKEN" && -z "$(runner_get RUNNER_CF_TOKEN)" ]]; then
    (( CAN_ASK )) || die "运行器需要一个 Cloudflare API token 读写 D1，在终端里运行一次 ./init.sh 输入"
    cat <<'EOF'
运行器要一个 Cloudflare API token 读写 D1（浏览器登录的方式没有保存 token）：
  https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token → 权限只加一行 "Account · D1 · Edit"
EOF
    runner_set RUNNER_CF_TOKEN "$(ask_secret '粘贴 token：')"
  fi
  proxy="$(runner_get RUNNER_PROXY)"
  set_crons "*/10 * * * *"
  ok "定时工作：这台机器上的运行器（代理：${proxy:-直连}；其余设置在 .sabonner-runner.env）"
elif [[ "$RUNNER" == remote || "$RUNNER" == worker ]]; then
  if [[ "$RUNNER" == remote ]]; then
    set_crons "*/10 * * * *"
    ok "定时工作：另一台机器上的运行器（这台只部署；Worker 每 10 分钟检查一次运行器的心跳）"
  else
    set_crons "* * * * *"
    ok "定时工作：Worker 每分钟的 cron"
  fi
  if [[ -f "$UNIT" ]]; then
    [[ $EUID -eq 0 ]] || die "这台机器上装着运行器，换方式要先停掉它，需要 root 运行"
    systemctl disable --now -q sabonner-runner 2>/dev/null || true
    rm -f "$UNIT"; systemctl daemon-reload
    ok "已停止并移除运行器服务（.sabonner-runner.env 留着，以后换回来还能用）"
  fi
fi

# ---------- 4. D1 数据库 ----------
step "准备 D1 数据库"
d1_id() {
  wr d1 list --json </dev/null 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      try {
        const j = JSON.parse(s.slice(s.indexOf("[")));
        const db = j.find((x) => x.name === process.argv[1]);
        process.stdout.write(db ? (db.uuid || db.database_id || "") : "");
      } catch { process.stdout.write(""); }
    });' "$DB_NAME"
}
DB_ID="$(d1_id)"
if [[ -z "$DB_ID" ]]; then
  wr d1 create "$DB_NAME" </dev/null >/dev/null
  DB_ID="$(d1_id)"
  [[ -n "$DB_ID" ]] || die "D1 创建后仍查不到，请在控制台 Storage & Databases → D1 确认"
  ok "已创建 D1：$DB_NAME"
else
  ok "D1 已存在：$DB_NAME"
fi
set_toml database_id "$DB_ID"

MIG_OUT="$(wr d1 migrations apply "$DB_NAME" --remote </dev/null 2>&1)" || { echo "$MIG_OUT" | tail -20; die "数据库迁移失败"; }
if grep -q "No migrations to apply" <<<"$MIG_OUT"; then ok "表结构已是最新"; else ok "表结构已更新"; fi

# ---------- 5. bot 与管理员 ----------
if (( RESET )) || [[ -z "$TG_TOKEN" || -z "$OWNER_ID" ]]; then
  step "配置 Telegram"
  while :; do
    TG_TOKEN="$(ask_secret 'bot token（@BotFather 给的，形如 123456:ABC...）：')"
    me="$(curl -s "https://api.telegram.org/bot${TG_TOKEN}/getMe" || true)"
    if grep -q '"ok":true' <<<"$me"; then
      ok "bot：@$(sed -E 's/.*"username":"([^"]+)".*/\1/' <<<"$me")"
      break
    fi
    warn "token 无效（或这台机器连不上 api.telegram.org），重新输入"
  done
  while :; do
    OWNER_ID="$(ask '你的 Telegram user id（给 @userinfobot 发消息可查）：')"
    [[ "$OWNER_ID" =~ ^[0-9]+$ ]] && break
    warn "应为纯数字"
  done
fi
NEW_SECRET=0
if (( RESET )) || [[ -z "$TG_WEBHOOK_SECRET" ]]; then TG_WEBHOOK_SECRET="$(rand)"; NEW_SECRET=1; fi
if (( RESET )) || [[ -z "$ADMIN_TOKEN" ]]; then ADMIN_TOKEN="$(rand)"; fi
save_env

# 运行器自检：在动 Worker 之前确认运行器在这台机器上能连通 D1、Telegram、bo3、斗鱼。
# 不通就停在这里，线上保持原样
if [[ "$RUNNER" == vps ]]; then
  step "运行器自检"
  (cd "$ROOT" && node runner/main.mjs --check) || die "运行器自检没通过，见上面的 ✘（代理等设置在 .sabonner-runner.env）。Worker 还没有改动"
fi

# ---------- 6. 部署 ----------
step "部署 Worker"
set +e
DEPLOY_OUT="$(wr deploy </dev/null 2>&1)"
DEPLOY_RC=$?
set -e
echo "$DEPLOY_OUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -vE "^\s*$|Proxy environment" | tail -15
if (( DEPLOY_RC != 0 )); then
  if grep -qi "workers.dev" <<<"$DEPLOY_OUT"; then
    warn "账户可能还没有 workers.dev 子域：控制台 Workers & Pages 页面里注册一个，然后重新运行 ./init.sh"
  fi
  die "部署失败，见上面的输出"
fi
url="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' <<<"$DEPLOY_OUT" | head -1 || true)"
[[ -n "$url" ]] && WORKER_URL="$url"
if [[ -z "$WORKER_URL" ]]; then
  WORKER_URL="$(ask '没有从输出里找到地址，请输入 Worker 地址（https://...）：')"
fi
WORKER_URL="${WORKER_URL%/}"
save_env
ok "已部署：$WORKER_URL"

# 网页读取的 Worker 地址
CONFIG_JS="$ROOT/web/config.js"
if [[ -f "$CONFIG_JS" ]] && ! grep -qF "'$WORKER_URL'" "$CONFIG_JS"; then
  URL="$WORKER_URL" node -e '
    const fs = require("fs"); const f = process.argv[1];
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/window\.SABONNER_API = .*;/, `window.SABONNER_API = ${JSON.stringify(process.env.URL).replace(/"/g, "\x27")};`));' "$CONFIG_JS"
  ok "web/config.js 已写入 Worker 地址"
fi

# ---------- 7. secret ----------
step "设置 secret"
TG_TOKEN="$TG_TOKEN" OWNER_ID="$OWNER_ID" TG_WEBHOOK_SECRET="$TG_WEBHOOK_SECRET" ADMIN_TOKEN="$ADMIN_TOKEN" \
  node -e 'const e = process.env; console.log(JSON.stringify({ TG_TOKEN: e.TG_TOKEN, OWNER_ID: e.OWNER_ID, TG_WEBHOOK_SECRET: e.TG_WEBHOOK_SECRET, ADMIN_TOKEN: e.ADMIN_TOKEN }))' \
  | wr secret bulk >/dev/null
ok "TG_TOKEN / OWNER_ID / TG_WEBHOOK_SECRET / ADMIN_TOKEN 已设置"

# ---------- 8. webhook ----------
step "注册 webhook 和命令菜单"
for i in $(seq 1 12); do
  curl -sf "$WORKER_URL/" >/dev/null && break
  (( i == 12 )) && die "访问不到 $WORKER_URL，新子域可能还在生效，几分钟后重新运行 ./init.sh"
  sleep 5
done
SETUP_OK=0
for i in 1 2 3 4 5 6 7 8; do
  res="$(curl -s "$WORKER_URL/setup?token=$ADMIN_TOKEN" || true)"
  # 只要求 webhook 成功；命令菜单失败不影响使用
  if grep -qE '"webhook":\{"ok":true' <<<"$res"; then SETUP_OK=1; break; fi
  # 前几次多半是 secret 刚设置、新版本还没生效；Telegram 偶尔解析不了 workers.dev 域名，多等一会儿
  (( i > 1 )) && echo "  第 $i 次重试…"
  sleep $(( i < 4 ? 4 : 10 ))
done
if (( SETUP_OK )); then
  ok "webhook 已注册"
else
  # 注册失败时 Telegram 会保留原来的 webhook。地址没变、secret 也没换的话，原来那个照样能用，不必中断
  cur="$(curl -s "https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo" | sed 's#\\/#/#g' || true)"
  if (( ! NEW_SECRET )) && grep -qF "\"url\":\"$WORKER_URL/tg\"" <<<"$cur"; then
    warn "这次没能重新注册 webhook（Telegram：$(sed -E 's/.*"description":"([^"]*)".*/\1/' <<<"$res")）"
    warn "不过之前注册的地址和 secret 都没变，bot 照常工作。想重试的话之后再运行一次 ./init.sh"
  else
    die "注册失败，Worker 返回：$res
  Telegram 解析不了域名这类错误一般过几分钟就好，稍后重新运行 ./init.sh"
  fi
fi
if grep -q 'chat not found' <<<"$res"; then
  warn "管理员命令菜单暂未设置：你还没给这个 bot 发过消息。发一次 /start 就会自动补上，不影响使用"
elif ! grep -qE '"ownerCommands":\{"ok":true' <<<"$res"; then
  warn "管理员命令菜单设置失败（不影响使用）：$res"
fi

info="$(curl -s "https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo" || true)"
if grep -q '"last_error_message"' <<<"$info"; then
  warn "Telegram 报告过 webhook 错误：$(sed -E 's/.*"last_error_message":"([^"]*)".*/\1/' <<<"$info")（旧错误可以忽略，发条消息再看）"
fi

# ---------- 9. 运行器 ----------
if [[ "$RUNNER" == vps ]]; then
  step "启动运行器"
  printf '%s\n' \
    '[Unit]' \
    'Description=Sabonner runner (bo3 / Douyu polling, Telegram pushes)' \
    'After=network-online.target' \
    'Wants=network-online.target' \
    '' \
    '[Service]' \
    'Type=simple' \
    "WorkingDirectory=$ROOT" \
    "ExecStart=$(command -v node) runner/main.mjs" \
    'Restart=always' \
    'RestartSec=15' \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target' > "$UNIT"
  systemctl daemon-reload
  systemctl enable -q sabonner-runner
  systemctl restart sabonner-runner
  sleep 3
  systemctl is-active --quiet sabonner-runner || die "运行器没有起来，看日志：journalctl -u sabonner-runner -n 50 --no-pager"
  ok "运行器运行中（systemd 服务 sabonner-runner，开机自启）"
  journalctl -u sabonner-runner -n 3 --no-pager -o cat 2>/dev/null | sed 's/^/    /' || true
fi

# ---------- 完成 ----------
cat <<EOF

${G}${B}部署完成${N}
  Worker     $WORKER_URL
  管理密码   保存在 .sabonner.env 的 ADMIN_TOKEN（网页管理用）

下一步，在 Telegram 给你的 bot 发：
  /start           应看到带「管理」部分的帮助
  /tier            勾选要订阅的 tier
  /team spirit     搜索并订阅队伍
  /room 6657       添加斗鱼主播

定时工作：  $(case "$RUNNER" in vps) echo "这台机器上的运行器（日志：journalctl -u sabonner-runner -f）" ;; remote) echo "另一台机器上的运行器" ;; worker) echo "Worker 每分钟的 cron" ;; *) echo "还没选（在终端里运行 ./update.sh 会问）" ;; esac)
看实时日志：  cd worker && npx wrangler tail
以后更新：    ./update.sh

网页：把仓库接到 Cloudflare Pages 和 / 或 Vercel，根目录填 web，没有构建命令（见 README「网页」一节）
EOF
if ! git -C "$ROOT" diff --quiet -- worker/wrangler.toml web/config.js 2>/dev/null; then
  echo
  warn "worker/wrangler.toml / web/config.js 有改动（database_id、时区、Worker 地址，都不是机密），提交后网页才会用上："
  echo "    git add worker/wrangler.toml web/config.js && git commit -m 'config: deploy' && git push"
fi
