#!/usr/bin/env bash
# cache.sh 的本地回归测试（假 gh / 假 zstd / 假 jq，不需要网络）。
# 重点验证：多机型时不会再选错缓存、按机型分组清理、stats 能算出「本轮」命中率。
#
# 用法：bash tests/run.sh   （仓库里）
#       bash dist/push/test/run.sh   （本地开发目录）
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# 仓库里是 tests/ + scripts/；本地开发目录是 dist/push/test/ + dist/push/
ROOT=""
for d in "$HERE/../scripts" "$HERE/.."; do
  if [ -f "$d/cache.sh" ]; then ROOT=$(cd "$d" && pwd); break; fi
done
[ -n "$ROOT" ] || { echo "找不到 cache.sh（在 $HERE/../scripts 或 $HERE/..）"; exit 1; }
TMP=$(mktemp -d)
case "$TMP" in [A-Za-z]:*) TMP=$(cygpath -u "$TMP") ;; esac   # Windows 下 mktemp 可能返回 C:/...
export CCSTUB_STATE="$TMP/state"
export PATH="$HERE/bin:$PATH"
S="$CCSTUB_STATE"
W="$TMP/work"
PASS=0; FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
want() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1（找不到：$3）"; fi; }
nope() { if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1（不该出现：$3）"; else ok "$1"; fi; }

TARGET=airoha/an7581
PROFILE=nokia_xg-040g-md-ubi

mkdir -p "$S/rel" "$W/openwrt"
printf '{"target":"%s","profile":"%s"}' "$TARGET" "$PROFILE" > "$W/config.json"

# 造一份缓存：cache.tar 里放一个 marker 文件，恢复后能看出是哪一份
mk_rel() { # $1=tag $2=target $3=profile $4=hits $5=total
  local tag=$1 d="$S/rel/$1" src="$TMP/src-$1"
  mkdir -p "$d" "$src/.ccache"
  jq -n --arg b "build-$tag" --arg t "$2" --arg p "$3" --arg c "abc12345" \
        --arg s "cfgsha" --arg v "ccache 4.10.2" --arg d "2026-11-02T00:00:00Z" \
        --argjson h "$4" --argjson n "$5" \
    '{build_id:$b,target:$t,profile:$p,commit:$c,config_sha256:$s,ccache_version:$v,created_at:$d,ccache_hits:$h,ccache_total:$n}' \
    > "$d/ccache.meta.json"
  echo "$tag" > "$src/.ccache/marker"
  tar -C "$src" -cf "$d/ccache.tar.zst.part00" .ccache
  (cd "$d" && sha256sum ccache.tar.zst.part00 > ccache.sha256)
}

reset_state() { rm -rf "$S/rel" "$S/order"; mkdir -p "$S/rel"; : > "$S/order"; }

# order 按「新→旧」写入
order() { printf '%s\n' "$@" > "$S/order"; }

restore_case() { # $1=名称 $2=CACHE_TAG
  echo "== $1（CACHE_TAG=$2）"
  rm -rf "$W/openwrt/.ccache" /tmp/build-notes
  local out; out=$(cd "$W" && CACHE_TAG="$2" GITHUB_REPOSITORY=test/repo bash "$ROOT/cache.sh" restore 2>&1)
  printf '%s\n' "$out"
  local got; got=$(cat "$W/openwrt/.ccache/marker" 2>/dev/null || echo '未恢复')
  printf '   恢复到: %s\n' "$got"
  printf '%s' "$out" > "$TMP/last-out"
  printf '%s' "$got" > "$TMP/last-got"
}
last_out() { cat "$TMP/last-out"; }
last_got() { cat "$TMP/last-got"; }

# ---------------------------------------------------------------- 1. 指定的缓存属于别的机型
echo "### 1. 指定的标识存在，但属于另一个机型"
reset_state
mk_rel cache-other-0001 airoha/an7583 other_dev 10 100
mk_rel cache-same-0002  "$TARGET" "$PROFILE" 500 1000
mk_rel cache-same-0001  "$TARGET" "$PROFILE" 100 800
order cache-other-0001 cache-same-0002 cache-same-0001
restore_case "指定 other1" cache-other-0001
want "改用同机型的最新一份" "$(last_got)" "cache-same-0002"
want "说明改用的理由" "$(last_out)" "改用 cache-same-0002（同机型最新的一份）"
want "说明为什么换" "$(last_out)" "是为 airoha/an7583 / other_dev 编的"

# ---------------------------------------------------------------- 2. 指定的缓存已被清理
echo "### 2. 指定的标识已被清理"
restore_case "指定不存在的 same9" cache-9f9f9f9f-e3ed
want "退到同机型最新" "$(last_got)" "cache-same-0002"
want "提示标识不可用" "$(last_out)" "不可用（可能已被清理），改为自动挑选"

# ---------------------------------------------------------------- 3. latest + 指定同机型
echo "### 3. latest 与「指定的正好同机型」"
restore_case "latest" latest
want "latest 选同机型最新" "$(last_got)" "cache-same-0002"

restore_case "指定 same1" cache-same-0001
want "指定的同机型直接用" "$(last_got)" "cache-same-0001"
nope "不应有多余的改用提示" "$(last_out)" "改用"

# ---------------------------------------------------------------- 4. 同机型被删掉后
echo "### 4. 同机型缓存都被清理"
rm -rf "$S/rel/cache-same-0002" "$S/rel/cache-same-0001"
order cache-other-0001
restore_case "只剩别的机型" latest
want "机型不符时不恢复" "$(last_got)" "未恢复"
want "meta 目标不符会跳过" "$(last_out)" "和本次 $TARGET 不同，跳过"

# ---------------------------------------------------------------- 4b. 同平台、不同机型
echo "### 4b. 同平台但不同机型：仍然用（没改到的包对象是通用的）"
reset_state
mk_rel cache-p2-0001 "$TARGET" another_profile 1 10
order cache-p2-0001
restore_case "只有同平台别的机型" latest
want "同平台不同机型也恢复" "$(last_got)" "cache-p2-0001"
want "说明机型不同" "$(last_out)" "机型 another_profile"
want "说明仍能命中一部分" "$(last_out)" "没改到的包仍可命中"

# ---------------------------------------------------------------- 5. 老缓存没有 meta
echo "### 5. 没有 meta 的老缓存"
reset_state
mkdir -p "$S/rel/cache-old-0001"
src="$TMP/src-old"; mkdir -p "$src/.ccache"; echo old > "$src/.ccache/marker"
tar -C "$src" -cf "$S/rel/cache-old-0001/ccache.tar.zst.part00" .ccache
(cd "$S/rel/cache-old-0001" && sha256sum ccache.tar.zst.part00 > ccache.sha256)
order cache-old-0001
restore_case "latest 选到无 meta 的老缓存" latest
want "老缓存照常恢复" "$(last_got)" "old"

restore_case "明确指定无 meta 的老缓存" cache-old-0001
want "老缓存也照常恢复" "$(last_got)" "old"
want "说明这份缓存没有机型信息" "$(last_out)" "这份缓存没有机型信息"

# ---------------------------------------------------------------- 6. 按机型分组清理
echo "### 6. 按机型分组清理（每组保留 KEEP=2 份）"
reset_state
for t in 1 2 3; do mk_rel "cache-same-000$t" "$TARGET" "$PROFILE" 1 10; done
for t in 1 2 3; do mk_rel "cache-oth-000$t" airoha/an7583 other_dev 1 10; done
order cache-same-0003 cache-oth-0003 cache-same-0002 cache-oth-0002 cache-same-0001 cache-oth-0001
( cd "$W" && GITHUB_REPOSITORY=test/repo bash -c '
    set +u
    source <(sed "/^case \"\${1:-}\" in/,\$d" "'"$ROOT"'/cache.sh")
    prune' ) > "$TMP/prune.log" 2>&1
cat "$TMP/prune.log"
left=$(ls "$S/rel" 2>/dev/null | sort | paste -sd' ' -)
echo "   剩下: $left"
left_n=$(ls "$S/rel" 2>/dev/null | wc -l)
if [ "$left_n" = 4 ]; then ok "两个机型各留 2 份，共 4 份"; else bad "应剩 4 份，实际 $left_n 份：$left"; fi
want "保留同机型最新两份" "$left" "cache-same-0003"
want "保留同机型第二份" "$left" "cache-same-0002"
nope "同机型第三份被清理" "$left" "cache-same-0001"
nope "另一机型的也在清理范围" "$left" "cache-oth-0001"

# ---------------------------------------------------------------- 7. stats 本轮命中率
echo "### 7. stats 输出本轮命中率（减掉缓存自带的累计值）"
mkdir -p "$W/openwrt/staging_dir/host/bin"
cat > "$W/openwrt/staging_dir/host/bin/ccache" <<'CC'
#!/usr/bin/env bash
cat "$CCSTUB_STATE/stat.txt"
CC
chmod +x "$W/openwrt/staging_dir/host/bin/ccache"
cat > "$S/stat.txt" <<'ST'
Cacheable calls:   1400 / 1900 (73.68%)
  Hits:             350 / 1400 (25.00%)
    Direct:         340 /  350 (97.14%)
  Misses:          1050 / 1400 (75.00%)
Local storage:
  Cache size (GB): 1.50 / 8.00 (18.75%)
ST
printf '100 1000\n' > /tmp/ccache-baseline
rm -f /tmp/build-notes
( cd "$W" && bash "$ROOT/cache.sh" stats ) > "$TMP/stats.log" 2>&1
cat "$TMP/stats.log"
want "算出本轮命中 250 / 400" "$(cat "$TMP/stats.log")" "命中 250 / 400 次可缓存调用（62.5%）"

rm -f /tmp/ccache-baseline
( cd "$W" && bash "$ROOT/cache.sh" stats ) > "$TMP/stats2.log" 2>&1
want "没有 baseline 时说明「累计即本轮」" "$(cat "$TMP/stats2.log")" "本次没有恢复缓存"

echo
echo "通过 $PASS 项，失败 $FAIL 项"
rm -rf "$TMP"
[ "$FAIL" = 0 ]
