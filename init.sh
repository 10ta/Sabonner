#!/usr/bin/env bash
# Sabonner 一键部署 / 更新
#
# 用法（在仓库根目录）：
#   ./init.sh           首次：登录 → 建库 → 建表 → 部署 → 设置 secret → 注册 webhook
#                       再次：复用已保存的配置，等于"更新部署"
#   ./init.sh --reset   重新输入 bot token / owner id，并重新生成 webhook 密钥和管理密码
#
# 配置保存在仓库根目录的 .sabonner.env（权限 600，已在 .gitignore 里），不要提交。

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
TG_TOKEN="" OWNER_ID="" TG_WEBHOOK_SECRET="" ADMIN_TOKEN="" WORKER_URL="" TZ_NAME=""
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
    for k in TG_TOKEN OWNER_ID TG_WEBHOOK_SECRET ADMIN_TOKEN WORKER_URL TZ_NAME SAVED_CF_TOKEN SAVED_CF_ACCOUNT; do
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

wr d1 execute "$DB_NAME" --remote --file=schema.sql -y </dev/null >/dev/null
ok "表结构已同步"

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
if (( RESET )) || [[ -z "$TG_WEBHOOK_SECRET" ]]; then TG_WEBHOOK_SECRET="$(rand)"; fi
if (( RESET )) || [[ -z "$ADMIN_TOKEN" ]]; then ADMIN_TOKEN="$(rand)"; fi
save_env

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
for i in 1 2 3 4 5; do
  res="$(curl -s "$WORKER_URL/setup?token=$ADMIN_TOKEN" || true)"
  if [[ "$(grep -o '"ok":true' <<<"$res" | wc -l)" -ge 3 ]]; then SETUP_OK=1; break; fi
  sleep 4   # secret 刚设置，等新版本生效
done
(( SETUP_OK )) || die "注册失败，Worker 返回：$res"
ok "webhook 已注册"

info="$(curl -s "https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo" || true)"
if grep -q '"last_error_message"' <<<"$info"; then
  warn "Telegram 报告过 webhook 错误：$(sed -E 's/.*"last_error_message":"([^"]*)".*/\1/' <<<"$info")（旧错误可以忽略，发条消息再看）"
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

看实时日志：  cd worker && npx wrangler tail
以后更新：    git pull && ./init.sh
EOF
if ! git -C "$ROOT" diff --quiet -- worker/wrangler.toml 2>/dev/null; then
  echo
  warn "worker/wrangler.toml 已写入 database_id 和时区，建议提交：git commit -am 'config: d1 id' && git push"
fi
