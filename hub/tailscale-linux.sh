#!/usr/bin/env bash
# =============================================================================
#  tailscale-linux.sh —— 装好 Tailscale，并用一次性的 Auth key 加入用户的网络
#
#      tailscale-linux.sh <密钥文件> [设备名]
#
#  以 root 在后台运行（添加机器时由 setup-linux.sh 调用，已有机器由 Hub 的
#  「装上 Tailscale」按钮调用）。密钥先挪进只有 root 能读的文件，Tailscale 从
#  那里读（不出现在命令行），用完就删。输出写进 /var/log/desk-tailscale.log。
# =============================================================================
KEY_SRC="$1"
NAME="$2"
KEY=/root/.desk-tailscale.key

( umask 077; head -c 400 "$KEY_SRC" | tr -d '\r\n ' > "$KEY" )
shred -u "$KEY_SRC" 2>/dev/null || rm -f "$KEY_SRC"
trap 'shred -u "$KEY" 2>/dev/null || rm -f "$KEY"' EXIT

if ! command -v tailscale >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1; then curl -fsSL https://tailscale.com/install.sh | sh
  else wget -qO- https://tailscale.com/install.sh | sh; fi
fi
command -v tailscale >/dev/null 2>&1 || { echo "DESK_TS=failed download"; exit 1; }
systemctl enable --now tailscaled >/dev/null 2>&1 || true

# The device name in the Tailscale admin console: the name given in Nightshift.
HOSTNAME_ARG=()
[ -n "$NAME" ] && HOSTNAME_ARG=(--hostname="$NAME")
if tailscale up --auth-key="file:$KEY" "${HOSTNAME_ARG[@]}"; then
  echo "DESK_TS=done $(tailscale ip -4 2>/dev/null | head -1)"
else
  echo "DESK_TS=failed key"
  exit 1
fi
