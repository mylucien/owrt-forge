#!/usr/bin/env python3
"""测试用的 jq 桩：只认 scripts/*.sh 用到的那几种 filter。

不装 jq 也能跑回归（Windows 的 Git Bash 里通常没有 jq）。
遇到没实现的 filter 直接报错退出 —— 宁可测试自己炸，也不能让它静默返回空。
"""
import json
import re
import sys

args = [a for a in sys.argv[1:] if a not in ('-r', '-e', '-j')]
flt = [a for a in args if a[:1] in '.('][0]
path = [a for a in args if a not in (flt,)][-1]
d = json.load(open(path, encoding='utf-8'))
pkgs = d.get('packages') or []

if 'length' in flt:
    print(len(pkgs))
elif flt == '.dotconfig_snapshot':
    sys.stdout.write((d.get('dotconfig_snapshot') or '').rstrip('\n') + '\n')
elif flt.startswith('.target'):
    print(d.get('target') or '')
elif flt.startswith('.profile'):
    print(d.get('profile') or '')
elif 'CONFIG_PACKAGE_' in flt:
    for p in pkgs:
        if re.fullmatch(r'[A-Za-z0-9_.+-]+', p):
            print('CONFIG_PACKAGE_%s=y' % p)
elif flt.startswith('.packages[]'):
    for p in pkgs:
        print(p)
else:
    sys.exit('jq 桩不支持的 filter: %s' % flt)
