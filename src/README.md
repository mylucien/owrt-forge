# 前端源码

`worker/index.js` 里内联的 `APP_CSS`、`APP_JS` 两个模板字符串由这里的文件生成，**不要直接改 worker/index.js 里的样式和脚本**——下次运行注入脚本会被覆盖。

```
src/app.css              设计令牌（颜色/间距/圆角）、布局骨架、基础组件
src/prod/extra.css       登录页、模板详情表格、设置页等补充样式
src/prod/app.part1.js    图标表、API 封装、状态、路由、应用骨架
src/prod/app.part2.js    模板列表页、模板详情页
src/prod/app.part3.js    插件商店、编译记录、设置页、弹窗、启动流程
```

## 改完怎么生效

```bash
python3 tools/build_ui.py                      # 就地更新 worker/index.js
python3 tools/build_ui.py --check              # 只检查 src 是否已同步（可放进 CI）
python3 tools/build_ui.py --preview out.html   # 另存静态页，直接双击看样式
```

注入是幂等的：只替换两个模板字符串内部的内容，后端代码和 `/*CATALOG:BEGIN*/` 内置目录都原样保留，所以 `tools/build_ui.py`（本脚本）和 `tools/build_worker.py`（嵌入插件目录）可以按任意顺序反复运行。

`--preview` 生成的静态页没有 Worker 接口，打开会是登录页，只适合调样式和布局；要连真实数据得部署 Worker，或者自己起一个假的 `/api/*`。

## 约定

- 不引入外部依赖：没有框架、没有构建工具、没有 CDN 字体或图标，全部手写 CSS + 原生 JS，图标是内联 SVG。Worker 免费版限制 1 MiB，整份 `worker/index.js` 约 320 KB（gzip 后约 75 KB）。
- 颜色一律走 `src/app.css` 里的 CSS 变量，深色模式靠 `[data-theme="dark"]` 覆盖同一批变量，不要写死颜色值。
- 所有接口调用集中在 `app.part1.js` 的 `api` 对象里，路径与 `worker/index.js` 的后端路由一一对应；改接口时两边一起改。
- 用户可控的内容一律经过 `esc()` 再插入 HTML。
