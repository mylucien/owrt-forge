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
# - 页面上的缓存标识可能指向已被清理的老缓存，也可能属于别的机型：restore 先确认 Release 还在、
#   再读 meta 看 target/profile，对不上就在最近的几份里找「同机型最新的一份」，
#   一份同机型的都没有才退到最新一份。以前直接退到「全仓库最新一份」，多机型时会拿错（run #91 就是这样）。
# - 发布时额外写一份 ccache.meta.json（目标 / 机型 / 源码 commit / .config 摘要 / ccache 版本 /
#   截至本轮结束的累计命中）；恢复时先拉它比对，机型不同就不下分卷，并把累计命中记下来供 stats 算本轮。
# - 清理按机型分组：每个 target+profile 只留最新 KEEP 份，不同机型互不挤占。
set -uo pipefail

KEEP=2                                   # 每个机型（target+profile）保留几份；不是全仓库合计
CANDS="${CACHE_CANDS:-6}"                # 兜底挑选时最多探测几份缓存（每份只下几十字节的 meta）
PART_SIZE="${CACHE_PART_SIZE:-1900M}"   # 1900MiB < 2GiB 的单文件上限；CACHE_PART_SIZE 仅供测试
MAX_PARTS=8
CDIR=openwrt/.ccache
NOTES=/tmp/build-notes
BASELINE=/tmp/ccache-baseline           # 恢复时记下这份缓存自带的累计统计，stats 据此算「本轮」
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

# 从 ccache.meta.json 读一个字段（没有 meta 输出空）
meta() { jq -r --arg k "$1" '.[$k] // ""' "$2" 2>/dev/null; }

# 仓库里所有缓存 Release，按创建时间新→旧
list_cache_tags() {
  gh release list --repo "$GITHUB_REPOSITORY" --limit 100 --json tagName,createdAt \
    --jq '[.[]|select(.tagName|startswith("cache-"))]|sort_by(.createdAt)|reverse|.[].tagName' 2>/dev/null
}

# 读某份缓存的 meta，输出「target \t profile \t commit \t hits \t total」；没有 meta 则无输出。
# 只下几十字节，用它判断「这份缓存是不是给这台机器编的」。
META_ROW=""
meta_row() {
  local tag="$1" d
  d=$(mktemp -d) || return 0
  if gh release download "$tag" --repo "$GITHUB_REPOSITORY" --dir "$d" --pattern 'ccache.meta.json' >/dev/null 2>&1 \
     && [ -s "$d/ccache.meta.json" ]; then
    jq -r '[.target // "", .profile // "", .commit // "",
            (.ccache_hits // "" | tostring), (.ccache_total // "" | tostring)] | @tsv' "$d/ccache.meta.json" 2>/dev/null
  fi
  rm -rf "$d"
}

# 这份 meta 是否和本次编译对得上（target 相同；profile 任一侧为空时只看 target）
row_match() {
  local row="$1" ct="$2" cp="$3" mt mp
  [ -n "$row" ] || return 1
  mt=$(printf '%s' "$row" | cut -f1); mp=$(printf '%s' "$row" | cut -f2)
  [ "$mt" = "$ct" ] || return 1
  [ -z "$mp" ] || [ -z "$cp" ] || [ "$mp" = "$cp" ]
}

# 挑选要恢复的缓存，结果放在 PICK_TAG。
# 规则：
#   1) 页面上指定的那份还在、而且同机型 → 直接用；
#   2) 指定的那份是同机型但已被清理 / 是别的机型 / 是 latest → 在最近 CANDS 份里挑同机型最新的一份；
#   3) 一份同机型的都没有 → 退到最新一份（老缓存没有 meta 时无法判断机型，只能这样）。
# 之前直接取「全仓库最新一份」，多机型轮流编译时会把另一个机型的缓存塞过来，meta 比对后整轮没有缓存。
PICK_TAG=""
choose() {
  local want="$1" ct="$2" cp="$3" tag row newest="" n=0
  PICK_TAG=""
  if [ -n "$want" ] && [ "$want" != "latest" ] && ! [[ "$want" =~ ^cache-[A-Za-z0-9_-]{8,64}$ ]]; then
    warn "缓存：标识 $want 不合法，改为自动挑选"; want=""
  fi
  if [ -n "$want" ] && [ "$want" != "latest" ] && tag_exists "$want"; then
    row=$(meta_row "$want")
    if row_match "$row" "$ct" "$cp"; then PICK_TAG="$want"; return 0; fi
    local mt mp; mt=$(printf '%s' "$row" | cut -f1); mp=$(printf '%s' "$row" | cut -f2)
    if [ -n "$row" ]; then
      note "缓存：指定的 $want 是为 $mt / $mp 编的，和本次 $ct / $cp 不同，改在同机型的缓存里找"
    fi
  elif [ -n "$want" ] && [ "$want" != "latest" ]; then
    note "缓存：$want 不可用（可能已被清理），改为自动挑选"
  fi

  while read -r tag; do
    [ -n "$tag" ] || continue
    n=$((n + 1)); [ "$n" -le "$CANDS" ] || break
    [ -n "$newest" ] || newest="$tag"
    row=$(meta_row "$tag")
    if row_match "$row" "$ct" "$cp"; then PICK_TAG="$tag"; return 0; fi
  done < <(list_cache_tags)

  PICK_TAG="$newest"
  return 0
}

restore() {
  : "${CACHE_TAG:?}"; : "${GITHUB_REPOSITORY:?}"
  command -v gh >/dev/null || { warn "缓存：编译机上没有 gh 命令，未使用缓存"; return 0; }
  command -v zstd >/dev/null || { warn "缓存：编译机上没有 zstd 命令，未使用缓存"; return 0; }

  local CT CP
  CT=$(jq -r '.target // ""' config.json 2>/dev/null)
  CP=$(jq -r '.profile // ""' config.json 2>/dev/null)

  # 选一份「同机型」的缓存：页面指定的标识可能已被清理，也可能属于别的机型。
  # 以前这里直接退到「全仓库最新一份」，多机型轮流编译时就会拿到别人的缓存，meta 比对后整轮没缓存。
  choose "$CACHE_TAG" "$CT" "$CP"
  local TAG="$PICK_TAG"
  if [ -z "$TAG" ]; then warn "缓存：仓库里没有可用的缓存，本次不用缓存"; return 0; fi
  if [ "$TAG" != "$CACHE_TAG" ]; then
    note "缓存：改用 $TAG（同机型缓存里最新的一份）"
  fi

  local D=/tmp/cache-dl X=/tmp/cache-x E=/tmp/cache-restore.err
  rm -rf "$D" "$X"; mkdir -p "$D" "$X"; : > "$E"

  # 先拉 meta（几十字节）核对目标/机型：对不上说明这份缓存编的是别的设备，下载分卷纯属浪费
  gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --dir "$D" --pattern 'ccache.meta.json' >/dev/null 2>&1 || true
  if [ -f "$D/ccache.meta.json" ]; then
    local mt mp mc cur
    mt=$(meta target "$D/ccache.meta.json"); mp=$(meta profile "$D/ccache.meta.json"); mc=$(meta commit "$D/ccache.meta.json")
    if [ -n "$mt" ] && { [ "$mt" != "$CT" ] || { [ -n "$mp" ] && [ -n "$CP" ] && [ "$mp" != "$CP" ]; }; }; then
      warn "缓存：$TAG 是为 $mt / $mp 编的，和本次 $CT / $CP 不同，跳过（缓存只对同一目标 + 机型有用）"
      rm -rf "$D" "$X"; return 0
    fi
    cur=$(git -C openwrt rev-parse --short=8 HEAD 2>/dev/null || echo '')
    if [ -n "$mc" ] && [ -n "$cur" ] && [ "$mc" != "$cur" ]; then
      note "缓存：$TAG 是源码 $mc 编的，本次是 $cur（源码变了，只有没改到的部分能命中）"
    fi
    # 这份缓存自带「它生成时的累计命中/可缓存调用」，本轮结束时减掉它就是本轮的数字，
    # 不用再让人拿两个累计值手算。
    local bh bt
    bh=$(meta ccache_hits "$D/ccache.meta.json"); bt=$(meta ccache_total "$D/ccache.meta.json")
    if [ -n "$bh" ] && [ -n "$bt" ]; then
      printf '%s %s\n' "$bh" "$bt" > "$BASELINE"
    else
      rm -f "$BASELINE"
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

# ccache -s 的累计「命中 / 可缓存调用」，输出 "hits total"。
# 统计是独立 step，编译步骤的 env 不会继承过来，所以要显式补 CCACHE_MAXSIZE，
# 否则 -s 里的上限会显示成 ccache 默认的 5G，看上去像「8G 没生效」。
counter() {
  local cc="$1" txt h t
  txt=$(CCACHE_DIR="$PWD/$CDIR" CCACHE_MAXSIZE="${CCACHE_MAXSIZE:-8G}" "$cc" -s 2>/dev/null)
  h=$(printf '%s\n' "$txt" | awk '/^[[:space:]]*Hits:/{for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/){print $i; exit}}')
  t=$(printf '%s\n' "$txt" | awk '/Cacheable calls:/{for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/){print $i; exit}}')
  printf '%s %s\n' "${h:-0}" "${t:-0}"
}

stats() {
  local cc; cc=$(ccache_bin) || { echo "没有找到 ccache（可能 ccache 没有生效，或编译还没走到那一步）"; return 0; }
  local out; out=$(CCACHE_DIR="$PWD/$CDIR" CCACHE_MAXSIZE="${CCACHE_MAXSIZE:-8G}" "$cc" -s 2>&1 \
    | grep -iE 'hit|miss|cache size|cacheable' | head -n 8 | sed 's/^[[:space:]]*//')
  [ -n "$out" ] && note "ccache 累计：$(echo "$out" | paste -sd';' -)"

  # 缓存里带着「生成它的那一轮」的累计值，restore 已经把它记下来了，减掉即本轮。
  local now h t dh dt
  now=$(counter "$cc"); h=${now% *}; t=${now#* }
  if [ -f "$BASELINE" ]; then
    local bh bt
    read -r bh bt < "$BASELINE" || true
    dh=$((h - ${bh:-0})); dt=$((t - ${bt:-0}))
    [ "$dh" -ge 0 ] || dh=0
    [ "$dt" -ge 0 ] || dt=0
    if [ "$dt" -gt 0 ]; then
      note "ccache 本轮：命中 $dh / $dt 次可缓存调用（$(awk -v a="$dh" -v b="$dt" 'BEGIN{printf "%.1f%%", 100*a/b}')）"
    else
      note "ccache 本轮：没有新的可缓存调用（命中 $dh 次）"
    fi
  else
    note "ccache 本轮：本次没有恢复缓存，累计值即本轮（命中 $h / $t）"
  fi
  return 0
}

# 按机型分组清理：同一 target 只留最新 KEEP 份，不同机型互不影响。
# 读不到 meta 的老缓存归到 unknown 组，同样按 KEEP 份保留。
prune() {
  local tag row t n
  declare -A cnt=()
  while read -r tag; do
    [ -n "$tag" ] || continue
    row=$(meta_row "$tag")
    t=$(printf '%s' "$row" | cut -f1)
    [ -n "$t" ] || t="unknown"
    if [[ -v "cnt[$t]" ]]; then n=${cnt[$t]}; else n=0; fi
    cnt[$t]=$((n + 1))
    if [ "$n" -ge "$KEEP" ]; then
      if gh release delete "$tag" --repo "$GITHUB_REPOSITORY" --cleanup-tag --yes >/dev/null 2>&1; then
        echo "缓存：清理旧缓存 $tag（$t 已留 $KEEP 份）"
      fi
    fi
  done < <(list_cache_tags)
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
  local SRC TGT PROF CSHA CCV NOW CH CT
  SRC=$(git -C openwrt rev-parse --short=8 HEAD 2>/dev/null || echo '')
  TGT=$(jq -r '.target // ""' config.json 2>/dev/null)
  PROF=$(jq -r '.profile // ""' config.json 2>/dev/null)
  CSHA=$(sha256sum openwrt/.config 2>/dev/null | cut -d' ' -f1)
  CCV=$(if cc=$(ccache_bin); then "$cc" --version 2>/dev/null | head -n 1; fi)
  # 把「截至本轮结束」的累计命中写进 meta：下次恢复后 stats 减掉它，就是那一轮自己的命中率
  CH=""; CT=""
  if cc=$(ccache_bin); then read -r CH CT < <(counter "$cc"); fi
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg b "$BUILD_ID" --arg t "$TGT" --arg p "$PROF" --arg c "$SRC" \
        --arg s "$CSHA" --arg v "$CCV" --arg d "$NOW" \
        --argjson h "${CH:-0}" --argjson n "${CT:-0}" \
    '{build_id:$b, target:$t, profile:$p, commit:$c, config_sha256:$s, ccache_version:$v, created_at:$d,
      ccache_hits:$h, ccache_total:$n}' \
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
  # 清理：按机型分组，每组只留最新的 KEEP 份。
  # 以前是「全仓库只留最新 KEEP 份」，多机型轮流编译会互相挤掉——A 机型刚编完就把 B 机型的缓存删了。
  prune

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
