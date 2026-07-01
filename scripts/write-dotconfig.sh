#!/usr/bin/env bash
# 用途：若 config.json 里携带 dotconfig_snapshot，写入 openwrt/.config 并 make defconfig 展开。
#
# 依赖环境变量：HAS_DOTCONFIG（"true"/"false"）
set -euo pipefail

: "${HAS_DOTCONFIG:?HAS_DOTCONFIG 未设置}"

if [ "$HAS_DOTCONFIG" = "true" ]; then
  jq -r .dotconfig_snapshot config.json > openwrt/.config
  cd openwrt && make defconfig
fi
