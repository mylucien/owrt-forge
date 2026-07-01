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
    echo "::add-mask::${token}" >&2
  fi

  printf '%s\n%s\n' "$clean_url" "$token"
}

authed_clone() {
  local clean_url="$1" token="$2" target="$3"; shift 3

  echo "DEBUG clean_url: $clean_url"
  echo "DEBUG token length: ${#token}"

  if [ -n "$token" ]; then
    echo "DEBUG: using auth header"
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0="http.extraheader" \
    GIT_CONFIG_VALUE_0="Authorization: Bearer ${token}" \
    git clone "$@" "$clean_url" "$target"

    git -C "$target" config http.extraheader "Authorization: Bearer ${token}"
  else
    echo "DEBUG: no token, cloning without auth"
    git clone "$@" "$clean_url" "$target"
  fi
}

git_sparse_clone() {
  local branch="$1" clean_url="$2" token="$3"; shift 3
  local repodir
  repodir=$(basename "$clean_url" .git)

  authed_clone "$clean_url" "$token" "$repodir" \
    --depth=1 -b "$branch" --single-branch --filter=blob:none --sparse

  (
    cd "$repodir"
    git sparse-checkout set "$@"
    mv -f "$@" ../package/
  )

  rm -rf "$repodir"
}

mkdir -p openwrt/package
cd openwrt

while read -r p; do
  raw_url=$(printf '%s\n' "$p" | jq -r .git_url)
  raw_token=$(printf '%s\n' "$p" | jq -r '.token // ""')

  echo "DEBUG raw_url: $raw_url"
  echo "DEBUG raw_token length: ${#raw_token}"

  auth_result=$(resolve_auth "$raw_url" "$raw_token")

  echo "DEBUG auth_result line count: $(printf '%s\n' "$auth_result" | wc -l)"

  clean_url=$(printf '%s\n' "$auth_result" | sed -n '1p')
  token=$(printf '%s\n' "$auth_result" | sed -n '2p')

  echo "DEBUG extracted clean_url: $clean_url"
  echo "DEBUG extracted token length: ${#token}"

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
