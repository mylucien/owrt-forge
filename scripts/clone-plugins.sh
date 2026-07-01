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
    # 会跟下面 printf 的两行结果混在一起，导致调用方用 sed 按行取值时整体错位一行。
    echo "::add-mask::${token}" >&2
  fi

  printf '%s\n%s\n' "$clean_url" "$token"
}

# 用 HTTP header 方式鉴权做克隆。
# 使用 Bearer 认证（GitHub 明确推荐，无需 base64 编码，更简洁）。
# git clone 命令行上的 `-c http.extraheader=...` 只对这一次 clone 请求生效，
# 不会被自动写进新仓库的 .git/config。
# 而稀疏/部分克隆后 git sparse-checkout set 触发的二次 fetch 是独立的 git 进程，
# 不会继承那个一次性 -c 参数——所以克隆完之后额外用一条独立的 git config 命令
# 把凭据显式落进这份克隆的本地配置，让后续 git 操作都能自动复用。
authed_clone() {
  local clean_url="$1" token="$2" target="$3"; shift 3
  local extra_header=()

  if [ -n "$token" ]; then
    extra_header=(-c "http.extraheader=Authorization: Bearer ${token}")
  fi

  git "${extra_header[@]}" clone "$@" "$clean_url" "$target"

  if [ -n "$token" ]; then
    # 显式落盘进这份克隆自己的 .git/config，供后续（如 sparse-checkout
    # 触发的二次 fetch）同仓库内的 git 操作自动复用，直到这份克隆整个
    # 被删除（sparse 场景删临时目录，full 场景删 .git）为止。
    git -C "$target" config http.extraheader "Authorization: Bearer ${token}"
  fi
}

git_sparse_clone() {
  local branch="$1" clean_url="$2" token="$3"; shift 3
  # "$@" 此后为 dirs 数组
  local repodir
  repodir=$(basename "$clean_url")

  authed_clone "$clean_url" "$token" "$repodir" \
    --depth=1 -b "$branch" --single-branch --filter=blob:none --sparse

  # 用子 shell 隔离 cd，确保任何步骤失败时不影响外层工作目录
  (
    cd "$repodir"
    git sparse-checkout set "$@"
    mv -f "$@" ../package/
  )

  # 临时克隆目录（含 .git、含刚才显式写入的凭据配置）整个删掉
  rm -rf "$repodir"
}

mkdir -p openwrt/package
cd openwrt

while read -r p; do
  raw_url=$(printf '%s\n' "$p" | jq -r .git_url)
  raw_token=$(printf '%s\n' "$p" | jq -r '.token // ""')

  # 只调用一次 resolve_auth，避免重复触发 ::add-mask::；
  # 用换行分隔取回 clean_url / token，规避 URL 或 token 本身含特殊字符时 IFS 拆分出错
  auth_result=$(resolve_auth "$raw_url" "$raw_token")
  clean_url=$(printf '%s\n' "$auth_result" | sed -n '1p')
  token=$(printf '%s\n' "$auth_result" | sed -n '2p')

  if [ "$(printf '%s\n' "$p" | jq -r .sparse)" = "true" ]; then
    # 用数组接收 dirs，避免目录名含空格时裸变量展开出错
    mapfile -t dirs < <(printf '%s\n' "$p" | jq -r '.dirs[]')
    git_sparse_clone "$(printf '%s\n' "$p" | jq -r .branch)" \
      "$clean_url" "$token" "${dirs[@]}"
  else
    name=$(printf '%s\n' "$p" | jq -r .name)
    authed_clone "$clean_url" "$token" "package/$name" --depth 1
    # 插件源码进 openwrt/package 只是为了参与编译，不需要 git 历史，
    # 顺手删掉 .git，既减小体积，也彻底断绝凭据残留磁盘的可能。
    rm -rf "package/$name/.git"
  fi
done < <(jq -c '.plugins[]' ../config.json)
