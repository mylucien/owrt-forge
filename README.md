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
- 一个 GitHub Personal Access Token（下面教怎么创建）

### 2.1 创建 GitHub Personal Access Token

这个 Token 会在 3.7 节的部署向导里填进去，作用是让 Worker 能代表你去触发编译、发布 Release、取消任务。两种类型选一种即可：

**方式一：fine-grained token（推荐，权限范围更小更安全）**

1. 登录 GitHub，右上角头像 → Settings → 左侧最底部 Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
2. **Token name**：随便起，比如 `openwrt-builder`
3. **Expiration**：建议设一个具体日期而不是"无限期"，到期前去续期即可，更安全
4. **Repository access**：选 "Only select repositories"，勾选你 2 节准备的那个仓库
5. **Permissions** → Repository permissions，找到并设置：
   - **Contents**：Read and write（发布 Release 需要）
   - **Actions**：Read and write（触发 `repository_dispatch`、取消 workflow run 都需要）
   - 其余权限不用动，保持默认 "No access" 即可
6. 点 "Generate token"，**立刻复制生成的字符串**（形如 `github_pat_xxxxx`），离开页面后就再也看不到明文了

**方式二：classic token（权限粒度粗，配置更简单）**

1. 登录 GitHub，右上角头像 → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)
2. **Note**：随便起一个名字
3. **Expiration**：同上，建议设具体日期
4. **Select scopes**：只需要勾选最顶层的 **`repo`** 这一个大类（会自动包含读写代码、发 dispatch 事件、创建 Release、取消 workflow 等所有需要的子权限），其余都不用勾
5. 点 "Generate token"，立刻复制

两种方式生成的字符串都形如 `ghp_xxxxx` 或 `github_pat_xxxxx`，先存到安全的地方（比如密码管理器），等 3.7 节部署向导里会用到。

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
  github_run_id TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS system_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

> 如果是从旧版本升级（D1 里已经有 `builds` 表，且没有 `github_run_id` 这一列），去 D1 控制台单独跑一句：`ALTER TABLE builds ADD COLUMN github_run_id TEXT;` 补上即可，不用重建整张表。

确认四张表（`templates`、`dotconfig_history`、`builds`、`system_config`）都建好了。

> `system_config` 是新增的配置表，登录密码、GitHub 仓库/Token、Worker URL、上报密钥等敏感配置都存在这张表里（除密码哈希外均加密存储），不再需要在 Cloudflare 后台逐项手填环境变量，见 3.4 节。

### 3.2 新建 Worker，粘贴代码

1. Workers & Pages → 创建 Worker，随便取个名字（比如 `openwrt-builder`）。
2. 打开在线编辑器，把 `worker.js` 的全部内容复制粘贴进去，覆盖默认代码。
3. 点 Deploy。

### 3.3 绑定 D1 数据库

Worker 的 Settings → Bindings → 新增一个 D1 database binding：

- **变量名称**必须填 `DB`（worker.js 里硬编码用的就是 `env.DB`，改了名字就连不上数据库）
- 选择 3.1 节建的那个数据库

### 3.4 配置唯一一个 Secret：`MASTER_KEY`

在 Settings → Variables and Secrets 里只需要添加一个，**勾选"加密"（Secret）**：

| 变量名 | 值 | 说明 |
|---|---|---|
| `MASTER_KEY` | 一段随机字符串 | 用于加密 D1 里存的登录密码哈希、GitHub 仓库/Token、Worker URL、上报密钥，并派生登录态签名密钥。建议 32 位以上随机串，比如终端跑 `openssl rand -hex 32` |

登录密码、GitHub 仓库地址、GitHub PAT、Worker URL、`REPORT_TOKEN` 这些都**不需要**在 Cloudflare 后台手动配置了，全部改成第一次打开网页时在线填写（见 3.7 节），加密后存进 D1 的 `system_config` 表。`MASTER_KEY` 是唯一的密钥，丢失意味着 D1 里所有加密的配置都无法解密，需要清空 `system_config` 表重新走一遍初始化流程（详见第 5 节）。

### 3.5 把 workflow 放进 GitHub 仓库

在你 3.2 节用到的那个 GitHub 仓库里，建这个路径的文件：

```
.github/workflows/build-openwrt.yml
```

把 `build-openwrt.yml` 的内容整个放进去，提交。

### 3.6 配置 GitHub 仓库的 Secrets

进该仓库 Settings → Secrets and variables → Actions → **Secrets** 标签下添加：

| Secret 名 | 值 |
|---|---|
| `REPORT_TOKEN` | 等网页"部署向导"生成后原样复制过来，见 3.7 节 |
| `TTYD_USER` | 网页终端的登录用户名，自己定，比如 `admin` |
| `TTYD_PASS` | 网页终端的登录密码，自己定，建议用随机串 |

`TTYD_USER`/`TTYD_PASS` 是干什么用的：手动触发编译时，GitHub Actions 虚拟机里会跑一个叫 `ttyd` 的网页终端程序，把 `make menuconfig` 的操作界面通过 `cloudflared` 临时隧道暴露到公网上，这样你才能在浏览器里直接操作勾选插件。这两个值就是这个临时网页终端的登录用户名和密码——`ttyd` 启动时会用 `--credential "$TTYD_USER:$TTYD_PASS"` 加上这层 Basic Auth 保护，避免别人猜到那个随机域名就能直接进来操作你的终端。这两个值完全由你自己定义，不需要跟 Worker 那边的任何配置对应，只要保证 GitHub 仓库这边设置过就行；并且只在触发编译那次的 Actions 运行环境里使用，不会被持久化存储到任何数据库。

GitHub 侧不再需要配置任何 **Variables**——原来的 `WORKER_URL` 现在由 Worker 在触发编译时自动下发，不用你手动维护。

仓库自带的 `GITHUB_TOKEN`（用于发布 Release）不需要你手动配置，Actions 运行时会自动注入，只要仓库的 Actions 权限里"Workflow permissions"设置成至少有 "Read and write permissions" 即可（仓库 Settings → Actions → General → Workflow permissions）。这个跟你在 2.1 节创建、填进部署向导的那个 GitHub PAT 是两套完全不同的凭证：`GITHUB_TOKEN` 是 GitHub 在每次 Actions 运行时临时生成、自动注入、运行结束就失效的内置令牌，只在仓库内部使用（比如这里发布 Release）；你创建的 PAT 则是从外部（Worker）发起 `repository_dispatch` 来触发这个仓库的 workflow，必须是长期有效、你自己持有的凭证，两者不能互相替代。

### 3.7 网页端：系统初始化 + 部署向导

前面几步做完后，打开 Worker 的访问地址，会看到"系统初始化"页面（因为 D1 里还没有任何密码记录）：

1. **设置登录密码**：填两遍密码（至少 6 位），提交后自动登录，进入"部署向导"页
2. **部署向导**填三项：
   - **Worker URL**：默认已经填好当前网址，正常情况不用改；如果你的 Worker 配置了多个路由入口，确认这里填的是你希望编译流程上报回来的那个地址
   - **GitHub 仓库**：格式 `owner/repo`，对应 3.5 节里放 workflow 的那个仓库
   - **GitHub PAT**：2.1 节创建的那个 Token
3. 点"保存并生成 REPORT_TOKEN"，页面会显示一个随机生成的 `REPORT_TOKEN`，**复制它**
4. 回到 GitHub 仓库，按 3.6 节的方式把这个值粘贴进 `REPORT_TOKEN` 这个 Secret
5. 网页上点"完成，进入主界面"——这个 token 之后不会再以明文形式展示，如果忘了复制或要轮换，去右上角 ⚙️ 设置菜单里点"重置 REPORT_TOKEN"重新生成一次（两边都要同步更新）

至此部署全部完成，可以建模板触发编译了。

### 3.8（可选）配置定时编译的 Cron Triggers

如果你打算用定时编译功能，需要在 Worker 的 Settings → Triggers → Cron Triggers 里手动加 cron 表达式。

免费版最多 3 条。比如想要每天凌晨 2 点（UTC）跑一次：

```
0 2 * * *
```

> 这里加的 cron 表达式，必须跟你后面在某个模板"定时编译"设置里填的 cron 表达式**逐字符一致**，Worker 是按字符串精确匹配 cron 找模板的，差一个空格都不算匹配。
>
> 注意 Cloudflare Cron 的时间是 **UTC 时间**，换算成北京时间要 +8 小时。`0 2 * * *`（UTC 2:00）等于北京时间上午 10 点。

### 3.9 部署完成，验证一下

如果 3.7 节的初始化和向导都顺利走完，并且看到了空的"编译模板"列表，就说明 Worker、D1、GitHub 三边都通了。

如果打开 Worker 地址后**没有**看到初始化页，而是直接报错或空白，通常是 D1 没绑定好（检查变量名是否为 `DB`）或 worker.js 粘贴时被截断了，见第 6 节排查。

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

> 别忘了第 3.8 节提到的：这里填的 cron 表达式要跟 Worker Cron Triggers 里加的那条**完全一致**才会被触发到。

### 4.5 管理 `.config` 版本历史

模板详情页的版本历史表里，每条记录可以：

- **查看**：弹窗看完整 `.config` 内容
- **下载**：存成本地 `.config` 文件
- **设为当前**：以后手动触发编译默认会带这份底稿
- **设为定时用**：定时任务改用这份
- **改备注**：点铅笔图标，方便区分"稳定版"、"测试版"之类
- **删除**：如果这份正被"当前"或"定时"引用，删除按钮会变灰，需要先把引用切到别的版本上才能删

系统每个模板只保留最近 10 条历史，超出会自动清掉最旧的，但**正被定时任务引用的版本永远不会被自动清理**，不用担心删错。

> 手动编译里 menuconfig 保存退出后产生的版本，存的通常是经过 `scripts/diffconfig.sh` 精简后的内容（只有偏离默认值的选项，比如几十到几百行），不是动辄几千行的完整 `.config`，这是正常现象——下次编译时 `make defconfig` 会自动把缺省项补全，效果跟用完整版一样，只是查看历史时更短更好读。如果某个版本看起来完整（几千行），说明那次精简步骤回退到了完整版，同样可以正常使用。

### 4.6 导出 / 导入模板

**导出**：模板详情页点"导出模板"，会下载一个 `.openwrt-template.json` 文件，包含源码地址、插件列表、两段脚本，以及当前那份 `.config` 的内容。

**导入**：在模板列表页右上角点"导入模板"，选文件，系统会建一个新模板（如果名字跟现有的重复，会自动加"(导入)"后缀），导入完成的模板跟手动建的完全一样，可以直接触发编译。

适合用来：备份一份"能跑通"的配置、分享给朋友复现同一个固件、或者自己迁移到另一台 Worker 时批量搬运配置。

### 4.7 查看编译记录

顶部导航"编译记录"，列出所有手动和定时触发过的任务，每条都有状态徽章和进度条，定时任务会标"定时"角标。失败、成功的任务都能在这里回溯。

排队中、准备中、配置中、编译中这几个进行中的状态，记录右下角会出现"取消编译"按钮（触发页的实时进度卡片上也有同样的按钮）。点击后会做两件事：

1. 调用 GitHub API 真正取消那次 Actions 运行，不会让虚拟机白白空跑到超时
2. 把这条记录在本系统里标成"已取消"，解开"同时只能跑一个任务"的并发锁，可以立刻触发下一次编译

> 取消按钮依赖 workflow 上报的 `github_run_id`，这个值是在 workflow 真正开始执行（"上报：已开始"这一步）之后才会回传的。如果任务还卡在刚触发、Actions 那边还没真正起跑的极短暂窗口期就点了取消，系统会提示"仅在本系统中标记为已取消"，需要你自己去 GitHub 仓库的 Actions 页面手动取消那次 run——但绝大多数卡死场景（编译耗时太久、menuconfig 终端没人操作）发生在这一步之后，正常使用基本不会碰到这个提示。

### 4.8 设置菜单（右上角 ⚙️）

- **重新配置 GitHub 连接**：重新打开部署向导，可以改 Worker URL / GitHub 仓库 / GitHub PAT。GitHub PAT 输入框留空表示沿用原有 Token 不变。
- **重置 REPORT_TOKEN**：生成一个新的上报密钥，旧的立即失效。重置后会弹窗显示新值，记得同步更新到 GitHub 仓库的 `REPORT_TOKEN` Secret，否则下次编译上报状态会失败（不影响编译本身，但页面看不到进度更新）。
- **重置所有配置**（危险区域）：清空 D1 里 `system_config` 表的全部内容，回到最初的"系统初始化"页面，相当于推倒重来，模板和编译记录数据不受影响。
- **退出登录**：清掉登录态 cookie，回到登录页。

---

## 5. 安全说明

- 网页本身靠密码 + session cookie 保护，没有账号体系，适合自己一个人或小范围使用，不建议公开分享登录密码。
- 登录密码以 PBKDF2 哈希存储（不可逆），GitHub 仓库地址/Token、Worker URL、`REPORT_TOKEN` 以 AES-GCM 加密存储在 D1 的 `system_config` 表里，解密密钥由 `MASTER_KEY` 派生，离开 Worker 进程（即没有这个 Secret）就无法解密。
- **`MASTER_KEY` 丢失等于这些加密配置全部作废**：没有别的恢复办法，只能去 D1 控制台手动清空 `system_config` 表（`DELETE FROM system_config;`），重新走一遍 3.7 节的初始化流程。建议把 `MASTER_KEY` 这串随机字符串自己额外备份一份（比如存进密码管理器），避免误删 Cloudflare Secret 后被迫重新配置。
- GitHub 侧现在只需要维护一个 `REPORT_TOKEN` Secret，不再需要任何 Variables——Worker URL 在每次触发编译时由 Worker 自动下发，不会写死在仓库配置里。
- menuconfig 网页终端是通过 `cloudflared` 临时隧道（`*.trycloudflare.com`）暴露到公网的，靠 ttyd 的用户名密码（`TTYD_USER`/`TTYD_PASS`）做二次保护，没有密码的人即使猜到这个随机域名也进不去，但既然 URL 含密码，**别把触发后弹出的终端链接转发给不信任的人**。
- 终端 session 设了 30 分钟超时，超时没保存退出会自动判失败，不会一直占着 Actions 资源。
- GitHub PAT、`REPORT_TOKEN` 是两套完全独立的密钥，前者只用来发起编译，后者只用来给 workflow 回传状态，互相不能越权使用。

---

## 6. 常见问题排查

**打开网址后报"服务器未配置 MASTER_KEY"或 502**
检查 Worker 是否绑定了 D1（变量名必须是 `DB`）、是否配置了 `MASTER_KEY` 这个 Secret，以及 worker.js 是否完整粘贴没截断。

**打开网址后报"no such table: system_config"之类的 SQL 错误**
说明 D1 建表步骤漏了 `system_config` 这张表，回去 3.1 节把建表 SQL 重新跑一遍（`CREATE TABLE IF NOT EXISTS` 不会影响已有表，可以放心重复执行）。

**密码对了但登录不进去**
极少数情况是 `MASTER_KEY` 在初始化之后被改动过——`MASTER_KEY` 一旦变化，之前存的密码哈希虽然不受影响（哈希本身不加密），但后续登录态签名、GitHub 配置等会全部对不上，建议不要在初始化完成后随意改动这个 Secret。

**登录后一直停在"部署向导"页面退不出去**
说明 GitHub 仓库 / Token 还没填完整，或者填的格式不对（仓库要求 `owner/repo`，不能带 `https://github.com/` 前缀）。把这一步走完才能进主界面。

**点击"触发编译"后一直停在"排队中"不动，或报错"GitHub / Worker URL 配置未完成"**
说明 GitHub 那边没收到 dispatch 请求。检查：
- 部署向导里填的 GitHub PAT 权限是否够（需要能对目标仓库发 `repository_dispatch`）
- 部署向导里填的 GitHub 仓库格式是否正确（`owner/repo`）
- 该仓库是否真的有 `.github/workflows/build-openwrt.yml` 这个文件，且分支是仓库默认分支
- 如果改过 GitHub PAT，确认走的是"重新配置 GitHub 连接"而不是直接去 GitHub 那边重新生成了 Token 但没同步更新到这边

排查完上面几项还是卡住不动，直接在编译记录里点"取消编译"解开并发锁，改完配置再重新触发一次即可，不需要等 6 小时自动超时判失败。

**进度卡在"准备"，终端窗口一直不出现**
去 GitHub 仓库的 Actions 页面看那次 run 的实时日志，通常是源码 clone 太慢，或者某个插件仓库地址写错、`diy_script_1` 脚本报错导致后续步骤跑不到 ttyd 那一步。如果日志里 `curl` 请求 Worker 接口直接返回 401，大概率是 GitHub 仓库 Secrets 里的 `REPORT_TOKEN` 跟网页这边当前的值不一致（比如重置过 REPORT_TOKEN 后忘了同步），去设置菜单"重置 REPORT_TOKEN"重新生成一次，再去 GitHub 仓库更新对应 Secret。

**menuconfig 里 Save & Exit 之后终端卡住不动，或 Actions 日志里看到 "Argument list too long"**
这是 `.config` 内容推送失败导致的：早期版本的 `push-config` 脚本会把整份 `.config` 内容直接当作命令行参数传给 `jq`/`curl`，而 Linux 对单条命令行参数长度有约 128KB 的硬限制（`MAX_ARG_STRLEN`），完整的 OpenWrt `.config` 文件随便就是几十万字节，远超这个限制，会在还没发出网络请求之前就被系统拒绝——跟"内容太多导致 Worker 这边报错"看起来很像，但其实是两回事，跟我们在 Worker 那边设的 2MB 体积上限完全无关，单纯靠减少选中的插件数量也不一定能稳定避开（取决于具体哪天的内容刚好压在临界值附近）。

现在的版本已经修了这个问题：改用文件读取（`jq --rawfile` / `curl --data-binary @文件`）传递内容，不再经过命令行参数，无论 `.config` 多大都不会再触发这个限制。同时还加了一层优化——保存退出后会先尝试用 OpenWrt 官方自带的 `scripts/diffconfig.sh` 把配置精简成"只保留偏离默认值的选项"再上传，体积通常只有完整 `.config` 的几十分之一，版本历史里查看起来也更清楚；如果这一步因为某些源码版本不兼容而失败，会自动回退上传完整版，不影响编译流程。如果你还在用旧版 `build-openwrt.yml`，把这个文件更新到最新版本即可。

**终端弹出来了，但显示 401 / 打不开**
检查 `TTYD_USER`/`TTYD_PASS` 是否正确配置在 GitHub 仓库的 Actions Secrets 里，必须两个都设置，并且跟 Worker 里没有关系（这两个密钥只存在于 GitHub Actions 那一侧）。

**编译失败，状态显示 failed**
去 GitHub Actions 的日志里看具体哪一步报错，常见原因是插件仓库地址失效、`make defconfig` 后某个依赖的 feeds 包没装上、或者磁盘空间不够（GitHub 免费 runner 只有几十 GB，编译大固件偶尔会爆盘）。

**任务卡死了，进度条不动也不报错，想手动停掉重新来**
编译记录（或触发页的实时进度卡片）上点"取消编译"。这会真正去取消 GitHub 那边的 Actions 运行，同时把本系统这条记录标成"已取消"，并发锁立刻解开，可以马上重新触发。如果点了之后提示"仅在本系统中标记为已取消"，说明任务还没跑到能上报 `run_id` 的那一步（极短暂的窗口期），需要自己去 GitHub 仓库的 Actions 页面手动取消那次 run，但这种情况很少见。

**定时编译到点了没有触发**
检查两处 cron 表达式是否**逐字符**一致：Worker 的 Cron Triggers 设置 vs 模板详情页里"定时编译"填的表达式。空格、星号都要完全对上。另外确认模板那边"使用版本"确实选了一个版本，没选是无法保存启用状态的。

**两个模板用了同一个 cron，结果只有一个跑了**
这是设计上的限制：系统有"同时只能跑一个任务"的并发保护，多个模板抢同一个触发时间点，只有第一个抢到的会执行，其余会被跳过，不会排队等待。如果需要都跑，把 cron 时间错开几分钟即可。

**想恢复到某个旧的 `.config` 但选项跟新源码不匹配**
导入或切换版本后再走一次手动编译进 menuconfig 看一眼，`make defconfig` 会自动丢弃新源码不认识的旧选项、给新增选项填默认值，但跨版本难免有些选项漂移，建议在版本备注里记一下对应的源码 commit，方便对齐。
