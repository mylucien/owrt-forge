#!/usr/bin/env bash
# 用途：根据 config.json 里的 plugins 列表克隆插件源码到 openwrt/package。
# 支持 HTTPS 公共库和 SSH 私有库。
# 支持稀疏克隆（sparse: true 时只拉取指定子目录）。
#
# 用法：在仓库根目录下执行，config.json 与 openwrt/ 均位于当前目录。
set -euo pipefail

# --- 新增配置：指定 Git 使用 SSH 私钥 ---
export GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=no"
# ---------------------------------------

function git_sparse_clone() {
  branch="$1" repourl="$2" && shift 2
  git clone --depth=1 -b "$branch" --single-branch \
    --filter=blob:none --sparse "$repourl"
  repodir=$(basename "$repourl")
  cd "$repodir" && git sparse-checkout set "$@"
  mv -f "$@" ../package/
  cd .. && rm -rf "$repodir"
}

mkdir -p openwrt/package
cd openwrt

jq -c '.plugins[]' ../config.json | while read -r p; do
  url=$(echo "$p" | jq -r .git_url)
  
  if [ "$(echo "$p" | jq -r .sparse)" = "true" ]; then
    # 稀疏克隆逻辑
    dirs=$(echo "$p" | jq -r '.dirs[]' | tr '\n' ' ')
    git_sparse_clone "$(echo "$p" | jq -r .branch)" "$url" $dirs
  else
    # 完整克隆逻辑（支持私有库）
    name=$(echo "$p" | jq -r .name)
    git clone --depth 1 "$url" "package/$name"
  fi
done
