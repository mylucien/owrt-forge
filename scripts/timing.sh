#!/usr/bin/env bash
# 编译结束后，从带时间戳的 make 日志里汇总「时间花在哪个包上」和「哪里长时间没有输出」，
# 结果写进构建说明。只做统计：日志格式不认识、python3 缺失，都静默跳过，绝不影响编译。
#
# 用法：bash timing.sh [/tmp/make.log] [源码目录，默认 openwrt]
#
# 计时来源按可靠性依次尝试（哪个有数据用哪个，构建说明里会写明用的哪个）：
#   1) scripts/time.pl 打的 `time: <目录>/<目标>#user#sys#real`——real 就是墙钟秒数，最准；
#      但 make world 这条路不经过 subdir 递归，实测一轮 2 小时 40 分里只有 1 条（target/linux/prereq），
#      所以只能当「有就用」。
#   2) `make[N]: Entering/Leaving directory` 成对配平——按 (层级, 路径) 配对，并行时不会串味；
#      但 OpenWrt 的子 make 带了 --no-print-directory，实测一轮只有 6 对，同样只能当补充。
#   3) 兜底：日志里 `make[3] -C <目录> compile` 是子 make 的启动时刻，结束时刻用
#      build_dir/<包>-<版本>/.built 的 mtime——这两个是真有数据的，能给出每个包的墙钟时间。
set -uo pipefail

LOG="${1:-/tmp/make.log}"
BASE="${2:-openwrt}"
NOTES=/tmp/build-notes
note() { echo "$*" >> "$NOTES"; echo "$*"; }

[ -f "$LOG" ] || { echo "没有 $LOG，跳过耗时汇总"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "没有 python3，跳过耗时汇总"; exit 0; }

python3 - "$LOG" "$BASE" <<'PY' > /tmp/timing-report
import os, re, sys

path, base = sys.argv[1], sys.argv[2]

# 行首时间戳：stamp.sh 打的是 "epoch HH:MM:SS "（两段都能用），老日志只有 HH:MM:SS
ts_full = re.compile(r'^(\d{9,11}) (\d{2}:\d{2}:\d{2}) (.*)$')
ts_hms = re.compile(r'^(\d{2}:\d{2}:\d{2}) (.*)$')

time_re = re.compile(r'^time: (\S+)#([\d.]+)#([\d.]+)#([\d.]+)$')
enter_re = re.compile(r"^make\[(\d+)\]: Entering directory '(.+)'")
leave_re = re.compile(r"^make\[(\d+)\]: Leaving directory '(.+)'")
# 子 make 的启动行，例如 " make[3] -C package/feeds/packages/net/sing-box compile"
start_re = re.compile(r'^make\[(\d+)\] -C (\S+) (compile|host-compile)$')

rows = []          # (abs_sec, hms, msg)
time_lines = []    # (name, real_sec)
pairs = []         # (level, dir, start_abs, end_abs)
starts = []        # (abs_sec, dir)

day = 0
prev = -1
for raw in open(path, encoding='utf-8', errors='replace'):
    line = raw.rstrip('\n')
    m = ts_full.match(line)
    if m:
        abs_s, hms, msg = int(m.group(1)), m.group(2), m.group(3)
    else:
        m = ts_hms.match(line)
        if not m:
            continue          # 没有时间戳的行（stamp.sh 没生效时的原始输出）不参与统计
        hms, msg = m.group(1), m.group(2)
        h, mi, s = (int(x) for x in hms.split(':'))
        abs_s = day * 86400 + h * 3600 + mi * 60 + s
        # 跨 UTC 零点时 HH:MM:SS 会回绕，差值会变成负数。用「累计天数」修正，
        # 而不是「每段 +86400」——后者在多次回绕时会把顺序搞乱。
        if abs_s < prev - 43200:
            day += 1
            abs_s += 86400
    prev = abs_s
    rows.append((abs_s, hms, msg.strip()))

if not rows:
    print("NODATA 日志里没有任何带时间戳的行（stamp.sh 没生效？）")
    sys.exit(0)

def dur(n):
    n = int(round(n))
    if n >= 3600:
        return "%dh%02dm" % (n // 3600, n % 3600 // 60)
    if n >= 60:
        return "%dm%02ds" % (n // 60, n % 60)
    return "%ds" % n

# --- 来源 1：time.pl ---
for abs_s, hms, msg in rows:
    m = time_re.match(msg)
    if m:
        time_lines.append((m.group(1), float(m.group(4))))

# --- 来源 2：Entering/Leaving 配对 ---
stack = []
for abs_s, hms, msg in rows:
    m = enter_re.match(msg)
    if m:
        stack.append((int(m.group(1)), m.group(2), abs_s))
        continue
    m = leave_re.match(msg)
    if m:
        lvl, p = int(m.group(1)), m.group(2)
        for i in range(len(stack) - 1, -1, -1):
            if stack[i][0] == lvl and stack[i][1] == p:
                _, _, s = stack.pop(i)
                pairs.append((lvl, p, s, abs_s))
                break

# --- 来源 3：子 make 启动行 + build_dir/.built 的 mtime ---
for abs_s, hms, msg in rows:
    m = start_re.match(msg)
    if m:
        starts.append((int(abs_s), m.group(2)))

def built_mtimes():
    """build_dir 下所有 .built 的 mtime，返回 {目录名: mtime}"""
    res = {}
    bd = os.path.join(base, 'build_dir')
    if not os.path.isdir(bd):
        return res
    for root, dirs, files in os.walk(bd):
        if '.built' in files:
            try:
                res[os.path.basename(root)] = os.stat(os.path.join(root, '.built')).st_mtime
            except OSError:
                pass
    return res

pkgs = []
if starts:
    mt = built_mtimes()
    last = rows[-1][0]
    for abs_s, d in starts:
        name = os.path.basename(d.rstrip('/'))
        # 目录名是 <包名>-<版本>；优先精确同名，其次取最短的同前缀目录名，免得 libfoo 抢到 libfoo-bar
        cand = name if name in mt else None
        if cand is None:
            pref = [k for k in mt if k.startswith(name + '-')]
            if pref:
                cand = min(pref, key=len)
        if cand is None:
            continue
        end = mt[cand]
        if end < abs_s - 2:      # .built 比这次启动还早 → 上一轮的残留
            continue
        if end > last + 3600:
            continue
        pkgs.append((d, end - abs_s))

print("SPAN %s → %s（%s）" % (rows[0][1], rows[-1][1], dur(rows[-1][0] - rows[0][0])))

def top_block(items, limit=8):
    agg = {}
    for name, sec in items:
        agg[name] = agg.get(name, 0) + sec
    top = sorted(agg.items(), key=lambda kv: -kv[1])[:limit]
    return "；".join("%s %s" % (k, dur(v)) for k, v in top if v >= 1)

src, line = "", ""
if len(time_lines) >= 1:
    src = "time.pl 实际耗时"
    line = top_block(time_lines)
elif len(pairs) >= 1:
    # 并行时同一目录可能出现多次（不同 target），按目录名合并；
    # 只用「出现次数最多」的那一层，免得父目录把子目录的时间再算一遍。
    cnt = {}
    for lvl, p, s, e in pairs:
        cnt[lvl] = cnt.get(lvl, 0) + 1
    keep = max(cnt, key=lambda k: cnt[k])
    items = [(p.split('/openwrt/', 1)[-1], e - s) for l, p, s, e in pairs if l == keep]
    src = "make 目录停留时间（层级 %d）" % keep
    line = top_block(items)
elif len(pkgs) >= 1:
    src = "包编译墙钟（启动→.built）"
    line = top_block(pkgs)

if line:
    print("TOPLINE %s|%s" % (src, line))
else:
    print("COUNTS time=%d enter=%d pkg=%d" % (len(time_lines), len(pairs), len(pkgs)))

# 长时间没有任何输出的段：并行槽被个别长任务占满时，日志会整段空白
blanks = []
for i in range(1, len(rows)):
    gap = rows[i][0] - rows[i - 1][0]
    if gap >= 120:
        blanks.append((gap, rows[i - 1][1], rows[i][1], rows[i - 1][2]))
gaps = []
for gap, a, b, lastmsg in sorted(blanks, reverse=True)[:3]:
    gaps.append("%s %s→%s（%s 之后）" % (dur(gap), a, b, lastmsg[:60]))
if gaps:
    print("GAPLINE " + "；".join(gaps))
PY

if [ ! -s /tmp/timing-report ] || grep -q '^NODATA' /tmp/timing-report; then
  echo "编译日志没有时间戳（stamp.sh 可能没生效），跳过耗时汇总"
  rm -f /tmp/timing-report
  exit 0
fi

SPAN=$(sed -n 's/^SPAN //p' /tmp/timing-report)
TOPS=$(sed -n 's/^TOPLINE //p' /tmp/timing-report)
COUNTS=$(sed -n 's/^COUNTS //p' /tmp/timing-report)
GAPS=$(sed -n 's/^GAPLINE //p' /tmp/timing-report)

[ -n "$SPAN" ] && note "编译耗时：$SPAN"
if [ -n "$TOPS" ]; then
  note "耗时最长的包/目录（Top 8，来源：${TOPS%%|*}）：${TOPS#*|}"
elif [ -n "$COUNTS" ]; then
  note "耗时统计：日志里没有可用的计时行（$COUNTS），本次跳过"
fi
[ -n "$GAPS" ] && note "最长无输出间隔：$GAPS"
rm -f /tmp/timing-report
exit 0
