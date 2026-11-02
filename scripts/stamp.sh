#!/usr/bin/env bash
# 给 stdin 的每一行加 "epoch HH:MM:SS " 前缀，用于编译结束后按阶段/按包统计耗时。
# 用法：make ... 2>&1 | bash stamp.sh | tee /tmp/make.log
#
# 为什么带 epoch：一轮编译两小时多，跨 UTC 零点时 HH:MM:SS 会回绕，直接相减会得到负数，
# 排序时被当成很小的值丢掉。epoch 单调递增，相减永远是对的，还能和文件 mtime 对齐
# （timing.sh 用它把「子 make 启动」和 build_dir/<包>/.built 的修改时间配成一对）。
# HH:MM:SS 仍然打在后面，方便人直接看日志。
#
# 用 python3 逐行处理：比每行 fork 一次 date 快得多；也不会因为日志里出现非 UTF-8 字节
# （某些编译器警告会夹带）而中断——直接按 bytes 透传。没有 python3 时原样透传，
# 只是没有时间戳，不影响编译。
set -uo pipefail

if command -v python3 >/dev/null 2>&1; then
  exec python3 -u -c '
import sys, time
out = sys.stdout.buffer
for line in sys.stdin.buffer:
    t = time.time()
    out.write(("%d %s " % (int(t), time.strftime("%H:%M:%S", time.localtime(t)))).encode() + line)
    out.flush()
'
fi
exec cat
