#!/usr/bin/env bash
# 用途：根据 config.json 里的 plugins 列表克隆插件源码到 openwrt/package。
# 支持稀疏克隆（sparse: true 时只拉取指定子目录）。
#
# 用法：在仓库根目录下执行，config.json 与 openwrt/ 均位于当前目录。
set -euo pipefail

# 从 (url, token) 中解析出真正用于鉴权的 token 和一个不含凭据的干净 URL，
# 并立即向 Actions 注册打码，防止后面任何 echo/日志把它带出去。
resolve_auth() {
  local raw_url="$1" raw_token="$2"
  local token="$raw_token"
  local clean_url="$raw_url"

  # 兼容旧格式：git_url 里直接写 https://TOKEN@github.com/... 的情况
  if [ -z "$token" ] && [[ "$raw_url" =~ ^https://([^@/[:space:]]+)@(.+)$ ]]; then
    token="${BASH_REMATCH[1]}"
    clean_url="https://${BASH_REMATCH[2]}"
  fi

  if [ -n "$token" ]; then
    # GitHub Actions 的日志打码依赖运行时显式注册，
    # 只要 job 还没结束，同一 run 内这个字符串后续再出现也会被打成 ***
    echo "::add-mask::${token}"
  fi

  printf '%s\n%s\n' "$clean_url" "$token"
}

# 用 HTTP header 方式鉴权做克隆：令牌不会出现在 URL / 命令行参数里，
# 克隆完成后无论是否用了 header 都主动清掉，避免残留进 .git/config。
authed_clone() {
  local clean_url="$1" token="$2" target="$3"; shift 3
  local extra_header=()

  if [ -n "$token" ]; then
    local basic
    basic=$(printf '%s' "x-access-token:${token}" | base64 -w0)
    extra_header=(-c "http.extraheader=Authorization: Basic ${basic}")
  fi

  git "${extra_header[@]}" clone "$@" "$clean_url" "$target"

  # extraheader 有可能被 git clone 一并写进新仓库的本地配置，
  # 不管有没有用到都统一清一遍，杜绝凭据落地磁盘。
  git -C "$target" config --unset-all http.extraheader 2>/dev/null || true

  # 插件源码进 openwrt/package 只是为了参与编译，不需要 git 历史，
  # 顺手删掉 .git，既减小体积，也彻底断绝任何凭据残留的可能。
  rm -rf "$target/.git"
}

function git_sparse_clone() {
  local branch="$1" clean_url="$2" token="$3"; shift 3
  local repodir
  repodir=$(basename "$clean_url")

  authed_clone "$clean_url" "$token" "$repodir" \
    --depth=1 -b "$branch" --single-branch --filter=blob:none --sparse

  cd "$repodir" && git sparse-checkout set "$@"
  mv -f "$@" ../package/
  cd .. && rm -rf "$repodir"
}

mkdir -p openwrt/package
cd openwrt

jq -c '.plugins[]' ../config.json | while read -r p; do
  raw_url=$(echo "$p" | jq -r .git_url)
  raw_token=$(echo "$p" | jq -r '.token // ""')

  # 只调用一次 resolve_auth，避免重复触发 ::add-mask::；
  # 用换行分隔取回 clean_url / token，规避 URL 或 token 本身含特殊字符时 IFS 拆分出错
  auth_result=$(resolve_auth "$raw_url" "$raw_token")
  clean_url=$(echo "$auth_result" | sed -n '1p')
  token=$(echo "$auth_result" | sed -n '2p')

  if [ "$(echo "$p" | jq -r .sparse)" = "true" ]; then
    dirs=$(echo "$p" | jq -r '.dirs[]' | tr '\n' ' ')
    git_sparse_clone "$(echo "$p" | jq -r .branch)" "$clean_url" "$token" $dirs
  else
    name=$(echo "$p" | jq -r .name)
    authed_clone "$clean_url" "$token" "package/$name" --depth 1
  fi
done
