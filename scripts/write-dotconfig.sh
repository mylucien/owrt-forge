#!/usr/bin/env bash
set -euo pipefail
: "${HAS_DOTCONFIG:?}"
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
  SNAP_P=$(sed -n 's/^CONFIG_TARGET_[^=]*_DEVICE_\([A-Za-z0-9_.+-]*\)=y$/\1/p' "$SNAP" | head -n1)
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
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 "$SCRIPTS_DIR/config-merge.py" --target "$T" --profile "$P" \
         --snapshot "$SNAP" --seed "$SEED" --template "$TPL" --out openwrt/.config > "$report"; then
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

  # 机型自己声明的包必须都在配置里。原理见 gen-config.sh 里同名函数上方的注释：
  # 底稿里一行 PACKAGE_x=m 会压掉 kconfig 的 "default y if DEFAULT_x"，而 =m 只编
  # ipk、不进固件 —— ponwrt 的 kmod-airoha-en7572 就是这样丢的，编译不报错、PON
  # 永远起不来。这里在 openwrt/ 里跑，逻辑与 gen-config.sh 完全一致（含同类替代检查）。
  # 注意用的是 EP（最终生效机型），不是模板机型：底稿指定了别的机型时，按底稿的包清单校验，
  # 否则会把模板机型的驱动硬塞进别人的固件里。
  (
    cd openwrt
    declare -A DECL=()
    profile_pkgs() {
      [ -n "$EP" ] || return 0
      [ -f tmp/.targetinfo ] || return 0
      awk -v id="DEVICE_$EP" '
        /^Target-Profile:/ { cur = $2; next }
        cur == id && /^Target-Profile-Packages:/ {
          sub(/^[^:]*:[ \t]*/, ""); print; exit
        }' tmp/.targetinfo 2>/dev/null
    }
    declared_pkgs() {
      local t
      DECL=()
      for t in $(profile_pkgs); do
        case "$t" in
          -*) unset "DECL[${t#-}]" ;;
          +*) DECL["${t#+}"]=1 ;;
          *@*|*:*|*'$'*) continue ;;
          *) [ -n "$t" ] && DECL["$t"]=1 ;;
        esac
      done
    }
    is_driver() { case "$1" in kmod-*|*-firmware) return 0 ;; *) return 1 ;; esac; }
    provides_of() {
      awk -v p="$1" '$0=="Package: "p{f=1; next}
        f && /^Provides:/ { sub(/^Provides:[ \t]*/, ""); print; exit }
        f && /^@@/ { exit }' tmp/.packageinfo 2>/dev/null
    }
    enabled_provides_map() {
      awk 'FNR==NR {
             if ($0 ~ /^CONFIG_PACKAGE_[A-Za-z0-9_.+-]+=y$/) {
               n=$0; sub(/^CONFIG_PACKAGE_/, "", n); sub(/=y$/, "", n); EN[n]=1
             }
             next
           }
           /^Package: / { pkg=$2; next }
           /^Provides:/ { for (i=2; i<=NF; i++) if (pkg in EN) print $i, pkg }
          ' .config tmp/.packageinfo 2>/dev/null
    }
    substituted_by() {
      local v other
      for v in $(provides_of "$1"); do
        other=$(awk -v v="$v" -v q="$1" '$1==v && $2!=q { print $2; exit }' /tmp/enabled-provides 2>/dev/null)
        [ -n "$other" ] && { echo "$other"; return 0; }
      done
      return 1
    }
    [ -n "$EP" ] && [ -f tmp/.targetinfo ] || exit 0
    declared_pkgs
    [ ${#DECL[@]} -gt 0 ] || exit 0
    enabled_provides_map > /tmp/enabled-provides
  skip_all=""; off_all=""
    for round in 1 2; do
      add=""; skip=""; off=""
      for p in $(printf '%s\n' "${!DECL[@]}" | sort); do
        grep -q "^CONFIG_PACKAGE_${p}=y$" .config && continue
        if o=$(substituted_by "$p"); then skip="$skip $p→$o"; continue; fi
        # 底稿明确写了 "# ... is not set"：应用类尊重它，驱动类照补（驱动缺了设备不工作，
        # 而且编译照样成功，属于看不见的缺）
        if ! is_driver "$p" && grep -q "^# CONFIG_PACKAGE_${p} is not set$" .config; then
          off="$off $p"; continue
        fi
        add="$add $p"
      done
      if [ -n "${skip// /}" ]; then
        skip_all="$skip_all $skip"
      fi
      if [ -n "${off// /}" ]; then
        off_all="$off_all $off"
      fi
      [ -n "${add// /}" ] || break
      for p in $add; do printf 'CONFIG_PACKAGE_%s=y\n' "$p" >> .config; done
      note "机型 $EP 声明、底稿里却没有的包：${add# } → 补成 =y 后重新 defconfig"
      make defconfig || true
      enabled_provides_map > /tmp/enabled-provides
    done
    if [ -n "${skip_all// /}" ]; then
      note "机型声明的包已有同类替代，按底稿的选择保留：$(printf '%s\n' $skip_all | sort -u | paste -sd' ')"
    fi
    if [ -n "${off_all// /}" ]; then
      note "机型声明的应用在底稿里被显式关掉，按底稿保持关闭：$(printf '%s\n' $off_all | sort -u | paste -sd' ')"
    fi
    drv=""; other=""
    for p in $(printf '%s\n' "${!DECL[@]}" | sort); do
      grep -q "^CONFIG_PACKAGE_${p}=y$" .config && continue
      substituted_by "$p" > /dev/null && continue
      if ! is_driver "$p" && grep -q "^# CONFIG_PACKAGE_${p} is not set$" .config; then continue; fi
      if is_driver "$p"; then drv="$drv $p"; else other="$other $p"; fi
    done
    if [ -n "${drv// /}" ]; then
      { echo "机型 $EP 声明的驱动没能生效：${drv# }"
        echo "底稿里这些包是 =m 或 n（=m 只编 ipk，不会装进固件），或者依赖不满足。"
        echo "把底稿里对应的行删掉或改成 =y 再编译；确实不需要，就改 target/linux/.../image 里这个机型的 DEVICE_PACKAGES。"
      } > /tmp/config-error
      echo "::error::$(head -n1 /tmp/config-error)"
      cat /tmp/config-error
      exit 1
    fi
    if [ -n "${other// /}" ]; then
      note "机型声明的应用没进配置：${other# }（有同类包顶替的已跳过，其余多为源码里条件不满足）"
    fi
  ) || exit 1

  # 审计：源码默认启用、但最终 .config 里没有的包。底稿不完整时这里会列出来。
  # 同符号在合并里只保留一份，以合并结果为准。
  if [ -s "$SEED" ]; then
    pkg_on() {
      grep -qx "CONFIG_PACKAGE_${1}=y" openwrt/.config
    }
    LOST=""
    for p in $(sed -n 's/^CONFIG_PACKAGE_\([A-Za-z0-9_.+-]*\)=y$/\1/p' "$SEED" | sort -u); do
      pkg_on "$p" || LOST="$LOST $p"
    done
    if [ -n "${LOST// /}" ]; then
      {
        echo "注意：底稿没有带上源码默认启用的这些包，固件里不会有它们："
        echo " ${LOST# }"
        echo "如果确实不需要可以忽略；如果是底稿不完整，把它们补进底稿再编译。"
      } >> /tmp/build-notes
      echo "::warning::底稿缺少源码默认启用的包：${LOST# }"
    fi
  fi
elif [ "$NPKG" -gt 0 ] || [ -n "$P" ]; then
  note "配置来源：按模板的机型和 ${NPKG} 个插件清单生成"
  bash "$SCRIPTS_DIR/gen-config.sh"
fi
