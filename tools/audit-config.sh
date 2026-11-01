#!/usr/bin/env bash
# 检查一份 .config 是否完整：与源码仓库自带的 configs/*.config 对比，
# 列出「源码发行版默认启用、但这份 config 里没有」的**驱动类**包。
#
# 用法：audit-config.sh <源码目录> <要检查的 .config>
#   bash audit-config.sh ~/ponwrt ./my.config
#
# 为什么要专门查驱动：普通包缺了顶多少个功能，驱动缺了设备直接不工作，
# 而且日志往往只说"某设备 probe 失败"，很难看出是配置少了一行。
# 典型：ponwrt 的 kmod-airoha-en7572 —— 少了它 PON 永远起不来，内核只报
#   "airoha-xpon: failed to obtain the optical frontend provider"
set -uo pipefail

SRC="${1:?用法: audit-config.sh <源码目录> <config 文件>}"
CFG="${2:?用法: audit-config.sh <源码目录> <config 文件>}"
[ -d "$SRC" ] || { echo "源码目录不存在: $SRC"; exit 2; }
[ -f "$CFG" ] || { echo "config 不存在: $CFG"; exit 2; }

ts=$(grep -oE '^CONFIG_TARGET_[A-Za-z0-9_]+_[A-Za-z0-9_]+=y$' "$CFG" | head -n1 | sed 's/^CONFIG_TARGET_//;s/=y$//')
if [ -z "$ts" ]; then echo "这份 config 里没有 CONFIG_TARGET_<board>_<subtarget>=y，无法判断目标平台"; exit 2; fi
m="${ts%%_*}"; s="${ts#*_}"
echo "目标平台：$m/$s"

SEEDS=()
for f in "$SRC/configs/${s}.config" "$SRC/configs/${m}_${s}.config" "$SRC/configs/release.config"; do
	[ -f "$f" ] && SEEDS+=("$f") || true
done
if [ ${#SEEDS[@]} -eq 0 ]; then
	echo "源码仓库没有匹配的 configs/*.config，没有可比对的基准（普通 OpenWrt 属于这种情况）"
	exit 0
fi
echo "比对基准：${SEEDS[*]}"
echo

# 取某个符号在这份 config 里"最后一次出现"的值，模拟 kconfig 的后者覆盖前者
eff() {
	local l
	l=$(grep -E "^# CONFIG_${1} is not set$|^CONFIG_${1}=[ym]$" "$CFG" | tail -n1)
	case "$l" in *"=y") echo y ;; *"=m") echo m ;; *) echo n ;; esac
}

drv_missing=(); drv_m=(); other=0
while read -r p; do
	[ -n "$p" ] || continue
	# 带下划线的多是构建选项（dnsmasq_full_dhcp、TAR_BZIP2 之类），不是独立包
	case "$p" in *_*) continue ;; esac
	v=$(eff "PACKAGE_$p")
	case "$p" in
		kmod-*|*-firmware)
			case "$v" in
				y) ;;
				m) drv_m+=("$p") ;;
				*) drv_missing+=("$p") ;;
			esac ;;
		*) [ "$v" = "y" ] || other=$((other + 1)) ;;
	esac
done < <(cat "${SEEDS[@]}" | sed -n 's/^CONFIG_PACKAGE_\([A-Za-z0-9_.+-]*\)=y$/\1/p' | sort -u)

status=0
if [ ${#drv_missing[@]} -gt 0 ]; then
	echo "== 源码默认启用、这份 config 里没有的驱动（${#drv_missing[@]} 个）=="
	printf '  %s\n' "${drv_missing[@]}"
	echo
	status=1
fi
if [ ${#drv_m[@]} -gt 0 ]; then
	echo "== 源码里是 =y、这份 config 写成 =m 的驱动（${#drv_m[@]} 个，单机型镜像建议改 =y）=="
	printf '  %s\n' "${drv_m[@]}"
	echo
fi
if [ "$other" -gt 0 ]; then
	echo "另有 $other 个非驱动类包与源码默认值不同（多为发行版自带应用，按需保留）"
	echo
fi

# PON 专项：这类包缺了不报错，只是设备不工作
key=(kmod-airoha-xpon kmod-airoha-pon-frontend kmod-airoha-en7572 airoha-pond)
hit=0
for k in "${key[@]}"; do
	v=$(eff "PACKAGE_$k")
	[ "$v" = "y" ] || { echo "PON 必需项 $k = $v"; hit=1; }
done
[ "$hit" = 1 ] && { echo "提示：缺任何一项，pon0 都不会起来（xpon 拿不到 optical frontend provider）"; status=1; }

[ "$status" = 0 ] && echo "驱动层面没有发现缺失" 
exit "$status"
