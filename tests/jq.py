#!/usr/bin/env python3
"""极简 jq 桩：只实现 cache.sh / workflow 里用到的几种 filter，用于本机回归测试。

支持：
  jq -r --arg k name '.[$k] // ""' f.json
  jq -r '[.target // "", ...] | @tsv' f.json
  jq -r '.target // ""' f.json          （.profile / .commit 同理）
  jq -r '(.target // "") + " " + (.profile // "")' f.json
  jq -r '.cache_publish // false' f.json
  jq -Rrs --argjson n 300 'rtrimstr("\n") | .[0:$n]'      （走 stdin）
  jq -n --arg/--argjson ... '{k:$v,...}'                  （构造 JSON）
"""
import json
import re
import sys

argv = sys.argv[1:]
flags = set()
opts = {'arg': {}, 'argjson': {}}
pos = []
i = 0
while i < len(argv):
    a = argv[i]
    if a in ('--arg', '--argjson'):
        opts[a[2:]][argv[i + 1]] = argv[i + 2]
        i += 3
    elif a.startswith('--'):
        i += 2 if a in ('--tab', '--indent', '--sort-keys') else 1
    elif a.startswith('-') and len(a) > 1:
        for ch in a[1:]:
            flags.add(ch)
        i += 1
    else:
        pos.append(a)
        i += 1

filt = pos[0] if pos else ''
norm = ' '.join(filt.split())

data = None
if 'n' not in flags:
    files = [p for p in pos[1:] if p != '-']
    if files:
        txt = open(files[0], encoding='utf-8', errors='replace').read()
    else:
        txt = sys.stdin.read()
    if 'R' in flags:
        data = txt if 's' in flags else (txt.splitlines()[0] if txt else '')
    else:
        try:
            data = json.loads(txt) if txt.strip() else None
        except Exception:
            data = None


def out(v):
    if isinstance(v, (dict, list)):
        sys.stdout.write(json.dumps(v, ensure_ascii=False) + '\n')
    elif v is None:
        sys.stdout.write('null\n')
    elif isinstance(v, bool):
        sys.stdout.write(('true' if v else 'false') + '\n')
    else:
        sys.stdout.write(str(v) + '\n')


obj = data if isinstance(data, dict) else {}

if 'n' in flags and norm.startswith('{'):
    pairs = re.findall(r'([A-Za-z_]\w*)\s*:\s*\$([A-Za-z_]\w*)', filt)
    res = {}
    for k, v in pairs:
        if v in opts['argjson']:
            res[k] = json.loads(opts['argjson'][v])
        else:
            res[k] = opts['arg'].get(v, '')
    out(res)
elif norm == '.[$k] // ""':
    out(obj.get(opts['arg'].get('k', ''), '') or '')
elif norm.startswith('[.target') and norm.endswith('@tsv'):
    row = [
        obj.get('target') or '',
        obj.get('profile') or '',
        obj.get('commit') or '',
        str(obj.get('ccache_hits') if obj.get('ccache_hits') is not None else ''),
        str(obj.get('ccache_total') if obj.get('ccache_total') is not None else ''),
    ]
    sys.stdout.write('\t'.join(row) + '\n')
elif norm in ('.target // ""', '.profile // ""', '.commit // ""'):
    key = norm.split('.')[1].split()[0]
    out(obj.get(key) or '')
elif norm == '(.target // "") + " " + (.profile // "")':
    out('%s %s' % (obj.get('target') or '', obj.get('profile') or ''))
elif norm == '.cache_publish // false':
    out(bool(obj.get('cache_publish', False)))
elif norm.startswith('rtrimstr("\\n")'):
    n = int(opts['argjson'].get('n', 300))
    sys.stdout.write((data or '').rstrip('\n')[:n] + '\n')
elif norm == '.assets|length':
    out(len(obj.get('assets') or []))
elif norm == '[.assets[].size]|add // 0':
    out(sum((a.get('size') or 0) for a in (obj.get('assets') or [])))
else:
    sys.stderr.write('jq stub: 未实现的 filter: %r\n' % norm)
    sys.exit(3)
