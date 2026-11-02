# 固件工坊（owrt-forge 改版）

在原项目基础上：插件商店式选择、清单直编（可不进 menuconfig）、状态机与排队、失败原因回显。

## 部署（比原版少两步）
1. 把 `worker/index.js` 粘贴到 Cloudflare Worker，绑定 D1（变量名 `DB`）并设置 Secret `MASTER_KEY`。
   **不用再手动建表**：首次请求会自动建表并迁移新增列。
2. 把 `.github/workflows/build-openwrt.yml` 和 `scripts/` 放进你的 public 编译仓库。
3. 仓库 Secrets：`REPORT_TOKEN`（部署向导生成）；仅在需要 menuconfig 时才需要 `TTYD_USER`、`TTYD_PASS`；私有插件仓库用 `SSH_PRIVATE_KEY` 或 `PLUGIN_GIT_TOKEN`（二选一，见下）。

## 使用
流程分两页：

1. **插件商店（选）**：选源码项目 → 平台 → 子平台 → 机型（三个都是下拉选框，不能手填；机型很多时可用旁边的输入框筛选）→ 勾选插件 → 点「生成模板」。
   - 目录里没有的插件：点「＋ 自定义插件」，填 GitHub 仓库地址，自动识别包名（整仓是一个包，或仓库里有多个包都行），添加后和目录里的插件一起出现，带「自定义」标记。**编译时会运行该仓库的代码，只添加信任的仓库。**
   - 目录里没有的源码：在项目下拉框最后一项「＋ 添加 / 管理自定义项目…」添加 GitHub 仓库（平台和机型靠 GitHub API 读取，所以只支持 GitHub）。
2. **模板页（确认、编译、复用）**：确认机型、插件清单、将写入的配置行，需要时开 menuconfig、固定配置底稿、设定定时，然后点「编译」。
   - 要改机型或加插件：点「编辑机型和插件」回到商店，已选内容会原样回填，保存后回到模板页。移除插件可直接在模板页点 ×。
   - 以后要编译，在模板列表里找到它点「编译」即可；定时编译用的也是同一个模板。

### 自定义插件的包名
`.config` 里启用的是**包名**（Makefile 里的 `PKG_NAME` / `BuildPackage`），不是目录名。「识别」会读取 Makefile 得到真实包名；一个目录里定义了多个包时，其余的会作为自动依赖一起启用。克隆后还会自动把 `include ../../luci.mk` 这类相对路径改成 `$(TOPDIR)/feeds/luci/luci.mk`，否则 luci 应用会被 OpenWrt 扫描时悄悄丢掉。编译前校验失败时，构建记录会逐个写明：源码里有没有这个包、自定义仓库里实际定义了哪些包名。

### 插件仓库拉不下来时
克隆前会打印 `[插件] 名字 <- 地址 (分支)`；失败时 `::error::` 直接写明是哪个插件、哪个地址，并带上 git 的原始错误——不再只有一句 `could not read Username for 'https://github.com'`。

- 地址写错、仓库改名或删除、仓库转私有，在 git 眼里都是「要凭据」（GitHub 对私有仓库返回 404，git 于是去问用户名）。Actions 没有终端，所以直接 128。
- 私有仓库二选一：
  - Secret `SSH_PRIVATE_KEY`（部署密钥），地址填 `git@github.com:owner/repo.git`；
  - Secret `PLUGIN_GIT_TOKEN`（有 repo 读权限的 PAT），地址继续用 `https://…`。脚本把它写进 `~/.gitconfig` 的 `http.https://github.com/.extraheader`，不放进 URL，退出时清掉。
- 地址写成 `https://…` 但只配了 SSH key：脚本会自动换成 `git@github.com:…` 重试一次，成功则继续。
- 任一插件拉取失败都会**中止并列出全部失败项**，不静默跳过——少个插件编出来的固件更难查。

### 配置是怎么生成的
编译时先合并**源码仓库自带的发行版默认配置**，再让源码生成该机型的**默认配置**，然后把所选插件合并进去，最后逐项校验：机型不存在、或有插件没生效（依赖缺失 / 源码里没有这个包），任务会在**编译前**直接失败，并在构建记录里写明是哪几个，不会等几小时后才发现。

### 源码自带的默认配置（configs/）
有些分支（ponwrt、immortalwrt 衍生版等）会把「本发行版默认启用」的包放在源码的 `configs/` 里，官方构建是 `kconfig.pl + configs/<subtarget>.config configs/release.config`。这些包通常**不在** `target.mk` 的 `DEFAULT_PACKAGES` 里，只写机型再 defconfig 是拿不到的——ponwrt 的整条 PON 栈（`kmod-airoha-xpon`、`kmod-airoha-pon-frontend`、`kmod-airoha-en7572`、`airoha-pond`）就是这种情况，少了它固件能刷能开机，但光口永远起不来。

现在按 `configs/<subtarget>.config` → `configs/<board>_<subtarget>.config` → `configs/release.config` 的顺序合并（后写覆盖先写），并剔除其中 `MULTI_PROFILE`、`PER_DEVICE_ROOTFS` 和其他机型的 `DEVICE_=` 行。这两个开关不是「开着只是变慢」：`MULTI_PROFILE=y` 会把 choice 里选中的机型清成 `is not set`，构建时该机型被判为 `install-disabled`，编译通过但不出镜像；`PER_DEVICE_ROOTFS` 在 Kconfig 里 `depends on TARGET_MULTI_PROFILE`，单选机型下本来也开不了。单选 choice 自身会 `select` target 的 `DEFAULT_PACKAGES` 与机型的 `DEVICE_PACKAGES`，不依赖它们。源码没有 `configs/` 时行为不变。

`=m` 不算「已启用」。OpenWrt 里 `CONFIG_PACKAGE_x=m` 只表示把它编成 ipk 放进软件源、**不进固件**；而 `configs/` 里的快照常常留着上一次构建的 `=m`，它会把 kconfig 的默认值压掉（每个包是 `default y if DEFAULT_<pkg>`，机型的 `DEVICE_PACKAGES` 正是通过 `select DEFAULT_<pkg>` 生效的）。所以合并了 `configs/` 也只是第一步。

选中机型之后还会按 `tmp/.targetinfo` 里这台机器声明的 `DEVICE_PACKAGES`（make 展开后的最终列表，已经算过 `+=` 与 `-包名`）逐个核对，没到 `=y` 的补上再 defconfig；补不上的驱动（`kmod-*`、`*-firmware`）**直接失败**并指出是配置里哪一行把它写成了 `=m`。两个例外，避免顶掉你的选择：机型要的包已换成同类（`wpad-openssl` → `wpad-basic-mbedtls`，按 `Provides` 判断）不重复装；底稿里显式 `is not set` 的应用保持关闭。

这些自动动作会在**构建日志里直接打印**（同时写进构建说明），例如：

```
机型 nokia_xg-040g-md-ubi 声明、配置里却没有的包：fitblk kmod-airoha-en7572 … → 补成 =y 后重新 defconfig
```

看到这行说明配置被自动修正过；一行都没有，代表你的配置本来就是对的。

### 配置底稿
- 默认**不固定**：每次编译（包括定时）都按模板的机型和插件清单重新生成，能跟上源码的变化。
- 在 menuconfig 里调过的配置会保存成「.config 版本」，但**不会自动固定**；要沿用它，在模板页「编译选项」里选择「固定为：该版本」。固定后编译以该版本为准，不再叠加机型与插件清单。手动编译和定时编译共用这个设置。
- 固定底稿时源码 `configs/*.config` 仍会**兜底**：底稿里没提到的符号由源码默认值补上，底稿里明确写了的（含 `# ... is not set`）仍以底稿为准，所以「故意去掉某个包」的语义不变。合并后会审计一遍，把「源码默认启用、但底稿没带上」的包写进构建说明并给一条告警，避免底稿不完整导致固件静默少驱动。机型声明的驱动同样不允许缺：底稿里写成 `=m` 的会被补成 `=y`，补不上直接失败（`=m` 只编 ipk，固件里没有）。

### 编译缓存（ccache，可选）
重复编译同一类固件时，可以把某次编译的 ccache 缓存发布出来，下次编译取回来用，省掉重复的编译时间。默认不启用。
- **发布**：模板页「编译选项」勾选「编译完成后发布缓存」；或在编译进行中点构建记录上的「完成后发布缓存」。缓存只存在于编译机上，编译结束后就没有了，所以必须在结束前设置。
- **使用**：模板页「编译选项」里的「编译缓存」选「使用同平台最新的缓存」或指定某一份。手动编译和定时编译共用这个设置。
- 缓存以 `cache-<构建ID>` 的 Release（预发布）存放在**编译仓库**里，用 zstd 压缩并按 1900MiB 分卷，**最多保留最新 2 份**；打包后超过 8 个分卷（或几乎是空的）会放弃发布。
- 启用后编译时会在 menuconfig 之后写入 `CONFIG_DEVEL=y` 和 `CONFIG_CCACHE=y`（不会进入保存的配置版本）。OpenWrt 里 ccache 选项要求 `CONFIG_DEVEL` 打开，只写 `CONFIG_CCACHE=y` 会被丢弃；`DEVEL` 只是让高级选项可见，其余保持默认。缓存上限 `CCACHE_MAXSIZE=8G`（未压缩），目录固定为 `openwrt/.ccache`。
- 页面上选的缓存如果已经被「只留 2 份」清理掉了，恢复时会自动改用**最新的一份**并在日志里写明，不会因为标识过期就整轮不用缓存（run #91 就是这么白跑的：标识指向已删除的 Release，结果全程无缓存，命中率只有 11%）。
- 发布时会多写一个 `ccache.meta.json`（目标 / 机型 / 源码 commit / `.config` 摘要 / ccache 版本）。恢复时先拉它比对：目标或机型不同就直接跳过，省下几百 MB 白下载；源码版本变了会在日志里提示「只有没改到的部分能命中」。
- 每个分卷带 sha256 校验清单；恢复时发现缺卷、截断、损坏会在构建说明里写明原因并不使用缓存，不影响编译。构建说明里会显示命中统计，可据此判断值不值得继续用。
- 缓存只对**同一套编译环境**有效：同一台 GitHub 托管机（同 system gcc）、同一份源码、同一套自建工具链。换宿主机（比如在本地虚拟机复现）时，自建工具链的二进制不同，`CCACHE_COMPILERCHECK=content` 会让目标代码全部 miss——这不是缓存坏了，是环境不同。
- 编译仓库是公开的话，任何人都能下载缓存 Release；缓存里是编译产物，不含密钥，但含你的第三方插件的编译结果。

## 项目结构
```
catalog.json              插件目录（Worker 在线读取），格式见 CATALOG.md
catalog-src/overrides.json  手工维护区：中文名、第三方插件、分类规则、内置源码项目
catalog.schema.json       目录格式的 JSON Schema
src/                      前端源码（样式 + 三段 JS），见 src/README.md
tools/                    目录同步、内置目录嵌入、前端注入脚本
worker/index.js           Cloudflare Worker（含内联的 APP_CSS / APP_JS，可直接部署）
scripts/                  编译用的脚本
.github/workflows/        build-openwrt.yml（编译）、sync-catalog.yml（每周同步插件目录）
```

前端要改样式或页面，改 `src/` 后跑 `python3 tools/build_ui.py` 重新注入 `worker/index.js`（`--preview 文件` 可以另存一份静态页本地看），再部署 Worker 即可；只改插件目录时不用动前端。

## 注意
- 更新插件信息只需改 `catalog-src/overrides.json` 并运行 `python3 tools/sync_catalog.py`，提交后商店点「刷新目录」即可，无需重新部署 Worker。详见 `CATALOG.md`。
- 体积只对少数常见插件有估算，其余留空，清单里只统计已知项。
- 选择 23.05 或 master 分支时目录仍按 24.10 整理，个别包可能不存在，这类任务会在编译前失败并提示“未生效的插件”，把它从模板里移除即可。
- 旧版本创建的模板没有记录“插件选择”，在模板页点「编辑机型和插件」重新选一次并保存即可纳入管理；旧模板里设过的「定时用 .config 版本」会自动变成「固定的配置底稿」。
- `demo.html` 是同一份前端加模拟 API，仅用于演示，不会连接真实 Worker。
