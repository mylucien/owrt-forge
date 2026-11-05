#!/usr/bin/env bash
# 机型声明的 DEVICE_PACKAGES 必须真的进镜像 —— gen-config.sh 与 write-dotconfig.sh 共用。
#
# 用法（在 openwrt/ 目录里，调用方已定义 note()）：
#     source "$SCRIPTS_DIR/device-packages.sh"
#     enforce_device_packages <机型 id> || exit 1
#
# 为什么需要这一段：选中 profile 后 target-metadata.pl 会对该机型的 DEVICE_PACKAGES
# 逐个 select DEFAULT_x，而 .config-package.in 里 PACKAGE_x 的默认值就是
# "default y if DEFAULT_x"。默认值只在符号没被赋值时才生效：源码 configs/*.config
# （或上传的底稿）里只要留着一行 PACKAGE_x=m，就把这个默认值压死了。而 =m 在镜像
# 构建里的意思是"编成 ipk 放进软件源，不装进固件"，板子上就没有这个包。
# ponwrt 官方镜像缺 kmod-airoha-en7572 就是这么来的（configs/an7581.config 写的 =m），
# 后果是光口永远 DOWN，内核只报 "airoha-xpon: failed to obtain the optical frontend
# provider"。编译全程不报错。
#
# 规则（两份脚本以前各抄一份，改一处忘另一处 —— 现在只留这一份）：
#   · 以 tmp/.targetinfo 里机型自己声明的包为准（make 展开后的最终列表，已算过 += / -变体）
#   · 缺的补成 =y 再 defconfig，最多两轮（补上的包会再拉起依赖）
#   · 配置里写了 "# ... is not set" 的，先看是「谁写的」（config-merge.py --emit-off）：
#       user = 底稿写的   → T0，不再打开，驱动也一样，只告警
#       seed = 源码补充写的 → 那是整份发行版配置里的默认值（动辄几千行 is not set），
#                             应用保持关闭，**机型声明的驱动仍补成 =y**（补不上会失败）
#     分不清来源（没固定底稿 / 没 python3）时退回老口径：一律当 T0
#   · 已被同类包顶替的（wpad-openssl 换成 wpad-basic 之类）按 Provides 判断，不重复装
#   · 驱动最后仍然没进配置 → 返回 1（设备缺驱动起不来，不能当成功）
#
# 注意这里只管"补"，不管来源优先级：值该取谁由 config-merge.py 决定。

_edp_is_driver() { case "$1" in kmod-*|*-firmware) return 0 ;; *) return 1 ;; esac; }

# 包的 Provides（虚拟包名），wpad-openssl / wpad-basic-mbedtls 都 provides wpad
_edp_provides_of() {
  awk -v p="$1" '$0=="Package: "p{f=1; next}
    f && /^Provides:/ { sub(/^Provides:[ \t]*/, ""); print; exit }
    f && /^@@/ { exit }' tmp/.packageinfo 2>/dev/null
}

# 已经启用的包里，谁提供了同样的虚拟包（用来判断"用户是不是有意换成了同类包"）
_edp_enabled_provides_map() {
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
_edp_substituted_by() {
  local v other
  for v in $(_edp_provides_of "$1"); do
    other=$(awk -v v="$v" -v q="$1" '$1==v && $2!=q { print $2; exit }' /tmp/enabled-provides 2>/dev/null)
    [ -n "$other" ] && { echo "$other"; return 0; }
  done
  return 1
}

# 机型在 targetinfo 里声明的包（原始写法，含 + / - 前缀）
_edp_profile_pkgs() {
  awk -v id="DEVICE_$1" '
    /^Target-Profile:/ { cur = $2; next }
    cur == id && /^Target-Profile-Packages:/ {
      sub(/^[^:]*:[ \t]*/, ""); print; exit
    }' tmp/.targetinfo 2>/dev/null
}

enforce_device_packages() {
  local dev="${1:-}"
  local -A DECL=() KEEP=() ORIG=()
  local t p add skip round why sub cfg_off_ready
  local skip_all="" off_user="" seed_drv="" seed_app="" auto_app=""
  local where="配置里"

  [ -n "$dev" ] || return 0
  [ -f .config ] || return 0
  [ -f tmp/.targetinfo ] || return 0

  # 「谁说的关闭」——config-merge.py --emit-off 的输出，每行 `<user|seed> <包名>`：
  #   user  底稿里明确写了 is not set：写配置的人的决定（T0），驱动也不打开
  #   seed  源码补充（configs/*.config）里的 is not set：整份发行版配置，几千行 is not set
  #         只是"发行版没编这些包"，不是你的选择，机型声明的驱动仍要补
  # 没有这个文件（不固定底稿 / 没有 python3）时退回老口径：配置里的 is not set 一律当 T0。
  cfg_off_ready=0
  if [ -s /tmp/cfg-off ]; then
    cfg_off_ready=1
    where="底稿里"
    while read -r why p; do
      [ -n "$p" ] && ORIG["$p"]="$why"
    done < /tmp/cfg-off
  fi

  # 按 Makefile 里 + / - 的写法算出机型的最终包集合
  for t in $(_edp_profile_pkgs "$dev"); do
    case "$t" in
      -*) unset "DECL[${t#-}]" ;;
      +*) DECL["${t#+}"]=1 ;;
      *@*|*:*|*'$'*) continue ;;
      *) [ -n "$t" ] && DECL["$t"]=1 ;;
    esac
  done
  [ ${#DECL[@]} -gt 0 ] || return 0
  _edp_enabled_provides_map > /tmp/enabled-provides

  skip_all=""
  for round in 1 2; do
    add=""; skip=""
    for p in $(printf '%s\n' "${!DECL[@]}" | sort); do
      grep -q "^CONFIG_PACKAGE_${p}=y$" .config && continue
      if sub=$(_edp_substituted_by "$p"); then skip="$skip $p→$sub"; continue; fi
      if grep -q "^# CONFIG_PACKAGE_${p} is not set$" .config; then
        why="${ORIG[$p]:-}"
        # 底稿明确关闭（或分不清来源）= T0：保持关闭，连驱动也不打开
        if [ "$cfg_off_ready" = 0 ] || [ "$why" = user ]; then
          KEEP["$p"]=1; off_user="$off_user $p"; continue
        fi
        if _edp_is_driver "$p"; then
          # 源码补充里的 is not set 不是用户的选择，驱动照补；补不上会在最后直接报错
          [ "$why" = seed ] && seed_drv="$seed_drv $p"
          add="$add $p"; continue
        fi
        KEEP["$p"]=1
        if [ "$why" = seed ]; then seed_app="$seed_app $p"; else auto_app="$auto_app $p"; fi
        continue
      fi
      add="$add $p"
    done
    [ -n "${skip// /}" ] && skip_all="$skip_all $skip"
    [ -n "${add// /}" ] || break
    for p in $add; do printf 'CONFIG_PACKAGE_%s=y\n' "$p" >> .config; done
    note "机型 $dev 声明、配置里却没有的包：${add# } → 补成 =y 后重新 defconfig"
    # 仍然留一份日志：gen-config.sh 诊断"插件没生效"时要 grep 这里
    make defconfig >> /tmp/defconfig.log 2>&1 || true
    _edp_enabled_provides_map > /tmp/enabled-provides
  done

  if [ -n "${skip_all// /}" ]; then
    note "机型声明的包已有同类替代，按配置里的选择保留：$(printf '%s\n' $skip_all | sort -u | paste -sd' ')"
  fi
  # T0：底稿里明确关闭的（分不清来源时 off_user 里是全部 is not set，与老口径一致）
  local uo_app="" uo_drv=""
  for p in $(printf '%s\n' $off_user | sort -u); do
    if _edp_is_driver "$p"; then uo_drv="$uo_drv $p"; else uo_app="$uo_app $p"; fi
  done
  if [ -n "${uo_app// /}" ]; then
    note "机型声明的应用在${where}被明确关闭（T0），保持关闭：${uo_app# }"
  fi
  if [ -n "${uo_drv// /}" ]; then
    # 驱动被明确关掉是有代价的（设备可能起不来），但 T0 就是 T0：只提示，不擅自打开
    note "机型声明的驱动在${where}被明确关闭（T0），按你的选择保持关闭：${uo_drv# } —— 固件里不会有这些驱动"
    echo "::warning::T0 明确关闭的驱动：${uo_drv# }（机型声明里有，但${where}写死了 is not set）"
  fi
  # 源码补充关掉的：应用按发行版默认保留关闭，驱动已经补过一轮 —— 都要说清楚，
  # 别再像以前那样把"defconfig 兜出来的 is not set"说成"你明确关闭"。
  if [ -n "${seed_drv// /}" ]; then
    note "机型声明的驱动在源码补充（configs/*.config）里是 is not set —— 那是发行版默认，不是你的选择，已按机型声明补成 =y：$(printf '%s\n' $seed_drv | sort -u | paste -sd' ' -)"
  fi
  if [ -n "${seed_app// /}" ]; then
    note "机型声明的应用在源码补充里是 is not set（发行版默认，不是你的选择），保持关闭：$(printf '%s\n' $seed_app | sort -u | paste -sd' ' -)。需要它就在模板里勾选，或改源码里的 configs/*.config"
  fi
  if [ -n "${auto_app// /}" ]; then
    note "机型声明的应用 defconfig 后仍是 is not set（依赖不满足或被别的包顶掉），没有补：$(printf '%s\n' $auto_app | sort -u | paste -sd' ' -)"
  fi

  local drv="" other=""
  for p in $(printf '%s\n' "${!DECL[@]}" | sort); do
    grep -q "^CONFIG_PACKAGE_${p}=y$" .config && continue
    _edp_substituted_by "$p" > /dev/null && continue
    [ -n "${KEEP[$p]:-}" ] && continue
    if _edp_is_driver "$p"; then drv="$drv $p"; else other="$other $p"; fi
  done
  if [ -n "${drv// /}" ]; then
    { echo "机型 $dev 声明的驱动没能生效：${drv# }"
      echo "这些包在配置里是 =m 或 n（=m 只编 ipk，不会装进固件），或者依赖不满足。"
      echo "把对应的行删掉或改成 =y 再编译；确实不需要，就改 target/linux/.../image 里这个机型的 DEVICE_PACKAGES。"
      echo "源码补充（configs/*.config）里的 is not set 不算你的选择，已经试着补过一轮；仍起不来说明依赖不满足。"
    } > /tmp/config-error
    echo "::error::$(head -n1 /tmp/config-error)"
    cat /tmp/config-error
    return 1
  fi
  if [ -n "${other// /}" ]; then
    note "机型声明的应用没进配置：${other# }（有同类包顶替的已跳过，其余多为源码里条件不满足；驱动都在，不影响开机）"
  fi
  return 0
}
