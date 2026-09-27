# Open-DSH-Desktop-Plugin-Installer

一个给 **DSH Desktop（DeepSeek Harness 桌面客户端）** 用的 Agent Skill：当客户端自带的插件面板做不到、或你需要对版本有精确控制时，**安装 / 升级 / 启用 DSH 插件**，并在 pnpm 的供应链策略、镜像滞后、git 依赖构建白名单把安装挡住时给出处置。

先把范围说清楚：**本技能不覆盖插件卸载与禁用**——那是 GUI「插件」页的卸载按钮和一个开关的工作；技能里只记录了官方顺序与风险，并明确标注未实测。下面「覆盖范围」一节逐条列出哪些路径真的跑过、哪些没有。

DSH Desktop 的 profile 由 Electron 客户端独占，因此：

- `dsh plugin --profile desktop` 会被明确拒绝（`profile "desktop" is managed exclusively by the Electron application`）；
- 插件市场（dsh-market）只覆盖自己精选目录里的插件，检测到有 agent 在运行时拒绝安装，对 `github:` 源在桌面端一律拒绝；
- 而 pnpm 11 的供应链策略（24 小时新发布隔离）、镜像滞后、git 依赖的构建白名单，会让「看起来是插件坏了」的问题其实出在包管理器上。

技能把这些边界和处置办法写成一条可执行流程：**侦察 → 兼容性预检 → 网络/镜像检查 → 备份 → 钉版本安装 → 启用 → 用宿主接口验证 → 报告是否需要重启**。

## 覆盖范围

**已实测**（2026-09-27，Windows + DSH Desktop 运行时 `0.1.7-rc.2` + 自带 pnpm `11.7.0`）：

| 路径 | 实测内容 |
|---|---|
| 安装 npm 包 | 装 `@klarkxy/dsh-dev-index@0.1.3` 并在宿主里确认 `live` |
| 升级 npm 包 | 升到 `0.1.4`（遇到镜像未同步，用 scope 级 `.npmrc` 解决） |
| 升级 git 源插件 | `dsh-better-sidebar`、`dshmarket`（1.65.1 → 1.66.2），含它们的 `prepare` 构建与 `allowBuilds` 键 |
| 启用 | 追加到 `dsh.profile.bundles`，宿主热挂载，无需重启 |
| pnpm 策略修复 | 修好「同一包名多条豁免规则只有第一条生效」导致的全局阻塞；之后用户自己在市场里的更新也恢复正常 |
| 可观测验证 | 用 `/dsh-market/installed`（Loader 实况）、`updates/summary`、市场与插件管理器日志判定结果 |
| 写前备份 | 每次改动前把 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 复制到时间戳目录 |

**未覆盖 / 未验证**（技能不会替你保证，用到时必须先说明）：

| 路径 | 现状 |
|---|---|
| 卸载插件 | 未实测。请用 GUI 的卸载按钮；技能内只记录官方执行顺序（先移出 `dsh.profile.bundles` → 再 `pnpm remove` → 可能要重启）并标注风险 |
| 禁用 / 关掉某个插件 | 未实测（本质是改 `dsh.profile.bundles`，但没用真实插件演练过） |
| 从备份回滚 | 流程与命令已写清，但没有在真实故障上演练过恢复 |
| 纯客户端插件（`dsh.client`、无宿主半边）的完整生命周期 | 未验证 |
| Creator 模式的 `plugin_manager` 工具路径 | 未使用（本机会话没有该工具） |
| macOS / Linux | 技能里的路径探测覆盖了它们，但只在 Windows 上跑过 |
| 与技能中枢的「从仓库导入 + 上游更新跟踪」整合 | 未验证（本地是按普通用户技能放置的） |

## 适用场景

- 「帮我装 / 更新某个 DSH 插件」「插件装不上」「更新失败」
- 插件市场报「插件目录加载失败 / The operation was aborted due to timeout」
- pnpm 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`、`Lockfile failed supply-chain policy check`、`ERR_PNPM_NO_MATCHING_VERSION`、`ERR_PNPM_IGNORED_BUILDS`
- 需要装**指定的最新版本**、或给 GitHub 源的插件更新到最新提交
- 要求「别重复安装」「先看看装了什么」

## 能力清单

- **按 profile 的真实语义操作**：依赖（`dependencies`）、启用（`dsh.profile.bundles`）、落盘（`node_modules`）三处一次对齐，并区分「装了」与「启用了」。
- **兼容性预检**：用宿主真实运行时版本（`runtime.json` 的 `desktopVersion`）核对插件的 `engines.dsh` / `peerDependencies` / 服务契约，并用解析探针在安装前验证依赖真的能加载。
- **绕开 pnpm 的 24 小时隔离与静默降级**：要最新版就显式钉版本 + 写豁免；一次性绕过（`--config.minimum-release-age=0`）与持久豁免的区别讲清楚。
- **修掉那个会自己长出来的坑**：`minimumReleaseAgeExclude` 里同一包名的多条规则只有第一条生效，必须用 `||` 并成一条——技能会检查并在报告里直接指出。
- **镜像滞后处置**：给单个 scope 配 `.npmrc` 指向官方源，且不影响其它包（作用域规则优先于 `--registry`，GUI 与市场同样受益）。
- **GitHub 源更新**：解析 HEAD 提交、精确的 `allowBuilds` tarball 键、构建超时与重试策略。
- **可观测验证**：用宿主 Loader 的实况（`/dsh-market/installed` 的 `state/bundle/hot`、`unbundled`、`diagnostics`）与更新清单判定成功，而不是「文件在不在」。
- **幂等**：动手前先查已装状态，已满足要求就只报告、不重装。

## 目录结构

```text
.
├── README.md
├── LICENSE
└── open-dsh-desktop-plugin-installer/
    ├── SKILL.md                          # 主流程（触发条件、阶段、覆盖范围、报错处置表）
    ├── references/
    │   ├── profile-layout.md             # profile 目录/文件职责、模块解析、三条安装通道的边界
    │   ├── pnpm-supply-chain.md          # 24h 隔离、豁免并集、registry scope、构建白名单、超时重试
    │   └── verification.md               # 可观测判据：本地接口、日志、探针、成功清单
    └── scripts/
        └── profile-report.mjs            # 只读快照：profile/运行时/已装清单/策略地雷（无依赖）
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

## 前置条件

- 一台装了 **DSH Desktop** 的机器（Electron 客户端；技能用客户端自带的 pnpm：`<安装目录>/resources/runtime/pnpm/bin/pnpm.mjs`）。
- 会话具备**完整文件权限**：profile 位于 `~/.dsh` 下，位于会话工作区之外，`workspace-write` 会被文件沙箱拒绝。技能的第一步就是向用户申请该权限，并说明原因。
- 可选：`gh` CLI 或 `git`（仅在需要从 GitHub 拉取 git 源插件时）。

## 设计原则（这些是做法，不是保证）

- **只读优先**：先侦察、再申请权限、再备份，然后才写文件。
- **不碰用户的配置层**：`cordis.patch.yml` 是用户自己的插件开关与配置层，客户端自己会维护它；技能除非被明确要求，否则不改。
- **幂等**：动手前先查已装/已启用状态；已经满足要求就只报告、不重装。
- **写前备份**：改前把 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`（必要时含 `.npmrc`）备份到工作区时间戳目录，并给出回滚命令。回滚本身未在真实故障上演练。
- **如实报告**：替换已装插件的文件不会替换内存里的模块代——技能会明确说明「是否需要重启才生效」，并且在自己没做过的路径上（卸载、禁用、回滚）直接告诉用户"这条我没验证过"。

## 许可

[MIT](./LICENSE) © 2026 Rim-World

## 生成说明

本仓库的 README 与其中的技能内容（`SKILL.md`、`references/`、`scripts/`）由 **DeepSeek-V4.1-Flash** 生成，直接来自一次真实的 DSH 桌面端插件安装/更新过程的经验沉淀；「覆盖范围」一节按当时的实际操作记录，未做过的路径均已标注。
