#!/usr/bin/env python3
"""把 src/ 下的前端源码注入 worker/index.js 的 APP_CSS / APP_JS。

前端源码分两部分：
    src/app.css          设计令牌、布局、基础组件
    src/prod/extra.css   登录页、表格、设置页等补充样式
    src/prod/app.part1-3.js  图标与 API 封装 / 模板页与详情 / 商店、记录、设置

worker/index.js 里只保留两个模板字符串 APP_CSS、APP_JS，后端代码原样不动。
脚本可以反复运行：只替换两个字符串内部的内容，CATALOG 内置目录和后端都不动。

用法：
    python3 tools/build_ui.py            # 就地更新 worker/index.js
    python3 tools/build_ui.py --check    # 只检查 src 是否已同步（CI 可用）
    python3 tools/build_ui.py --preview dist/preview.html   # 另存一份静态页，方便本地看
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKER = ROOT / "worker" / "index.js"

CSS_FILES = ["src/app.css", "src/prod/extra.css"]
JS_FILES = ["src/prod/app.part1.js", "src/prod/app.part2.js", "src/prod/app.part3.js"]

CSS_OPEN = "const APP_CSS = `"
JS_OPEN = "const APP_JS = `"
CLOSE = "\n  `;"
TITLE_OLD = "<title>OpenWrt 自动编译</title>"
TITLE_NEW = "<title>固件工坊 · OpenWrt 编译台</title>"


def embed(text: str) -> str:
    """转义成模板字符串内容：反斜杠、反引号、${"""
    return re.sub(r"[\\`]|\$\{", lambda m: "\\" + m.group(0), text)


def build_css() -> str:
    parts = []
    for name in CSS_FILES:
        p = ROOT / name
        if not p.is_file():
            raise SystemExit("缺少样式文件：" + name)
        parts.append(p.read_text(encoding="utf-8").rstrip())
    return "\n\n".join(parts)


def build_js() -> str:
    parts = []
    for name in JS_FILES:
        p = ROOT / name
        if not p.is_file():
            raise SystemExit("缺少脚本文件：" + name)
        parts.append(p.read_text(encoding="utf-8").rstrip())
    return "\n\n".join(parts) + "\n"


def splice(source: str, css: str, js: str) -> str:
    """只替换两个模板字符串内部的内容，其余代码（后端、内置目录）逐字保留。"""
    i_css = source.find(CSS_OPEN)
    i_js = source.find(JS_OPEN)
    if i_css < 0 or i_js < 0:
        raise SystemExit("worker/index.js 里找不到 APP_CSS / APP_JS 模板字符串")
    j_js = source.find(CLOSE, i_js)
    if j_js < 0:
        raise SystemExit("worker/index.js 里找不到 APP_JS 的结束标记")
    j_js += len(CLOSE)
    out = (
        source[:i_css]
        + CSS_OPEN + "\n" + embed(css) + CLOSE
        + "\n\n  "
        + JS_OPEN + "\n" + embed(js) + CLOSE
        + source[j_js:]
    )
    # 页面标题跟着前端的名字走（重复运行不会二次替换）
    return out.replace(TITLE_OLD, TITLE_NEW)


def main() -> int:
    check = "--check" in sys.argv
    preview = None
    if "--preview" in sys.argv:
        preview = pathlib.Path(sys.argv[sys.argv.index("--preview") + 1])

    css, js = build_css(), build_js()
    src = WORKER.read_text(encoding="utf-8")
    out = splice(src, css, js)

    if out == src:
        print("worker/index.js 已是最新（%d 字节）" % len(src.encode()))
        if check:
            return 0
    elif check:
        print("worker/index.js 与 src/ 不一致，请运行 python3 tools/build_ui.py")
        return 1
    else:
        WORKER.write_text(out, encoding="utf-8", newline="")
        print("已更新 worker/index.js：%d → %d 字节" % (len(src.encode()), len(out.encode())))

    if preview:
        html = (
            "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\" />\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n"
            "<title>固件工坊 · 预览</title>\n<style>\n" + css + "\n</style>\n</head>\n"
            "<body data-theme=\"light\">\n<div id=\"app\"></div>\n<script>\n" + js
            + "\n</script>\n</body>\n</html>\n"
        )
        preview.parent.mkdir(parents=True, exist_ok=True)
        preview.write_text(html, encoding="utf-8", newline="")
        print("已生成预览页 %s（%d 字节）" % (preview, len(html.encode())))

    print("css %.1f KB / %d 行，js %.1f KB / %d 行" % (
        len(css.encode()) / 1024, css.count("\n") + 1,
        len(js.encode()) / 1024, js.count("\n") + 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
