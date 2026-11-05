# 固件工坊（owrt-forge 改版）

在原项目基础上：插件商店式选择、清单直编（可不进 menuconfig）、状态机与排队、失败原因回显。

## 部署（比原版少两步）
1. 把 `worker/index.js` 粘贴到 Cloudflare Worker，绑定 D1（变量名 `DB`）并设置 Secret `MASTER_KEY`。
   **不用再手动建表**：首次请求会自动建表并迁移新增列。
   **注意**：`worker/index.js` 是单文件 Worker，只推到 GitHub 不会自动上线——改过它（页面文案、缓存保留规则、接口）都要重新粘贴部署一次。本地改前端后先用 `python3 tools/build_worker.py` 生成 `dist/worker-index.js`，推到仓库的 `worker/index.js`，再部署。
   **怎么确认线上是哪一版**：部署完打开 `https://<你的域名>/api/health`，返回里的 `worker_version` 要和 `worker/index.js` 顶部的 `WORKER_VERSION` 一致，`features` 里能看到线上到底有没有 `cache_per_target_prune`（按机型清理缓存）、`config_merge_by_level`、`cache_keep_6` 这些行为开关。对不上就是没部署，别去别处找原因。
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

选中机型之后还会按 `tmp/.targetinfo` 里这台机器声明的 `DEVICE_PACKAGES`（make 展开后的最终列表，已经算过 `+=` 与 `-包名`）逐个核对，没到 `=y` 的补上再 defconfig；补不上的驱动（`kmod-*`、`*-firmware`）**直接失败**并指出是配置里哪一行把它写成了 `=m`。三个例外，避免顶掉你的选择：机型要的包已换成同类（`wpad-openssl` → `wpad-basic-mbedtls`，按 `Provides` 判断）不重复装；**底稿里**明确写 `is not set` 的包保持关闭（T0，驱动也一样，只给告警不中止）；`=m` 的驱动仍按 `=y` 补上（`=m` 不进固件）。

「明确关闭」要分清是谁写的：底稿里的 `is not set` 是你的决定；`configs/*.config` 里那几千行 `is not set` 只是「这个发行版默认没编这些包」（整份快照 6000+ 行），它关掉的应用按默认保持关闭，关掉的驱动仍然按机型声明补成 `=y` —— 驱动缺了设备起不来，而这不是你选过的事。

这些自动动作会在**构建日志里直接打印**（同时写进构建说明），例如：

```
机型 nokia_xg-040g-md-ubi 声明、配置里却没有的包：fitblk kmod-airoha-en7572 … → 补成 =y 后重新 defconfig
```

看到这行说明配置被自动修正过；一行都没有，代表你的配置本来就是对的。

### 配置底稿
- 默认**不固定**：每次编译（包括定时）都按模板的机型和插件清单重新生成，能跟上源码的变化。
- 在 menuconfig 里调过的配置会保存成「.config 版本」，但**不会自动固定**；要沿用它，在模板页「编译选项」里选择「固定为：该版本」。固定后以该版本为准：它写了的符号都听它的，它没写的才由源码补充和模板补上（见下条的分级表）。手动编译和定时编译共用这个设置。
- 固定底稿后，`openwrt/.config` 由**底稿 / 源码补充 / 模板**三个来源**按符号级别**合并（`scripts/config-merge.py`），不是"谁最后写谁赢"的整份覆盖。同一级别内高优先级的不被覆盖，级别之间互不影响：

  | 级别 | 符号 | 取谁 |
  |---|---|---|
  | **T0 明确关闭** | 合并结果里是 `# CONFIG_x is not set`（或 `=n`）、且**来源是底稿**的符号 | **最高一级**：后面的补包不再打开它，驱动也不例外。只在合并完成之后生效，不参与来源比大小。源码补充写的关闭不算 T0 —— 应用照默认关着，驱动仍按机型声明补成 `=y` |
  | 平台/子目标 | `CONFIG_TARGET_<m>=y`、`CONFIG_TARGET_<m>_<s>=y` | 只认这次任务的 target，别的平台/子目标一律丢弃 |
  | 机型（型号） | `CONFIG_TARGET_<m>_<s>_DEVICE_<p>=y`（单选）、`CONFIG_TARGET_DEVICE_<m>_<s>_DEVICE_<p>=y`（多选）、`MULTI_PROFILE`、`ALL_PROFILES`、`PER_DEVICE_ROOTFS` | **底稿 > 模板**。机型 id 按前缀剥取（不能用 `split('_DEVICE_')`，多选写法里第一个 `_DEVICE_` 在 `TARGET_DEVICE_` 处）；`PER_DEVICE_ROOTFS` 只在多选模式下跟着带上，单选时丢掉 |
  | 目标选项 | `CONFIG_TARGET_DEVICE_PACKAGES_<...>`、`CONFIG_TARGET_ROOTFS_*`、`TARGET_IMAGES_*` | 底稿 > 源码补充 > 模板 |
  | 包 | `CONFIG_PACKAGE_*=y/m/n`、`# CONFIG_PACKAGE_x is not set` | 底稿 > 源码补充 > 模板插件清单 |
  | 内核/其它 | `CONFIG_KERNEL_*` 及其它 | 底稿 > 源码补充 > 模板 |

- **「谁写的关闭」决定它算不算 T0**：合并器会把每个被关闭的包连来源一起交出去（`--emit-off`，每行 `<user|seed> <包名>`）。底稿写的 = `user` = T0：后续「机型声明的包补成 `=y`」不会碰它，包和驱动都一样；驱动被 T0 关掉时构建说明给告警（「固件里不会有这些驱动」）但**不中止编译** —— 那是你写死的选择。`configs/*.config` 里的关闭 = `seed`，不是你的选择，关掉的应用保持关闭、驱动照补。以前两者混为一谈：defconfig 兜出来的默认值被说成「你明确关闭」，该补的驱动也不补。写成 `=m` 不在此列 —— `=m` 只编 ipk、不进固件，仍会被补成 `=y`。没固定底稿或编译机没有 python3 时拿不到来源，退回老口径（配置里的 `is not set` 一律当 T0）。

- 所以**底稿里的型号优先**：模板写着 `fiberhome_hg5382a`、底稿里是 `nokia_xg-040g-md-ubi`，就按 nokia 编，并在构建说明里写明「模板机型 X 与底稿机型 Y 不一致」；之后的机型校验和驱动补包也按 nokia 的 `DEVICE_PACKAGES`，不会把模板机型的驱动塞进别人的固件。机型三行只在底稿没指定型号时才由模板写。
- 源码补充（`configs/*.config`）按**最终生效的型号**找文件（`configs/<s>.config`、`configs/<m>_<s>.config`、`configs/<s>_<型号>.config`、`configs/<型号>.config`、`configs/release.config`），不是按模板型号找 —— 不同型号由源码补的包本来就不一样。这些文件里的 `MULTI_PROFILE` / `DEVICE_*` 行按级别丢弃：那是「这份发行版默认编哪些设备」，留着会把选中的机型清掉。
- 合并后仍会审计一遍：**源码默认启用、但最终没进固件**的包会写进构建说明并给告警（`=m` 单独标注，它只编 ipk）。注意口径 —— 源码补充是参与合并的，所以这里列出来的不是"底稿没带上"，而是"按级别该是 `=y` 但 `defconfig` 没让它是"：多数是依赖不满足、平台条件不成立，或被 `defconfig` 关掉；要确认原因看 `make defconfig` 的 `unmet dependencies`。**只有底稿或源码补充真的写了 `is not set` 的才算「明确关闭」**，单独报个数、不算缺失；剩下的 `is not set`（defconfig 兜出来的）照旧算缺，否则这一项永远不会报警。列表最多列 8 个、后面跟总数，整份扫描不会刷屏。
- 底稿本身容忍格式瑕疵：BOM（记事本另存为 UTF-8 会加）、行尾空格、CRLF 都能正确识别，不会因为第一行带 BOM 就把机型行丢掉、静默回落到模板机型。其它平台的机型行会被丢弃，构建说明里会点名。
- 「覆盖明细」只列**取值真的被改掉**的符号（前 6 条）。底稿和源码补充都写 `=y` 的包满地都是，以前它们把名额占满，真正冲突的那几行反而看不到。
- **模板里勾选的插件如果被压成关闭或 `=m`，会单独告警**：`::warning::模板里勾选的插件被配置压成关闭或 =m，固件里不会有：luci-app-foo（模板选了，底稿 改成关闭）`。整份 `.config` 当底稿时最容易踩这个坑，而上面的「覆盖明细」只列前几个符号，看不到你勾的那条。
- 机型声明的驱动也不允许缺：写成 `=m` 的会被补成 `=y`，补不上直接失败（`=m` 只编 ipk，固件里没有）；**底稿** T0 明确关闭的驱动不补、也不失败，只给告警；源码补充关掉的驱动照补，补完仍起不来才是失败。补包这段是 `scripts/device-packages.sh`，固定底稿和不固定底稿两条路**共用同一份实现**（以前各抄一份，来源判定只在一边生效）。

### 编译缓存（ccache，可选）
重复编译同一类固件时，可以把某次编译的 ccache 缓存发布出来，下次编译取回来用，省掉重复的编译时间。默认不启用。
- **发布**：模板页「编译选项」勾选「编译完成后发布缓存」；或在编译进行中点构建记录上的「完成后发布缓存」。缓存只存在于编译机上，编译结束后就没有了，所以必须在结束前设置。
- **使用**：模板页「编译选项」里的「编译缓存」选「使用同平台最新的缓存」或指定某一份。手动编译和定时编译共用这个设置。
- 缓存以 `cache-<构建ID>` 的 Release（预发布）存放在**编译仓库**里，用 zstd 压缩并按 1900MiB 分卷，**每个机型（target）保留最新 2 份**，不同机型互不挤占（页面上的记录也按同样规则保留）；打包后超过 8 个分卷（或几乎是空的）会放弃发布。
- 启用后编译时会在 menuconfig 之后写入 `CONFIG_DEVEL=y` 和 `CONFIG_CCACHE=y`（不会进入保存的配置版本）。OpenWrt 里 ccache 选项要求 `CONFIG_DEVEL` 打开，只写 `CONFIG_CCACHE=y` 会被丢弃；`DEVEL` 只是让高级选项可见，其余保持默认。缓存上限 `CCACHE_MAXSIZE=8G`（未压缩），目录固定为 `openwrt/.ccache`。
- 页面上选的缓存如果已经被清理掉、或者属于别的机型，恢复时依次退：**同机型最新 → 同平台（target 相同）不同机型最新 → 仓库最新一份**，并在日志里写明换了哪一份、为什么换。同平台不同机型只影响「编哪些包」，没改到的包命令行一样、对象仍能命中；跨平台会被直接跳过。run #91 就是标识指向已删除的 Release、结果全程无缓存，命中率只有 11%。
- 明确指定了一份**没有 meta 的老缓存**时按指定使用（日志里会说明无法核对机型），不会再被悄悄换成别的。
- 发布时会多写一个 `ccache.meta.json`（目标 / 机型 / 源码 commit / `.config` 摘要 / ccache 版本 / 截至本轮结束的累计命中）。恢复时先拉它比对：目标或机型不同就直接跳过，省下几百 MB 白下载；源码版本变了会在日志里提示「只有没改到的部分能命中」；累计命中用来算**本轮**命中率。
- 每个分卷带 sha256 校验清单；恢复时发现缺卷、截断、损坏会在构建说明里写明原因并不使用缓存，不影响编译。构建说明里会显示「本轮命中 / 可缓存调用」的命中率和「耗时最长的包/目录 / 最长无输出间隔」，可据此判断值不值得继续用。
- 耗时埋点：编译输出每行加 `epoch HH:MM:SS ` 前缀再进日志（`scripts/stamp.sh`）。带 epoch 是为了跨 UTC 零点时不回绕，也能和文件 mtime 对齐。`scripts/timing.sh` 按「`time.pl` 的 real → `make Entering/Leaving` 成对 → 子 make 启动到包目录里最后一个 `.` 标记」依次取有数据的那种，日志里会写明用的哪种；三种都没有时明确写「没有可用的计时行」，不会给出看着像结论的空表。
  - 第三种来源按「host / target 层 + 相对路径」认包目录：`tools/`、`toolchain/` 下的启动行优先对 host 层，同一份源码给两边各编一次也不会互相覆盖。
  - 结束时刻取 `.built`（编译完）、`.pkgdir` / `.installed`（装完）里最晚的那个，所以包含安装；**不含**打成 ipk 和 `package/index`，这部分只体现在「最长无输出间隔」里。
  - 同一个目录一轮里被调起多次只算第一次启动；对不上的目录会单独报「另有 N 个……未计入」。
- 编译器指纹用 `%compiler% -dumpfullversion`（版本串），不再对编译器二进制取内容哈希（`content`）。自建交叉工具链是每台编译机现编的，用 `content` 会让「换镜像 / 宿主 gcc 小版本变化」直接导致整份缓存失效；版本串只跟 gcc 版本走。
  - 只给**一个** `-dump` 选项：gcc 只处理第一个，写成 `-dumpmachine -dumpfullversion` 只会输出三元组、版本号被吞掉，等于指纹里没有版本。
  - 代价：同版本但配置不同的工具链会被当成同一个编译器——ccache 本身把命令行参数算进 key，风险可控。
  - clang 不认 `-dumpfullversion`，会跳过那次缓存；目标代码不经过 clang 调用，碰不到。
- 缓存绑定的仍然是**同一套编译环境**（同一托管机镜像、同一份源码、同一套工具链）。换宿主机（比如在本地虚拟机复现）时镜像版本不同就很难命中，这不是缓存坏了，是环境不同。
- 缓存真正能省的是 **C 代码编译**：实测命中率 99% 时内核 `target/linux compile` 从 848 秒降到 52 秒；但 `tools + toolchain`（约 41 分钟，每轮从零现编）和包阶段的 configure/打包/Go/Rust 大件都吃不到，所以总时长不会线性下降。
- 编译仓库是公开的话，任何人都能下载缓存 Release；缓存里是编译产物，不含密钥，但含你的第三方插件的编译结果。

## 项目结构
```
catalog.json              插件目录（Worker 在线读取），格式见 CATALOG.md
catalog-src/overrides.json  手工维护区：中文名、第三方插件、分类规则、内置源码项目
catalog.schema.json       目录格式的 JSON Schema
src/                      前端源码（样式 + 三段 JS），见 src/README.md
tools/                    目录同步、内置目录嵌入、前端注入脚本
worker/index.js           Cloudflare Worker（含内联的 APP_CSS / APP_JS，可直接部署）
scripts/                  编译用的脚本（device-packages.sh 是 gen-config 与 write-dotconfig 共用的补包实现）
tests/                    本地回归（不需要源码、不联网）：配置分级合并、底稿写入、缓存挑选、耗时汇总
.github/workflows/        build-openwrt.yml（编译）、sync-catalog.yml（每周同步插件目录）
```

改完脚本先跑一遍回归（几秒到几十秒，Windows 的 Git Bash 也能跑）：

```bash
for t in tests/*-test.sh tests/run.sh; do bash "$t" || echo "FAILED: $t"; done
```

覆盖范围：`config-merge-test.sh` 分级取值（含多设备写法、`PER_DEVICE_ROOTFS` 不被当机型）、`write-dotconfig-test.sh` 端到端（假 openwrt + 假 make + 假 jq）、`timing-test.sh` 耗时汇总的三种取源、`run.sh` 缓存挑选与按机型清理（假 gh / zstd / jq）。

前端要改样式或页面，改 `src/` 后跑 `python3 tools/build_ui.py` 重新注入 `worker/index.js`（`--preview 文件` 可以另存一份静态页本地看），再部署 Worker 即可；只改插件目录时不用动前端。

## 注意
- 更新插件信息只需改 `catalog-src/overrides.json` 并运行 `python3 tools/sync_catalog.py`，提交后商店点「刷新目录」即可，无需重新部署 Worker。详见 `CATALOG.md`。
- 体积只对少数常见插件有估算，其余留空，清单里只统计已知项。
- 选择 23.05 或 master 分支时目录仍按 24.10 整理，个别包可能不存在，这类任务会在编译前失败并提示“未生效的插件”，把它从模板里移除即可。
- 旧版本创建的模板没有记录“插件选择”，在模板页点「编辑机型和插件」重新选一次并保存即可纳入管理；旧模板里设过的「定时用 .config 版本」会自动变成「固定的配置底稿」。
- `demo.html` 是同一份前端加模拟 API，仅用于演示，不会连接真实 Worker。
