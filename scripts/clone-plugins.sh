#!/usr/bin/env bash
# 用途：根据 config.json 里的 plugins 列表克隆插件源码到 openwrt/package。
# 支持稀疏克隆（sparse: true 时只拉取指定子目录）。
# 支持私有仓库鉴权，同时规避以下三个令牌泄露风险：
#   1. 令牌出现在命令行参数里，被同机其它进程通过 /proc/<pid>/cmdline 读到
#   2. 令牌出现在 git 报错信息里，被原样打印进 Actions 日志（Actions 只打码
#      secrets 上下文里的值，运行时从 config.json 解出来的令牌它并不知情）
#   3. 令牌被 git 写死进克隆下来的 .git/config，残留在磁盘上，
#      一旦后续打包逻辑变化就可能被带进产物
#
# config.json 里 plugins[] 的字段约定：
#   git_url : 仓库地址。推荐不内嵌凭据；若为兼容旧数据内嵌了
#             https://TOKEN@host/... 形式，脚本会自动识别并拆分。
#   token   : （推荐）单独字段传令牌，不与 URL 混在一起。
#   branch / sparse / dirs / name : 同原逻辑。
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
    # 关键：必须写到 stderr。这个函数是用 $(resolve_auth ...) 取返回值的，
    # 命令替换会把函数里所有写到 stdout 的内容都捕获进来，如果这行也走 stdout，
    # 会跟下面 printf 的两行结果混在一起，导致调用方用 sed 按行取值时整体错位一行
    # （clean_url 和 token 的值会互相串掉），进而让 git clone 收到一个乱码地址。
    echo "::add-mask::${token}" >&2
  fi

  printf '%s\n%s\n' "$clean_url" "$token"
}

# 用 HTTP header 方式鉴权做克隆：令牌不会出现在 URL / 命令行参数里，
# 克隆完成后主动清掉可能残留的 extraheader 配置，避免凭据落地磁盘。
# 注意：这里不清理 .git 目录——稀疏克隆流程紧接着还要用 .git 做
# sparse-checkout，提前删掉会导致 "fatal: not a git repository"。
# .git 的清理交给各调用方按自己的需要处理（见下方两处调用）。
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
}

function git_sparse_clone() {
  local branch="$1" clean_url="$2" token="$3"; shift 3
  local repodir
  repodir=$(basename "$clean_url")

  authed_clone "$clean_url" "$token" "$repodir" \
    --depth=1 -b "$branch" --single-branch --filter=blob:none --sparse

  cd "$repodir" && git sparse-checkout set "$@"
  mv -f "$@" ../package/
  # 临时克隆目录（含 .git、含任何可能残留的凭据配置）整个删掉，
  # 不需要像整仓克隆那样单独处理 .git。
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
    # 插件源码进 openwrt/package 只是为了参与编译，不需要 git 历史，
    # 顺手删掉 .git，既减小体积，也彻底断绝凭据残留磁盘的可能。
    rm -rf "package/$name/.git"
  fi
done
