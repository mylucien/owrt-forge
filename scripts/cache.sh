#!/usr/bin/env bash
# ccache 缓存：restore（编译前恢复）/ stats（编译后统计）/ publish（编译后打包发布）
# 用法：cache.sh restore|stats|publish
#
# 说明
# - 启用 ccache 后 OpenWrt 把缓存固定放在 openwrt/.ccache，并且是「未压缩」存放，
#   所以发布时用 zstd 压缩，再按 PART_SIZE 切成分卷（Release 单个文件上限 2GiB）。
# - 任何一步失败都只是「没有缓存可用 / 没有发布成功」，绝不让编译任务失败（脚本总是 exit 0）。
#   失败原因会写进构建说明和 Actions 日志（::warning::），带上 gh / zstd / tar 的真实报错。
# - 每个分卷有 sha256 校验清单（ccache.sha256）；发布后会核对 Release 上的文件数和大小，
#   不完整就删掉，避免留下坏缓存。
# - 页面上的缓存标识可能指向已被清理的老缓存：restore 先确认 Release 还在，不在就退到最新一份，
#   否则整轮编译会静默地不用缓存（run #91 就是这样，跑完才发现命中率 11%）。
# - 发布时额外写一份 ccache.meta.json（目标 / 机型 / 源码 commit / .config 摘要 / ccache 版本）；
#   恢复时先拉它比对，机型不同就不下分卷（缓存只对同一目标 + 机型有意义）。
# - 只保留最新 KEEP 份缓存 Release；Worker 里的 CACHE_KEEP 要和这里一致。
set -uo pipefail

KEEP=2
PART_SIZE="${CACHE_PART_SIZE:-1900M}"   # 1900MiB < 2GiB 的单文件上限；CACHE_PART_SIZE 仅供测试
MAX_PARTS=8
CDIR=openwrt/.ccache
NOTES=/tmp/build-notes
note() { echo "$*" >> "$NOTES"; echo "$*"; }
warn() { note "$*"; echo "::warning title=ccache 缓存::$*"; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 字节"; }
# 取错误文件里最后几行有内容的，压成一行（最多 300 字符）
# 按「字符」截断（cut -c 是按字节的，会把汉字切成半个而变成乱码）；输入里的非法字节会被替换成 �
trunc() { jq -Rrs --argjson n "$1" 'rtrimstr("\n") | .[0:$n]'; }
lasterr() { grep -v '^[[:space:]]*$' "$1" 2>/dev/null | tail -n 3 | paste -sd'|' - | trunc 300; }

# 缓存 Release 还在不在。页面/数据库里的标识可能是被清理掉的老缓存，
# 直接下载会报 release not found，整轮编译就白跑（#91 就是这样，跑完才发现命中率 11%）。
tag_exists() { gh release view "$1" --repo "$GITHUB_REPOSITORY" --json tagName >/dev/null 2>&1; }

# 按创建时间取最新的一份缓存；没有缓存返回空
newest_tag() {
  gh release list --repo "$GITHUB_REPOSITORY" --limit 100 --json tagName,createdAt \
    --jq '[.[]|select(.tagName|startswith("cache-"))]|sort_by(.createdAt)|last|.tagName // ""' 2>/dev/null
}

# 从 ccache.meta.json 读一个字段（没有 meta 输出空）
meta() { jq -r --arg k "$1" '.[$k] // ""' "$2" 2>/dev/null; }

restore() {
  : "${CACHE_TAG:?}"; : "${GITHUB_REPOSITORY:?}"
  command -v gh >/dev/null || { warn "缓存：编译机上没有 gh 命令，未使用缓存"; return 0; }
  command -v zstd >/dev/null || { warn "缓存：编译机上没有 zstd 命令，未使用缓存"; return 0; }

  local TAG="$CACHE_TAG"
  if [ "$TAG" != "latest" ] && ! [[ "$TAG" =~ ^cache-[A-Za-z0-9_-]{8,64}$ ]]; then
    warn "缓存：标识不合法，未使用缓存"; return 0
  fi
  # 指定的那份被清理掉了（KEEP 只留最新几份，页面上的旧标识会失效）就换最新的一份：
  # 缓存是拿来省时间的，宁可换一份，也不能因为标识过期就整轮不用缓存。
  if [ "$TAG" = "latest" ] || ! tag_exists "$TAG"; then
    local NEW; NEW=$(newest_tag)
    if [ -z "$NEW" ]; then warn "缓存：$TAG 不可用，仓库里也没有其它缓存，本次不用缓存"; return 0; fi
    note "缓存：$TAG 不可用（可能已被清理），改用最新的一份 $NEW"
    TAG="$NEW"
  fi

  local D=/tmp/cache-dl X=/tmp/cache-x E=/tmp/cache-restore.err
  rm -rf "$D" "$X"; mkdir -p "$D" "$X"; : > "$E"

  # 先拉 meta（几十字节）核对目标/机型：对不上说明这份缓存编的是别的设备，下载分卷纯属浪费
  gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --dir "$D" --pattern 'ccache.meta.json' >/dev/null 2>&1 || true
  if [ -f "$D/ccache.meta.json" ]; then
    local mt mp mc ct cp cur
    mt=$(meta target "$D/ccache.meta.json"); mp=$(meta profile "$D/ccache.meta.json"); mc=$(meta commit "$D/ccache.meta.json")
    ct=$(jq -r '.target // ""' config.json 2>/dev/null); cp=$(jq -r '.profile // ""' config.json 2>/dev/null)
    if [ -n "$mt" ] && { [ "$mt" != "$ct" ] || { [ -n "$mp" ] && [ "$mp" != "$cp" ]; }; }; then
      warn "缓存：$TAG 是为 $mt / $mp 编的，和本次 $ct / $cp 不同，跳过（缓存只对同一目标 + 机型有用）"
      rm -rf "$D" "$X"; return 0
    fi
    cur=$(git -C openwrt rev-parse --short=8 HEAD 2>/dev/null || echo '')
    if [ -n "$mc" ] && [ -n "$cur" ] && [ "$mc" != "$cur" ]; then
      note "缓存：$TAG 是源码 $mc 编的，本次是 $cur（源码变了，只有没改到的部分能命中）"
    fi
  fi

  if ! gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --dir "$D" \
        --pattern 'ccache.tar.zst.part*' --pattern 'ccache.sha256' 2> "$E"; then
    warn "缓存：下载 $TAG 失败：$(lasterr "$E")"; rm -rf "$D" "$X"; return 0
  fi
  local N; N=$(find "$D" -name 'ccache.tar.zst.part*' -type f | wc -l)
  if [ "$N" -lt 1 ]; then warn "缓存：$TAG 里没有缓存文件，未使用缓存"; rm -rf "$D" "$X"; return 0; fi

  # 校验：分卷缺失、被截断、损坏都能在这里发现；老版本发布的缓存没有清单，就跳过校验
  if [ -f "$D/ccache.sha256" ]; then
    if ! (cd "$D" && sha256sum -c ccache.sha256 > "$E" 2>&1); then
      warn "缓存：$TAG 校验失败（分卷缺失或损坏），未使用缓存：$(grep -v ': OK$' "$E" | head -n 3 | paste -sd'|' - | trunc 300)"
      rm -rf "$D" "$X"; return 0
    fi
  fi

  # 解压：分别记录 zstd 和 tar 的报错，失败时能看出是哪一段出的问题
  local ZE=/tmp/cache-zstd.err TE=/tmp/cache-tar.err
  if cat "$D"/ccache.tar.zst.part* | zstd -d -c 2> "$ZE" | tar -x -C "$X" --no-same-owner 2> "$TE"; then
    :
  else
    warn "缓存：$TAG 解压失败，未使用缓存。zstd: $(lasterr "$ZE") ; tar: $(lasterr "$TE")"
    rm -rf "$D" "$X"; return 0
  fi
  # 只接受顶层恰好是 .ccache 的包，避免把别的东西解压进源码目录
  if [ "$(ls -A "$X")" != ".ccache" ]; then
    warn "缓存：$TAG 的内容不符合预期（顶层不是 .ccache），未使用缓存"; rm -rf "$D" "$X"; return 0
  fi
  rm -rf "$CDIR"; mv "$X/.ccache" "$CDIR"
  note "缓存：已恢复 $TAG（$N 个分卷，解压后 $(du -sh "$CDIR" | cut -f1)）"
  rm -rf "$D" "$X"
}

ccache_bin() { [ -x openwrt/staging_dir/host/bin/ccache ] && echo "$PWD/openwrt/staging_dir/host/bin/ccache"; }

stats() {
  local cc; cc=$(ccache_bin) || { echo "没有找到 ccache（可能 ccache 没有生效，或编译还没走到那一步）"; return 0; }
  # 统计是单独的 step，编译步骤的 env 不会继承过来；不补 CCACHE_MAXSIZE 的话，
  # -s 里的上限会显示成 ccache 自己的默认值（5G），看上去像「8G 没生效」，其实只是这里没带环境变量
  local out; out=$(CCACHE_DIR="$PWD/$CDIR" CCACHE_MAXSIZE="${CCACHE_MAXSIZE:-8G}" "$cc" -s 2>&1 | grep -iE 'hit|miss|cache size|cacheable' | head -n 8 | sed 's/^[[:space:]]*//')
  [ -n "$out" ] && note "ccache 统计：$(echo "$out" | paste -sd';' -)"
  return 0
}

publish() {
  : "${GITHUB_REPOSITORY:?}"; : "${BUILD_ID:?}"; : "${WORKER_URL:?}"; : "${REPORT_TOKEN:?}"
  # 是否发布以「编译结束时」Worker 里的设置为准（编译途中可以在构建记录上切换）
  local pub
  pub=$(curl -sf -H "X-Report-Token: $REPORT_TOKEN" "$WORKER_URL/api/builds/$BUILD_ID/config" | jq -r '.cache_publish // false') || pub=false
  [ "$pub" = "true" ] || { echo "没有勾选发布缓存，跳过"; return 0; }
  [ -d "$CDIR" ] || { warn "缓存：没有找到 ccache 目录（ccache 可能没有生效），无缓存可发布"; return 0; }
  local cc; if cc=$(ccache_bin); then CCACHE_DIR="$PWD/$CDIR" "$cc" --cleanup >/dev/null 2>&1 || true; fi

  local OUT=/tmp/cache-out TAG="cache-$BUILD_ID" E=/tmp/cache-publish.err
  rm -rf "$OUT"; mkdir -p "$OUT"; : > "$E"
  if ! tar -C openwrt -cf - .ccache 2> "$E" | zstd -T0 -3 -q 2>> "$E" | split -b "$PART_SIZE" -d - "$OUT/ccache.tar.zst.part"; then
    warn "缓存：打包失败：$(lasterr "$E")"; rm -rf "$OUT"; return 0
  fi
  local N TOTAL
  N=$(find "$OUT" -name 'ccache.tar.zst.part*' -type f | wc -l)
  TOTAL=$(find "$OUT" -type f -printf '%s\n' | awk '{s+=$1} END{print s+0}')
  if [ "$N" -lt 1 ] || [ "$TOTAL" -lt 1048576 ]; then warn "缓存：打包后几乎是空的（$TOTAL 字节），不发布"; rm -rf "$OUT"; return 0; fi
  if [ "$N" -gt "$MAX_PARTS" ]; then warn "缓存：打包后 $(human "$TOTAL")（$N 个分卷）超过上限（$MAX_PARTS 个分卷），不发布，避免占用过多空间"; rm -rf "$OUT"; return 0; fi
  (cd "$OUT" && sha256sum ccache.tar.zst.part* > ccache.sha256)

  # 记下这份缓存是为哪个源码/配置编的，恢复时据此判断「值不值得下」以及「能命中多少」
  local SRC TGT PROF CSHA CCV NOW
  SRC=$(git -C openwrt rev-parse --short=8 HEAD 2>/dev/null || echo '')
  TGT=$(jq -r '.target // ""' config.json 2>/dev/null)
  PROF=$(jq -r '.profile // ""' config.json 2>/dev/null)
  CSHA=$(sha256sum openwrt/.config 2>/dev/null | cut -d' ' -f1)
  CCV=$(if cc=$(ccache_bin); then "$cc" --version 2>/dev/null | head -n 1; fi)
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg b "$BUILD_ID" --arg t "$TGT" --arg p "$PROF" --arg c "$SRC" \
        --arg s "$CSHA" --arg v "$CCV" --arg d "$NOW" \
    '{build_id:$b, target:$t, profile:$p, commit:$c, config_sha256:$s, ccache_version:$v, created_at:$d}' \
    > "$OUT/ccache.meta.json"

  local TARGET; TARGET=$(jq -r '(.target // "") + " " + (.profile // "")' config.json 2>/dev/null)
  if ! gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --prerelease \
        --title "ccache 缓存 $TAG" --notes "编译 $BUILD_ID 的 ccache 缓存（$TARGET）。由编译页面发布，下次编译可选择使用。" "$OUT"/* 2> "$E"; then
    warn "缓存：发布 Release 失败，缓存没有保存：$(lasterr "$E")"
    gh release delete "$TAG" --repo "$GITHUB_REPOSITORY" --cleanup-tag --yes >/dev/null 2>&1 || true
    rm -rf "$OUT"; return 0
  fi
  # 核对 Release 上的文件数和总大小，不完整就删掉（否则下次恢复时会遇到半截的缓存）
  local WANT_N WANT_SIZE GOT_N GOT_SIZE
  WANT_N=$(find "$OUT" -type f | wc -l); WANT_SIZE=$(find "$OUT" -type f -printf '%s\n' | awk '{s+=$1} END{print s+0}')
  GOT_N=$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets --jq '.assets|length' 2>/dev/null || echo 0)
  GOT_SIZE=$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets --jq '[.assets[].size]|add // 0' 2>/dev/null || echo 0)
  if [ "$GOT_N" != "$WANT_N" ] || [ "$GOT_SIZE" != "$WANT_SIZE" ]; then
    warn "缓存：Release 上的文件不完整（应有 $WANT_N 个共 $WANT_SIZE 字节，实际 $GOT_N 个共 $GOT_SIZE 字节），已删除这份缓存"
    gh release delete "$TAG" --repo "$GITHUB_REPOSITORY" --cleanup-tag --yes >/dev/null 2>&1 || true
    rm -rf "$OUT"; return 0
  fi
  # 只保留最新 KEEP 份缓存 Release
  gh release list --repo "$GITHUB_REPOSITORY" --limit 100 --json tagName,createdAt \
    --jq "[.[]|select(.tagName|startswith(\"cache-\"))]|sort_by(.createdAt)|reverse|.[$KEEP:][].tagName" \
    | xargs -r -I{} gh release delete {} --repo "$GITHUB_REPOSITORY" --cleanup-tag --yes || true

  jq -n --arg b "$BUILD_ID" --arg t "$TAG" --argjson s "$TOTAL" '{build_id:$b,tag:$t,size:$s}' \
    | curl -sf -X POST "$WORKER_URL/api/report/cache" -H "X-Report-Token: $REPORT_TOKEN" -H "Content-Type: application/json" --data-binary @- >/dev/null \
    || warn "缓存：已发布到 Release，但上报页面失败，页面上可能看不到这份缓存"
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
