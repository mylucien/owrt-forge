#!/usr/bin/env bash
# gen-config.sh 的端到端冒烟：假 openwrt 目录 + 假 make + 假 jq。
#
# 重点是它和 write-dotconfig.sh 现在共用 scripts/device-packages.sh，
# 所以「机型声明的包必须进固件」「T0 明确关闭的不许补」这两条要在这条路上同样成立
# （以前这条路上驱动还会被硬补回来，是两份拷贝漂移出来的差异）。
#
# 用法：bash tests/gen-config-test.sh
#       bash dist/push/test/gen-config-test.sh
#       KEEP_TMP=1 ...   保留临时目录
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPTS=""
for d in "$HERE/../scripts" "$HERE/../../owrt-forge-fix/scripts"; do
  if [ -f "$d/gen-config.sh" ]; then SCRIPTS=$(cd "$d" && pwd); break; fi
done
[ -n "$SCRIPTS" ] || { echo "找不到 gen-config.sh（在 $HERE/../scripts 或 ../../owrt-forge-fix/scripts）"; exit 1; }

W=$(mktemp -d)
case "$W" in [A-Za-z]:*) W=$(cygpath -u "$W") ;; esac
if [ "${KEEP_TMP:-}" = "1" ]; then echo "临时目录：$W"; else trap 'rm -rf "$W"' EXIT; fi

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
has() {
  if grep -qxF "$2" "$W/app/openwrt/.config"; then ok "$1"; else bad "$1（.config 里没有 $2）"; fi
}
hasnt() {
  if grep -qF "$2" "$W/app/openwrt/.config"; then bad "$1（不该有 $2）"; else ok "$1"; fi
}
inlog() {
  if grep -qF "$2" "$W/app/log"; then ok "$1"; else bad "$1（日志里没有：$2）"; fi
}

mkdir -p "$W/bin" "$W/app/openwrt/configs" "$W/app/openwrt/tmp"

# ---- 假 jq（与 write-dotconfig-test.sh 共用同一份）----
cat > "$W/bin/jq" <<SH
#!/usr/bin/env bash
exec python3 "$HERE/lib/fake-jq.py" "\$@"
SH
# ---- 假 make：defconfig 什么也不做，配置就按脚本写的样子留着 ----
printf '#!/usr/bin/env bash\nexit 0\n' > "$W/bin/make"
chmod +x "$W/bin/jq" "$W/bin/make" 2>/dev/null || true

# ---- 源码自带的默认配置：带多设备开关、别的机型的 DEVICE_ 行、以及一个被明确关掉的应用 ----
cat > "$W/app/openwrt/configs/an7581.config" <<'EOF'
CONFIG_TARGET_MULTI_PROFILE=y
CONFIG_TARGET_PER_DEVICE_ROOTFS=y
CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_airoha_an7581-evb=y
CONFIG_PACKAGE_wpad-basic-mbedtls=y
# CONFIG_PACKAGE_kmod-usb3 is not set
# CONFIG_PACKAGE_luci-app-argon is not set
EOF
cat > "$W/app/openwrt/configs/release.config" <<'EOF'
CONFIG_PACKAGE_kmod-airoha-xpon=y
EOF

cat > "$W/app/openwrt/tmp/.targetinfo" <<'EOF'
Target: airoha/an7581
Target-Profile: DEVICE_fiberhome_hg5382a
Target-Profile-Packages: kmod-phy-maxlinear +kmod-usb3 luci-app-argon -kmod-dropped
EOF
cat > "$W/app/openwrt/tmp/.packageinfo" <<'EOF'
Package: kmod-phy-maxlinear
@@
Package: kmod-usb3
@@
Package: luci-app-argon
@@
EOF

python3 - "$HERE" "$W/app/config.json" <<'PY'
import json, sys
json.dump({"target": "airoha/an7581", "profile": "fiberhome_hg5382a", "packages": []},
          open(sys.argv[2], 'w', encoding='utf-8'))
PY

( cd "$W/app" && SCRIPTS_DIR="$SCRIPTS" PATH="$W/bin:$PATH" bash "$SCRIPTS/gen-config.sh" > "$W/app/log" 2>&1 )
rc=$?
if [ "$rc" -eq 0 ]; then ok "脚本正常结束（rc=0）"; else
  bad "脚本退出码 $rc"; sed -n '1,25p' "$W/app/log"; fi

has   "机型行照写"                  'CONFIG_TARGET_airoha_an7581_DEVICE_fiberhome_hg5382a=y'
hasnt "源码里的 MULTI_PROFILE 被剥掉" 'CONFIG_TARGET_MULTI_PROFILE=y'
hasnt "其它机型的 DEVICE_ 行被剥掉"   'CONFIG_TARGET_DEVICE_airoha_an7581_DEVICE_airoha_an7581-evb=y'
has   "源码里的发行版包保留"          'CONFIG_PACKAGE_wpad-basic-mbedtls=y'
has   "机型声明的驱动被补成 =y"        'CONFIG_PACKAGE_kmod-phy-maxlinear=y'
has   "机型声明的包被补成 =y"          'CONFIG_PACKAGE_kmod-usb3=y'
has   "源码补充关的应用保持关闭"      '# CONFIG_PACKAGE_luci-app-argon is not set'
hasnt "没把应用硬补成 =y"             'CONFIG_PACKAGE_luci-app-argon=y'
inlog "驱动来自源码补充也照补"          '机型声明的驱动在源码补充（configs/*.config）里是 is not set'
has   "-变体里的包被排除"              'CONFIG_TARGET_airoha_an7581=y'
hasnt "-变体里的包被当成要装的"        'CONFIG_PACKAGE_kmod-dropped=y'
inlog "说明里点出补了哪些包"            '声明、配置里却没有的包'
inlog "说明里点出应用是发行版默认关的"  '机型声明的应用在源码补充里是 is not set'

echo
echo "gen-config: $pass 通过, $fail 失败"
[ "$fail" -eq 0 ]
