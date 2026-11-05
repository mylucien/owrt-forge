#!/usr/bin/env bash
set -euo pipefail
: "${HAS_DOTCONFIG:?}"
SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
touch /tmp/build-notes
# 写进构建说明（页面上展示），同时打到日志 —— 否则日志里看不到自动补了什么
note() { printf '%s\n' "$*" >> /tmp/build-notes; printf '%s\n' "$*"; }
NPKG=$(jq '(.packages // []) | length' config.json)
T=$(jq -r '.target // ""' config.json)
P=$(jq -r '.profile // ""' config.json)     # 模板机型
m=""; s=""
if [ -n "$T" ] && [ "$T" != "/" ]; then m="${T%%/*}"; s="${T##*/}"; fi

# ---------------------------------------------------------------------------
# 有固定底稿时怎么写 .config：按「符号级别」合并，而不是把三份文件拼起来。
#
#   一个 .config 里混着五种级别的符号（平台 / 机型 / 目标选项 / 包 / 内核其它）。
#   整份拼接等于按文件覆盖：底稿一份几百行的快照会把包和内核选项一起顶掉，
#   模板的插件清单又夹在包这一级中间，最后「谁最后写谁赢」—— 这不是分级。
#
#   各级的优先级（同级内高优先级的不被覆盖，跨级互不影响）：
#     L1 平台/子目标   只认本次任务的 target
#     L2 机型（型号）  底稿 > 模板        ← 型号这一级底稿说了算
#     L3 目标选项      底稿 > 源码补充 > 模板
#     L4 包            底稿 > 源码补充 > 模板插件
#     L5 内核/其它     底稿 > 源码补充 > 模板
#
#   合并交给 scripts/config-merge.py（可单测），这里只负责准备三个来源。
#   源码补充（configs/*.config）里的 MULTI_PROFILE / DEVICE_ 行在合并时按级别丢掉：
#   那是「这份发行版默认编哪些设备」，留着会把选中的机型清掉（见 gen-config.sh）。
# ---------------------------------------------------------------------------
if [ "$HAS_DOTCONFIG" = "true" ]; then
  SNAP=/tmp/dotconfig.snapshot
  jq -r .dotconfig_snapshot config.json > "$SNAP"
  SNAP_N=$(grep -c "^CONFIG_" "$SNAP" || true)

  # 底稿自己指定的机型（单选与多选两种写法都认，多个时取第一个）。
  # 这里先粗算一次，只为了按机型挑源码补充文件；最终以合并器的结果为准。
  #
  # 不能用 `CONFIG_TARGET_[^=]*_DEVICE_` 这种带通配的写法：CONFIG_TARGET_PER_DEVICE_ROOTFS=y
  # 也长得像，机型会被取成 ROOTFS（后面还会误报「模板机型与底稿机型不一致」）。
  # 只认本 target 的两种前缀，和 config-merge.py 的 device_id() 一致。
  SNAP_P=""
  if [ -n "$m" ]; then
    SNAP_P=$(sed -n \
      -e "s/^CONFIG_TARGET_DEVICE_${m}_${s}_DEVICE_\([A-Za-z0-9_.+-]*\)=y$/\1/p" \
      -e "s/^CONFIG_TARGET_${m}_${s}_DEVICE_\([A-Za-z0-9_.+-]*\)=y$/\1/p" \
      "$SNAP" | head -n1 || true)
  fi
  SEL="${SNAP_P:-$P}"

  # ---- 来源二：源码仓库自带的发行版默认配置（查找规则与 gen-config.sh 对齐）----
  SEED=/tmp/cfg-seed
  : > "$SEED"
  if [ -n "$T" ] && [ "$T" != "/" ]; then
    if [ -n "$SEL" ]; then
      for f in "openwrt/configs/${s}.config" "openwrt/configs/${m}_${s}.config" \
               "openwrt/configs/${s}_${SEL}.config" "openwrt/configs/${SEL}.config"; do
        if [ -f "$f" ]; then cat "$f" >> "$SEED"; fi
      done
    elif [ -f "openwrt/configs/${s}.config" ]; then
      cat "openwrt/configs/${s}.config" >> "$SEED"
    fi
    if [ -f "openwrt/configs/release.config" ]; then cat "openwrt/configs/release.config" >> "$SEED"; fi
  fi

  # ---- 来源三：模板（机型行 + 插件清单），优先级最低 ----
  TPL=/tmp/cfg-template
  : > "$TPL"
  if [ -n "$m" ]; then
    printf 'CONFIG_TARGET_%s=y\n' "$m" >> "$TPL"
    printf 'CONFIG_TARGET_%s_%s=y\n' "$m" "$s" >> "$TPL"
  fi
  if [ -n "$P" ] && [ -n "$m" ]; then
    printf 'CONFIG_TARGET_%s_%s_DEVICE_%s=y\n' "$m" "$s" "$P" >> "$TPL"
  fi
  if [ "$NPKG" -gt 0 ]; then
    jq -r '.packages[]? | select(test("^[A-Za-z0-9_.+-]+$")) | "CONFIG_PACKAGE_\(.)=y"' config.json >> "$TPL"
  fi

  # ---- 来源一：底稿，最高优先级 ----
  report=/tmp/cfg-merge.log
  # 「合并结果里被明确关闭的包 + 是谁关的」交给 device-packages.sh：底稿关的（user）是
  # 你的决定，源码补充关的（seed）只是发行版默认，机型声明的驱动还得补。先清空，免得
  # 上一轮的残留被当真。
  : > /tmp/cfg-off
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 "$SCRIPTS_DIR/config-merge.py" --target "$T" --profile "$P" \
         --snapshot "$SNAP" --seed "$SEED" --template "$TPL" --out openwrt/.config \
         --emit-off /tmp/cfg-off > "$report"; then
      echo "::error::分级合并配置失败"
      cat "$report"
      exit 1
    fi
    while IFS= read -r line; do
      case "$line" in
        "NOTE "*) note "${line#NOTE }" ;;
      esac
    done < "$report"
    EP=$(sed -n 's/^EP=//p' "$report" | head -n1)
    note "配置来源：底稿 $SNAP_N 项（最高）→ 源码补充 → 模板插件 $NPKG 个（最低），按级别取值"

    # 模板里勾了、最终却没进固件（被底稿/源码补充压成关闭或 =m）的插件，单独告警。
    # 「覆盖明细」只列前几个符号，插件商店用户最容易在这里踩空：页面勾着的应用没了。
    TPL_DOWN=$(sed -n 's/^TPL_DOWN=//p' "$report" | head -n1)
    TPL_SHOWN=$(sed -n 's/^TPL_ITEM //p' "$report" | wc -l | tr -d ' ')
    if [ -n "$TPL_DOWN" ] && [ "$TPL_DOWN" -gt 0 ] 2>/dev/null; then
      TPL_LIST=$(sed -n 's/^TPL_ITEM //p' "$report" | paste -sd'、' -)
      if [ -n "$TPL_LIST" ]; then
        note "模板选中但没进固件（$TPL_DOWN 个）：$TPL_LIST$([ "$TPL_DOWN" -gt "$TPL_SHOWN" ] && echo ' …')"
        echo "::warning::模板里勾选的插件被配置压成关闭或 =m，固件里不会有：$TPL_LIST"
      fi
    fi
  else
    # runner 正常都有 python3；万一没有，退回「低优先级先写」的拼接，不中断编译
    note "没有 python3，退回按文件顺序拼接：模板 → 源码补充 → 底稿"
    cat "$TPL" "$SEED" "$SNAP" > openwrt/.config
    EP="$SEL"
  fi

  (cd openwrt && make defconfig)

  # 机型这一类要单独校验：defconfig 之后必须真的生效，否则编出来的可能就是别的机型。
  # 单选与多设备两种写法分开校验（多设备模式下单选那行会被 kconfig 清掉）。
  if [ -n "$EP" ] && [ -n "$m" ]; then
    if grep -qx 'CONFIG_TARGET_MULTI_PROFILE=y' openwrt/.config; then
      VLINE="CONFIG_TARGET_DEVICE_${m}_${s}_DEVICE_${EP}=y"
    else
      VLINE="CONFIG_TARGET_${m}_${s}_DEVICE_${EP}=y"
    fi
    if ! grep -qxF "$VLINE" openwrt/.config; then
      {
        echo "机型 $EP 没有在 ${T} 的配置里生效（期望 $VLINE）。"
        echo "底稿机型：${SNAP_P:-无}；模板机型：${P:-无}；目标：${T:-无}。"
        echo "常见原因：底稿是从别的平台/机型存下来的，或者该机型名在这个源码版本里已经改了。"
        echo "改法：在模板页重新保存一次底稿，或去掉模板上固定的底稿。"
      } > /tmp/config-error
      echo "::error::$(head -n1 /tmp/config-error)"
      cat /tmp/config-error
      exit 1
    fi
  fi

  # 机型自己声明的包必须都在配置里；实现与 gen-config.sh 共用 scripts/device-packages.sh
  # （以前这里和那边各一份，T0 语义只在一边生效）。原理见那个文件的头注释。
  # 用 EP（最终生效机型）而不是模板机型：底稿指定了别的机型时，按底稿的包清单校验，
  # 否则会把模板机型的驱动硬塞进别人的固件里。
  source "$SCRIPTS_DIR/device-packages.sh"
  ( cd openwrt && enforce_device_packages "$EP" ) || exit 1

  # 审计：源码默认启用的包，最终有没有进固件。
  # 注意口径 —— 源码补充是参与合并的（不是"底稿没带上就丢"），所以这里列出来的
  # 基本都是「按级别该是 =y，但 defconfig 没让它是 =y」：依赖不满足、平台条件不成立，
  # 或者被人为写成 =m（只编 ipk）。不要再写成"底稿不完整"。
  #
  # 「明确关闭」只认有来源的（底稿 user / 源码补充 seed，见 /tmp/cfg-off）。
  # 别再按 .config 里有没有 "# ... is not set" 来判：defconfig 会把所有可见但没开的包
  # 都写成这一行（an7581 上就有 6000 多条），按它算等于把所有"依赖不满足被顶掉"的包
  # 都算成"你明确关闭"，LOST 永远报不出来。
  if [ -s "$SEED" ]; then
    pkg_state() {
      if grep -qx "CONFIG_PACKAGE_${1}=y" openwrt/.config; then echo y
      elif grep -qx "CONFIG_PACKAGE_${1}=m" openwrt/.config; then echo m
      elif grep -qx "# CONFIG_PACKAGE_${1} is not set" openwrt/.config; then echo off
      else echo missing; fi
    }
    declare -A AUD_USER=() AUD_SEED=()
    if [ -s /tmp/cfg-off ]; then
      while read -r origin pkg; do
        case "$origin" in
          user) AUD_USER["$pkg"]=1 ;;
          seed) AUD_SEED["$pkg"]=1 ;;
        esac
      done < /tmp/cfg-off
    fi
    LOST=""; OFFC=0; MODC=0
    for p in $(sed -n 's/^CONFIG_PACKAGE_\([A-Za-z0-9_.+-]*\)=y$/\1/p' "$SEED" | sort -u); do
      st=$(pkg_state "$p")
      [ "$st" = y ] && continue
      if [ "$st" = m ]; then MODC=$((MODC + 1)); LOST="$LOST $p"; continue; fi
      if [ -n "${AUD_USER[$p]:-}" ] || [ -n "${AUD_SEED[$p]:-}" ]; then
        OFFC=$((OFFC + 1)); continue
      fi
      LOST="$LOST $p"
    done
    if [ "$OFFC" -gt 0 ]; then
      note "其中 $OFFC 个包在配置里被明确关闭（底稿的决定或源码补充的默认），按配置保持关闭，不算缺失"
    fi
    if [ -n "${LOST// /}" ]; then
      LOSTN=$(printf '%s\n' $LOST | wc -l | tr -d ' ')
      SHOWN=$(printf '%s\n' $LOST | head -n 8 | paste -sd' ' -)
      MORE=""
      if [ "$LOSTN" -gt 8 ]; then MORE=" …（另有 $((LOSTN - 8)) 个，见日志）"; fi
      {
        echo "注意：源码默认启用、但最终没进固件的包 $LOSTN 个（其中 $MODC 个是 =m，只编 ipk 不装进固件）："
        echo " ${SHOWN}${MORE}"
        echo "源码补充是参与合并的，所以到这里还没有，原因通常是依赖不满足、被 defconfig 关掉，或该平台不支持；"
        echo "确认办法：看编译日志里 make defconfig 的 unmet dependencies 提示，或下面「插件没生效」那段诊断。"
      } >> /tmp/build-notes
      echo "::warning::源码默认启用但没进固件的包 ${LOSTN} 个：${SHOWN}${MORE}"
    fi
  fi
elif [ "$NPKG" -gt 0 ] || [ -n "$P" ]; then
  note "配置来源：按模板的机型和 ${NPKG} 个插件清单生成"
  bash "$SCRIPTS_DIR/gen-config.sh"
fi
