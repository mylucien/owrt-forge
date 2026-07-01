#!/usr/bin/env bash
# 用途：轮询等待 /tmp/menuconfig-done 标记文件出现，超时（默认30分钟）则上报失败并退出非0。
#
# 依赖环境变量：WORKER_URL, REPORT_TOKEN, BUILD_ID, SCRIPTS_DIR
# 可选环境变量：TIMEOUT_SECONDS（默认 1800）
set -euo pipefail

: "${WORKER_URL:?WORKER_URL 未设置}"
: "${REPORT_TOKEN:?REPORT_TOKEN 未设置}"
: "${BUILD_ID:?BUILD_ID 未设置}"
: "${SCRIPTS_DIR:?SCRIPTS_DIR 未设置}"

TIMEOUT="${TIMEOUT_SECONDS:-1800}"
ELAPSED=0

while [ ! -f /tmp/menuconfig-done ]; do
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    bash "$SCRIPTS_DIR/report.sh" "$BUILD_ID" failed '"reason":"menuconfig_timeout"'
    exit 1
  fi
done
