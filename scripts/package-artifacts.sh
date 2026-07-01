#!/usr/bin/env bash
# 用途：把编译产物打包，只保留 rootfs/sysupgrade/factory 镜像 + 各 target 的完整 packages 包。
#
# 依赖环境变量：GITHUB_WORKSPACE
set -euo pipefail

: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE 未设置}"

mkdir -p /tmp/release_files

cd openwrt/bin/targets
find . -type d -mindepth 2 -maxdepth 2 | while read -r dir; do
  name=$(echo "$dir" | tr '/' '-' | sed 's/^-//')
  tar czf "../../../${name}-packages.tar.gz" -C "$dir" .
done

cd "$GITHUB_WORKSPACE"
find openwrt/bin/targets -name "*.img.gz" -o -name "*sysupgrade*" -o -name "*factory*" | \
  xargs -I{} cp {} /tmp/release_files/ 2>/dev/null || true
cp ./*-packages.tar.gz /tmp/release_files/ 2>/dev/null || true
