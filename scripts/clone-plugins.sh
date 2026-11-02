#!/usr/bin/env bash
set -euo pipefail

# 绝不等待输入：Actions 没有 TTY，git 想要凭据时只会抛
# "could not read Username for 'https://github.com': No such device or address"，
# 看不出是哪个仓库、为什么失败。
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/echo
export GIT_SSH_COMMAND="ssh -i ${HOME}/.ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o BatchMode=yes"

ROOT="$PWD"; mkdir -p openwrt/package
NAME_RE='^[A-Za-z0-9_.+-]+$'
URL_RE='^(https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/%+@-]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/+-]+)$'
DIR_RE='^[A-Za-z0-9._+/-]+$'

# 私有仓库：PLUGIN_GIT_TOKEN 走 https 认证。写进 ~/.gitconfig 而不是 URL，
# 免得 token 出现在日志和进程列表里；退出时清掉（后面 make 会执行第三方插件代码）。
if [ -n "${PLUGIN_GIT_TOKEN:-}" ]; then
  _b64=$(printf 'x-access-token:%s' "$PLUGIN_GIT_TOKEN" | base64 | tr -d '\n')
  git config --global "http.https://github.com/.extraheader" "AUTHORIZATION: basic ${_b64}"
  unset _b64
  echo "已启用 PLUGIN_GIT_TOKEN（私有插件仓库通过 https 认证）"
fi
cleanup_auth() {
  git config --global --unset-all "http.https://github.com/.extraheader" >/dev/null 2>&1 || true
}
trap cleanup_auth EXIT

FAILED=()

# 日志里不打印 https://user:token@host 的 userinfo 部分
redact() {
  if [ "$#" -gt 0 ]; then
    printf '%s' "$1" | sed -E 's#(https://)[^/@[:space:]]+@#\1***@#g'
  else
    sed -E 's#(https://)[^/@[:space:]]+@#\1***@#g'
  fi
}

https_to_ssh() {
  case "$1" in
    https://github.com/*)
      local p="${1#https://github.com/}"
      printf 'git@github.com:%s.git' "${p%.git}"
      ;;
    *) return 1 ;;
  esac
}

# 先按配置里的地址克隆；https 失败且本机有部署密钥时，自动换成 SSH 再试一次
# —— 常见情况就是把私有仓库写成了 https://…，而 workflow 只注入了 SSH_PRIVATE_KEY。
clone_repo() { # $1=name $2=url $3=dest $4=branch(可空) $5=full|sparse
  local name="$1" url="$2" dest="$3" branch="${4:-}" mode="${5:-full}"
  local -a opts=()
  [ -n "$branch" ] && opts+=(-b "$branch")
  if [ "$mode" = "sparse" ]; then
    opts+=(--depth=1 --single-branch --filter=blob:none --sparse)
  else
    opts+=(--depth 1)
  fi

  local err="" rc=0 alt=""
  err=$(git clone "${opts[@]}" -- "$url" "$dest" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then return 0; fi

  if alt=$(https_to_ssh "$url") && [ -f "${HOME}/.ssh/id_ed25519" ]; then
    echo "  https 克隆失败（rc=${rc}），改用 SSH 重试：${alt}" >&2
    rm -rf "$dest"
    rc=0
    err=$(git clone "${opts[@]}" -- "$alt" "$dest" 2>&1) || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "  SSH 重试成功" >&2
      return 0
    fi
  fi

  echo "::error::插件仓库克隆失败：${name} <- $(redact "$url")"
  echo "  git: $(printf '%s' "$err" | redact | tail -n 3 | tr '\n' ' ' | cut -c1-300)" >&2
  echo "  检查：地址是否拼错、仓库是否公开可读${branch:+、分支 ${branch} 是否存在}；" >&2
  echo "        私有仓库请用 git@github.com:owner/repo.git + SSH_PRIVATE_KEY，或配置 PLUGIN_GIT_TOKEN" >&2
  return 1
}

# 很多 luci 应用的 Makefile 写的是 `include ../../luci.mk`（相对 luci feed 的位置），放进 package/ 后找不到，
# 整个包会被 OpenWrt 扫描时悄悄丢掉。统一改成不依赖位置的写法。
fix_luci_include() {
  find "$1" -name Makefile -print0 2>/dev/null | while IFS= read -r -d '' f; do
    if grep -qE 'include[[:space:]]+(\.\./)+luci\.mk' "$f"; then
      sed -i -E 's#include[[:space:]]+(\.\./)+luci\.mk#include $(TOPDIR)/feeds/luci/luci.mk#' "$f"
      echo "已修正 luci.mk 相对路径：${f#"$ROOT"/openwrt/}"
    fi
  done
}

while IFS= read -r p; do
  name=$(jq -r .name <<<"$p")
  [[ "$name" =~ $NAME_RE ]] || { echo "::error::插件目录名非法: $name"; exit 1; }
  # feed 类插件（如 iStore）：追加到 feeds.conf.default 并单独更新，之后由 feeds install -a 安装
  feed=$(jq -r '.feed // empty' <<<"$p")
  if [ -n "$feed" ]; then
    [[ "$feed" =~ ^src-(git|git-full|link)\ [A-Za-z0-9_.-]+\ https://[^[:space:]]+$ ]] || { echo "::error::feed 行格式非法: $feed"; exit 1; }
    echo "[feed] $name: $feed"
    echo "$feed" >> "$ROOT/openwrt/feeds.conf.default"
    if ! (cd "$ROOT/openwrt" && ./scripts/feeds update "$name"); then
      echo "::error::feed 更新失败：$name <- $feed"
      FAILED+=("$name")
    fi
    continue
  fi

  url=$(jq -r .git_url <<<"$p"); branch=$(jq -r '.branch // ""' <<<"$p")
  [[ "$url" =~ $URL_RE ]] || { echo "::error::插件仓库地址非法: $(redact "$url")（不要把 token 写进地址，改用 PLUGIN_GIT_TOKEN）"; exit 1; }
  # 分支可为空（使用仓库默认分支）；整仓克隆和稀疏克隆都会用到
  echo "[插件] $name <- $(redact "$url")${branch:+ (分支 $branch)}"
  if [ "$(jq -r '.sparse // false' <<<"$p")" = "true" ]; then
    # url 以 .git 结尾时 basename 与 git clone 生成的目录名不一致，所以统一克隆到固定的 $tmp/r
    tmp=$(mktemp -d); mapfile -t dirs < <(jq -r '.dirs[]' <<<"$p")
    for d in "${dirs[@]}"; do [[ "$d" =~ $DIR_RE && "$d" != /* && "$d" != *..* ]] || { echo "::error::子目录非法: $d"; exit 1; }; done
    if ! clone_repo "$name" "$url" "$tmp/r" "$branch" sparse; then
      rm -rf "$tmp"; FAILED+=("$name"); continue
    fi
    if ! git -C "$tmp/r" sparse-checkout set "${dirs[@]}"; then
      echo "::error::稀疏目录在 ${name} 里不存在：${dirs[*]}"
      rm -rf "$tmp"; FAILED+=("$name"); continue
    fi
    # 同名的源码自带包会被这里的版本替换（直接 mv 到已存在的目录里会变成嵌套目录）
    for d in "${dirs[@]}"; do
      rm -rf "$ROOT/openwrt/package/$(basename "$d")"
      mv -f "$tmp/r/$d" "$ROOT/openwrt/package/$(basename "$d")"
      fix_luci_include "$ROOT/openwrt/package/$(basename "$d")"
    done
    rm -rf "$tmp"
  else
    rm -rf "$ROOT/openwrt/package/$name"
    if ! clone_repo "$name" "$url" "$ROOT/openwrt/package/$name" "$branch" full; then
      FAILED+=("$name"); continue
    fi
    fix_luci_include "$ROOT/openwrt/package/$name"
  fi
done < <(jq -c '.plugins[]?' config.json)

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "::error::${#FAILED[@]} 个插件没能拉取：${FAILED[*]}（已中止，避免固件静默少插件）"
  exit 1
fi
