#!/usr/bin/env bash
# 从 /tmp/make.log 里识别「缺少依赖」类报错，生成：
#   /tmp/fail-reason  一句话原因（显示在构建记录的「失败原因」，≤450 字）
#   /tmp/fail-hints   详细说明和处理建议（放在日志摘要最前面）
# 只做识别和提示，不改任何编译行为；识别不到就什么都不写。
set -uo pipefail
LOG="${1:-/tmp/make.log}"
: > /tmp/fail-reason; : > /tmp/fail-hints
[ -s "$LOG" ] || exit 0

uniq_join() { sort -u | head -n "${1:-8}" | paste -sd' ' -; }
reasons=(); hints=()

# 失败的是哪个包（make 的 V=s 日志里有 "ERROR: package/... failed to build"）
failed_pkgs=$(grep -aoE "ERROR: (package|feeds)/[^ ]+ failed to build" "$LOG" | sed -E 's/^ERROR: //; s/ failed to build$//; s#.*/##' | uniq_join 5)

# A. Makefile 依赖的包在源码/feeds 里不存在
dep_missing=$(grep -aoE "Makefile '[^']+' has a dependency on '[^']+', which does not exist" "$LOG" \
  | sed -E "s#Makefile '([^']+)/Makefile' has a dependency on '([^']+)', which does not exist#\2（被 \1 依赖）#; s#package/feeds/[^/]+/##; s#package/##" | sort -u | head -n 8)
if [ -n "$dep_missing" ]; then
  names=$(echo "$dep_missing" | sed -E 's/（.*//' | uniq_join 8)
  reasons+=("依赖包不存在：$names")
  hints+=("【依赖包在源码里不存在】"$'\n'"$(echo "$dep_missing" | sed 's/^/  - /')"$'\n'"  处理：这些包不在当前源码和 feeds 里。去掉依赖它们的插件，或把包所在仓库作为自定义插件一并加入清单。")
fi

# B. 编译产物链接了运行时库，但包的 DEPENDS 没声明
lib_missing=$(awk '
  /Package [^ ]+ is missing dependencies for the following libraries:/ { pkg=$0; sub(/.*Package /,"",pkg); sub(/ is missing.*/,"",pkg); inlib=1; next }
  inlib && /^[[:space:]]*lib[^[:space:]]*\.so[^[:space:]]*[[:space:]]*$/ { gsub(/[[:space:]]/,""); print pkg ": " $0; next }
  { inlib=0 }' "$LOG" | sort -u | head -n 10)
if [ -n "$lib_missing" ]; then
  pk=$(echo "$lib_missing" | sed -E 's/:.*//' | uniq_join 5)
  reasons+=("包缺少运行时库依赖：$pk")
  hints+=("【包缺少库依赖声明（missing dependencies）】"$'\n'"$(echo "$lib_missing" | sed 's/^/  - /')"$'\n'"  处理：这个包用到了上面的库，但它的 Makefile 没写 DEPENDS。把对应库包（libxxx）加进插件清单，或给该包的 Makefile 补上 +libxxx。")
fi

# C. 缺少头文件
hdr=$(grep -aoE "fatal error: [^ :]+: No such file or directory" "$LOG" | sed -E 's/fatal error: ([^:]+):.*/\1/' | sort -u | head -n 6)
if [ -n "$hdr" ]; then
  guess=""
  for h in $hdr; do
    case "$h" in
      ffi.h|ffitarget.h) guess+=" $h→libffi" ;;
      zlib.h)            guess+=" $h→zlib" ;;
      openssl/*)         guess+=" $h→libopenssl" ;;
      ncurses.h|curses.h) guess+=" $h→libncurses" ;;
    esac
  done
  reasons+=("缺少头文件：$(echo "$hdr" | paste -sd' ' -)")
  hints+=("【缺少头文件】"$'\n'"$(echo "$hdr" | sed 's/^/  - /')"$'\n'"  处理：编译这个包时，它需要的开发库没有进入构建依赖。${guess:+可能对应的包：${guess# }。}可以先把对应库包加进插件清单试一次；仍不行说明该包的 Makefile 缺少 DEPENDS / PKG_BUILD_DEPENDS。")
fi

# D. pkg-config 找不到模块
pc=$(grep -aoE "(Package '?[^' ]+'? was not found in the pkg-config search path|No package '[^']+' found|Package '[^']+', required by '[^']*', not found)" "$LOG" | sed -E "s/Package '?([^' ]+)'? was not.*/\1/; s/No package '([^']+)' found/\1/; s/Package '([^']+)', required by.*/\1/" | sort -u | head -n 6)
if [ -n "$pc" ]; then
  reasons+=("pkg-config 找不到：$(echo "$pc" | paste -sd' ' -)")
  hints+=("【pkg-config 缺模块】"$'\n'"$(echo "$pc" | sed 's/^/  - /')"$'\n'"  处理：对应的开发库没有被编译或没有进依赖链。把提供该模块的库包加进插件清单。")
fi

# E. 生成固件/安装时 opkg 解析依赖失败
opkg_missing=$(awk '
  /Cannot satisfy the following dependencies for / { pkg=$0; sub(/.*dependencies for /,"",pkg); sub(/:.*/,"",pkg); inl=1; next }
  inl && /^[[:space:]]*\* [^[:space:]]+/ { d=$2; print pkg " 需要 " d; next }
  { inl=0 }' "$LOG" | sort -u | head -n 10)
if [ -n "$opkg_missing" ]; then
  reasons+=("安装时依赖无法满足：$(echo "$opkg_missing" | sed -E 's/ 需要 .*//' | uniq_join 5)")
  hints+=("【安装依赖无法满足（opkg）】"$'\n'"$(echo "$opkg_missing" | sed 's/^/  - /')"$'\n'"  处理：被需要的包没有被编译进来或已被取消勾选。把它加进插件清单，或去掉依赖它的包。")
fi

# F. 编译主机缺工具 / perl 模块
host=$(grep -aoE "(^|[^[:alnum:]_])[[:alnum:]_.+-]+: command not found|Can't locate [^ ]+\.pm in @INC" "$LOG" | sed -E "s/^[^[:alnum:]_]//; s/: command not found//; s/Can't locate ([^ ]+)\.pm.*/perl:\1/" | sort -u | head -n 6)
if [ -n "$host" ]; then
  reasons+=("编译主机缺少工具：$(echo "$host" | paste -sd' ' -)")
  hints+=("【编译主机缺工具】"$'\n'"$(echo "$host" | sed 's/^/  - /')"$'\n'"  处理：这是 GitHub Actions 运行环境缺的命令，需要在工作流的依赖安装步骤里补装对应软件包。")
fi

# G. configure 阶段明确报「找不到」
cfg=$(grep -aiE "configure: error: .*(not found|cannot find|can't find|no usable|missing|requires)" "$LOG" | sed -E 's/^.*configure: error: //' | sort -u | head -n 3)
if [ -n "$cfg" ] && [ -z "$hdr$pc$lib_missing" ]; then
  reasons+=("configure 报缺少依赖：$(echo "$cfg" | head -n 1 | cut -c1-80)")
  hints+=("【configure 阶段缺依赖】"$'\n'"$(echo "$cfg" | sed 's/^/  - /')"$'\n'"  处理：按提示补上缺的开发库，或把提供它的库包加进插件清单。")
fi

[ ${#reasons[@]} -gt 0 ] || exit 0
summary=$(printf '%s；' "${reasons[@]}"); summary="${summary%；}"
[ -n "$failed_pkgs" ] && summary="$summary（失败的包：$failed_pkgs）"
printf '%s' "$summary" | cut -c1-450 > /tmp/fail-reason
printf '%s\n\n' "${hints[@]}" > /tmp/fail-hints
exit 0
