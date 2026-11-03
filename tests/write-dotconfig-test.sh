#!/usr/bin/env bash
# write-dotconfig.sh 的端到端冒烟：假 openwrt 目录 + 假 make + 假 jq，
# 检查「底稿 / 源码补充 / 模板」三个来源按级别合并后落进 openwrt/.config 的样子。
# 不需要真的 OpenWrt 源码，也不联网。
#
# 三组用例：
#   A 单选写法（CONFIG_TARGET_<m>_<s>_DEVICE_<id>）
#   B 多设备写法（MULTI_PROFILE + CONFIG_TARGET_DEVICE_<m>_<s>_DEVICE_<id>）
#   C 底稿里只有 PER_DEVICE_ROOTFS（名字里有 _DEVICE_，不能被当成机型）
#
# 用法：bash tests/write-dotconfig-test.sh   （仓库里）
#       bash dist/push/test/write-dotconfig-test.sh   （本地开发目录）
#       KEEP_TMP=1 ...   保留临时目录，方便看生成的 .config 与日志
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# 仓库里是 tests/ + scripts/；本地开发目录是 dist/push/test/ + dist/owrt-forge-fix/scripts/
SCRIPTS=""
for d in "$HERE/../scripts" "$HERE/../../owrt-forge-fix/scripts"; do
  if [ -f "$d/write-dotconfig.sh" ]; then SCRIPTS=$(cd "$d" && pwd); break; fi
done
[ -n "$SCRIPTS" ] || { echo "找不到 write-dotconfig.sh（在 $HERE/../scripts 或 ../../owrt-forge-fix/scripts）"; exit 1; }

W=$(mktemp -d)
case "$W" in [A-Za-z]:*) W=$(cygpath -u "$W") ;; esac
if [ "${KEEP_TMP:-}" = "1" ]; then echo "临时目录：$W"; else trap 'rm -rf "$W"' EXIT; fi

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
has() {
  if grep -qxF "$2" "$3"; then ok "$1"; else bad "$1（$3 里没有 $2）"; fi
}
hasnt() {
  if grep -qF "$2" "$3"; then bad "$1（$3 里不该有 $2）"; else ok "$1"; fi
}
inlog() {
  if grep -qF "$2" "$3"; then ok "$1"; else bad "$1（日志里没有：$2）"; fi
}
notinlog() {
  if grep -qF "$2" "$3"; then bad "$1（日志里不该有：$2）"; else ok "$1"; fi
}

mkdir -p "$W/bin" "$W/app/openwrt/configs" "$W/app/openwrt/tmp"

# ---- 假 jq：共用 tests/lib/fake-jq.py（gen-config-test.sh 也用同一份）----
cat > "$W/bin/jq" <<SH
#!/usr/bin/env bash
exec python3 "$HERE/lib/fake-jq.py" "\$@"
SH

# ---- 假 make：defconfig 什么也不做（合并结果已经写在 .config 里）----
printf '#!/usr/bin/env bash\nexit 0\n' > "$W/bin/make"
chmod +x "$W/bin/jq" "$W/bin/make" 2>/dev/null || true

# ---- 源码补充：发行版默认配置（带 MULTI_PROFILE 与别的设备，模拟 ponwrt）----
cat > "$W/app/openwrt/configs/an7581.config" <<'EOF'
CONFIG_TARGET_MULTI_PROFILE=y
CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_airoha_an7581-evb=y
CONFIG_PACKAGE_wpad-basic-mbedtls=y
# CONFIG_PACKAGE_kmod-phy-maxlinear is not set
EOF
cat > "$W/app/openwrt/configs/release.config" <<'EOF'
CONFIG_PACKAGE_kmod-airoha-xpon=y
CONFIG_KERNEL_DEBUG_INFO=y
EOF

# ---- 假的机型元数据：补包那一段要读 tmp/.targetinfo 与 tmp/.packageinfo ----
cat > "$W/app/openwrt/tmp/.targetinfo" <<'EOF'
Target: airoha/an7581
Target-Profile: DEVICE_nokia_xg-040g-md-ubi
Target-Profile-Packages: kmod-phy-maxlinear luci-app-argon kmod-usb3
Target-Profile: DEVICE_fiberhome_hg5382a
Target-Profile-Packages: kmod-phy-maxlinear luci-app-argon kmod-usb3
EOF
cat > "$W/app/openwrt/tmp/.packageinfo" <<'EOF'
Package: kmod-phy-maxlinear
@@
Package: luci-app-argon
@@
Package: kmod-usb3
@@
EOF

make_config_json() {   # $1=profile $2=底稿文件
  python3 - "$W/app/config.json" "$1" "$2" <<'PY'
import json, sys
prof, snapf = sys.argv[2], sys.argv[3]
snap = open(snapf, encoding='utf-8').read()
json.dump({"target": "airoha/an7581", "profile": prof,
           "packages": ["kmod-phy-maxlinear", "luci-app-argon"],
           "dotconfig_snapshot": snap}, open(sys.argv[1], 'w', encoding='utf-8'))
PY
}

run_case() {           # $1=名字 $2=profile $3=底稿文件
  make_config_json "$2" "$3"
  rm -f "$W/app/openwrt/.config" /tmp/build-notes /tmp/config-error
  ( cd "$W/app" && HAS_DOTCONFIG=true SCRIPTS_DIR="$SCRIPTS" PATH="$W/bin:$PATH" \
      bash "$SCRIPTS/write-dotconfig.sh" > "$W/$1.log" 2>&1 )
  echo $? > "$W/$1.rc"
  cp "$W/app/openwrt/.config" "$W/$1.config" 2>/dev/null || : > "$W/$1.config"
  if [ "$(cat "$W/$1.rc")" -eq 0 ]; then ok "[$1] 脚本正常结束（rc=0）"; else
    bad "[$1] 退出码 $(cat "$W/$1.rc")"; sed -n '1,20p' "$W/$1.log"; fi
}

# ===========================================================================
# A. 单选写法：模板要求 hg5382a，底稿里是 nokia
# ===========================================================================
cat > "$W/snapA" <<'EOF'
CONFIG_TARGET_airoha=y
CONFIG_TARGET_airoha_an7581=y
CONFIG_TARGET_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi=y
CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi="kmod-usb3"
CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_fiberhome_hg5382a=""
CONFIG_PACKAGE_kmod-airoha-en7572=m
CONFIG_PACKAGE_luci-base=y
# CONFIG_PACKAGE_luci-app-argon is not set
# CONFIG_KERNEL_DEBUG_INFO is not set
EOF
run_case A fiberhome_hg5382a "$W/snapA"
C="$W/A.config"; L="$W/A.log"

has   "[A] 型号取底稿 nokia"            'CONFIG_TARGET_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi=y' "$C"
hasnt "[A] 模板机型被压掉"              'CONFIG_TARGET_airoha_an7581_DEVICE_fiberhome_hg5382a=y'    "$C"
hasnt "[A] 源码补充的其它设备被丢"      'CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_airoha_an7581-evb=y' "$C"
hasnt "[A] 源码补充的 MULTI_PROFILE 被丢" 'CONFIG_TARGET_MULTI_PROFILE=y'                          "$C"
has   "[A] 平台行保留"                  'CONFIG_TARGET_airoha_an7581=y'                             "$C"
has   "[A] 选中机型的 DEVICE_PACKAGES 保留" 'CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi="kmod-usb3"' "$C"
hasnt "[A] 别的机型的 DEVICE_PACKAGES 被丢" 'CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_fiberhome_hg5382a' "$C"
has   "[A] 底稿的 =m 压过源码补充"      'CONFIG_PACKAGE_kmod-airoha-en7572=m'                       "$C"
has   "[A] 源码补充压过模板要求"        '# CONFIG_PACKAGE_kmod-phy-maxlinear is not set'            "$C"
hasnt "[A] 模板要的包没被抬成 =y"       'CONFIG_PACKAGE_kmod-phy-maxlinear=y'                       "$C"
has   "[A] 源码补充的包保留"            'CONFIG_PACKAGE_kmod-airoha-xpon=y'                         "$C"
has   "[A] 底稿内核选项压过源码补充"    '# CONFIG_KERNEL_DEBUG_INFO is not set'                     "$C"
has   "[A] T0 关闭的驱动保持关闭"       '# CONFIG_PACKAGE_kmod-phy-maxlinear is not set'            "$C"
hasnt "[A] T0 关闭的驱动没被补成 =y"    'CONFIG_PACKAGE_kmod-phy-maxlinear=y'                       "$C"
has   "[A] 机型声明、配置里没有的包照补" 'CONFIG_PACKAGE_kmod-usb3=y'                                "$C"
inlog "[A] 构建说明里点出 T0 关闭的驱动" 'T0 明确关闭的驱动'                                        "$L"
inlog "[A] T0 关闭给了告警"             '::warning::T0'                                            "$L"
inlog "[A] 说明里写了分级摘要"           '分级写入'                                                 "$L"
inlog "[A] 说明里点出机型不一致"         '模板机型 fiberhome_hg5382a 与底稿机型 nokia_xg-040g-md-ubi 不一致' "$L"
inlog "[A] 模板插件被压掉单独告警"       '::warning::模板里勾选的插件被配置压成关闭或 =m'            "$L"
inlog "[A] 点名是哪个插件"               'luci-app-argon'                                           "$L"
notinlog "[A] 审计口径不再是「底稿没带上」" '底稿没有带上'                                          "$L"

# ===========================================================================
# B. 多设备写法：MULTI_PROFILE + TARGET_DEVICE_<m>_<s>_DEVICE_<id>
#    机型 id 必须按前缀剥；split('_DEVICE_', 1) 会取成 airoha_an7581_DEVICE_nokia_...
# ===========================================================================
cat > "$W/snapB" <<'EOF'
CONFIG_TARGET_airoha=y
CONFIG_TARGET_airoha_an7581=y
CONFIG_TARGET_MULTI_PROFILE=y
CONFIG_TARGET_PER_DEVICE_ROOTFS=y
CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi=y
CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi="kmod-usb3"
CONFIG_PACKAGE_kmod-airoha-en7572=y
EOF
run_case B nokia_xg-040g-md-ubi "$W/snapB"
C="$W/B.config"; L="$W/B.log"

has   "[B] 保留多选写法的机型行"     'CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi=y' "$C"
has   "[B] MULTI_PROFILE 保留"       'CONFIG_TARGET_MULTI_PROFILE=y'                                     "$C"
has   "[B] PER_DEVICE_ROOTFS 保留"   'CONFIG_TARGET_PER_DEVICE_ROOTFS=y'                                 "$C"
has   "[B] 选中机型的 DEVICE_PACKAGES 没被丢" 'CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi="kmod-usb3"' "$C"
hasnt "[B] 单选写法的机型行没混进来" 'CONFIG_TARGET_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi=y'          "$C"
notinlog "[B] 机型 id 没被拆错"      'airoha_an7581_DEVICE_nokia'                                       "$L"
notinlog "[B] 不误报机型不一致"      '不一致'                                                           "$L"

# ===========================================================================
# C. 底稿里只有 PER_DEVICE_ROOTFS（名字里有 _DEVICE_）→ 不能当机型
# ===========================================================================
cat > "$W/snapC" <<'EOF'
CONFIG_TARGET_airoha=y
CONFIG_TARGET_airoha_an7581=y
CONFIG_TARGET_PER_DEVICE_ROOTFS=y
CONFIG_PACKAGE_kmod-airoha-en7572=y
EOF
run_case C fiberhome_hg5382a "$W/snapC"
C="$W/C.config"; L="$W/C.log"

has   "[C] 机型回落到模板"          'CONFIG_TARGET_airoha_an7581_DEVICE_fiberhome_hg5382a=y' "$C"
notinlog "[C] 没把 ROOTFS 当机型"   'ROOTFS'                                                "$L"
notinlog "[C] 不误报机型不一致"     '不一致'                                                "$L"
hasnt "[C] 单选时不输出 PER_DEVICE_ROOTFS" 'CONFIG_TARGET_PER_DEVICE_ROOTFS=y'              "$C"

echo
echo "write-dotconfig: $pass 通过, $fail 失败"
[ "$fail" -eq 0 ]
