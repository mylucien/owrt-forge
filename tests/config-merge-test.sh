#!/usr/bin/env bash
# config-merge.py 的分级合并回归。不需要 openwrt 源码，只喂三份假来源。
#
# 用法：bash tests/config-merge-test.sh   （仓库里）
#       bash dist/push/test/config-merge-test.sh   （本地开发目录）
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# 仓库里是 tests/ + scripts/；本地开发目录是 dist/push/test/ + dist/owrt-forge-fix/scripts/
SCRIPTS=""
for d in "$HERE/../scripts" "$HERE/../../owrt-forge-fix/scripts"; do
  if [ -f "$d/config-merge.py" ]; then SCRIPTS=$(cd "$d" && pwd); break; fi
done
[ -n "$SCRIPTS" ] || { echo "找不到 config-merge.py（在 $HERE/../scripts 或 ../../owrt-forge-fix/scripts）"; exit 1; }
MERGE="$SCRIPTS/config-merge.py"

TMP=$(mktemp -d)
case "$TMP" in [A-Za-z]:*) TMP=$(cygpath -u "$TMP") ;; esac   # Windows 下 mktemp 可能返回 C:/...
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
check(){ if grep -qxF "$2" "$3"; then ok "$1"; else bad "$1（找不到 $2）"; fi; }
contains(){ if grep -qF "$2" "$3"; then ok "$1"; else bad "$1（找不到 $2）"; fi; }
nocheck(){ if grep -qF "$2" "$3"; then bad "$1（不该出现 $2）"; else ok "$1"; fi; }

# ---------------------------------------------------------------------------
# 场景 1：底稿 nokia，模板 hg5382a → 型号听底稿
# ---------------------------------------------------------------------------
cat > "$TMP/snap" <<'EOF'
CONFIG_TARGET_airoha=y
CONFIG_TARGET_airoha_an7581=y
CONFIG_TARGET_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi=y
CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi="kmod-usb3"
CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_fiberhome_hg5382a=""
CONFIG_PACKAGE_kmod-airoha-en7572=y
# CONFIG_PACKAGE_luci-app-foo is not set
EOF
cat > "$TMP/seed" <<'EOF'
CONFIG_TARGET_MULTI_PROFILE=y
CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_airoha_an7581-evb=y
CONFIG_TARGET_mediatek=y
CONFIG_TARGET_mediatek_filogic=y
CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_airoha_an7581-evb="kmod-foo"
CONFIG_PACKAGE_wpad-basic-mbedtls=y
CONFIG_PACKAGE_kmod-airoha-xpon=y
EOF
cat > "$TMP/tpl" <<'EOF'
CONFIG_TARGET_airoha=y
CONFIG_TARGET_airoha_an7581=y
CONFIG_TARGET_airoha_an7581_DEVICE_fiberhome_hg5382a=y
CONFIG_PACKAGE_kmod-phy-maxlinear=y
CONFIG_PACKAGE_wpad-basic-mbedtls=n
CONFIG_PACKAGE_luci-app-foo=y
EOF
python3 "$MERGE" --target airoha/an7581 --profile fiberhome_hg5382a \
  --snapshot "$TMP/snap" --seed "$TMP/seed" --template "$TMP/tpl" --out "$TMP/out" > "$TMP/rep" || bad "场景1 合并失败"

check   "1 型号取底稿 nokia"        'CONFIG_TARGET_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi=y' "$TMP/out"
nocheck "1 模板机型被压掉"          'CONFIG_TARGET_airoha_an7581_DEVICE_fiberhome_hg5382a=y'    "$TMP/out"
nocheck "1 源码补充的其它设备被丢"  'CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_airoha_an7581-evb=y' "$TMP/out"
nocheck "1 源码补充的 MULTI_PROFILE 被丢" 'CONFIG_TARGET_MULTI_PROFILE=y'                        "$TMP/out"
nocheck "1 其它平台被丢"            'CONFIG_TARGET_mediatek=y'        "$TMP/out"
nocheck "1 其它子目标被丢"          'CONFIG_TARGET_mediatek_filogic=y' "$TMP/out"
check   "1 平台行保留"              'CONFIG_TARGET_airoha_an7581=y'                             "$TMP/out"
check   "1 只留选中机型的 DEVICE_PACKAGES" 'CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi="kmod-usb3"' "$TMP/out"
nocheck "1 别的机型的 DEVICE_PACKAGES 被丢" 'CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_fiberhome_hg5382a' "$TMP/out"
check   "1 EP 是底稿机型"           'EP=nokia_xg-040g-md-ubi'                                   "$TMP/rep"
check   "1 说明里点出机型不一致"     'NOTE 模板机型 fiberhome_hg5382a 与底稿机型 nokia_xg-040g-md-ubi 不一致 —— 按「型号听底稿」编 nokia_xg-040g-md-ubi，不按 fiberhome_hg5382a 校验/补包' "$TMP/rep"
check   "1 模板插件被底稿关掉会点名"  'TPL_ITEM luci-app-foo（模板选了，底稿 改成关闭）' "$TMP/rep"
check   "1 模板插件被压掉的数量"      'TPL_DOWN=1' "$TMP/rep"

# ---------------------------------------------------------------------------
# 场景 2：包这一级 底稿 > 源码补充 > 模板
# ---------------------------------------------------------------------------
printf 'CONFIG_PACKAGE_a=y\nCONFIG_PACKAGE_b=y\nCONFIG_PACKAGE_c=y\n'            > "$TMP/s2"
printf '# CONFIG_PACKAGE_a is not set\nCONFIG_PACKAGE_b=m\nCONFIG_PACKAGE_d=y\n' > "$TMP/e2"
printf 'CONFIG_PACKAGE_a=y\nCONFIG_PACKAGE_c=y\nCONFIG_PACKAGE_e=y\n'            > "$TMP/t2"
python3 "$MERGE" --target x86/64 --profile generic \
  --snapshot /dev/null --seed "$TMP/e2" --template "$TMP/t2" --out "$TMP/o2" > "$TMP/r2" || bad "场景2 合并失败"
# 没有底稿时：源码补充 > 模板
check   "2 源码补充压过模板（a 关）" '# CONFIG_PACKAGE_a is not set' "$TMP/o2"
nocheck "2 模板的 a=y 被压掉"        'CONFIG_PACKAGE_a=y'            "$TMP/o2"
check   "2 模板独有的 e 保留"        'CONFIG_PACKAGE_e=y'            "$TMP/o2"
check   "2 源码补充的 d 保留"        'CONFIG_PACKAGE_d=y'            "$TMP/o2"
check   "2 EP 回落到模板机型"        'EP=generic'                    "$TMP/r2"
check   "2 无底稿时机型来自模板"      'CONFIG_TARGET_x86_64_DEVICE_generic=y' "$TMP/o2"
check   "2 明确关闭算 T0 并报出来"    'NOTE T0 明确关闭：1 个包在合并结果里是 is not set，后面的补包不会打开它们' "$TMP/r2"
check   "2 模板插件被压成关闭会点名"  'TPL_ITEM a（模板选了，源码补充 改成关闭）' "$TMP/r2"
check   "2 模板插件数统计"            'TPL_DOWN=1' "$TMP/r2"

# ---------------------------------------------------------------------------
# 场景 3：有底稿时，同一符号 底稿 > 源码补充；L5 也分级
# ---------------------------------------------------------------------------
printf 'CONFIG_PACKAGE_a=m\nCONFIG_KERNEL_X=y\n'          > "$TMP/s3"
printf 'CONFIG_PACKAGE_a=y\n# CONFIG_KERNEL_X is not set\n' > "$TMP/e3"
printf 'CONFIG_TARGET_x86_64_DEVICE_generic=y\nCONFIG_PACKAGE_a=n\n' > "$TMP/t3"
python3 "$MERGE" --target x86/64 --profile generic \
  --snapshot "$TMP/s3" --seed "$TMP/e3" --template "$TMP/t3" --out "$TMP/o3" > "$TMP/r3" || bad "场景3 合并失败"
check   "3 底稿 =m 压过源码 =y"      'CONFIG_PACKAGE_a=m'      "$TMP/o3"
check   "3 底稿内核选项压过源码"      'CONFIG_KERNEL_X=y'       "$TMP/o3"
check   "3 底稿没写机型时用模板"      'CONFIG_TARGET_x86_64_DEVICE_generic=y' "$TMP/o3"
check   "3 报告里给了覆盖明细"        'NOTE · 包：PACKAGE_a 取 m（底稿=m，压掉 模板=n）' "$TMP/r3"

# ---------------------------------------------------------------------------
# 场景 4：多设备写法（MULTI_PROFILE + TARGET_DEVICE_<m>_<s>_DEVICE_<id>）
#   机型 id 必须按前缀剥出来，不能 split('_DEVICE_', 1) —— 第一个 _DEVICE_
#   出现在 TARGET_DEVICE_ 处，会取成 airoha_an7581_DEVICE_nokia_...
# ---------------------------------------------------------------------------
cat > "$TMP/s4" <<'EOF'
CONFIG_TARGET_airoha=y
CONFIG_TARGET_airoha_an7581=y
CONFIG_TARGET_MULTI_PROFILE=y
CONFIG_TARGET_PER_DEVICE_ROOTFS=y
CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi=y
CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi="kmod-usb3"
CONFIG_PACKAGE_kmod-airoha-en7572=y
EOF
# 模板里换成另一台（多选写法），底稿赢
printf 'CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_fiberhome_hg5382a=y\n' > "$TMP/t4"
python3 "$MERGE" --target airoha/an7581 --profile nokia_xg-040g-md-ubi \
  --snapshot "$TMP/s4" --seed /dev/null --template "$TMP/t4" --out "$TMP/o4" > "$TMP/r4" || bad "场景4 合并失败"
check   "4 多设备机型 id 正确"        'EP=nokia_xg-040g-md-ubi'                              "$TMP/r4"
check   "4 输出保留多选写法"          'CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi=y' "$TMP/o4"
check   "4 MULTI_PROFILE 保留"        'CONFIG_TARGET_MULTI_PROFILE=y'                        "$TMP/o4"
check   "4 PER_DEVICE_ROOTFS 跟着保留" 'CONFIG_TARGET_PER_DEVICE_ROOTFS=y'                    "$TMP/o4"
check   "4 选中机型的 DEVICE_PACKAGES 没被丢" 'CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_nokia_xg-040g-md-ubi="kmod-usb3"' "$TMP/o4"
nocheck "4 别的机型的 DEVICE_PACKAGES 被丢" 'CONFIG_TARGET_DEVICE_PACKAGES_airoha_an7581_DEVICE_fiberhome_hg5382a' "$TMP/o4"
contains "4 只选底稿里的那一台"        'NOTE 配置合并：平台 airoha/an7581；机型 nokia_xg-040g-md-ubi（底稿）' "$TMP/r4"
nocheck "4 模板机型的多选行被压掉"     'CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_fiberhome_hg5382a=y' "$TMP/o4"
nocheck "4 机型一致时不报不一致"       '不一致' "$TMP/r4"

# ---------------------------------------------------------------------------
# 场景 5：PER_DEVICE_ROOTFS 的名字里有 _DEVICE_，不能被当机型
# ---------------------------------------------------------------------------
cat > "$TMP/s5" <<'EOF'
CONFIG_TARGET_airoha=y
CONFIG_TARGET_airoha_an7581=y
CONFIG_TARGET_PER_DEVICE_ROOTFS=y
CONFIG_PACKAGE_kmod-airoha-en7572=y
EOF
printf 'CONFIG_TARGET_airoha_an7581_DEVICE_fiberhome_hg5382a=y\n' > "$TMP/t5"
python3 "$MERGE" --target airoha/an7581 --profile fiberhome_hg5382a \
  --snapshot "$TMP/s5" --seed /dev/null --template "$TMP/t5" --out "$TMP/o5" > "$TMP/r5" || bad "场景5 合并失败"
check   "5 机型回落到模板（不是 ROOTFS）" 'EP=fiberhome_hg5382a' "$TMP/r5"
nocheck "5 没把 ROOTFS 当机型"        'EP=ROOTFS'  "$TMP/r5"
nocheck "5 不误报机型不一致"          '不一致'      "$TMP/r5"
nocheck "5 单选时不输出 PER_DEVICE_ROOTFS" 'CONFIG_TARGET_PER_DEVICE_ROOTFS=y' "$TMP/o5"
check   "5 模板机型行保留"            'CONFIG_TARGET_airoha_an7581_DEVICE_fiberhome_hg5382a=y' "$TMP/o5"

# ---------------------------------------------------------------------------
# 场景 6：只有多设备写法、模板是单选 → 不能输出 MULTI_PROFILE（会把 choice 清掉）
# ---------------------------------------------------------------------------
printf 'CONFIG_TARGET_x86_64_DEVICE_generic=y\n' > "$TMP/t6"
printf 'CONFIG_TARGET_PER_DEVICE_ROOTFS=y\n' > "$TMP/s6"
python3 "$MERGE" --target x86/64 --profile generic \
  --snapshot "$TMP/s6" --seed /dev/null --template "$TMP/t6" --out "$TMP/o6" > "$TMP/r6" || bad "场景6 合并失败"
check   "6 单选写法下不开 MULTI_PROFILE" 'EP=generic' "$TMP/r6"
nocheck "6 输出里没有 MULTI_PROFILE"     'CONFIG_TARGET_MULTI_PROFILE=y' "$TMP/o6"

echo
echo "config-merge: $pass 通过, $fail 失败"
[ "$fail" -eq 0 ]
