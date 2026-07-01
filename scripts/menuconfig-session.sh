#!/usr/bin/env bash
# 用途：ttyd 连接后运行的会话入口。
# 用户在 menuconfig 里退出后，主动询问是否使用当前配置继续，
# 不再依赖 .config 文件的 mtime 变化来判断"是否保存"——
# 因为用户如果完全不修改任何选项直接退出，mconf 根本不会重写 .config，
# 靠时间戳判断会导致这种情况永远卡死、直到 30 分钟超时失败。
#
# 依赖环境变量：OPENWRT_DIR
set -euo pipefail

: "${OPENWRT_DIR:?OPENWRT_DIR 未设置}"

cd "$OPENWRT_DIR"

while true; do
  make menuconfig || true
  echo ""
  read -r -p "已退出 menuconfig。使用当前配置开始编译？输入 y 确认，输入其它任意键将重新进入 menuconfig: " ans
  case "$ans" in
    y|Y)
      echo "✅ 正在推送配置..."
      push-config
      touch /tmp/menuconfig-done
      pkill -f "ttyd --port 7681" || true
      echo "🚀 配置已推送，即将开始编译，可以关闭此窗口"
      break
      ;;
    *)
      echo "↩️ 重新进入 menuconfig..."
      ;;
  esac
done
