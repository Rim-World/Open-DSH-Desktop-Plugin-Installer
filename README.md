# Open-DSH-Desktop-Plugin-Installer

一个给 **DSH Desktop（DeepSeek Harness 桌面客户端）** 用的 Agent Skill，用来解决在安装和更新插件时遇到的问题。

它按顺序做以下几件事：

1. **先核对、请求权限、再问人**：拿到一个插件，先读取文本判断它**声明支持什么版本**、它是**哪一类**插件（宿主半边 / 浏览器半边 / 普通依赖 / 没有 bundle 契约所以装了也不生效），以及**用户正在用的客户端**是 Desktop 还是网页端、什么版本，把结论汇报给你，**由你决定装不装**，并向用户请求**完整文件权限**权限、说明原因。
2. **在客户端自带的插件面板做不到时，按 profile 的真实语义把操作做完**：安装、升级、启用、停用、卸载，并在 pnpm 的供应链策略、镜像滞后、git 依赖构建白名单把安装挡住时给出处置；清单被改坏或安装失败时按备份回滚。
3. **把「装上了」和「能用」分开算**：先核对来源装出来到底是哪个包（名字、分发通道、默认分支与发布产物的差别、校验和），再把 `state: live` 只当**宿主半边**的结论——带浏览器半边的插件要冷启动客户端才算验证过。

**范围以实测为准，这一点比功能列表更重要：**

- 生效范围仅限 **DSH Desktop 的 `desktop` profile**。它不替代官方 GUI，也不是跨端通用的 DSH 插件管理器。
- 上面这些动作有些**未经完整测试验证**：*安装 / 升级 / 启用*是在**真实第三方插件**上做的（npm 包与 git 源都有，并在宿主状态里确认到 `live`）；*停用 / 卸载 / 从备份回滚*是用一份**本地临时 bundle**（自己的空实现）完整演练出来的，**没有在第三方插件上验证副作用**——第三方插件停用/卸载时会不会牵出别的问题，本技能不做保证。
- 仍未验证：顺序颠倒地卸载（仍启用着就移除）、纯客户端插件（只有浏览器半边）的完整生命周期、Creator 模式的 `plugin_manager` 路径、macOS/Linux，以及类型结论之后的**功能冒烟**（"在加载路径上"不等于"功能一定正常"）。

DSH Desktop 的 profile 由 Electron 客户端独占，因此：

- `dsh plugin --profile desktop` 会被明确拒绝（`profile "desktop" is managed exclusively by the Electron application`）；
- 插件市场（dsh-market）只覆盖自己精选目录里的插件，检测到有 agent 在运行时拒绝安装，对 `github:` 源在桌面端一律拒绝；
- 而 pnpm 11 的供应链策略（24 小时新发布隔离）、镜像滞后、git 依赖的构建白名单，会让「看起来是插件坏了」的问题其实出在包管理器上。

技能把这些边界和处置办法写成一条可执行流程：**侦察 → 兼容性核对（版本 / 类型 / 客户端，然后交给你决定）→ 网络与镜像检查 → 备份 → 钉版本安装 → 启用 → 用宿主接口验证 → 报告是否需要重启**。

## 覆盖范围

**已实测**（2026-09-27 ～ 09-28，Windows + DSH Desktop 运行时 `0.1.7-rc.2` + 自带 pnpm `11.7.0`）：

| 路径 | 实测内容 |
|---|---|
| **兼容性核对（版本 + 类型）** | 对「已装插件 / 本地目录 / registry 元数据」三类目标判定 `engines.dsh`、`engines.node`、插件类型与 peer 旁证；用合成的 `engines.dsh=">=0.2.0 <0.3.0"` 包验证了 ❌ 分支与退出码 `3`、未知分支退出码 `4`；registry 路径约 1.2 s。同时实测确认：PATH 上的 `dsh` CLI 是 `0.1.5-rc.3` 而桌面端运行时是 `0.1.7-rc.2`，共享模块 fallback 指向的也是 CLI 那一份——**两者都不能当桌面端的兼容性判据** |
| 安装 npm 包 | 装 `@klarkxy/dsh-dev-index@0.1.3` 并在宿主里确认 `live` |
| 升级 npm 包 | 升到 `0.1.4`（遇到镜像未同步，用 scope 级 `.npmrc` 解决） |
| 升级 git 源插件 | `dsh-better-sidebar`、`dshmarket`（1.65.1 → 1.66.2），含它们的 `prepare` 构建与 `allowBuilds` 键 |
| 启用 | 追加到 `dsh.profile.bundles`，宿主热挂载，无需重启 |
| **停用** | 移出 `dsh.profile.bundles`：数秒内卸下该行，状态变 `disabled`、`bundle:false`，进入 `unbundled`；依赖与文件保留；无需重启；加回即恢复 `live` |
| **卸载** | 按官方顺序（先停用 → 再 `pnpm remove`）：依赖、`installed`、`activation`、`node_modules`、`unbundled` 全部回到基线，其余插件仍 live，无需重启 |
| **从备份回滚** | 一次**真实损坏**（清单被写坏、宿主插件列表全空）后恢复三个文件，宿主自动回到"全 live、无诊断、与基线逐字节一致" |
| pnpm 策略修复 | 修好"同一包名多条豁免规则只有第一条生效"导致的全局阻塞；之后用户自己在市场里的更新也恢复正常 |
| 可观测验证 | 用 `/dsh-market/installed`（Loader 实况）、`updates/summary`、市场与插件管理器日志判定结果 |
| 写前备份 | 每次改动前把 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 复制到时间戳目录 |

**未覆盖 / 未验证**（技能不会替你保证，用到时必须先说明）：

| 路径 | 现状 |
|---|---|
| 顺序颠倒地卸载（仍启用着就 `pnpm remove`） | 未演练；按官方说明应先停用再移除 |
| 第三方（npm / git 源）插件停用或卸载时的自身副作用 | 未验证（演练对象是本地 `file:` 临时 bundle） |
| 纯客户端插件（`dsh.client`、无宿主半边）的完整生命周期 | 未验证 |
| 类型结论之后的功能冒烟 | 未验证：`dsh.client.platform: "web"` 只说明"在加载路径上"，装完仍要用 `live` + 实际功能确认。**补充：`live` 只覆盖宿主半边**——带浏览器半边的插件要冷启动才算验证过；技能现在把这一点写进报告，而不是拿 `live` 顶替 |
| 浏览器半边在冷启动时失败 | 能定位与恢复：失败落在客户端自己的启动日志（含 renderer console）里，技能给了读法与"把包名移出 `bundles` 即恢复"的处置；但**预判**只有一条离线检查可用——包名 / 装配条目名 / 客户端注册 id 三处是否自洽 |
| Creator 模式的 `plugin_manager` 工具路径 | 未使用（本机会话没有该工具） |
| macOS / Linux | 技能里的路径探测覆盖了它们，但只在 Windows 上跑过 |
| 与技能中枢的「从仓库导入 + 上游更新跟踪」整合 | 未验证（本地是按普通用户技能放置的） |

## 适用场景

- 「帮我装 / 更新 / 停用 / 卸载某个 DSH 插件」「插件装不上」「更新失败」
- 插件市场报「插件目录加载失败 / The operation was aborted due to timeout」
- pnpm 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`、`Lockfile failed supply-chain policy check`、`ERR_PNPM_NO_MATCHING_VERSION`、`ERR_PNPM_IGNORED_BUILDS`
- 需要装**指定的最新版本**、或给 GitHub 源的插件更新到最新提交
- 要求「别重复安装」「先看看装了什么」

## 能力清单

- **兼容性核对（先做这个）**：一条命令给出插件声明的 `engines.dsh` / `engines.node` / peer、它是哪一类插件（宿主半边 / 浏览器半边 / 普通依赖），以及**目标客户端自己的**版本（Desktop 读 `runtime.json` 的 `desktopVersion`，网页端读 CLI 版本），最后是 `兼容 / 未知 / 不兼容` 三档结论加退出码——结论交给用户决定，不替他拍板。实测踩过的坑也写进去了：PATH 上的 CLI 版本、共享模块 fallback 的版本都**不能**当桌面端的判据。
- **按 profile 的真实语义操作**：依赖（`dependencies`）、启用（`dsh.profile.bundles`）、落盘（`node_modules`）三处一次对齐，并区分「装了」与「启用了」。
- **区分"没生效"的两种原因**：没有 `dsh.bundle.patch` 的包装上也不会激活任何层（只是普通依赖）；替换已装插件的文件不会替换内存里的模块代（要重启）。
- **绕开 pnpm 的 24 小时隔离与静默降级**：要最新版就显式钉版本 + 写豁免；一次性绕过（`--config.minimum-release-age=0`）与持久豁免的区别讲清楚。
- **修掉那个会自己长出来的坑**：`minimumReleaseAgeExclude` 里同一包名的多条规则只有第一条生效，必须用 `||` 并成一条——技能会检查并在报告里直接指出。
- **镜像滞后处置**：给单个 scope 配 `.npmrc` 指向官方源，且不影响其它包（作用域规则优先于 `--registry`，GUI 与市场同样受益）。
- **GitHub 源更新**：解析 HEAD 提交、精确的 `allowBuilds` tarball 键、构建超时与重试策略。
- **可观测验证**：用宿主 Loader 的实况（`/dsh-market/installed` 的 `state/bundle/hot`、`unbundled`、`diagnostics`）与更新清单判定成功，而不是「文件在不在」。
- **产物身份核对**：来源（URL / 本地 tarball / 口述包名）不等于包本身——读产物清单确认 `name` / `version` / `private` / `dsh.bundle.patch`，按作者声明的分发通道取件，核校验和，分清默认分支与发布产物，并在"改名过"的包上做**三处名字自洽**检查（包名 / 装配条目名 / 客户端注册 id）。
- **把宿主半边与浏览器半边分开算**：`state: live` + 0 诊断只证明宿主半边；带浏览器半边的插件要**冷启动**才算验证过，否则报告里必须写明未验证。客户端起不来时去读它自己的启动日志，而不是 profile 的包操作日志。
- **分清"客户端自带的"与"你装的"**：改动前先确定文件归谁（安装目录载荷 / profile / 用户级三层），客户端载荷里被版本清单钉住的那一份不要去替换。
- **幂等**：动手前先查已装状态，已满足要求就只报告、不重装。

## 目录结构

```text
.
├── README.md
├── LICENSE
└── open-dsh-desktop-plugin-installer/
    ├── SKILL.md                          # 主流程（触发条件、阶段、覆盖范围、报错处置表）
    ├── references/
    │   ├── profile-layout.md             # 目录/文件职责、归属判据（客户端载荷 vs 用户级）、模块解析、三条安装通道的边界
    │   ├── compatibility.md              # 版本/类型/客户端三方核对、汇报模板、决定门、排错
    │   ├── artifact-identity.md          # 产物身份：清单字段、分发通道、tag vs 默认分支、校验和、三处名字自洽
    │   ├── pnpm-supply-chain.md          # 24h 隔离、豁免并集、registry scope、构建白名单、工具安装脚本被挡、超时重试
    │   └── verification.md               # 可观测判据：本地接口、日志、探针、冷启动验证、成功清单
    └── scripts/
        ├── profile-report.mjs            # 只读快照：profile/运行时/已装清单/策略地雷（无依赖）
        └── plugin-compat.mjs             # 只读兼容性核对：声明范围 / 插件类型 / 客户端版本 → 结论与退出码
```

## 安装

**方式一：让 DSH 自己导入**

在 DSH 里把本仓库作为技能来源导入（设置 → 技能 → 从 GitHub 仓库导入），选择仓库中的 `open-dsh-desktop-plugin-installer/`。这条路径本身未在真实环境验证过，导入后请确认技能出现在技能列表里。

**方式二：手动放置**（这条跑过）

```bash
git clone https://github.com/Rim-World/Open-DSH-Desktop-Plugin-Installer
cp -r Open-DSH-Desktop-Plugin-Installer/open-dsh-desktop-plugin-installer ~/.dsh/skills/
```

Windows（PowerShell）：

```powershell
Copy-Item -Recurse .\Open-DSH-Desktop-Plugin-Installer\open-dsh-desktop-plugin-installer "$env:USERPROFILE\.dsh\skills\"
```

只需装一份：`~/.dsh/skills/`（DSH 技能中枢可管理）或 `~/.agents/skills/`（跨工具通用）二选一。两个根都放会出现同名冲突。安装后无需重启：DSH 会监听技能根目录，新技能在下一个模型步骤即可见。

## 快速开始

技能被触发后，第一件事是跑只读快照（不需要任何依赖）：

```bash
node open-dsh-desktop-plugin-installer/scripts/profile-report.mjs
```

它会打印：profile 与运行时版本、每个依赖的规格与落盘版本、`dsh.profile.bundles` 的启用状态、`allowBuilds` 与 `minimumReleaseAgeExclude` 的可疑规则、市场最近的错误事件，以及一个 **attention** 汇总（例如「装了但没启用」「豁免规则重复导致失效」「占位符没填」）。

要装某个插件之前，再跑兼容性核对（这一条才是"该不该装"的判据）：

```bash
# 装之前：从 registry 读元数据（约 1–2 秒）
node open-dsh-desktop-plugin-installer/scripts/plugin-compat.mjs --spec '@scope/plugin-name'
# 已经装着的这一份 / 本地 checkout（离线）
node open-dsh-desktop-plugin-installer/scripts/plugin-compat.mjs --installed plugin-name
node open-dsh-desktop-plugin-installer/scripts/plugin-compat.mjs --dir ./some-plugin
```

输出：插件声明支持的版本范围、它是哪一类插件、你实际在用的客户端是什么版本，以及 `✅ 兼容 / ⚠️ 未知 / ❌ 不兼容`（退出码 `0/3/4`，`+ --json` 给机器读）。**不兼容时技能默认不装**，会先把冲突项讲清楚再让你选。

## 前置条件

- 一台装了 **DSH Desktop** 的机器（Electron 客户端；技能用客户端自带的 pnpm：`<安装目录>/resources/runtime/pnpm/bin/pnpm.mjs`）。
- 会话具备**完整文件权限**：profile 位于 `~/.dsh` 下，位于会话工作区之外，`workspace-write` 会被文件沙箱拒绝。技能的第一步就是向用户申请该权限，并说明原因。
- 可选：`gh` CLI 或 `git`（仅在需要从 GitHub 拉取 git 源插件时）。

## 设计原则（这些是做法，不是保证）

- **只读优先**：先侦察、再申请权限、再备份，然后才写文件。
- **不碰用户的配置层**：`cordis.patch.yml` 是用户自己的插件开关与配置层，客户端自己会维护它；技能除非被明确要求，否则不改。
- **幂等**：动手前先查已装/已启用状态；已经满足要求就只报告、不重装。
- **写前备份，坏了能回**：改前把 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`（必要时含 `.npmrc`）备份到工作区时间戳目录。回滚已实测——一次真实损坏（清单被写坏、插件列表全空）靠恢复这三个文件回到了基线。
- **manifest 只做结构化编辑**：演练中唯一一次真正的破坏就是把 JSON 拼错了；技能要求改完立刻解析校验（`ConvertFrom-Json` / `JSON.parse`）。
- **如实报告**：替换已装插件的文件不会替换内存里的模块代——技能会明确说明「是否需要重启才生效」；对仍未验证的路径（顺序颠倒的卸载、第三方插件的停用/卸载副作用、非 Windows 平台）会直接告诉用户"这条我没验证过"。**判据也分层**：把"别人给的来源是什么""宿主半边是否 live""浏览器半边是否冷启动过""功能是否正常"分四条分别说，不让上一条顶替下一条。

## 许可

[MIT](./LICENSE) © 2026 Rim-World

## 版本与生成说明

- **技能版本 `0.3.0`**，见 `SKILL.md` frontmatter 的 `metadata.version`；本机安装的那一份应与本仓库 `main` 的同一提交一致。
- `0.3.0` 的新增：
  - **阶段 2.5 产物身份核对**，配一篇新参考 `references/artifact-identity.md`：读产物清单的 `name` / `version` / `private` / `dsh.bundle.patch`；按作者声明的分发通道取件；把 tag 解析成 commit 再和默认分支比；有校验和就核；bundle 插件查**三处名字自洽**（包名 / 装配条目名 / 客户端注册 id）；本地产物必须留在稳定位置并写进报告。
  - **阶段 8 补第 7 条：冷启动验证**。带浏览器半边的插件只在客户端启动时被求值，热挂载不经过那一步，所以 `live` 只覆盖宿主半边；失败要读客户端自己的启动日志（renderer console 在里面），处置是先把包名移出 `bundles`。
  - `references/profile-layout.md` 补**归属判据**：客户端载荷 / profile / 用户级三层，以及"载荷里被版本清单钉住的那一份不要替换"。
  - `references/pnpm-supply-chain.md` 补**工具自身安装脚本被白名单挡住**的识别与两种处置（一次性绕过 / 持久放宽），并要求升级后跑一次真实调用而不是只看版本号。
  - `metadata.updated` 保留并随每次改动更新，它是本仓库自身的维护记录。约定是：**元数据可以记日期，技能正文与参考文档不写具体排查日期**——正文沉淀的是可复用的判据，不是某次事件的经过。
- `0.2.0` 相对 `0.1.x` 的新增：阶段 2 从"看一眼 engines/peers"改成完整的**兼容性核对 + 用户决定门**（版本 / 类型 / 客户端三方核对），配套 `scripts/plugin-compat.mjs` 与 `references/compatibility.md`；并修正了共享模块 fallback 的说明——**它的版本不能当兼容性判据**（实测它指向的是 CLI 那一份，而不是正在运行的桌面端运行时）。
- 本仓库的 README 与其中的技能内容（`SKILL.md`、`references/`、`scripts/`）由 **DeepSeek-V4.1-Flash** 生成，直接来自真实 DSH 桌面端插件安装/更新过程的经验沉淀；「覆盖范围」一节按实际操作记录，未做过的路径均已标注。
