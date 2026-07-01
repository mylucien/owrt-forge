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

  if [ -n "$token" ]; then
    # 用 credential helper 方式注入，彻底绕开命令行参数和环境变量的限制。
    # git 在需要凭据时会调用 helper 脚本，脚本直接输出 username/password，
    # 不经过命令行参数，不会出现在 /proc/<pid>/cmdline，也不受 git 版本影响。
    local helper_script
    helper_script=$(mktemp)
    chmod +x "$helper_script"
    # printf 而不是 echo，避免内容含特殊字符时出问题
    printf '#!/bin/sh\nprintf "username=x-access-token\\npassword=%s\\n" "%s"\n' "$token" "$token" > "$helper_script"

    git -c "credential.helper=${helper_script}" clone "$@" "$clean_url" "$target"

    # 清理 helper 脚本，token 不落盘残留
    rm -f "$helper_script"

    # .git/config 里写入同样的 helper，供 sparse-checkout 触发的二次 fetch 使用；
    # 注意这里写的是 helper 路径已经被删掉了，所以改为直接写 extraheader
    git -C "$target" config http.extraheader "Authorization: Bearer ${token}"
  else
    git clone "$@" "$clean_url" "$target"
  fi
}

git_sparse_clone() {
  local branch="$1" clean_url="$2" token="$3"; shift 3
  local repodir
  repodir=$(basename "$clean_url" .git)

  local helper_script=""
  if [ -n "$token" ]; then
    helper_script=$(mktemp)
    chmod +x "$helper_script"
    printf '#!/bin/sh\nprintf "username=x-access-token\\npassword=%s\\n" "%s"\n' "$token" "$token" > "$helper_script"
  fi

  if [ -n "$helper_script" ]; then
    git -c "credential.helper=${helper_script}" clone \
      --depth=1 -b "$branch" --single-branch --filter=blob:none --sparse \
      "$clean_url" "$repodir"
    rm -f "$helper_script"
    # 二次 fetch 用 extraheader
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
