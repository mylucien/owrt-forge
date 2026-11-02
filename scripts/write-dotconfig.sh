#!/usr/bin/env bash
set -euo pipefail
: "${HAS_DOTCONFIG:?}"
touch /tmp/build-notes
# 写进构建说明（页面上展示），同时打到日志 —— 否则日志里看不到自动补了什么
note() { printf '%s\n' "$*" >> /tmp/build-notes; printf '%s\n' "$*"; }
NPKG=$(jq '(.packages // []) | length' config.json)
T=$(jq -r '.target // ""' config.json)

# ---------------------------------------------------------------------------
# 源码仓库自带的发行版默认配置（与 gen-config.sh 同一套查找规则）
# ---------------------------------------------------------------------------
SEEDS=()
if [ -n "$T" ] && [ "$T" != "/" ]; then
  m="${T%%/*}"; s="${T##*/}"
  for f in "openwrt/configs/${s}.config" "openwrt/configs/${m}_${s}.config" "openwrt/configs/release.config"; do
    [ -f "$f" ] && SEEDS+=("$f") || true
  done
fi

# 摘掉多设备模式的开关和其他机型的 DEVICE_=y。MULTI_PROFILE 开着会把 choice 里选的机型
# 清掉（构建时该机型 install-disabled，不出镜像）；PER_DEVICE_ROOTFS 在 Kconfig 里
# depends on MULTI_PROFILE，单选模式本来就开不了。单选 choice 已无条件 select target 默认包
# 和机型 DEVICE_PACKAGES，不靠这两个开关。详见 gen-config.sh 同名函数上方。
seed_strip() {
  grep -vE '^[[:space:]]*#?[[:space:]]*CONFIG_TARGET_(MULTI_PROFILE|ALL_PROFILES|PER_DEVICE_ROOTFS)([= ]|$)' \
  | grep -vE '^[[:space:]]*#?[[:space:]]*CONFIG_TARGET_([A-Za-z0-9_]+_)?DEVICE_' \
  | grep -vE '^[[:space:]]*#?[[:space:]]*CONFIG_TARGET_DEVICE_PACKAGES_'
}

if [ "$HAS_DOTCONFIG" = "true" ]; then
  SNAP_N=$(jq -r .dotconfig_snapshot config.json | grep -c "^CONFIG_" || true)

  if [ ${#SEEDS[@]} -gt 0 ]; then
    # 底稿优先，但先铺源码默认配置兜底：底稿里没提到的符号由源码默认值补上，
    # 底稿里明确写了的（含 "# ... is not set"）后写覆盖先写，仍然是底稿说了算。
    # 否则上传一份不完整的底稿，源码新增的包会被静默丢掉（例：ponwrt 的 PON 前端驱动）。
    cat "${SEEDS[@]}" | seed_strip > openwrt/.config || true
    jq -r .dotconfig_snapshot config.json >> openwrt/.config
    note "配置来源：源码默认配置（${SEEDS[*]}）+ 固定底稿（${SNAP_N} 项），底稿优先"
  else
    # 固定了配置底稿且源码没有 configs/：原样使用该版本
    jq -r .dotconfig_snapshot config.json > openwrt/.config
    note "配置来源：固定底稿（${SNAP_N} 项），源码仓库没有 configs/*.config，未做兜底"
  fi

  (cd openwrt && make defconfig)

  # 机型自己声明的包必须都在配置里。原理见 gen-config.sh 里同名函数上方的注释：
  # 底稿里一行 PACKAGE_x=m 会压掉 kconfig 的 "default y if DEFAULT_x"，而 =m 只编
  # ipk、不进固件 —— ponwrt 的 kmod-airoha-en7572 就是这样丢的，编译不报错、PON
  # 永远起不来。这里在 openwrt/ 里跑，逻辑与 gen-config.sh 完全一致（含同类替代检查）。
  P=$(jq -r '.profile // ""' config.json)
  (
    cd openwrt
    declare -A DECL=()
    profile_pkgs() {
      [ -n "$P" ] || return 0
      [ -f tmp/.targetinfo ] || return 0
      awk -v id="DEVICE_$P" '
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
    [ -n "$P" ] && [ -f tmp/.targetinfo ] || exit 0
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
      note "机型 $P 声明、底稿里却没有的包：${add# } → 补成 =y 后重新 defconfig"
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
      { echo "机型 $P 声明的驱动没能生效：${drv# }"
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
  # 同一个符号在合并结果里可能出现多次（seed 一次、底稿一次），以最后一行为准。
  if [ ${#SEEDS[@]} -gt 0 ]; then
    pkg_on() {
      local l
      l=$(grep -E "^# CONFIG_PACKAGE_${1} is not set$|^CONFIG_PACKAGE_${1}=[ym]$" openwrt/.config | tail -n1)
      case "$l" in *"=y") return 0 ;; *) return 1 ;; esac
    }
    LOST=""
    for p in $(cat "${SEEDS[@]}" | sed -n 's/^CONFIG_PACKAGE_\([A-Za-z0-9_.+-]*\)=y$/\1/p' | sort -u); do
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
elif [ "$(jq '(.packages // []) | length' config.json)" -gt 0 ] || [ -n "$(jq -r '.profile // ""' config.json)" ]; then
  note "配置来源：按模板的机型和 ${NPKG} 个插件清单生成"
  bash "$SCRIPTS_DIR/gen-config.sh"
fi
