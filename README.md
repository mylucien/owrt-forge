# OpenWrt 自动编译系统 — 部署与使用文档

配套文件：`worker.js`（Cloudflare Worker，含前端）、`build-openwrt.yml`（GitHub Actions workflow）

---

## 1. 这套系统是什么

一个带密码保护的网页，用来管理 OpenWrt 的编译配置（源码、插件、脚本、`.config`），点一下按钮就能让 GitHub Actions 帮你编译固件。

- **手动编译**：触发后会打开一个嵌在网页里的终端，直接进入 `make menuconfig` 界面，你勾选完插件保存退出，系统自动把 `.config` 存下来、开始编译、编译完发布到 GitHub Release。
- **定时编译**：按 cron 表达式自动触发，不会弹终端，直接用你之前选定的某个 `.config` 版本编译。
- 每次手动编译产生的 `.config` 都会存一份历史版本，可以随时切换、下载、设为以后默认用的版本。
- 整套配置（源码地址、插件列表、脚本、`.config`）可以导出成一个 JSON 文件，分享给别人，对方导入就能复现同一套编译环境。

整个系统两部分组成：

| 部分 | 是什么 | 部署在哪 |
|---|---|---|
| `worker.js` | 网页 + API + 数据库读写 + 定时任务调度 | Cloudflare Worker |
| `build-openwrt.yml` | 真正执行 git clone / 编译 / 发布 Release 的脚本 | 你自己的 GitHub 仓库（必须 public） |

Worker 自己不编译任何东西，只负责存配置、点火、收结果。所有重活——拉源码、跑脚本、编译——都在 GitHub Actions 的虚拟机里做。

---

## 2. 部署前需要准备

- 一个 Cloudflare 账号（免费版够用）
- 一个 GitHub 账号，新建（或选一个）**public** 仓库，专门用来跑这个编译 workflow
- 一个有 `repo` 权限的 GitHub Personal Access Token（classic 或 fine-grained 都行，需要能对该仓库发 `repository_dispatch` 事件，并允许创建 Release）

---

## 3. 部署步骤

### 3.1 建 D1 数据库

进 Cloudflare 控制台 → Workers & Pages → D1，新建一个数据库，名字随意，比如 `openwrt-builder`。

进这个数据库的 Console，把下面 SQL 整段贴进去执行：

```sql
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT,
  repo_url TEXT,
  branch TEXT,
  target TEXT,
  plugins TEXT,
  diy_script_1 TEXT,
  diy_script_2 TEXT,
  dotconfig_version_id TEXT,
  schedule_cron TEXT,
  schedule_enabled INTEGER DEFAULT 0,
  schedule_dotconfig_version_id TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS dotconfig_history (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  build_id TEXT,
  label TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  template_id TEXT,
  repo_url TEXT,
  branch TEXT,
  target TEXT,
  plugins TEXT,
  diy_script_1 TEXT,
  diy_script_2 TEXT,
  dotconfig_version_id TEXT,
  dotconfig_snapshot TEXT,
  dotconfig_result TEXT,
  trigger_type TEXT DEFAULT 'manual',
  schedule_cron TEXT,
  status TEXT,
  web_url TEXT,
  download_url TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
```

确认三张表（`templates`、`dotconfig_history`、`builds`）都建好了。

### 3.2 新建 Worker，粘贴代码

1. Workers & Pages → 创建 Worker，随便取个名字（比如 `openwrt-builder`）。
2. 打开在线编辑器，把 `worker.js` 的全部内容复制粘贴进去，覆盖默认代码。
3. 点 Deploy。

### 3.3 绑定 D1 数据库

Worker 的 Settings → Bindings → 新增一个 D1 database binding：

- **变量名称**必须填 `DB`（worker.js 里硬编码用的就是 `env.DB`，改了名字就连不上数据库）
- 选择 3.1 节建的那个数据库

### 3.4 配置环境变量 / Secrets

同样在 Settings → Variables and Secrets，添加以下几个，**全部勾选"加密"（Secret）**：

| 变量名 | 值 | 说明 |
|---|---|---|
| `LOGIN_PASSWORD` | 自己定的密码 | 网页登录密码 |
| `SESSION_SECRET` | 一段随机字符串 | 给登录态签名用，跟密码无关，建议用密码生成器随便造一串 32 位以上的随机串 |
| `GITHUB_TOKEN` | GitHub PAT | 要有权限对目标仓库发 dispatch 事件 |
| `GITHUB_REPO` | `你的用户名/仓库名` | 比如 `yourname/openwrt-builds`，注意不带 `https://github.com/` 前缀 |
| `REPORT_TOKEN` | 一段随机字符串 | workflow 上报状态时用的密钥，等下要原样填到 GitHub Actions Secrets 里，两边必须完全一致 |

`SESSION_SECRET` 和 `REPORT_TOKEN` 随便生成两个不一样的长随机字符串就行，比如在终端跑 `openssl rand -hex 32`。

### 3.5 把 workflow 放进 GitHub 仓库

在你 3.2 节用到的那个 GitHub 仓库里，建这个路径的文件：

```
.github/workflows/build-openwrt.yml
```

把 `build-openwrt.yml` 的内容整个放进去，提交。

### 3.6 配置 GitHub 仓库的 Secrets 和 Variables

进该仓库 Settings → Secrets and variables → Actions：

**Secrets** 标签下添加：

| Secret 名 | 值 |
|---|---|
| `REPORT_TOKEN` | 跟 3.4 节里 Worker 的 `REPORT_TOKEN` **完全一致** |
| `TTYD_USER` | 网页终端的登录用户名，自己定，比如 `admin` |
| `TTYD_PASS` | 网页终端的登录密码，自己定，建议用随机串 |

**Variables** 标签下添加：

| Variable 名 | 值 |
|---|---|
| `WORKER_URL` | 你 Worker 的访问地址，形如 `https://openwrt-builder.yourname.workers.dev`，**不要带末尾斜杠** |

仓库自带的 `GITHUB_TOKEN`（用于发布 Release）不需要你手动配置，Actions 运行时会自动注入，只要仓库的 Actions 权限里"Workflow permissions"设置成至少有 "Read and write permissions" 即可（仓库 Settings → Actions → General → Workflow permissions）。

### 3.7（可选）配置定时编译的 Cron Triggers

如果你打算用定时编译功能，需要在 Worker 的 Settings → Triggers → Cron Triggers 里手动加 cron 表达式。

免费版最多 3 条。比如想要每天凌晨 2 点（UTC）跑一次：

```
0 2 * * *
```

> 这里加的 cron 表达式，必须跟你后面在某个模板"定时编译"设置里填的 cron 表达式**逐字符一致**，Worker 是按字符串精确匹配 cron 找模板的，差一个空格都不算匹配。
>
> 注意 Cloudflare Cron 的时间是 **UTC 时间**，换算成北京时间要 +8 小时。`0 2 * * *`（UTC 2:00）等于北京时间上午 10 点。

### 3.8 部署完成，验证一下

打开 Worker 的访问地址，应该看到一个深色背景的登录页，输入 `LOGIN_PASSWORD` 能登进去，看到空的"编译模板"列表，就说明 Worker 和 D1 都通了。

GitHub Actions 那边的连通性要等你真正触发一次编译才能验证，见下面第 4 节。

---

## 4. 日常使用

### 4.1 建一个编译模板

登录后点"新建模板"，填：

- **模板名称**：随便起，方便自己认
- **源码仓库 / 分支**：比如 `https://github.com/coolsnowwolf/lede`、`master`
- **目标平台**：填 OpenWrt 的 `CONFIG_TARGET` 对应的平台路径，比如 `mediatek/mt7986a`，具体要看你路由器型号对应哪个 target
- **插件列表**：点"添加插件"，每个插件填：
  - 插件名（随便起，会作为 `package/` 目录下的文件夹名）
  - git 仓库地址
  - 如果只想要某个仓库里的部分子目录（比如只要某个大仓库里的一两个 luci app），勾选"稀疏克隆"，填分支和子目录名（逗号分隔）
- **自定义脚本①／②**：分别是 `feeds update` 之前、`feeds install` 之后执行的 shell 脚本，没有就留空

保存后会进入模板详情页。

### 4.2 准备一份 `.config` 底稿（可选）

如果你已经有现成的 `.config` 文件，可以在详情页点"上传新版本"直接贴进去或选文件上传，给它起个备注（比如"稳定版"），方便以后认。

如果没有，也没关系——手动触发编译时选"无（从零开始）"，进 menuconfig 后从默认配置开始勾选就行，保存退出后系统会自动把你勾完的结果存成一个新版本。

### 4.3 手动触发一次编译

模板详情页点"触发编译"，选好底稿（没有就选"无"），点"触发编译"。

接下来会发生：

1. 页面显示一条状态进度条（排队 → 准备 → 配置 → 编译 → 完成）
2. 进度走到"配置"阶段后，页面会嵌入一个终端窗口——这就是 GitHub Actions 虚拟机里跑起来的 `make menuconfig`，直接在网页里操作方向键、空格、回车
3. 勾好你要的插件/选项后，**用方向键退出 menuconfig 并选 Save 保存退出**（跟在自己电脑上操作一样）
4. 保存退出后终端会自动推送配置、关闭，页面进度条往后走到"编译"
5. 编译完成后页面会出现"下载编译产物"链接，跳转到 GitHub Release 页面

> 第一次触发如果终端窗口迟迟没出现，通常是 GitHub Actions 那边还在装依赖、clone 源码（OpenWrt 源码比较大，可能要几分钟），耐心等一下，状态条会先停在"准备"阶段。

### 4.4 设置定时编译

前提：模板必须已经有至少一个 `.config` 历史版本（手动跑过一次或上传过都行），因为定时编译**不会**弹出 menuconfig，必须有一份现成配置直接用。

在模板详情页的"定时编译"区：

1. 打开"启用定时编译"开关
2. 填 cron 表达式，或点下面的快捷按钮选一个常用时间（注意是 UTC 时间）
3. 在"使用版本"下拉框里选一个历史版本——这个版本会被定时任务专门引用，跟你手动编译默认用的"当前版本"是分开的两个指针，互不影响
4. 点"保存定时设置"

之后到了设定的时间点，Cloudflare 会自动触发一次编译，跳过 menuconfig 直接用你选的版本编译完发布。

> 别忘了第 3.7 节提到的：这里填的 cron 表达式要跟 Worker Cron Triggers 里加的那条**完全一致**才会被触发到。

### 4.5 管理 `.config` 版本历史

模板详情页的版本历史表里，每条记录可以：

- **查看**：弹窗看完整 `.config` 内容
- **下载**：存成本地 `.config` 文件
- **设为当前**：以后手动触发编译默认会带这份底稿
- **设为定时用**：定时任务改用这份
- **改备注**：点铅笔图标，方便区分"稳定版"、"测试版"之类
- **删除**：如果这份正被"当前"或"定时"引用，删除按钮会变灰，需要先把引用切到别的版本上才能删

系统每个模板只保留最近 10 条历史，超出会自动清掉最旧的，但**正被定时任务引用的版本永远不会被自动清理**，不用担心删错。

### 4.6 导出 / 导入模板

**导出**：模板详情页点"导出模板"，会下载一个 `.openwrt-template.json` 文件，包含源码地址、插件列表、两段脚本，以及当前那份 `.config` 的内容。

**导入**：在模板列表页右上角点"导入模板"，选文件，系统会建一个新模板（如果名字跟现有的重复，会自动加"(导入)"后缀），导入完成的模板跟手动建的完全一样，可以直接触发编译。

适合用来：备份一份"能跑通"的配置、分享给朋友复现同一个固件、或者自己迁移到另一台 Worker 时批量搬运配置。

### 4.7 查看编译记录

顶部导航"编译记录"，列出所有手动和定时触发过的任务，每条都有状态徽章和进度条，定时任务会标"定时"角标。失败、成功的任务都能在这里回溯。

---

## 5. 安全说明

- 网页本身靠密码 + session cookie 保护，没有账号体系，适合自己一个人或小范围使用，不建议公开分享登录密码。
- menuconfig 网页终端是通过 `cloudflared` 临时隧道（`*.trycloudflare.com`）暴露到公网的，靠 ttyd 的用户名密码（`TTYD_USER`/`TTYD_PASS`）做二次保护，没有密码的人即使猜到这个随机域名也进不去，但既然 URL 含密码，**别把触发后弹出的终端链接转发给不信任的人**。
- 终端 session 设了 30 分钟超时，超时没保存退出会自动判失败，不会一直占着 Actions 资源。
- `GITHUB_TOKEN`、`REPORT_TOKEN` 是两套完全独立的密钥，前者只用来发起编译，后者只用来给 workflow 回传状态，互相不能越权使用。

---

## 6. 常见问题排查

**登录页打不开 / 502**
检查 Worker 是否绑定了 D1（变量名必须是 `DB`），以及 worker.js 是否完整粘贴没截断。

**密码对了但登录不进去**
确认 `LOGIN_PASSWORD` 这个 Secret 是否真的保存成功了（有时候编辑完忘了点保存）。

**点击"触发编译"后一直停在"排队中"不动**
说明 GitHub 那边没收到 dispatch 请求。检查：
- `GITHUB_TOKEN` 权限是否够（需要能对目标仓库发 `repository_dispatch`）
- `GITHUB_REPO` 格式是否正确（`owner/repo`，不要带 `https://github.com/`）
- 该仓库是否真的有 `.github/workflows/build-openwrt.yml` 这个文件，且分支是仓库默认分支

**进度卡在"准备"，终端窗口一直不出现**
去 GitHub 仓库的 Actions 页面看那次 run 的实时日志，通常是源码 clone 太慢，或者某个插件仓库地址写错、`diy_script_1` 脚本报错导致后续步骤跑不到 ttyd 那一步。

**终端弹出来了，但显示 401 / 打不开**
检查 `TTYD_USER`/`TTYD_PASS` 是否正确配置在 GitHub 仓库的 Actions Secrets 里，必须两个都设置，并且跟 Worker 里没有关系（这两个密钥只存在于 GitHub Actions 那一侧）。

**编译失败，状态显示 failed**
去 GitHub Actions 的日志里看具体哪一步报错，常见原因是插件仓库地址失效、`make defconfig` 后某个依赖的 feeds 包没装上、或者磁盘空间不够（GitHub 免费 runner 只有几十 GB，编译大固件偶尔会爆盘）。

**定时编译到点了没有触发**
检查两处 cron 表达式是否**逐字符**一致：Worker 的 Cron Triggers 设置 vs 模板详情页里"定时编译"填的表达式。空格、星号都要完全对上。另外确认模板那边"使用版本"确实选了一个版本，没选是无法保存启用状态的。

**两个模板用了同一个 cron，结果只有一个跑了**
这是设计上的限制：系统有"同时只能跑一个任务"的并发保护，多个模板抢同一个触发时间点，只有第一个抢到的会执行，其余会被跳过，不会排队等待。如果需要都跑，把 cron 时间错开几分钟即可。

**想恢复到某个旧的 `.config` 但选项跟新源码不匹配**
导入或切换版本后再走一次手动编译进 menuconfig 看一眼，`make defconfig` 会自动丢弃新源码不认识的旧选项、给新增选项填默认值，但跨版本难免有些选项漂移，建议在版本备注里记一下对应的源码 commit，方便对齐。
