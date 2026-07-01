#!/usr/bin/env bash
# 用途：将当前 .config 推送到 Worker，供 menuconfig 会话确认保存/使用当前配置时调用。
# 由 menuconfig-session.sh 通过 `push-config` 命令调用（部署时会被安装到 /usr/local/bin）。
#
# 依赖环境变量：WORKER_URL, REPORT_TOKEN, BUILD_ID, OPENWRT_DIR
set -euo pipefail

: "${WORKER_URL:?WORKER_URL 未设置}"
: "${REPORT_TOKEN:?REPORT_TOKEN 未设置}"
: "${BUILD_ID:?BUILD_ID 未设置}"
: "${OPENWRT_DIR:?OPENWRT_DIR 未设置}"

CONFIG_TO_PUSH="$OPENWRT_DIR/.config"
PUSHED_KIND="完整版"

# 优先推送精简版：OpenWrt 官方 scripts/diffconfig.sh 只保留偏离默认值的选项，
# 体积通常只有完整 .config 的几十分之一，生成失败（极少数源码版本可能不兼容）
# 则自动回退推送完整 .config，不阻塞主流程。还原时 make defconfig 对两种格式
# 都能正确展开成完整配置（见 write-dotconfig.sh），不需要额外改动。
if [ -x "$OPENWRT_DIR/scripts/diffconfig.sh" ]; then
  if (cd "$OPENWRT_DIR" && ./scripts/diffconfig.sh > /tmp/diffconfig.min 2>/tmp/diffconfig.err) \
     && [ -s /tmp/diffconfig.min ]; then
    CONFIG_TO_PUSH=/tmp/diffconfig.min
    PUSHED_KIND="精简版"
  else
    echo "⚠️ diffconfig.sh 精简失败，回退推送完整 .config（不影响编译）" >&2
    cat /tmp/diffconfig.err >&2 2>/dev/null || true
  fi
fi

# 关键修复：不再把整份配置内容当作单个命令行参数传给 jq / curl。
# Linux 单个命令行参数长度上限约 128KB（MAX_ARG_STRLEN），完整 .config
# 经常轻松超过这个数字，之前用 --arg/-d 直接传值会触发系统级的
# "Argument list too long"，请求根本发不出去，跟 Worker 那边 2MB 的
# JSON 体积上限完全是两回事。改用 --rawfile 让 jq 直接读文件、
# curl --data-binary @file 直接读文件，全程不经过命令行参数。
jq -n \
  --arg build_id "$BUILD_ID" \
  --rawfile content "$CONFIG_TO_PUSH" \
  '{build_id: $build_id, content: $content}' > /tmp/dotconfig_payload.json

curl -sf -X POST "$WORKER_URL/api/report/dotconfig" \
  -H "X-Report-Token: $REPORT_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/dotconfig_payload.json

echo "✅ .config 已推送（$PUSHED_KIND）"
