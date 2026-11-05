#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按「符号级别」合并 .config —— 底稿 / 源码补充 / 模板 三个来源，分级取值。

为什么不能直接 `cat` 三份拼起来：
  一个 .config 里同时含 L1~L5 五种级别。整份拼接等于「按文件」覆盖：
  底稿一份 254 行的快照会把 L4 的包、L5 的内核选项一起顶掉，模板的插件清单
  又会被压在包这一级的中间 —— 结果是「谁最后写谁赢」，跟你想表达的
  「型号听底稿、其它按优先级补」不是一回事，还会把别的机型的包一并带进来。

级别与各自治的优先级（同级别内后者不覆盖前者，跨级别互不影响）：

  T0 明确关闭      `# CONFIG_X is not set` / `=n`
                   合并结果里显式关掉的符号是最高一级：后面的补包（机型声明的
                   DEVICE_PACKAGES）不会再把它们打开，驱动也不例外。合并阶段仍按
                   来源优先级取值 —— 底稿写了 =y、源码补充写了 is not set，是底稿赢；
                   赢下来的那个值如果是「关闭」，它就是 T0，谁也不能再翻。
                   但「谁说的关闭」要分开：底稿是写配置的人的决定（=user，真 T0）；
                   源码补充（configs/*.config）是整份发行版配置，里面成千上万个
                   is not set 只是发行版默认（=seed），机型声明的驱动仍要补成 =y，
                   否则又回到「固件里少一层驱动、编译却不报错」。两者通过
                   --emit-off 交给调用方（write-dotconfig.sh → device-packages.sh）。

  L1 平台/子目标   CONFIG_TARGET_<m>=y、CONFIG_TARGET_<m>_<s>=y
                   只认本次任务的 target；其它平台的行一律丢弃。
  L2 机型          CONFIG_TARGET_<m>_<s>_DEVICE_<p>=y（单选）
                   CONFIG_TARGET_DEVICE_<m>_<s>_DEVICE_<p>=y（多选）
                   CONFIG_TARGET_MULTI_PROFILE / ALL_PROFILES / PER_DEVICE_ROOTFS
                   底稿 > 模板。源码 configs/*.config 里的这类行不参与：那是
                   「这份发行版默认编哪些设备」，留着会把选中的机型清掉
                   （gen-config.sh 里有同样的说明）。最终只留一个（或底稿指定的一组）。
  L3 目标选项      CONFIG_TARGET_DEVICE_PACKAGES_<...>（机型包增量）、
                   CONFIG_TARGET_ROOTFS_*、CONFIG_TARGET_IMAGES_* 等
                   底稿 > 源码补充 > 模板；只保留选中机型的 DEVICE_PACKAGES。
  L4 包            CONFIG_PACKAGE_*=y/m/n、# CONFIG_PACKAGE_x is not set
                   底稿 > 源码补充 > 模板插件清单
  L5 内核/其它     CONFIG_KERNEL_* 及其它所有符号
                   底稿 > 源码补充 > 模板

用法：
  config-merge.py --target airoha/an7581 --profile fiberhome_hg5382a \
                  --snapshot /tmp/dotconfig.snapshot --seed /tmp/cfg-seed \
                  --template /tmp/cfg-template --out openwrt/.config \
                  [--emit-off /tmp/cfg-off]
报告打到 stdout（`NOTE ` 开头的中文说明 + `EP=` 生效机型），由调用方写进构建说明。
--emit-off 写出的每行是 `<user|seed> <包名>`：合并结果里被明确关闭的包，以及是谁关的。
"""

import argparse
import os
import re
import sys

UNSET = 'n'                                  # `# CONFIG_X is not set` 的内部表示
SYM_RE = re.compile(r'^(CONFIG_[A-Za-z0-9_.+-]+)=(.*)$')
UNSET_RE = re.compile(r'^#\s*(CONFIG_[A-Za-z0-9_.+-]+) is not set\s*$')

L1_PLATFORM, L2_DEVICE, L3_TARGET, L4_PACKAGE, L5_OTHER = 1, 2, 3, 4, 5
LEVEL_NAME = {1: '平台', 2: '机型', 3: '目标选项', 4: '包', 5: '内核/其它'}

MULTI_SWITCHES = ('CONFIG_TARGET_MULTI_PROFILE',
                  'CONFIG_TARGET_ALL_PROFILES',
                  'CONFIG_TARGET_PER_DEVICE_ROOTFS')

MAX_EXAMPLES = 6


def read_symbols(path):
    """读一个配置文件，返回 [(key, value)]：`# CONFIG_X is not set` 记为 ('CONFIG_X', 'n')。

    只取符号行，注释与空行丢掉（defconfig 之后本来也会重写）。
    用 utf-8-sig 读：Windows 记事本存的底稿带 BOM，否则第一行会被悄悄丢掉（机型行正好
    常在开头，结果是静默换成模板的机型）；行尾空白一并去掉，免得 `CONFIG_X=y ` 判不出来。
    """
    res = []
    if not path or not os.path.isfile(path):
        return res
    with open(path, encoding='utf-8-sig', errors='replace') as fh:
        for raw in fh:
            line = raw.rstrip()
            m = SYM_RE.match(line)
            if m:
                res.append((m.group(1), m.group(2)))
                continue
            m = UNSET_RE.match(line)
            if m:
                res.append((m.group(1), UNSET))
    return res


def level_of(key, plat, subm):
    """判断一个符号属于哪一级（key 带 `CONFIG_` 前缀）。"""
    name = key[len('CONFIG_'):] if key.startswith('CONFIG_') else key
    if name.startswith('TARGET_'):
        rest = name[len('TARGET_'):]
        if rest.startswith('DEVICE_PACKAGES_'):
            return L3_TARGET                      # 机型包增量，属于「目标选项」这一级
        if rest in ('MULTI_PROFILE', 'ALL_PROFILES', 'PER_DEVICE_ROOTFS'):
            return L2_DEVICE
        if '_DEVICE_' in rest:
            return L2_DEVICE                      # 单选 / 多选两种机型写法
        if rest == plat or rest == '%s_%s' % (plat, subm):
            return L1_PLATFORM
        # 平台与子目标都是小写单词（airoha、mediatek_filogic、x86_64）；
        # TARGET_ROOTFS_*/TARGET_KERNEL_* 这些选项一律以大写开头，不会被误判
        if re.fullmatch(r'[a-z0-9]+(_[a-z0-9]+)*', rest):
            return L1_PLATFORM
        return L3_TARGET                          # TARGET_ROOTFS_* 等
    if name.startswith('PACKAGE_'):
        return L4_PACKAGE
    return L5_OTHER


def device_prefixes(plat, subm):
    """两种机型写法的前缀。多选的那条更长，先试它。

        单选  CONFIG_TARGET_<m>_<s>_DEVICE_<id>
        多选  CONFIG_TARGET_DEVICE_<m>_<s>_DEVICE_<id>      （TARGET_MULTI_PROFILE=y 时才有）
    """
    if subm:
        return ('CONFIG_TARGET_DEVICE_%s_%s_DEVICE_' % (plat, subm),
                'CONFIG_TARGET_%s_%s_DEVICE_' % (plat, subm))
    return ('CONFIG_TARGET_DEVICE_%s_DEVICE_' % plat,
            'CONFIG_TARGET_%s_DEVICE_' % plat)


def device_id(key, plat, subm):
    """从机型行里取出机型 id；不是本 target 的机型行返回 ''。

    必须按前缀剥，不能用 split('_DEVICE_', 1)：多选写法里第一个 `_DEVICE_` 出现在
    `TARGET_DEVICE_` 处，split 会取出 `airoha_an7581_DEVICE_nokia_xg-040g-md-ubi`
    这种垃圾，后面校验机型行、匹配 DEVICE_PACKAGES 全部对不上。
    按前缀剥还顺带把别的平台的机型行和 MULTI_PROFILE/PER_DEVICE_ROOTFS 这类
    名字里带 `_DEVICE_` 的开关排除掉了（前缀对不上）。
    """
    if key in MULTI_SWITCHES:
        return ''
    for pref in device_prefixes(plat, subm):
        if key.startswith(pref) and len(key) > len(pref):
            return key[len(pref):]
    return ''


def device_keys(syms, plat, subm):
    """取这个来源里 `=y` 的机型行（单选与多选两种写法都算，只认本 target）。"""
    out = []
    for key, val in syms:
        if val != 'y':
            continue
        if key.startswith('CONFIG_TARGET_DEVICE_PACKAGES_'):
            continue
        if key in MULTI_SWITCHES:      # PER_DEVICE_ROOTFS 的名字里也有 _DEVICE_
            continue
        if device_id(key, plat, subm):
            out.append(key)
    return out


def foreign_device_rows(syms, plat, subm):
    """名字像机型行、却不属于本次 target 的（别的平台、别的子目标）。

    这些行按级别被丢掉是对的（留着会把选中的机型清掉），但要告诉用户一声：
    底稿是从别的平台存下来的时候，用户只会看到「机型没生效」，看不出是这一行的问题。
    """
    out = []
    for key, val in syms:
        if val != 'y' or key in MULTI_SWITCHES:
            continue
        if key.startswith('CONFIG_TARGET_DEVICE_PACKAGES_'):
            continue
        if level_of(key, plat, subm) != L2_DEVICE:
            continue
        if device_id(key, plat, subm):
            continue
        out.append(key)
    return out


def render(key, val):
    return '# %s is not set' % key if val == UNSET else '%s=%s' % (key, val)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', required=True, help='例 airoha/an7581')
    ap.add_argument('--profile', default='', help='模板机型（可空）')
    ap.add_argument('--snapshot', default='', help='固定底稿（可空）')
    ap.add_argument('--seed', default='', help='源码补充配置（可空）')
    ap.add_argument('--template', default='', help='模板生成的机型/插件行（可空）')
    ap.add_argument('--out', required=True)
    ap.add_argument('--emit-off', default='',
                    help='写出合并结果里被明确关闭的包：每行 `user <包>`（底稿）或 `seed <包>`（源码补充）')
    a = ap.parse_args()

    if '/' in a.target:
        plat, subm = a.target.split('/', 1)
    else:
        plat, subm = a.target, ''

    snap = read_symbols(a.snapshot)
    seed = read_symbols(a.seed)
    tpl = read_symbols(a.template)
    notes = []

    # ---------------- L2 机型：只有底稿和模板参与 ----------------
    dsnap = device_keys(snap, plat, subm)
    dtpl = device_keys(tpl, plat, subm)
    if dsnap:
        chosen, dev_src = dsnap, '底稿'
    elif dtpl:
        chosen, dev_src = dtpl, '模板'
    else:
        chosen, dev_src = [], '无'
    if not chosen and a.profile:
        # 模板文件里没写机型行（非预期），仍按模板机型兜一下
        chosen = ['CONFIG_TARGET_%s_%s_DEVICE_%s' % (plat, subm, a.profile)]
        dev_src = '模板'
    dev_ids = [d for d in (device_id(k, plat, subm) for k in chosen) if d]
    ep = dev_ids[0] if dev_ids else ''

    multi_on = False
    multi_src = ''
    for name, syms in (('底稿', snap), ('模板', tpl)):
        for key, val in syms:
            if key in MULTI_SWITCHES and val == 'y':
                multi_on, multi_src = True, name
                break
        if multi_on:
            break
    # 单选写法底下 MULTI_PROFILE 必须是关的，否则 choice 会被清掉、不出镜像
    multi_fmt = device_prefixes(plat, subm)[0]
    if multi_on and not any(k.startswith(multi_fmt) for k in chosen):
        multi_on = False

    # ---------------- L3/L4/L5：三来源按级别取最高优先 ----------------
    entries = {}
    for src, prio, syms in (('底稿', 0, snap), ('源码补充', 1, seed), ('模板', 2, tpl)):
        for key, val in syms:
            lv = level_of(key, plat, subm)
            if lv in (L1_PLATFORM, L2_DEVICE):
                continue                      # L1 由 --target 决定，L2 上面单独处理
            if key.startswith('CONFIG_TARGET_DEVICE_PACKAGES_'):
                if not any(key.endswith('_DEVICE_' + d) for d in dev_ids):
                    continue                  # 别的机型的包增量，留着没意义
            entries.setdefault(key, []).append((prio, val, src))

    best = {}
    for key, lst in entries.items():
        top = min(p for p, _, _ in lst)               # 优先级数字越小越优先
        same = [x for x in lst if x[0] == top]
        prio, val, src = same[-1]                     # 同一来源里重复出现，后写的生效
        best[key] = (prio, val, src, lst if len(lst) > len(same) else [])

    out = ['CONFIG_TARGET_%s=y' % plat]
    if subm:
        out.append('CONFIG_TARGET_%s_%s=y' % (plat, subm))
    if multi_on:
        out.append('CONFIG_TARGET_MULTI_PROFILE=y')
        # 多设备模式下底稿/模板若开着 per-device rootfs（每台机各一份 rootfs），一并带上。
        # 单选时它也不能留：Kconfig 里 depends on TARGET_MULTI_PROFILE，留着反而是脏配置。
        src_syms = snap if multi_src == '底稿' else tpl
        if any(k == 'CONFIG_TARGET_PER_DEVICE_ROOTFS' and v == 'y' for k, v in src_syms):
            out.append('CONFIG_TARGET_PER_DEVICE_ROOTFS=y')
        notes.append('机型走多设备模式（来自%s）' % multi_src)
    for key in chosen:
        out.append('%s=y' % key)

    counts = {1: 2 if subm else 1, 2: len(chosen) + (1 if multi_on else 0)}
    for lv in (L3_TARGET, L4_PACKAGE, L5_OTHER):
        keys = sorted(k for k in best if level_of(k, plat, subm) == lv)
        counts[lv] = len(keys)
        for key in keys:
            out.append(render(key, best[key][1]))

    with open(a.out, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('\n'.join(out) + '\n')

    # 明确关闭的包要连同「谁关的」一起交出去：底稿 = 用户的决定，源码补充 = 发行版默认。
    # 后面 device-packages.sh 靠它决定补不补机型声明的包（源码补充关掉的驱动仍要补 =y）。
    off_user, off_seed = [], []
    for key, (prio, val, src, _o) in sorted(best.items()):
        if val != UNSET or level_of(key, plat, subm) != L4_PACKAGE:
            continue
        (off_user if src == '底稿' else off_seed).append(key[len('CONFIG_PACKAGE_'):])
    if a.emit_off:
        with open(a.emit_off, 'w', encoding='utf-8', newline='\n') as fh:
            for p in off_user:
                fh.write('user %s\n' % p)
            for p in off_seed:
                fh.write('seed %s\n' % p)

    # ---------------- 报告 ----------------
    print('EP=%s' % ep)
    print('NOTE 配置合并：平台 %s；机型 %s（%s）' %
          (a.target, ', '.join(dev_ids) if dev_ids else '未指定', dev_src))
    if a.profile and dev_ids and a.profile not in dev_ids:
        print('NOTE 模板机型 %s 与底稿机型 %s 不一致 —— 按「型号听底稿」编 %s，'
              '不按 %s 校验/补包' % (a.profile, ', '.join(dev_ids), dev_ids[0], a.profile))
    print('NOTE 分级写入：%s' % '、'.join(
        '%s %d' % (LEVEL_NAME[lv], counts[lv]) for lv in (1, 2, 3, 4, 5)))
    if off_user:
        print('NOTE T0 明确关闭：底稿关了 %d 个包，后面的补包不会打开它们' % len(off_user))
    if off_seed:
        print('NOTE 源码补充自带关闭 %d 个包（发行版默认，不是你的选择；机型声明的驱动仍会补成 =y）' %
              len(off_seed))
    for n in notes:
        print('NOTE %s' % n)

    over = []
    for key, (prio, val, src, others) in sorted(best.items()):
        if not others:
            continue
        # 只有取值真的不同才算「压掉」。底稿和源码补充都写 =y 的包满地都是（整份底稿几千行），
        # 以前它们会把 6 个示例名额占满，真正被改掉的那几行反而看不到。
        lost = sorted({(p, s, v) for p, v, s in others if p > prio and v != val})
        if not lost:
            continue
        lv = level_of(key, plat, subm)
        over.append((lv, key, src, val, lost[-1]))
    if over:
        for lv, key, src, val, (lp, lsrc, lval) in over[:MAX_EXAMPLES]:
            print('NOTE · %s：%s 取 %s（%s=%s，压掉 %s=%s）' %
                  (LEVEL_NAME[lv], key.replace('CONFIG_', '', 1),
                   '关' if val == UNSET else val, src,
                   'n' if val == UNSET else val, lsrc, 'n' if lval == UNSET else lval))
        if len(over) > MAX_EXAMPLES:
            print('NOTE · ……另有 %d 个符号按同一规则取值' % (len(over) - MAX_EXAMPLES))

    # 模板里勾选的插件，最终被别的来源压成关闭或 =m。
    # 拿整份 .config 当底稿时最容易踩：页面上勾着的插件静默失效，固件里没有它，
    # 而上面那段「覆盖明细」只列前几个符号，插件商店用户根本看不到自己那条。
    # 这里按包名点名，调用方（write-dotconfig.sh）据此发 ::warning::。
    tpl_pkgs = {k for k, v in tpl if v == 'y' and level_of(k, plat, subm) == L4_PACKAGE}
    down = []
    for key in sorted(tpl_pkgs):
        if key not in best:
            continue
        prio, val, src, _ = best[key]
        if src == '模板':
            continue
        if val in (UNSET, 'n', 'm'):
            down.append((key[len('CONFIG_PACKAGE_'):], '关闭' if val in (UNSET, 'n') else '=m',
                         src))
    print('TPL_DOWN=%d' % len(down))
    for name, how, src in down[:MAX_EXAMPLES]:
        print('TPL_ITEM %s（模板选了，%s 改成%s）' % (name, src, how))

    alien = sorted({k for k, _ in snap + seed + tpl
                    if level_of(k, plat, subm) == L1_PLATFORM
                    and k not in ('CONFIG_TARGET_%s' % plat,
                                  'CONFIG_TARGET_%s_%s' % (plat, subm))})
    if alien:
        names = [k.replace('CONFIG_', '', 1) for k in alien]
        print('NOTE 已丢弃其它平台的行 %d 项：%s%s' %
              (len(names), '、'.join(names[:5]), ' 等' if len(names) > 5 else ''))
    fo = sorted(set(foreign_device_rows(snap, plat, subm))
                | set(foreign_device_rows(seed, plat, subm))
                | set(foreign_device_rows(tpl, plat, subm)))
    if fo:
        names = [k.replace('CONFIG_', '', 1) for k in fo]
        print('NOTE 已丢弃不属于本次 target 的机型行 %d 项：%s%s' %
              (len(names), '、'.join(names[:5]), ' 等' if len(names) > 5 else ''))

    return 0


if __name__ == '__main__':
    sys.exit(main())
