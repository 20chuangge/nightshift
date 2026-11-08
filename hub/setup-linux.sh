#!/usr/bin/env bash
# =============================================================================
#  setup-linux.sh —— 把一台 Linux 机器变成 Desk Hub
#  支持：Ubuntu / Debian（apt）、Rocky / Alma / RHEL / CentOS Stream（dnf、yum）
#
#  Desk 客户端「添加机器」经 SSH 自动调用它；也可以手动跑：
#      sudo bash hub/setup-linux.sh                       # 在解开的程序目录里
#      sudo bash setup-linux.sh --pkg /tmp/desk-hub.tar.gz --port 4390
#
#  按顺序做：
#    1. 识别系统和包管理器
#    2. Node.js：官方二进制装进程序目录，不依赖发行版的源
#    3. 每个 Bot 的桌面：Xvfb、x11vnc、websockify、noVNC、XFCE、Chromium
#    4. 程序：只替换代码；config/、skills/ 只补缺，已有的 Bot 和设置不动
#    5. 运行账号免密 sudo（远程机器专给助理用）+ systemd 服务
#    6. 启动、放行防火墙端口
#    7. 自检并输出结果
#  重跑是安全的：数据目录和已有配置原样保留。
#
#  最后几行给 src/remote.mjs 解析：
#      DESK_HUB_URL=http://<ip>:<port>
#      DESK_PAIR_CODE=12345678
#      DESK_HUB_OK=1        <- 本机 /api/health 应答了
#      DESK_DESKTOP_OK=1    <- 每 Bot 桌面需要的程序都在
# =============================================================================
set -euo pipefail

# Bump when this script changes the system (packages, service, users): a
# machine set up with a lower number cannot take a code-only self-update.
SETUP_VERSION=1

PORT=4390
PKG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port)   PORT="$2"; shift ;;
    --port=*) PORT="${1#*=}" ;;
    --pkg)    PKG="$2"; shift ;;
    --pkg=*)  PKG="${1#*=}" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "[desk] 未知参数: $1" >&2; exit 1 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { echo "[desk] 需要 root：sudo bash $0" >&2; exit 1; }

# If the client that started us goes away (it gave up waiting, the laptop
# slept), the setup must still finish: ignore the hangup, and send all output
# through `tee -p`, which keeps writing the log after the SSH pipe is gone
# instead of killing us on the next line we print.
trap '' HUP PIPE
SETUP_LOG=/var/log/desk-setup.log
: > "$SETUP_LOG" 2>/dev/null || SETUP_LOG=/tmp/desk-setup.log
exec > >(tee -p -a "$SETUP_LOG") 2>&1

say()  { printf '\n[desk] %s\n' "$*"; }
warn() { printf '[desk] 警告：%s\n' "$*" >&2; }

# A second run (the human pressed retry while the first is still going) waits
# for the first instead of fighting it for the package lock and the files.
if command -v flock >/dev/null 2>&1; then
  exec 9>/var/lock/desk-setup.lock
  if ! flock -n 9; then
    say "上一次安装还在进行，等它结束…"
    flock -w 3600 9 || { echo "[desk] 等了一小时，上一次安装还没结束" >&2; exit 1; }
  fi
fi
has()  { command -v "$1" >/dev/null 2>&1; }

RUN_USER="${SUDO_USER:-root}"
RUN_GROUP="$(id -gn "$RUN_USER")"
SERVICE="${DESK_SERVICE_NAME:-desk-hub}"
UNIT="/etc/systemd/system/${SERVICE}.service"

# An existing install keeps its directory, and with it its bots, memory and
# workspace. Older versions installed to ~/desk-hub; new ones use /opt, which
# systemd may execute from even with SELinux enforcing.
APP_DIR="${DESK_APP_DIR:-}"
if [ -z "$APP_DIR" ] && [ -f "$UNIT" ]; then
  APP_DIR="$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | head -1)"
fi
APP_DIR="${APP_DIR:-/opt/desk-hub}"

# ---------------------------------------------------------------------------
say "1/7 识别系统"
if has apt-get; then PM=apt
elif has dnf; then PM=dnf
elif has yum; then PM=yum
else echo "[desk] 不支持的系统：没有 apt-get / dnf / yum" >&2; exit 1
fi
OS_NAME="$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-}") || true)"
OS_NAME="${OS_NAME:-$(uname -sr)}"
say "$OS_NAME（$PM），程序目录 $APP_DIR，运行账号 $RUN_USER"

# A fresh Ubuntu runs its own automatic updates right after boot: wait for
# their lock (up to 10 min) instead of failing the package.
# A stalled mirror connection (seen behind proxies) must not hang forever:
# give up on 30 s of silence and retry.
APT_WAIT="-o DPkg::Lock::Timeout=600 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=3"
pm_refresh() {
  case "$PM" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get $APT_WAIT update -qq >/dev/null 2>&1 || true ;;
    *)   "$PM" -y -q makecache >/dev/null 2>&1 || true ;;
  esac
}
pm_one() {
  case "$PM" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get $APT_WAIT install -y -qq "$1" >/dev/null 2>&1 ;;
    *)   "$PM" install -y -q "$1" >/dev/null 2>&1 ;;
  esac
}
# One package at a time: a name missing on this release must not sink the rest.
# A failure gets one retry after refreshing the index (fresh images often have
# an empty or stale one).
pm_install() {
  local pkg
  for pkg in "$@"; do
    # One line per package: the human sees it moving, and a long install is
    # never mistaken for a hang.
    printf '[desk]   安装 %s…\n' "$pkg"
    pm_one "$pkg" && continue
    pm_refresh
    pm_one "$pkg" || warn "没装上 $pkg"
  done
}

pm_refresh
if [ "$PM" != apt ]; then
  # Xvfb, x11vnc, websockify, noVNC and XFCE live in EPEL on the RHEL family;
  # CRB carries some of their dependencies.
  pm_install epel-release
  if [ "$PM" = dnf ]; then
    dnf -y -q install dnf-plugins-core >/dev/null 2>&1 || true
    dnf config-manager --set-enabled crb >/dev/null 2>&1 || dnf config-manager --set-enabled powertools >/dev/null 2>&1 || true
  fi
  pm_refresh
fi
has tar || pm_install tar
has gzip || pm_install gzip
has curl || has wget || pm_install curl

fetch() {
  if has curl; then curl -fsSL --retry 2 --connect-timeout 15 -m 600 "$1" -o "$2"
  else wget -q -T 60 -O "$2" "$1"
  fi
}

# ---------------------------------------------------------------------------
say "2/7 Node.js"
node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
NODE_BIN=""
RUNTIME="$APP_DIR/runtime"
if node_ok "$RUNTIME/bin/node"; then
  NODE_BIN="$RUNTIME/bin/node"
elif has node && node_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
else
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "[desk] 不支持的 CPU 架构：$(uname -m)" >&2; exit 1 ;;
  esac
  TMP_NODE="$(mktemp -d)"
  # Official build first, then a mirror that is fast from mainland China.
  for BASE in https://nodejs.org/dist/latest-v22.x https://npmmirror.com/mirrors/node/latest-v22.x; do
    fetch "$BASE/SHASUMS256.txt" "$TMP_NODE/sums" 2>/dev/null || continue
    FILE="$(grep -o "node-v22\.[0-9.]*-linux-${ARCH}\.tar\.gz" "$TMP_NODE/sums" | head -1 || true)"
    [ -n "$FILE" ] || continue
    say "下载 $FILE（$BASE）"
    fetch "$BASE/$FILE" "$TMP_NODE/$FILE" || continue
    (cd "$TMP_NODE" && grep " $FILE\$" sums | sha256sum -c - >/dev/null 2>&1) || { warn "$FILE 校验不通过，换源"; continue; }
    rm -rf "$RUNTIME" && mkdir -p "$RUNTIME"
    tar xzf "$TMP_NODE/$FILE" -C "$RUNTIME" --strip-components=1
    NODE_BIN="$RUNTIME/bin/node"
    break
  done
  rm -rf "$TMP_NODE"
fi
node_ok "${NODE_BIN:-/nonexistent}" || { echo "[desk] Node.js 安装失败（下载不到官方二进制）" >&2; exit 1; }
say "Node $("$NODE_BIN" -v)：$NODE_BIN"

# ---------------------------------------------------------------------------
say "3/7 每个 Bot 的桌面（Xvfb、x11vnc、websockify、noVNC、XFCE、Chromium）"
if [ "$PM" = apt ]; then
  pm_install xvfb x11vnc websockify novnc dbus-x11
  has chromium || has chromium-browser || pm_install chromium-browser
  has chromium || has chromium-browser || pm_install chromium
  if ! has xfce4-session; then
    say "安装 XFCE（约 1-2 分钟）"
    pm_install xfce4 xfce4-terminal
  fi
else
  pm_install xorg-x11-server-Xvfb x11vnc python3-websockify novnc dbus-x11 chromium
  if ! has xfce4-session; then
    say "安装 XFCE（约 2-4 分钟）"
    "$PM" -y -q groupinstall "Xfce" >/dev/null 2>&1 || pm_install xfce4-session xfwm4 xfdesktop xfce4-panel xfce4-terminal
  fi
fi
DESKTOP_OK=1
for bin in Xvfb x11vnc websockify; do
  has "$bin" || { warn "缺 $bin，Bot 桌面用不了；Hub 本身不受影响"; DESKTOP_OK=0; }
done
[ -d /usr/share/novnc ] || { warn "缺 noVNC 网页（/usr/share/novnc）"; DESKTOP_OK=0; }
# Bot desktops run XFCE: GNOME does not start inside a bare Xvfb, so a machine
# that already has GNOME still needs XFCE for its bots.
has xfce4-session || { warn "XFCE 没装成，Bot 桌面会是黑屏"; DESKTOP_OK=0; }

# One desktop session per bot display (GNOME when the host has the memory).
cat > /usr/local/bin/desk-bot-session <<'DESK_SESSION_EOF'
#!/bin/sh
DISP="$1"
[ -n "$DISP" ] || exit 1
export DISPLAY=":$DISP"
export XDG_SESSION_TYPE=x11
# Each bot session gets its own runtime dir and bus. Sharing /run/user/<uid>
# with a logged-in GNOME (Wayland) session made XFCE pick up that session's
# environment: xfwm4 and the panel tried DISPLAY=wayland-0 and exited.
export XDG_RUNTIME_DIR="/tmp/desk-runtime-$(id -u)-$DISP"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
unset WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS SESSION_MANAGER
export GDK_BACKEND=x11
export QT_QPA_PLATFORM=xcb
export LIBGL_ALWAYS_SOFTWARE=1
export NO_AT_BRIDGE=1
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "${DESK_BOT_GNOME:-0}" = 1 ] && command -v gnome-session >/dev/null 2>&1 && [ "$MEM_MB" -ge 6000 ]; then
  export XDG_CURRENT_DESKTOP=GNOME
  exec dbus-launch --exit-with-session gnome-session
fi
export XDG_CURRENT_DESKTOP=XFCE
# Skip the panel's first-run "default or empty config?" dialog on a new desktop.
export XFCE_PANEL_MIGRATE_DEFAULT=1
exec dbus-launch --exit-with-session xfce4-session
DESK_SESSION_EOF
chmod 755 /usr/local/bin/desk-bot-session

# Nothing may pop up over a bot's screen or lock it: no crash-report dialogs,
# no screen locker, no screensaver.
if [ -f /etc/default/apport ]; then
  sed -i 's/^enabled=1/enabled=0/' /etc/default/apport
  systemctl disable --now apport.service >/dev/null 2>&1 || true
  rm -f /var/crash/*.crash 2>/dev/null || true
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
mkdir -p "$RUN_HOME/.config/autostart"
for app in light-locker xfce4-screensaver xscreensaver update-notifier ubuntu-advantage-notification \
           ubuntu-report-on-upgrade gnome-initial-setup-first-login orca-autostart; do
  printf '[Desktop Entry]\nType=Application\nName=%s\nHidden=true\n' "$app" > "$RUN_HOME/.config/autostart/$app.desktop"
done
chown -R "$RUN_USER:$RUN_GROUP" "$RUN_HOME/.config"

# ---------------------------------------------------------------------------
say "4/7 程序 → $APP_DIR"
STAGE="$(mktemp -d)"
if [ -n "$PKG" ]; then
  [ -f "$PKG" ] || { echo "[desk] 程序包不存在: $PKG" >&2; exit 1; }
  tar xzf "$PKG" -C "$STAGE"
else
  SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  for item in src public config skills hub node_modules package.json; do
    [ -e "$SRC_DIR/$item" ] && cp -r "$SRC_DIR/$item" "$STAGE/"
  done
fi
[ -f "$STAGE/src/server.mjs" ] || { echo "[desk] 程序包内容不对，缺 src/server.mjs" >&2; exit 1; }
mkdir -p "$APP_DIR"
# Code is replaced wholesale ...
for item in src public hub node_modules; do
  rm -rf "${APP_DIR:?}/$item"
  [ -e "$STAGE/$item" ] && cp -r "$STAGE/$item" "$APP_DIR/"
done
cp -f "$STAGE/package.json" "$APP_DIR/"
# ... but config/ holds this machine's bots and model settings, and skills/
# what the bots learned: only fill in what is missing.
for item in config skills; do
  [ -d "$STAGE/$item" ] || continue
  mkdir -p "$APP_DIR/$item"
  cp -rn "$STAGE/$item/." "$APP_DIR/$item/" 2>/dev/null || true
done
rm -rf "$STAGE"
mkdir -p "$APP_DIR/data" "$APP_DIR/workspace"
printf '%s
' "$SETUP_VERSION" > "$APP_DIR/.setup-version"
chown -R "$RUN_USER:$RUN_GROUP" "$APP_DIR"
has restorecon && restorecon -R "$APP_DIR" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
say "5/7 运行账号与 ${SERVICE}.service"
# A remote machine is dedicated to the assistant: its bots install packages
# and change system settings without a human there to type a password.
if [ "$RUN_USER" != root ]; then
  SUDOERS_TMP="$(mktemp)"
  echo "$RUN_USER ALL=(ALL) NOPASSWD:ALL" > "$SUDOERS_TMP"
  if visudo -cf "$SUDOERS_TMP" >/dev/null 2>&1; then
    install -m 440 "$SUDOERS_TMP" /etc/sudoers.d/desk-hub
  else
    warn "sudoers 校验失败，没有开免密 sudo"
  fi
  rm -f "$SUDOERS_TMP"
fi

CHROME_BIN=""
for c in /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium /usr/bin/google-chrome; do
  [ -x "$c" ] && { CHROME_BIN="$c"; break; }
done
cat > "$UNIT" <<EOF
[Unit]
Description=Desk Hub (personal AI assistant)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=HOST=0.0.0.0
Environment=ASSIST_ALLOW_REMOTE=1
Environment=PORT=$PORT
Environment=DESK_MACHINE_MODE=remote
${CHROME_BIN:+Environment=CHROME_PATH=$CHROME_BIN}
ExecStart=$NODE_BIN src/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
say "6/7 启动并放行端口 $PORT"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
if has ufw && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || warn "ufw 放行 $PORT 失败"
fi
if has firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 \
    || warn "firewalld 放行 $PORT 失败"
fi

# ---------------------------------------------------------------------------
say "7/7 自检"
CODE=""
for _ in $(seq 1 30); do
  if [ -f "$APP_DIR/data/security.json" ]; then
    CODE="$(grep -o '"code"[^,}]*' "$APP_DIR/data/security.json" | head -1 | grep -o '[0-9]\{6,10\}' || true)"
    [ -n "$CODE" ] && break
  fi
  sleep 1
done

HUB_OK=0
for _ in $(seq 1 40); do
  if (has curl && curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1) \
     || (has wget && wget -q -T 2 -O /dev/null "http://127.0.0.1:${PORT}/api/health" 2>/dev/null); then
    HUB_OK=1
    break
  fi
  sleep 1
done
if [ "$HUB_OK" = 0 ]; then
  echo "[desk] Hub 没能在 ${PORT} 上应答，最近日志：" >&2
  journalctl -u "$SERVICE" -n 15 --no-pager >&2 2>/dev/null || true
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "$IP" ] || IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}' | head -1 || true)"
echo "DESK_OS=$OS_NAME"
echo "DESK_HUB_URL=http://${IP:-127.0.0.1}:${PORT}"
echo "DESK_PAIR_CODE=${CODE:-unknown}"
echo "DESK_APP_DIR=$APP_DIR"
echo "DESK_HUB_OK=${HUB_OK}"
echo "DESK_DESKTOP_OK=${DESKTOP_OK}"
