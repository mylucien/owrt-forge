#!/usr/bin/env bash
set -euo pipefail

resolve_auth() {
  local raw_url="$1" raw_token="$2"
  local token="$raw_token"
  local clean_url="$raw_url"

  # 兼容 URL 内嵌 token 的旧格式（classic PAT / fine-grained PAT 均支持）
  if [ -z "$token" ] && [[ "$raw_url" =~ ^https://([^@/[:space:]]+)@(.+)$ ]]; then
    token="${BASH_REMATCH[1]}"
    clean_url="https://${BASH_REMATCH[2]}"
  fi

  # 统一补全 .git 后缀
  [[ "$clean_url" != *.git ]] && clean_url="${clean_url}.git"

  if [ -n "$token" ]; then
    echo "::add-mask::${token}" >&2
  fi

  printf '%s\n%s\n' "$clean_url" "$token"
}

authed_clone() {
  local clean_url="$1" token="$2" target="$3"; shift 3

  if [ -n "$token" ]; then
    # fine-grained PAT 只支持 Bearer，不支持 Basic Auth / URL 内嵌
    # 用 git -c 直接传 extraheader，避免环境变量方式的兼容性问题
    git \
      -c "http.extraheader=Authorization: Bearer ${token}" \
      clone "$@" "$clean_url" "$target"

    # 写入克隆仓库自己的 .git/config，供后续二次 fetch 使用
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
    git \
      -c "http.extraheader=Authorization: Bearer ${token}" \
      clone \
      --depth=1 -b "$branch" --single-branch --filter=blob:none --sparse \
      "$clean_url" "$repodir"

    # 必须在 sparse-checkout set 之前写入，供二次 fetch 使用
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

  # 整个临时目录删掉，含 .git/config 里的凭据
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
