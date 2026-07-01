#!/usr/bin/env bash
# 用途：从 Worker 拉取本次构建的完整配置(config.json)，解析出后续步骤需要的字段。
#
# 依赖环境变量：WORKER_URL, REPORT_TOKEN, BUILD_ID, GITHUB_OUTPUT, GITHUB_ENV
set -euo pipefail

: "${WORKER_URL:?WORKER_URL 未设置}"
: "${REPORT_TOKEN:?REPORT_TOKEN 未设置}"
: "${BUILD_ID:?BUILD_ID 未设置}"

curl -sf -H "X-Report-Token: $REPORT_TOKEN" \
  "$WORKER_URL/api/builds/$BUILD_ID/config" -o config.json

echo "build_id=$BUILD_ID" >> "$GITHUB_OUTPUT"
echo "template_id=$(jq -r '.template_id // ""' config.json)" >> "$GITHUB_OUTPUT"
echo "trigger_type=$(jq -r '.trigger_type // "manual"' config.json)" >> "$GITHUB_OUTPUT"

HAS=$(jq -r 'if .dotconfig_snapshot and .dotconfig_snapshot != "" then "true" else "false" end' config.json)
echo "has_dotconfig=$HAS" >> "$GITHUB_OUTPUT"

# config.json 里的 worker_url 是部署向导里填写的"权威"地址，
# 用它覆盖触发时刻传入的 WORKER_URL（两者通常一致，这里以 D1 配置为准，
# 避免触发时刻与上报时刻地址不一致）。
CFG_WORKER_URL=$(jq -r '.worker_url // ""' config.json)
if [ -n "$CFG_WORKER_URL" ]; then
  echo "WORKER_URL=$CFG_WORKER_URL" >> "$GITHUB_ENV"
fi
