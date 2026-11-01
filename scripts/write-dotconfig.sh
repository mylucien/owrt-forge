#!/usr/bin/env bash
set -euo pipefail
: "${HAS_DOTCONFIG:?}"
touch /tmp/build-notes
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

# 摘掉"整包全设备"类选项：底稿是单机型的，不能让 seed 把整个 subtarget 的设备都打开
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
    echo "配置来源：源码默认配置（${SEEDS[*]}）+ 固定底稿（${SNAP_N} 项），底稿优先" >> /tmp/build-notes
  else
    # 固定了配置底稿且源码没有 configs/：原样使用该版本
    jq -r .dotconfig_snapshot config.json > openwrt/.config
    echo "配置来源：固定底稿（${SNAP_N} 项），源码仓库没有 configs/*.config，未做兜底" >> /tmp/build-notes
  fi

  (cd openwrt && make defconfig)

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
  echo "配置来源：按模板的机型和 ${NPKG} 个插件清单生成" >> /tmp/build-notes
  bash "$SCRIPTS_DIR/gen-config.sh"
fi
