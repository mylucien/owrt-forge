#!/usr/bin/env bash
# 用途：在 openwrt 目录下的 .config 里启用 ccache，并确认它真的生效。
# 必须在 openwrt 目录内运行（编译步骤已经 cd 进去）。
#
# 为什么要同时打开 CONFIG_DEVEL：
#   config/Config-devel.in 里是 `bool "Use ccache" if DEVEL`，提示条件是 DEVEL。
#   只写 CONFIG_CCACHE=y 的话，make defconfig 会把它当成不可见选项丢掉（实测如此），
#   ccache 就根本没有启用。DEVEL 只是让高级选项可见，其余选项保持默认值。
set -uo pipefail
NOTES=/tmp/build-notes
note() { echo "$*" >> "$NOTES"; echo "$*"; }

[ -f .config ] || { note "ccache：没有找到 .config，未启用"; exit 0; }

# 先删掉可能已有的 DEVEL / CCACHE 行（包括 "# CONFIG_DEVEL is not set"），再追加，避免重复赋值
sed -i -e '/^CONFIG_DEVEL=/d' -e '/^# CONFIG_DEVEL is not set/d' \
       -e '/^CONFIG_CCACHE=/d' -e '/^# CONFIG_CCACHE is not set/d' .config
# 缓存目录固定用默认的 openwrt/.ccache（发布和恢复都按这个位置找）；用户自定义过就改回默认
if grep -q '^CONFIG_CCACHE_DIR="[^"]' .config; then
  sed -i '/^CONFIG_CCACHE_DIR=/d' .config
  note "ccache：把自定义的缓存目录改回默认的 openwrt/.ccache（缓存的发布和恢复按这个位置处理）"
fi
printf 'CONFIG_DEVEL=y\nCONFIG_CCACHE=y\n' >> .config
make defconfig > /tmp/enable-ccache.log 2>&1 || { note "ccache：make defconfig 失败，未启用（见日志）"; tail -n 5 /tmp/enable-ccache.log; exit 0; }

if grep -q '^CONFIG_CCACHE=y' .config; then
  note "ccache：已启用（同时打开了 CONFIG_DEVEL，仅用于让高级选项可见）"
else
  note "ccache：没有生效（CONFIG_CCACHE 被 defconfig 丢弃），本次编译不使用缓存，也无缓存可发布"
  echo "::warning title=ccache 没有生效::CONFIG_CCACHE 被 make defconfig 丢弃"
fi
exit 0
