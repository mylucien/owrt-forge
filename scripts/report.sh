#!/usr/bin/env bash
# 用途：向 Worker 上报构建状态。
# 用法：report.sh <build_id> <status> [额外JSON字段]
#   额外JSON字段是不带花括号的 JSON 片段，例如：
#   report.sh "$BUILD_ID" running '"github_run_id":"12345"'
#
# 依赖环境变量：WORKER_URL, REPORT_TOKEN
set -euo pipefail

: "${WORKER_URL:?WORKER_URL 未设置}"
: "${REPORT_TOKEN:?REPORT_TOKEN 未设置}"

BUILD_ID="${1:?用法: report.sh <build_id> <status> [额外JSON字段]}"
STATUS="${2:?用法: report.sh <build_id> <status> [额外JSON字段]}"
EXTRA_FIELDS="${3:-}"

if [ -n "$EXTRA_FIELDS" ]; then
  PAYLOAD="{\"build_id\":\"$BUILD_ID\",\"status\":\"$STATUS\",$EXTRA_FIELDS}"
else
  PAYLOAD="{\"build_id\":\"$BUILD_ID\",\"status\":\"$STATUS\"}"
fi

curl -sf -X POST "$WORKER_URL/api/report" \
  -H "X-Report-Token: $REPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
