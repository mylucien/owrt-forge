#!/usr/bin/env bash
set -euo pipefail
: "${HAS_DOTCONFIG:?}"
touch /tmp/build-notes
NPKG=$(jq '(.packages // []) | length' config.json)
if [ "$HAS_DOTCONFIG" = "true" ]; then
  echo "配置来源：固定底稿（$(jq -r .dotconfig_snapshot config.json | grep -c "^CONFIG_" || true) 项），模板里的机型和 ${NPKG} 个插件清单没有叠加，以底稿为准" >> /tmp/build-notes
  # 固定了配置底稿：原样使用该版本，不再叠加机型和插件清单，避免旧选择里已去掉的插件残留
  jq -r .dotconfig_snapshot config.json > openwrt/.config
  (cd openwrt && make defconfig)
elif [ "$(jq '(.packages // []) | length' config.json)" -gt 0 ] || [ -n "$(jq -r '.profile // ""' config.json)" ]; then
  echo "配置来源：按模板的机型和 ${NPKG} 个插件清单生成" >> /tmp/build-notes
  bash "$SCRIPTS_DIR/gen-config.sh"
fi
