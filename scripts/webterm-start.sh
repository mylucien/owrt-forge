#!/usr/bin/env bash
# 用途：把 push-config.sh / menuconfig-session.sh 安装到位，拉起 ttyd + cloudflared，
# 等待隧道地址就绪后写入 GITHUB_OUTPUT 的 web_url。
#
# 依赖环境变量：
#   TTYD_USER, TTYD_PASS  - ttyd 登录凭据
#   OPENWRT_DIR           - openwrt 源码目录（供 menuconfig-session.sh 使用）
#   GITHUB_OUTPUT         - GitHub Actions 输出文件
#   SCRIPTS_DIR           - 本仓库 .github/scripts 所在路径（供拷贝脚本用）
set -eo pipefail

: "${TTYD_USER:?TTYD_USER 未设置}"
: "${TTYD_PASS:?TTYD_PASS 未设置}"
: "${OPENWRT_DIR:?OPENWRT_DIR 未设置}"
: "${SCRIPTS_DIR:?SCRIPTS_DIR 未设置}"

# 安装 push-config 到 PATH，menuconfig-session.sh 里直接调用 `push-config` 即可
sudo install -m 0755 "$SCRIPTS_DIR/push-config.sh" /usr/local/bin/push-config

# menuconfig-session.sh 放到 /tmp 并赋予可执行权限
cp "$SCRIPTS_DIR/menuconfig-session.sh" /tmp/menuconfig-session.sh
chmod +x /tmp/menuconfig-session.sh

# 锁定 ttyd 版本号，避免 latest 重定向偶发失败
TTYD_VER="1.7.7"
curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VER}/ttyd.x86_64" \
  -o /tmp/ttyd_bin
sudo install -m 0755 /tmp/ttyd_bin /usr/local/bin/ttyd

ttyd --port 7681 \
     --credential "${TTYD_USER}:${TTYD_PASS}" \
     --max-clients 1 \
     --writable \
     /tmp/menuconfig-session.sh &

# 锁定 cloudflared 版本
CF_VER="2024.12.2"
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CF_VER}/cloudflared-linux-amd64" \
  -o /tmp/cloudflared_bin
sudo install -m 0755 /tmp/cloudflared_bin /usr/local/bin/cloudflared

cloudflared tunnel --url http://localhost:7681 \
  --no-autoupdate > /tmp/cf.log 2>&1 &

URL=""
for i in $(seq 1 30); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cf.log | head -1 || true)
  [ -n "$URL" ] && break
  sleep 2
done

if [ -z "$URL" ]; then
  echo "未能在 60 秒内获取 cloudflared 隧道地址" >&2
  cat /tmp/cf.log >&2
  exit 1
fi

AUTH_URL="https://${TTYD_USER}:${TTYD_PASS}@${URL#https://}"
echo "web_url=${AUTH_URL}" >> "$GITHUB_OUTPUT"
