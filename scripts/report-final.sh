#!/usr/bin/env bash
# 用途：无论成功失败都执行的最终上报（对应 workflow 里 if: always()）。
#
# 依赖环境变量：
#   WORKER_URL, REPORT_TOKEN, BUILD_ID
#   JOB_STATUS       - 传入 ${{ job.status }}
#   GITHUB_REPOSITORY
set -euo pipefail

: "${WORKER_URL:?WORKER_URL 未设置}"
: "${REPORT_TOKEN:?REPORT_TOKEN 未设置}"
: "${BUILD_ID:?BUILD_ID 未设置}"
: "${JOB_STATUS:?JOB_STATUS 未设置}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY 未设置}"

if [ "$JOB_STATUS" = "success" ]; then
  STATUS="success"
  DOWNLOAD_URL="https://github.com/${GITHUB_REPOSITORY}/releases/tag/build-${BUILD_ID}"
else
  STATUS="failed"
  DOWNLOAD_URL=""
fi

curl -sf -X POST "$WORKER_URL/api/report" \
  -H "X-Report-Token: $REPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"build_id\":\"${BUILD_ID}\",\"status\":\"${STATUS}\",\"download_url\":\"${DOWNLOAD_URL}\"}"
