#!/usr/bin/env bash
# timing.sh 第三种来源（子 make 启动行 → build_dir 结束标记）的回归测试。
# 只依赖 python3，不需要网络、不需要真编译：造一棵假 build_dir 和一段带时间戳的假日志。
#
# 用法：bash tests/timing-test.sh   （仓库里）
#       bash dist/push/test/timing-test.sh   （本地开发目录）
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# 仓库里是 tests/ + scripts/；本地开发目录是 dist/push/test/ + dist/push/
SCRIPTS=""
for d in "$HERE/../scripts" "$HERE/.."; do
  if [ -f "$d/timing.sh" ]; then SCRIPTS=$(cd "$d" && pwd); break; fi
done
[ -n "$SCRIPTS" ] || { echo "找不到 timing.sh（在 $HERE/../scripts 或 $HERE/..）"; exit 1; }
TMP=$(mktemp -d)
case "$TMP" in [A-Za-z]:*) TMP=$(cygpath -u "$TMP") ;; esac   # Windows 下 mktemp 可能返回 C:/...
W="$TMP/w2"; SRC="$W/openwrt"; LOG="$W/make.log"
mkdir -p "$SRC"
PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
want() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1（找不到：$3）"; printf '    实际：%s\n' "$2"; fi; }
nope() { if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1（不该出现：$3）"; printf '    实际：%s\n' "$2"; else ok "$1"; fi; }

python3 - "$SRC" "$LOG" <<'PY'
import os, sys, pathlib
src, logp = sys.argv[1], sys.argv[2]
t0 = 1767225600                       # 2026-01-01 00:00:00 UTC，只用来对齐 mtime 和日志

def mk(rel, stamps):
    d = pathlib.Path(src, 'build_dir', rel)
    d.mkdir(parents=True, exist_ok=True)
    for name, off in stamps:
        p = d / name
        if name.endswith('/'):        # .pkgdir 是目录，不是文件
            p.mkdir(exist_ok=True)
        elif not p.exists():
            p.write_text('x')
        os.utime(p, (t0 + off, t0 + off))

# 同一份源码给 host 和 target 各编一次：目录名完全一样，只有所在层不同
mk('host/foo-1.2.3',                   [('.built', 50)])
mk('target-mips_24kc_musl/foo-1.2.3',  [('.built', 300), ('.pkgdir/', 420)])   # 装完比编完晚 2 分钟
mk('target-mips_24kc_musl/bar-2.0',    [('.built', 120)])

def line(off, msg):
    h, rem = divmod(off, 3600); m, s = divmod(rem, 60)
    return '%d %02d:%02d:%02d %s\n' % (t0 + off, h, m, s, msg)

rows = [
    (0,   ' make[3] -C tools/foo compile'),        # host 那份
    (0,   ' make[3] -C package/foo compile'),      # target 那份，同名
    (0,   ' make[3] -C package/bar compile'),
    (30,  ' make[3] -C package/foo compile'),      # 同一目录被调起两次，不能累加
    (0,   ' make[3] -C package/nosuch compile'),   # 对不上 build_dir，应被单独计数
    (600, ' 打包完成'),                             # 只是把日志末尾推到最后一次结束之后
]
open(logp, 'w', encoding='utf-8', newline='\n').writelines(line(o, m) for o, m in rows)
PY

rm -f /tmp/build-notes
OUT=$(bash "$SCRIPTS/timing.sh" "$LOG" "$SRC" 2>&1)
printf '%s\n' "$OUT" | sed 's/^/    /'

echo "== 同名 host/target 目录"
want "host 那份没被 target 覆盖（tools/foo 50s）" "$OUT" "tools/foo 50s"
want "target 那份也在（package/foo）"             "$OUT" "package/foo"

echo "== 结束时刻取最后一个标记"
want "target 那份算到 .pkgdir（7m00s）"           "$OUT" "package/foo 7m00s"
nope "没有退回到 .built（否则是 5m00s）"          "$OUT" "5m00s"

echo "== 同一目录多次启动只算一次"
nope "没有把两次启动累加（否则 13m 多）"          "$OUT" "13m"

echo "== 对不上的目录单独计数"
want "写了未计入的条数"                            "$OUT" "另有 1 个"

echo "== 基本输出"
want "有总跨度"                                    "$OUT" "编译耗时："
want "bar 也在 Top 里"                             "$OUT" "package/bar 2m00s"

rm -rf "$TMP"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
