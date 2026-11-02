#!/usr/bin/env bash
# 由「机型 + 插件清单」生成 .config，分四步：
#   ⓪ 铺上源码仓库自带的发行版默认配置（configs/<subtarget>.config 等），
#      这类文件里放的往往是发行版"额外补充"的包（例：ponwrt 的整条 PON 栈），
#      官方构建用 scripts/kconfig.pl + 合并，这里不合并就会丢
#   ① 再写目标平台和机型 → make defconfig → 得到该机型的默认配置，并确认机型真的生效
#   ①b 核对机型自己声明的 DEVICE_PACKAGES：驱动类没进 .config 就补成 =y，
#      补不上直接失败（=m 的包不会装进固件，光看编译成功发现不了）
#   ② 再追加所选插件 → make defconfig → 逐个确认插件真的生效
# 机型不存在、或有插件没生效（依赖缺失 / 源码里没有这个包），直接失败并说明原因，
# 不会等编译几个小时后才发现固件里少了东西。
# 固定了配置底稿的任务不会走到这里（见 write-dotconfig.sh）。
set -euo pipefail
cd openwrt
T=$(jq -r '.target // ""' ../config.json)    # 例 mediatek/filogic、x86/64
P=$(jq -r '.profile // ""' ../config.json)   # 例 cmcc_rax3000m、generic
: > /tmp/missing-packages
: > /tmp/config-error
: > /tmp/defconfig.log
: > /tmp/gate-hints
# 写进构建说明（页面上展示），同时打到日志 —— 否则日志里看不到自动补了什么
note() { printf '%s\n' "$*" >> /tmp/build-notes; printf '%s\n' "$*"; }

# target/profile 会被写进 .config，必须严格校验，防止注入额外的配置行
if [ -n "$P" ]; then
  [[ "$P" =~ ^[A-Za-z0-9_.+-]+$ ]] || { echo "::error::profile 格式非法: $P"; exit 1; }
  [[ "$T" =~ ^[A-Za-z0-9_+-][A-Za-z0-9_.+-]*/[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$ ]] || { echo "::error::target 格式非法: $T"; exit 1; }
fi

m="${T%%/*}"; s="${T##*/}"

# ---------------------------------------------------------------------------
# 源码仓库自带的发行版默认配置
#
# 很多发行版（ponwrt、immortalwrt 衍生分支等）把"本发行版默认启用"的包放在 configs/ 下，
# 官方构建流程是：
#     ./scripts/kconfig.pl + "configs/<subtarget>.config" configs/release.config > .config
#     make defconfig
# 这些包大多不在 target.mk 的 DEFAULT_PACKAGES 里（ponwrt 的 kmod-airoha-xpon、
# kmod-airoha-pon-frontend、kmod-airoha-en7572、airoha-pond 就是这样），
# 只写机型再 defconfig 是拿不到的，固件里会静默少掉一层驱动。
# 找不到 configs/ 就当普通 OpenWrt 处理，行为与原来完全一致。
# ---------------------------------------------------------------------------
SEEDS=()
if [ -n "$T" ]; then
  for f in "configs/${s}.config" "configs/${m}_${s}.config" "configs/${s}_${P}.config" "configs/${P}.config"; do
    [ -n "$P" ] || continue
    [ -f "$f" ] && SEEDS+=("$f") || true
  done
  # 没有 profile（进 menuconfig 的流程）时，按 subtarget 命名找
  if [ -z "$P" ] && [ -f "configs/${s}.config" ]; then SEEDS+=("configs/${s}.config"); fi
fi
[ -f configs/release.config ] && SEEDS+=("configs/release.config") || true

# 合并前摘掉多设备模式的两个开关，以及其他机型的 DEVICE_=y。别以为"开着只是编得慢"，
# 实测（ponwrt an7581，OpenWrt 24.10 同款 kconfig）：
#   TARGET_MULTI_PROFILE  开=切到"勾多个设备"的菜单，defconfig 会把 choice 里选中的机型清成
#                         is not set；构建时 _PROFILE_SET 为空 → 该机型 install-disabled，
#                         编译"成功"却不出镜像，比编多了更糟。
#   TARGET_PER_DEVICE_ROOTFS  Kconfig 里 depends on TARGET_MULTI_PROFILE，单选机型下想开也开不了；
#                         它只为多设备构建给每台机器单独一份 rootfs，这里不需要。
# 单选机型的 choice 本身会无条件 select target 的 DEFAULT_PACKAGES 和机型的 DEVICE_PACKAGES，
# 所以不开 per-device rootfs 也不缺包（空 seed 实测：17 个机型包 + 基础包全 =y）。
seed_strip() {
  grep -vE '^[[:space:]]*#?[[:space:]]*CONFIG_TARGET_(MULTI_PROFILE|ALL_PROFILES|PER_DEVICE_ROOTFS)([= ]|$)' \
  | grep -vE '^[[:space:]]*#?[[:space:]]*CONFIG_TARGET_([A-Za-z0-9_]+_)?DEVICE_' \
  | grep -vE '^[[:space:]]*#?[[:space:]]*CONFIG_TARGET_DEVICE_PACKAGES_'
}

# 不叠加任何旧配置：源码默认配置 + 模板里的机型和插件清单就是唯一来源
rm -f .config

if [ ${#SEEDS[@]} -gt 0 ]; then
  cat "${SEEDS[@]}" | seed_strip >> .config || true
  note "已合并源码默认配置：${SEEDS[*]}"
else
  echo "源码仓库没有匹配的 configs/*.config，只用机型默认配置"
fi

# ---------------------------------------------------------------------------
# 机型声明的 DEVICE_PACKAGES 必须真的进镜像
#
# 选中 profile 后，target-metadata.pl 会对该机型的 DEVICE_PACKAGES 逐个
# select DEFAULT_x，而 .config-package.in 里 PACKAGE_x 的默认值就是
# "default y if DEFAULT_x"。问题在于默认值只在符号没被赋值时才生效：
# 源码 configs/*.config（或上传的底稿）里只要留着一行 PACKAGE_x=m，就把这个
# 默认值压死了。而 =m 在镜像构建里的意思是"编成 ipk 放进软件源，不装进固件"，
# 板子上就没有这个包。ponwrt 官方镜像缺 kmod-airoha-en7572 就是这么来的
# （configs/an7581.config 写的 =m），后果是光口永远 DOWN，内核只报
# "airoha-xpon: failed to obtain the optical frontend provider"。
#
# 所以这里以 tmp/.targetinfo 里机型自己声明的包为准（make 展开后的最终列表，
# 已经算过 += 和 -变体），缺的补成 =y 再 defconfig：驱动补不上直接失败，其余只
# 写进构建说明。唯一例外是被同类包顶替的（wpad-openssl 换成 wpad-basic 之类），
# 按 Provides 判断，尊重模板里的选择，不重复装。
# ---------------------------------------------------------------------------
declare -A DECL=()
profile_pkgs() {
  [ -n "${P:-}" ] || return 0
  [ -f tmp/.targetinfo ] || return 0
  awk -v id="DEVICE_$P" '
    /^Target-Profile:/ { cur = $2; next }
    cur == id && /^Target-Profile-Packages:/ {
      sub(/^[^:]*:[ \t]*/, ""); print; exit
    }' tmp/.targetinfo 2>/dev/null
}
declared_pkgs() {   # 按 Makefile 里 + / - 的写法算出机型的最终包集合
  local t
  DECL=()
  for t in $(profile_pkgs); do
    case "$t" in
      -*) unset "DECL[${t#-}]" ;;
      +*) DECL["${t#+}"]=1 ;;
      *@*|*:*|*'$'*) continue ;;
      *) [ -n "$t" ] && DECL["$t"]=1 ;;
    esac
  done
}
is_driver() { case "$1" in kmod-*|*-firmware) return 0 ;; *) return 1 ;; esac; }
# 包的 Provides（虚拟包名），wpad-openssl / wpad-basic-mbedtls 都 provides wpad
provides_of() {
  awk -v p="$1" '$0=="Package: "p{f=1; next}
    f && /^Provides:/ { sub(/^Provides:[ \t]*/, ""); print; exit }
    f && /^@@/ { exit }' tmp/.packageinfo 2>/dev/null
}
# 已经启用的包里，谁提供了同样的虚拟包（用来判断"用户是不是有意换成了同类包"）
enabled_provides_map() {
  awk 'FNR==NR {
         if ($0 ~ /^CONFIG_PACKAGE_[A-Za-z0-9_.+-]+=y$/) {
           n=$0; sub(/^CONFIG_PACKAGE_/, "", n); sub(/=y$/, "", n); EN[n]=1
         }
         next
       }
       /^Package: / { pkg=$2; next }
       /^Provides:/ { for (i=2; i<=NF; i++) if (pkg in EN) print $i, pkg }
      ' .config tmp/.packageinfo 2>/dev/null
}
# 若 $1 已被别的同类包顶替，输出顶替者并返回 0
substituted_by() {
  local v other
  for v in $(provides_of "$1"); do
    other=$(awk -v v="$v" -v q="$1" '$1==v && $2!=q { print $2; exit }' /tmp/enabled-provides 2>/dev/null)
    [ -n "$other" ] && { echo "$other"; return 0; }
  done
  return 1
}

enforce_device_packages() {
  local round p add skip drv other miss o off
  [ -n "${P:-}" ] || return 0
  if [ ! -f tmp/.targetinfo ]; then echo "没有 tmp/.targetinfo，跳过机型包核对"; return 0; fi
  declared_pkgs
  [ ${#DECL[@]} -gt 0 ] || return 0
  enabled_provides_map > /tmp/enabled-provides

  skip_all=""; off_all=""

  for round in 1 2; do
    add=""; skip=""; off=""
    for p in $(printf '%s\n' "${!DECL[@]}" | sort); do
      grep -q "^CONFIG_PACKAGE_${p}=y$" .config && continue
      if o=$(substituted_by "$p"); then skip="$skip $p→$o"; continue; fi
      # 配置里明确写了 "# ... is not set"：应用类尊重这个选择，驱动类照补（驱动缺了
      # 设备不工作，而且编译不报错，属于"看不见的缺"）
      if ! is_driver "$p" && grep -q "^# CONFIG_PACKAGE_${p} is not set$" .config; then
        off="$off $p"; continue
      fi
      add="$add $p"
    done
    if [ -n "${skip// /}" ]; then
      skip_all="$skip_all $skip"
    fi
    if [ -n "${off// /}" ]; then
      off_all="$off_all $off"
    fi
    [ -n "${add// /}" ] || break
    for p in $add; do printf 'CONFIG_PACKAGE_%s=y\n' "$p" >> .config; done
    note "机型 $P 声明、配置里却没有的包：${add# } → 补成 =y 后重新 defconfig"
    make defconfig 2>&1 | tee -a /tmp/defconfig.log
    enabled_provides_map > /tmp/enabled-provides
  done
  if [ -n "${skip_all// /}" ]; then
    note "机型声明的包已有同类替代，按配置里的选择保留：$(printf '%s\n' $skip_all | sort -u | paste -sd' ')"
  fi
  if [ -n "${off_all// /}" ]; then
    note "机型声明的应用在配置里被显式关掉，保持关闭：$(printf '%s\n' $off_all | sort -u | paste -sd' ')"
  fi

  drv=""; other=""
  for p in $(printf '%s\n' "${!DECL[@]}" | sort); do
    grep -q "^CONFIG_PACKAGE_${p}=y$" .config && continue
    substituted_by "$p" > /dev/null && continue
    if ! is_driver "$p" && grep -q "^# CONFIG_PACKAGE_${p} is not set$" .config; then continue; fi
    if is_driver "$p"; then drv="$drv $p"; else other="$other $p"; fi
  done
  if [ -n "${drv// /}" ]; then
    { echo "机型 $P 声明的驱动没能生效：${drv# }"
      echo "这些包在源码 configs/*.config 或上传底稿里被写成了 =m 或 n（=m 只编 ipk，不会装进固件），或者依赖不满足。"
      echo "把对应的行删掉或改成 =y 再编译；确实不需要，就改 target/linux/.../image 里这个机型的 DEVICE_PACKAGES。"
    } > /tmp/config-error
    echo "::error::$(head -n1 /tmp/config-error)"
    cat /tmp/config-error
    exit 1
  fi
  if [ -n "${other// /}" ]; then
    note "机型声明的应用没进配置：${other# }（有同类包顶替的已跳过，其余多为源码里条件不满足；驱动都在，不影响开机）"
  fi
}

if [ -n "$P" ]; then
  # 机型行写在最后：前面的 seed 里可能有同一个符号的相反取值，后写覆盖先写
  printf 'CONFIG_TARGET_%s=y\nCONFIG_TARGET_%s_%s=y\nCONFIG_TARGET_%s_%s_DEVICE_%s=y\n' "$m" "$m" "$s" "$m" "$s" "$P" >> .config
  make defconfig 2>&1 | tee -a /tmp/defconfig.log
  if ! grep -q "^CONFIG_TARGET_${m}_${s}_DEVICE_${P}=y" .config; then
    echo "机型 ${P} 在 ${T} 里不存在或没有生效。请回到模板页重新选择机型（源码版本可能改过机型名）。" | tee /tmp/config-error
    echo "::error::$(cat /tmp/config-error)"
    exit 1
  fi
  echo "已生成 ${T} / ${P} 的默认配置"

  # 根文件系统分区大小：整盘镜像类目标（x86、armsr、rockchip、sunxi、bcm27xx）的默认值很小（x86 只有 104MB），
  # 装几个 luci 应用就会在生成 root.ext4 时报 "failed to allocate N blocks, out of space"，这里提到 1024MB。
  # 路由器常见的闪存固件（mediatek、ramips、ath79、qualcommax 等）用不到这个选项，不改。想要别的大小改 ROOTFS_MB（单位 MB）。
  ROOTFS_MB=1024
  case "$m" in x86|armsr|rockchip|sunxi|bcm27xx)
    cur=$(sed -n 's/^CONFIG_TARGET_ROOTFS_PARTSIZE=//p' .config | head -n1)
    if [ -n "$cur" ] && [ "$cur" -lt "$ROOTFS_MB" ] 2>/dev/null; then
      sed -i "s/^CONFIG_TARGET_ROOTFS_PARTSIZE=.*/CONFIG_TARGET_ROOTFS_PARTSIZE=${ROOTFS_MB}/" .config
      echo "根文件系统分区 ${cur}MB → ${ROOTFS_MB}MB"
    fi ;;
  esac

  # 机型自己声明的驱动必须都在 .config 里（理由见上面的长注释）
  enforce_device_packages
fi

# 追加所选插件，再让源码补全依赖
jq -r '.packages[]? | select(test("^[A-Za-z0-9_.+-]+$")) | "CONFIG_PACKAGE_\(.)=y"' ../config.json >> .config
make defconfig 2>&1 | tee -a /tmp/defconfig.log

for p in $(jq -r '.packages[]?' ../config.json); do
  grep -q "^CONFIG_PACKAGE_${p}=y" .config || echo "$p" >> /tmp/missing-packages
done

# 逐个说明没生效的原因。以 OpenWrt 扫描出的 tmp/.packageinfo 为准：
#   · 包没被扫描出来 → Makefile 有问题（给出扫描日志）或包名不对
#   · 包被扫描出来了但没启用 → 顺着它的依赖往下查：哪个依赖在源码里不存在、哪个平台限制（@...）不满足
PKGINFO=tmp/.packageinfo
deps_of()    { awk -v p="$1" '$0=="Package: "p {f=1; next} f && /^Depends:/ {sub(/^Depends: */,""); print; exit} f && /^@@/ {exit}' "$PKGINFO"; }
pkg_known()  { grep -qxF "Package: $1" "$PKGINFO" || grep -qE "^Provides:.*(^|[[:space:]])$1([[:space:]]|$)" "$PKGINFO"; }
cfg_on()     { grep -qE "^CONFIG_$1=y" .config; }
# 打印 $1 的依赖里有问题的部分（没有问题则不输出）；$2 缩进；$3 剩余深度
explain() {
  local p="$1" ind="$2" depth="$3" tok n c neg out
  for tok in $(deps_of "$p"); do
    case "$tok" in
      @*)
        c="${tok#@}"; neg=""; case "$c" in '!'*) neg=1; c="${c#!}";; esac
        if [[ "$c" =~ ^[A-Za-z0-9_]+$ ]]; then
          if { [ -z "$neg" ] && ! cfg_on "$c"; } || { [ -n "$neg" ] && cfg_on "$c"; }; then
            echo "${ind}限制条件 ${tok} 不满足：这个包不支持当前平台或当前配置"
          fi
        else
          echo "${ind}限制条件 ${tok}（较复杂，请对照 Makefile 的 DEPENDS 核对）"
        fi ;;
      *)
        n="${tok#+}"
        [[ "$n" =~ ^[A-Za-z0-9_.+-]+$ ]] || continue          # 带条件的写法（+FOO:bar）无法静态判断，跳过
        case "$n" in libc|libgcc|libpthread|librt|libstdcpp|libatomic) continue;; esac
        if ! pkg_known "$n"; then
          echo "${ind}依赖 ${n}：源码和 feeds 里都没有这个包"
        elif [ "$depth" -gt 0 ]; then
          out=$(explain "$n" "${ind}    " $((depth - 1)))
          [ -n "$out" ] && { echo "${ind}依赖 ${n} 本身有问题："; echo "$out"; }
        fi ;;
    esac
  done
  return 0
}
# 打印 Kconfig 对这个包的真实判定：depends on / select 条件，以及条件里每个符号在 .config 里的当前值
kconfig_info() {
  local p="$1" l s v
  awk -v s="config PACKAGE_$p" '{l=$0; sub(/^[ \t]+/,"",l)} l==s{f=1;next} f&&(l==""||l~/^config /){exit} f&&l~/^(depends on|select|visible if)/{print l}' tmp/.config-package.in 2>/dev/null | while read -r l; do
    echo "    Kconfig：$l"
    case "$l" in "depends on"*)
      for s in $(echo "${l#depends on}" | sed -E 's/[()!&|<>=]+/ /g'); do
        [[ "$s" =~ ^[A-Za-z][A-Za-z0-9_.+-]*$ ]] || continue
        case "$s" in y|n|m) continue;; esac
        v=$(sed -n "s/^CONFIG_${s}=//p" .config | head -n1 || true)
        echo "        ${s} = ${v:-未设置(n)}"
        # 条件里要求另一个包必须启用（例：ponwrt 要求 libdrm / ffmpeg 的相关选项需要 PACKAGE_video-support）
        if [[ "$s" == PACKAGE_* ]] && { [ -z "$v" ] || [ "$v" = n ]; } && pkg_known "${s#PACKAGE_}"; then echo "${s#PACKAGE_}" >> /tmp/gate-hints; fi
      done ;;
    esac
  done || true
  grep -E "(^|[^A-Za-z0-9_-])(PACKAGE_)?${p}([^A-Za-z0-9_-]|$)" /tmp/defconfig.log 2>/dev/null | grep -iE "warn|error|unmet|override|invalid" | sort -u | head -n 5 | sed 's/^/    defconfig 输出：/' || true
  grep -nE "CONFIG_PACKAGE_${p}( |=)" .config 2>/dev/null | sed 's/^/    .config 里：/' || true
}
diagnose() {
  local p d names out dirs
  for p in $(cat /tmp/missing-packages); do
    if pkg_known "$p"; then
      echo "- ${p}：已被识别，但 defconfig 后没有启用。"
      out=$(explain "$p" "    " 3)
      if [ -n "$out" ]; then echo "$out"; else echo "    没有发现缺失的依赖或不满足的平台限制，下面是 Kconfig 的原始判定，请对照："; fi
      kconfig_info "$p"
    else
      dirs=$(find package -maxdepth 4 -type d -name "$p" -not -path 'package/feeds/*' 2>/dev/null | head -n3 || true)
      if [ -n "$dirs" ]; then
        echo "- ${p}：目录 $(echo $dirs | tr '\n' ' ')存在，但 OpenWrt 没有扫描出这个包，通常是 Makefile 有错误。"
        for d in $dirs; do [ -s "logs/$d/dump.txt" ] && { echo "    扫描日志 logs/$d/dump.txt 末尾："; tail -n 6 "logs/$d/dump.txt" | sed 's/^/      /'; }; done
      else
        echo "- ${p}：源码和 feeds 里都没有叫这个名字的包（包名要和 Makefile 里的 PKG_NAME / BuildPackage 一致，不是目录名）"
      fi
    fi
  done
  local gates still g
  gates=$(sort -u /tmp/gate-hints 2>/dev/null | tr '\n' ' ')
  if [ -n "${gates// /}" ]; then
    cp .config /tmp/config.before-gate
    # 被丢掉的包在 .config 里的那一行也一起没了，所以要连同它们再写一遍
    for g in $gates $(cat /tmp/missing-packages); do echo "CONFIG_PACKAGE_${g}=y" >> .config; done
    make defconfig > /dev/null 2>&1 || true
    still=""
    for p in $(cat /tmp/missing-packages); do grep -q "^CONFIG_PACKAGE_${p}=y" .config || still="$still $p"; done
    if [ -z "$still" ] && [ -n "$P" ] && [ "$(echo $gates | wc -w)" -le 6 ]; then
      # 这些包是 Kconfig 条件明确要求的（depends on PACKAGE_xxx），补上后全部生效：保留这份配置，不再失败
      AUTO_ADDED="${gates% }"
      : > /tmp/missing-packages
      return 0
    fi
    cp /tmp/config.before-gate .config
    if [ -z "$still" ]; then echo "- 已验证：额外启用 ${gates}后，缺失的插件都能生效（未选择机型，没有自动补上；请在模板里加上这些包）"
    else echo "- 额外启用 ${gates}后，仍有没生效的：${still}"; fi
  fi
  if grep -q "unmet direct dependencies" /tmp/defconfig.log 2>/dev/null; then
    echo "- defconfig 输出里的「依赖未满足」警告（最多 30 行）："
    grep -A4 "unmet direct dependencies" /tmp/defconfig.log | head -n 30 | sed 's/^/    /' || true
  fi
  jq -r '.plugins[]? | select(.git_url) | (if .sparse then (.dirs[] | split("/") | last) else .name end)' ../config.json | sort -u | while read -r d; do
    if [ ! -d "package/$d" ]; then echo "- 自定义插件目录 package/$d 不存在"; continue; fi
    names=$(grep -rhoE --include=Makefile "(call BuildPackage,[[:space:]]*[A-Za-z0-9_.+-]+|^PKG_NAME[[:space:]]*:?=[[:space:]]*[A-Za-z0-9_.+-]+)" "package/$d" 2>/dev/null | sed -E 's/^.*[,=][[:space:]]*//' | sort -u | tr '\n' ' ' || true)
    echo "- package/$d 里的包名：${names:-（Makefile 里没找到 BuildPackage / PKG_NAME，luci 应用会按目录名 $d 生成）}"
  done
}

if [ -s /tmp/missing-packages ]; then
  before="$(tr '\n' ' ' < /tmp/missing-packages)"
  AUTO_ADDED=""
  diagnose > /tmp/diag.txt
  if [ -s /tmp/missing-packages ]; then
    { echo "有插件没生效："; cat /tmp/diag.txt; } > /tmp/config-error
    echo "::error::以下插件 defconfig 后没有生效：$(tr '\n' ' ' < /tmp/missing-packages)"
    cat /tmp/config-error
    if [ -n "$P" ]; then
      exit 1      # 机型已确定，缺了插件就是真的缺：直接失败，省掉几小时无效编译
    fi
    echo "::warning::未选择机型，按警告处理，继续进入 menuconfig"
  else
    {
      echo "已自动补上：${AUTO_ADDED}"
      echo "原因：${before}的 Kconfig 条件要求这些包同时启用，否则会被整体丢掉；补上后已验证全部生效。"
      echo "想把它固化进模板：在自定义插件的「额外需要的包」里填上这些包名。"
    } > /tmp/config-error
    echo "::notice::$(head -n1 /tmp/config-error)"
    cat /tmp/config-error
  fi
fi
exit 0
