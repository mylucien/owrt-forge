#!/usr/bin/env bash
# ccache 缓存：restore（编译前恢复）/ stats（编译后统计）/ publish（编译后打包发布）
# 用法：cache.sh restore|stats|publish
#
# 说明
# - 开启 CONFIG_CCACHE=y 后 OpenWrt 把缓存固定放在 openwrt/.ccache，并且是「未压缩」存放，
#   所以发布时用 zstd 压缩，再按 1900MiB 切成分卷（Release 单个文件上限 2GiB）。
# - 任何一步失败都只是「没有缓存可用 / 没有发布成功」，绝不让编译任务失败（脚本总是 exit 0）。
# - 只保留最新 KEEP 份缓存 Release；Worker 里的 CACHE_KEEP 要和这里一致。
set -uo pipefail

KEEP=2
CDIR=openwrt/.ccache
NOTES=/tmp/build-notes
note() { echo "$*" >> "$NOTES"; echo "$*"; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 字节"; }

restore() {
  : "${CACHE_TAG:?}"; : "${GITHUB_REPOSITORY:?}"
  if ! [[ "$CACHE_TAG" =~ ^cache-[A-Za-z0-9_-]{8,64}$ ]]; then note "缓存：标识不合法，未使用缓存"; return 0; fi
  local D=/tmp/cache-dl X=/tmp/cache-x
  rm -rf "$D" "$X"; mkdir -p "$D" "$X"
  if ! gh release download "$CACHE_TAG" --repo "$GITHUB_REPOSITORY" --dir "$D" --pattern 'ccache.tar.zst.part*'; then
    note "缓存：$CACHE_TAG 下载失败（可能已被清理），本次不使用缓存"; rm -rf "$D" "$X"; return 0
  fi
  if cat "$D"/ccache.tar.zst.part* | zstd -d -c | tar -x -C "$X" --no-same-owner; then
    # 只接受顶层恰好是 .ccache 的包，避免把别的东西解压进源码目录
    if [ "$(ls -A "$X")" = ".ccache" ]; then
      rm -rf "$CDIR"; mv "$X/.ccache" "$CDIR"
      note "缓存：已恢复 $CACHE_TAG（解压后 $(du -sh "$CDIR" | cut -f1)）"
    else
      note "缓存：$CACHE_TAG 的内容不符合预期，未使用缓存"
    fi
  else
    note "缓存：$CACHE_TAG 解压失败，未使用缓存"
  fi
  rm -rf "$D" "$X"
}

ccache_bin() { [ -x openwrt/staging_dir/host/bin/ccache ] && echo "$PWD/openwrt/staging_dir/host/bin/ccache"; }

stats() {
  local cc; cc=$(ccache_bin) || { echo "没有找到 ccache（可能编译还没走到那一步）"; return 0; }
  local out; out=$(CCACHE_DIR="$PWD/$CDIR" "$cc" -s 2>&1 | grep -iE 'hit|miss|cache size|cacheable' | head -n 8 | sed 's/^[[:space:]]*//')
  [ -n "$out" ] && note "ccache 统计：$(echo "$out" | paste -sd'；' -)"
  return 0
}

publish() {
  : "${GITHUB_REPOSITORY:?}"; : "${BUILD_ID:?}"; : "${WORKER_URL:?}"; : "${REPORT_TOKEN:?}"
  # 是否发布以「编译结束时」Worker 里的设置为准（编译途中可以在构建记录上切换）
  local pub
  pub=$(curl -sf -H "X-Report-Token: $REPORT_TOKEN" "$WORKER_URL/api/builds/$BUILD_ID/config" | jq -r '.cache_publish // false') || pub=false
  [ "$pub" = "true" ] || { echo "没有勾选发布缓存，跳过"; return 0; }
  [ -d "$CDIR" ] || { note "缓存：没有找到 ccache 目录，无缓存可发布"; return 0; }
  local cc; cc=$(ccache_bin) && CCACHE_DIR="$PWD/$CDIR" "$cc" --cleanup >/dev/null 2>&1 || true

  local OUT=/tmp/cache-out TAG="cache-$BUILD_ID"
  rm -rf "$OUT"; mkdir -p "$OUT"
  tar -C openwrt -cf - .ccache | zstd -T0 -3 -q | split -b 1900M -d - "$OUT/ccache.tar.zst.part"
  local N TOTAL
  N=$(find "$OUT" -type f | wc -l)
  TOTAL=$(find "$OUT" -type f -printf '%s\n' | awk '{s+=$1} END{print s+0}')
  if [ "$N" -lt 1 ] || [ "$TOTAL" -lt 1048576 ]; then note "缓存：打包后几乎是空的，不发布"; rm -rf "$OUT"; return 0; fi
  if [ "$N" -gt 2 ]; then note "缓存：打包后 $(human "$TOTAL")（$N 个分卷）超过上限（2 个分卷），不发布，避免占用过多空间"; rm -rf "$OUT"; return 0; fi

  local TARGET; TARGET=$(jq -r '(.target // "") + " " + (.profile // "")' config.json 2>/dev/null)
  if ! gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --prerelease \
        --title "ccache 缓存 $TAG" --notes "编译 $BUILD_ID 的 ccache 缓存（$TARGET）。由编译页面发布，下次编译可选择使用。" "$OUT"/*; then
    note "缓存：发布 Release 失败（缓存没有保存）"; rm -rf "$OUT"; return 0
  fi
  # 只保留最新 KEEP 份缓存 Release
  gh release list --repo "$GITHUB_REPOSITORY" --limit 100 --json tagName,createdAt \
    --jq "[.[]|select(.tagName|startswith(\"cache-\"))]|sort_by(.createdAt)|reverse|.[$KEEP:][].tagName" \
    | xargs -r -I{} gh release delete {} --repo "$GITHUB_REPOSITORY" --cleanup-tag --yes || true

  jq -n --arg b "$BUILD_ID" --arg t "$TAG" --argjson s "$TOTAL" '{build_id:$b,tag:$t,size:$s}' \
    | curl -sf -X POST "$WORKER_URL/api/report/cache" -H "X-Report-Token: $REPORT_TOKEN" -H "Content-Type: application/json" --data-binary @- >/dev/null \
    || note "缓存：已发布到 Release，但上报页面失败，页面上可能看不到这份缓存"
  note "缓存：已发布 $TAG，压缩后 $(human "$TOTAL")（$N 个分卷）"
  rm -rf "$OUT"
}

case "${1:-}" in
  restore) restore ;;
  stats)   stats ;;
  publish) publish ;;
  *) echo "用法: cache.sh restore|stats|publish" ;;
esac
exit 0
