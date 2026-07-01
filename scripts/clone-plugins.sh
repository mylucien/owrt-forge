#!/usr/bin/env bash
set -euo pipefail

resolve_auth() {
  local raw_url="$1" raw_token="$2"
  local token="$raw_token"
  local clean_url="$raw_url"

  # 兼容旧格式：token 内嵌在 URL 里
  if [ -z "$token" ] && [[ "$raw_url" =~ ^https://([^@/[:space:]]+)@(.+)$ ]]; then
    token="${BASH_REMATCH[1]}"
    clean_url="https://${BASH_REMATCH[2]}"
  fi

  # 统一补全 .git 后缀
  [[ "$clean_url" != *.git ]] && clean_url="${clean_url}.git"

  if [ -n "$token" ]; then
    # 注册打码，后续日志中该字符串一律显示为 ***
    echo "::add-mask::${token}" >&2
  fi

  printf '%s\n%s\n' "$clean_url" "$token"
}

authed_clone() {
  local clean_url="$1" token="$2" target="$3"; shift 3

  if [ -n "$token" ]; then
    # 把 token 内嵌进 URL，这是 git 最兼容的鉴权方式
    # ::add-mask:: 已注册，日志里 token 会被打成 ***
    local authed_url
    authed_url="${clean_url/https:\/\//https://x-access-token:${token}@}"
    git clone "$@" "$authed_url" "$target"

    # 供后续同目录 git 操作（sparse 二次 fetch）使用，clone 完再写，不影响克隆本身
    git -C "$target" config http.extraheader "Authorization: Bearer ${token}"
  else
    git clone "$@" "$clean_url" "$target"
  fi
}

git_sparse_clone() {
  local branch="$1" clean_url="$2" token="$3"; shift 3
  local repodir
  repodir=$(basename "$clean_url" .git)

  if [ -n "$token" ]; then
    local authed_url
    authed_url="${clean_url/https:\/\//https://x-access-token:${token}@}"
    git clone \
      --depth=1 -b "$branch" --single-branch --filter=blob:none --sparse \
      "$authed_url" "$repodir"
    # 写入 extraheader，供 sparse-checkout set 触发的二次 fetch 使用
    git -C "$repodir" config http.extraheader "Authorization: Bearer ${token}"
  else
    git clone \
      --depth=1 -b "$branch" --single-branch --filter=blob:none --sparse \
      "$clean_url" "$repodir"
  fi

  (
    cd "$repodir"
    git sparse-checkout set "$@"
    mv -f "$@" ../package/
  )

  # 临时目录含 .git（含凭据配置）整个删掉，不残留
  rm -rf "$repodir"
}

mkdir -p openwrt/package
cd openwrt

while read -r p; do
  raw_url=$(printf '%s\n' "$p" | jq -r .git_url)
  raw_token=$(printf '%s\n' "$p" | jq -r '.token // ""')

  auth_result=$(resolve_auth "$raw_url" "$raw_token")
  clean_url=$(printf '%s\n' "$auth_result" | sed -n '1p')
  token=$(printf '%s\n' "$auth_result" | sed -n '2p')

  if [ "$(printf '%s\n' "$p" | jq -r .sparse)" = "true" ]; then
    mapfile -t dirs < <(printf '%s\n' "$p" | jq -r '.dirs[]')
    git_sparse_clone "$(printf '%s\n' "$p" | jq -r .branch)" \
      "$clean_url" "$token" "${dirs[@]}"
  else
    name=$(printf '%s\n' "$p" | jq -r .name)
    authed_clone "$clean_url" "$token" "package/$name" --depth 1
    rm -rf "package/$name/.git"
  fi
done < <(jq -c '.plugins[]' ../config.json)
