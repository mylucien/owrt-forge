#!/usr/bin/env bash
# 编译结束后，从带时间戳的 make 日志里汇总「时间花在哪个包上」和「哪里长时间没有输出」，
# 结果写进构建说明。只做统计：日志没有时间戳、格式不认识、python3 缺失，都静默跳过，绝不影响编译。
#
# 用法：bash timing.sh [/tmp/make.log]
set -uo pipefail

LOG="${1:-/tmp/make.log}"
NOTES=/tmp/build-notes
note() { echo "$*" >> "$NOTES"; echo "$*"; }

[ -f "$LOG" ] || { echo "没有 $LOG，跳过耗时汇总"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "没有 python3，跳过耗时汇总"; exit 0; }

python3 - "$LOG" <<'PY' > /tmp/timing-report
import re, sys

path = sys.argv[1]
ts_re = re.compile(r'^(\d{2}:\d{2}:\d{2}) (.*)$')
enter_re = re.compile(r"^make\[(\d)\]: Entering directory '(.+)'")
leave_re = re.compile(r"^make\[(\d)\]: Leaving directory '(.+)'")

rows = []
for line in open(path, encoding='utf-8', errors='replace'):
    m = ts_re.match(line)
    if m:
        rows.append((m.group(1), m.group(2).strip()))
if not rows:
    print("SKIP 编译日志没有时间戳")
    sys.exit(0)

def sec(t):
    h, m, s = (int(x) for x in t.split(':'))
    return h * 3600 + m * 60 + s

def dur(n):
    n = int(n)
    if n >= 3600:
        return "%dh%02dm" % (n // 3600, n % 3600 // 60)
    if n >= 60:
        return "%dm%02ds" % (n // 60, n % 60)
    return "%ds" % n

# 用 Entering/Leaving 成对出现算每个目录的墙钟时间：并行编译时相邻行配对会串味，
# 这一对是子 make 自己的生命周期，互不干扰。
stack, pairs = [], []
for t, msg in rows:
    m = enter_re.match(msg)
    if m:
        stack.append((int(m.group(1)), m.group(2), t))
        continue
    m = leave_re.match(msg)
    if m:
        lvl, p = int(m.group(1)), m.group(2)
        for i in range(len(stack) - 1, -1, -1):
            if stack[i][0] == lvl and stack[i][1] == p:
                _, _, t0 = stack.pop(i)
                pairs.append((sec(t) - sec(t0), p))
                break

print("SPAN %s → %s" % (rows[0][0], rows[-1][0]))

tops = []
for d, p in sorted(pairs, reverse=True)[:8]:
    tops.append("%s %s" % (p.split('/openwrt/', 1)[-1], dur(d)))
if tops:
    print("TOPLINE " + "；".join(tops))

# 长时间没有任何输出的段：并行槽被个别长任务占满时，日志会整段空白
blanks = []
for i in range(1, len(rows)):
    gap = sec(rows[i][0]) - sec(rows[i - 1][0])
    if gap >= 120:
        blanks.append((gap, rows[i - 1][0], rows[i][0], rows[i - 1][1]))
gaps = []
for gap, t0, t1, last in sorted(blanks, reverse=True)[:3]:
    gaps.append("%s %s→%s（%s 之后）" % (dur(gap), t0, t1, last[:60]))
if gaps:
    print("GAPLINE " + "；".join(gaps))
PY

if [ ! -s /tmp/timing-report ] || grep -q '^SKIP' /tmp/timing-report; then
  echo "编译日志没有时间戳（stamp.sh 可能没生效），跳过耗时汇总"
  rm -f /tmp/timing-report
  exit 0
fi

SPAN=$(sed -n 's/^SPAN //p' /tmp/timing-report)
TOPS=$(sed -n 's/^TOPLINE //p' /tmp/timing-report)
GAPS=$(sed -n 's/^GAPLINE //p' /tmp/timing-report)

[ -n "$SPAN" ] && note "编译耗时：$SPAN"
[ -n "$TOPS" ] && note "耗时最长的目录（Top 8，按目录停留时间）：$TOPS"
[ -n "$GAPS" ] && note "最长无输出间隔：$GAPS"
rm -f /tmp/timing-report
exit 0
