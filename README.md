# Open-DSH-Desktop-Plugin-Installer

一个面向 **DSH Desktop（DeepSeek Harness 桌面客户端）** 的 Agent Skill，用于处理插件安装与更新中官方面板覆盖不到的问题：在 DSH Desktop 的 profile 上按真实语义完成插件的安装、升级、启用、停用、卸载与回滚。

它按固定顺序做三类事：

1. **先核对、请求权限、再交用户决定**：读取插件声明，判断它支持什么版本、属于哪一类（宿主半边 / 浏览器半边 / 普通依赖 / 没有 bundle 契约因此装了也不生效），对照实际使用的客户端（Desktop 还是 WebUI、什么版本），把结论汇报给用户，由用户决定是否安装；写 profile 前先申请完整文件权限并说明原因。
2. **官方面板做不到时，手工完成同样的操作**：安装、升级、启用、停用、卸载；pnpm 供应链策略、镜像滞后、git 依赖构建白名单挡住安装时给出处置；清单写坏或安装失败时按备份回滚。
3. **把「装上了」和「能用」分开算**：先核对来源装出来到底是哪个包（名称、分发通道、默认分支与发布产物的差异、校验和）；`state: live` 只代表宿主半边，带浏览器半边的插件要冷启动客户端才算验证过。

## 为什么桌面端插件难装

DSH Desktop 的 profile 由 Electron 客户端独占，三条常规通道各有边界：

- `dsh plugin --profile desktop` 被设计性拒绝：`profile "desktop" is managed exclusively by the Electron application`；
- 插件市场（dsh-market）只覆盖自己精选目录里的插件，检测到 agent 正在运行时拒绝安装，对 `github:` 源在桌面端一律拒绝（日志写 `this desktop operation is not supported by the official plugin manager`）；
- pnpm 11 的供应链策略（24 小时新发布隔离）、镜像滞后、git 依赖构建白名单，会让「看起来是插件坏了」的问题实际出在包管理器上。

本技能把这些边界与处置方法写成一条可执行流程：**侦察 → 产物身份核对 → 兼容性核对（版本 / 类型 / 客户端，交用户决定）→ 更新核对（按每个包自己的通道，市场的空白行不算答案）→ 网络与镜像 → 备份 → 按通道安装（npm 钉版本 / git 钉提交 / 本地产物换文件 + 离线安装）→ 启用 → 用宿主接口验证 → 报告是否需要重启**。

## 覆盖范围

范围以实测为准，这一点比功能列表更重要：不在没做过的路径上向用户保证。

生效范围仅限 **DSH Desktop 的 `desktop` profile**。本技能不替代官方 GUI，也不是跨端通用的 DSH 插件管理器。

### 已实测

测试区间为 2026-09-27 至 2026-10-03，环境为 Windows + DSH Desktop，运行时 `0.1.7-rc.2` 与 `0.2.0-rc.2` 两代都跑过，使用客户端自带的 pnpm `11.7.0`。

| 路径 | 实测内容 |
|---|---|
| **兼容性核对（版本 + 类型）** | 对「已装插件 / 本地目录 / registry 元数据」三类目标判定 `engines.dsh`、`engines.node`、插件类型与 peer 旁证；用合成的 `engines.dsh=">=0.2.0 <0.3.0"` 包验证了 ❌ 分支与退出码 `3`、未知分支退出码 `4`；registry 路径约 1.2 s。同时实测确认：PATH 上的 `dsh` CLI 是 `0.1.5-rc.3` 而桌面端运行时是 `0.1.7-rc.2`，共享模块 fallback 指向的也是 CLI 那一份——两者都不能当桌面端的兼容性判据 |
| 安装 npm 包 | 装 `@klarkxy/dsh-dev-index@0.1.3` 并在宿主里确认 `live` |
| 升级 npm 包 | 升到 `0.1.4`（遇到镜像未同步，用 scope 级 `.npmrc` 解决） |
| 升级 git 源插件 | `dsh-better-sidebar`、`dshmarket`（1.65.1 → 1.66.2），含它们的 `prepare` 构建与 `allowBuilds` 键；另做过一次只换提交、版本号不变的窄更新（只改了 4 个文件，无构建步骤） |
| **换 `file:` 本地产物（发布附件新版）** | 从 Release 下载新版附件、与作者公布的校验和比对一致，替换 profile 内的文件并改依赖行路径，用 `pnpm install --offline` 完成安装（3.7 s，不触碰远端依赖）；旧产物保留可回滚。同一次实测确认：市场接口对这类包只给 `kind=linked`、版本字段为空、`updateAvailable:false`——它不等于「已最新」。另外用当前落盘产物的 sha256 与它所属版本发布的校验和比对，证明了「手上这份就是官方产物」 |
| 启用 | 追加到 `dsh.profile.bundles`，宿主热挂载，无需重启 |
| **停用** | 移出 `dsh.profile.bundles`：数秒内卸下该行，状态变 `disabled`、`bundle:false`，进入 `unbundled`；依赖与文件保留；无需重启；加回即恢复 `live` |
| **卸载** | 按官方顺序（先停用 → 再 `pnpm remove`）：依赖、`installed`、`activation`、`node_modules`、`unbundled` 全部回到基线，其余插件仍 live，无需重启 |
| **从备份回滚** | 一次真实损坏（清单被写坏、宿主插件列表全空）后恢复三个文件，宿主自动回到「全 live、无诊断、与基线逐字节一致」 |
| pnpm 策略修复 | 修好「同一包名多条豁免规则只有第一条生效」导致的全局阻塞；之后用户自己在市场里的更新也恢复正常 |
| 可观测验证 | 用 `/dsh-market/installed`（Loader 实况）、`updates/summary`、市场与插件管理器日志判定结果 |
| 写前备份 | 每次改动前把 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 复制到时间戳目录 |

其中，安装 / 升级 / 启用是在真实第三方插件上完成的；停用 / 卸载 / 从备份回滚的演练对象是一份本地临时 bundle（自建空实现，`file:` 源）。第三方插件停用或卸载时的自身副作用未验证，本技能对此不做保证。

### 未验证

技能不会替用户保证这些路径；用到时必须先说明。

| 路径 | 现状 |
|---|---|
| 顺序颠倒地卸载（仍启用着就 `pnpm remove`） | 未演练；按官方说明应先停用再移除 |
| 第三方（npm / git 源）插件停用或卸载时的自身副作用 | 未验证（演练对象是本地 `file:` 临时 bundle） |
| 纯客户端插件（`dsh.client`、无宿主半边）的完整生命周期 | 未验证 |
| 「有哪些插件能更新」的逐通道核对 | 通道规则与「市场对 `linked` 类包没有版本信息」都已实测；但更新发现依赖逐个包去问它自己的上游（registry / git HEAD / Releases），没有一次调用能覆盖全部包的接口。技能因此要求把每个包的通道写进报告，而不是给一句整体的「都已最新」 |
| 类型结论之后的功能冒烟 | 未验证：`dsh.client.platform: "web"` 只说明「在加载路径上」，装完仍要用 `live` + 实际功能确认。补充：`live` 只覆盖宿主半边——带浏览器半边的插件要冷启动才算验证过；技能把这一点写进报告，而不是拿 `live` 顶替 |
| 浏览器半边在冷启动时失败 | 能定位与恢复：失败落在客户端自己的启动日志（含 renderer console）里，技能给了读法与「把包名移出 `bundles` 即恢复」的处置；但预判只有一条离线检查可用——五处名字（包名 / 装配条目名 / 客户端注册 id / 浏览器半边导出名 / 宿主半边生产者标识）是否自洽 |
| Creator 模式的 `plugin_manager` 工具路径 | 未使用（本机会话没有该工具） |
| macOS / Linux | 技能里的路径探测覆盖了它们，但只在 Windows 上跑过 |
| 与技能中枢的「从仓库导入 + 上游更新跟踪」整合 | 未验证（本地是按普通用户技能放置的） |

## 适用场景

- 「帮我装 / 更新 / 停用 / 卸载某个 DSH 插件」「插件装不上」「更新失败」
- 「有几个插件能更新」「帮我看看哪些能更新，然后更新掉」——尤其是市场显示「无需更新」、而用户确认上游发了新版时
- 插件市场报「插件目录加载失败 / The operation was aborted due to timeout」
- pnpm 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`、`Lockfile failed supply-chain policy check`、`ERR_PNPM_NO_MATCHING_VERSION`、`ERR_PNPM_IGNORED_BUILDS`
- 需要安装指定版本，或把 GitHub 源插件更新到最新提交
- 要求「别重复安装」「先看看装了什么」

## 核心能力

- **兼容性核对（先做这一步）**：一条命令给出插件声明的 `engines.dsh` / `engines.node` / peer、插件类型（宿主半边 / 浏览器半边 / 普通依赖），以及目标客户端自己的版本（Desktop 读 `runtime.json` 的 `desktopVersion`，WebUI 读 CLI 版本），最后是兼容 / 未知 / 不兼容三档结论加退出码。结论交给用户决定，不替用户拍板。实测踩过的坑也写进去了：PATH 上的 CLI 版本、共享模块 fallback 的版本都不能当桌面端的判据。
- **产物身份核对**：来源（URL / 本地 tarball / 口述包名）不等于包本身。读产物清单确认 `name` / `version` / `private` / `dsh.bundle.patch`，按作者声明的分发通道取件，核校验和，分清默认分支与发布产物，并在改过名的包上做五处名字自洽检查（包名 / 装配条目名 / 客户端注册 id / 浏览器半边导出名 / 宿主半边生产者标识）——只错后两处时宿主照样 `live`、诊断为空，而且客户端可能照常启动、只是该插件不出现。
- **按 profile 的真实语义操作**：依赖（`dependencies`）、启用（`dsh.profile.bundles`）、文件（`node_modules`）三处一次改齐，区分「装了」与「启用了」。
- **区分「没生效」的两种原因**：没有 `dsh.bundle.patch` 的包装上也不会激活任何层（只是普通依赖）；替换已装插件的文件不会替换内存里的模块代（要重启）。
- **绕开 pnpm 的 24 小时隔离与静默降级**：要最新版就显式钉版本 + 写豁免；一次性绕过（`--config.minimum-release-age=0`）与持久豁免的区别讲清楚。
- **修掉那个会自己长出来的坑**：`minimumReleaseAgeExclude` 里同一包名的多条规则只有第一条生效，必须用 `||` 并成一条——技能会检查并在报告里直接指出。
- **镜像滞后处置**：给单个 scope 配 `.npmrc` 指向官方源，且不影响其它包（作用域规则优先于 `--registry`，GUI 与市场同样受益）。
- **GitHub 源更新**：解析 HEAD 提交、精确的 `allowBuilds` tarball 键、构建超时与重试策略。
- **更新发现按通道做，不信单一接口**：更新有三条互不相通的通道（registry 版本 / git 提交 / 发布附件），市场的更新表只覆盖前两条——本地 tarball 属于 `linked` 类，版本字段为空、`updateAvailable` 恒为 `false`，那是「我不知道」而不是「已最新」。技能对每个包回到它自己的发布通道核对，并在报告里为这类包单独说明。
- **换本地产物有独立流程**：`file:` 依赖存的是路径，所以「更新」= 换文件 + 改依赖行，`pnpm add` 那套用不上。完整步骤是：核作者校验和 → 换 profile 内文件 → 结构化改依赖行 → `install --offline` → 数 lockfile 新旧文件名引用；并用当前产物的 sha256 对比作者校验和，先证明「手上这份是谁」。
- **宿主半边与浏览器半边分开验证**：`state: live` + 0 诊断只证明宿主半边；带浏览器半边的插件要冷启动才算验证过，否则报告里写明未验证。客户端起不来时去读它自己的启动日志，而不是 profile 的包操作日志。
- **分清「客户端自带的」与「用户装的」**：改动前先确定文件归谁（安装目录载荷 / profile / 用户级三层），客户端载荷里被版本清单钉住的那一份不要替换。
- **幂等**：动手前先查已装状态，已满足要求就只报告、不重装。
- **把「更新」和「启用」分开**：更新只动依赖与文件，不会顺带把包加进 `dsh.profile.bundles`。宿主对没启用的包写的状态串是聚合原因（「已停用(市场开关或补丁层)」），不代表用户主动关过它——技能把「装了 / 启用了 / 更新到哪个版本」分开说，启用交给用户决定。
- **先读日志再动手**：`<profile>\.plugin-manager\logs\*\pnpm.log` 与 `.dsh-market\log.ndjson` 里往往已经有真正的报错文本（用户转述的原因常常只是猜测）。技能把「开工前先搜一遍这次要动的包名」写成侦察阶段的固定动作。
- **认出会伪装成「操作失败」的坑**：发布附件与源码 tarball 走不同下载主机（一条超时不能推出「这个仓库拉不动」）；PowerShell 双引号里的 `$var:` 会被当成作用域限定符而让整条命令解析失败；终端中文乱码是显示层问题、不代表文件坏了。三条都写进了处置表。

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

要装某个插件之前，再跑兼容性核对（这一条才是「该不该装」的判据）：

```bash
# 装之前：从 registry 读元数据（约 1–2 秒）
node open-dsh-desktop-plugin-installer/scripts/plugin-compat.mjs --spec '@scope/plugin-name'
# 已经装着的这一份 / 本地 checkout（离线）
node open-dsh-desktop-plugin-installer/scripts/plugin-compat.mjs --installed plugin-name
node open-dsh-desktop-plugin-installer/scripts/plugin-compat.mjs --dir ./some-plugin
```

输出：插件声明支持的版本范围、它是哪一类插件、实际在用的客户端是什么版本，以及 `✅ 兼容 / ⚠️ 未知 / ❌ 不兼容`（退出码 `0/3/4`；加 `--json` 输出机器可读结果）。不兼容时技能默认不装，会先把冲突项讲清楚再让用户选。

## 前置条件

- 一台装了 **DSH Desktop** 的机器（Electron 客户端；技能用客户端自带的 pnpm：`<安装目录>/resources/runtime/pnpm/bin/pnpm.mjs`）。
- 会话具备**完整文件权限**：profile 位于 `~/.dsh` 下、会话工作区之外，`workspace-write` 会被文件沙箱拒绝。技能的第一步就是向用户申请该权限，并说明原因。
- 可选：`gh` CLI 或 `git`（仅在需要从 GitHub 拉取 git 源插件时）。

## 设计原则（这些是做法，不是保证）

- **只读优先**：先侦察、再申请权限、再备份，然后才写文件。
- **不碰用户的配置层**：`cordis.patch.yml` 是用户自己的插件开关与配置层，客户端自己会维护它；技能除非被明确要求，否则不改。
- **幂等**：动手前先查已装/已启用状态；已经满足要求就只报告、不重装。
- **写前备份，坏了能回**：改前把 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`（必要时含 `.npmrc`）备份到工作区时间戳目录。回滚已实测——一次真实损坏（清单被写坏、插件列表全空）靠恢复这三个文件回到了基线。
- **manifest 只做结构化编辑**：演练中唯一一次真正的破坏就是把 JSON 拼错了；技能要求改完立刻解析校验（`ConvertFrom-Json` / `JSON.parse`）。
- **如实报告**：替换已装插件的文件不会替换内存里的模块代——技能会明确说明「是否需要重启才生效」；对仍未验证的路径（顺序颠倒的卸载、第三方插件的停用/卸载副作用、非 Windows 平台）会直接告诉用户「这条我没验证过」。判据也分层：把「来源是什么」「宿主半边是否 live」「浏览器半边是否冷启动过」「功能是否正常」分四条分别说，不让上一条顶替下一条。

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
    │   ├── artifact-identity.md          # 产物身份：清单字段、分发通道、tag vs 默认分支、校验和、五处名字自洽
    │   ├── update-channels.md            # 更新发现（三条通道、市场对 linked 类包的沉默）、本地产物替换、取件与命令陷阱
    │   ├── pnpm-supply-chain.md          # 24h 隔离、豁免并集、registry scope、构建白名单、工具安装脚本被挡、超时重试、离线安装
    │   └── verification.md               # 可观测判据：本地接口、日志、探针、冷启动验证、成功清单
    └── scripts/
        ├── profile-report.mjs            # 只读快照：profile/运行时/已装清单/策略地雷（无依赖）
        └── plugin-compat.mjs             # 只读兼容性核对：声明范围 / 插件类型 / 客户端版本 → 结论与退出码
```

## 版本与生成说明

- 技能版本 **`0.4.0`**，见 `SKILL.md` frontmatter 的 `metadata.version`；本机安装的那一份与本仓库 `main` 的同一提交一致。
- 约定：`metadata.updated` 随每次改动更新，是本仓库自身的维护记录；技能正文与参考文档不写具体排查日期，只保留可复用的判据。

### 0.4.0（主题：「有更新」这件事本身的判据，以及本地产物的替换）

- 新增 `references/update-channels.md`：更新有三条互不相通的通道（registry 版本 / git 提交 / 发布附件），市场表只覆盖前两条；本地 tarball 属 `linked` 类，`current`/`latest` 为空、`updateAvailable` 恒为 `false`——那是「我不知道」，不是「已最新」。附本地产物替换的完整步骤、报告模板，以及「用当前产物 sha256 对比作者校验和」这条来源证明。
- SKILL.md 新增阶段 2.6「更新核对」：先取市场表的全局视图（`/dsh-market/updates?force=1`，顺便刷新缓存），再对每个 `linked` 类包回到它自己的发布通道核对（读 Releases，先排除 `draft`，`prerelease` 交用户判断）；报告把「可检测」与「可安装」分开，然后停下让用户决定。
- 「更新 ≠ 启用」写进流程：宿主对未启用包写的状态串是聚合原因，市场自己的禁用清单可能是空的——不从这行字反推用户意图，也不顺手把包加回 `bundles`。
- 阶段 5 增「换 `file:` 本地产物」：改依赖行路径 + `pnpm install --offline`（本地产物更新不需要网络，也避免顺带重解析远端依赖而超时），用 lockfile 里旧文件名 0 处、新文件名有条目来验证。
- 取件与终端的三个反直觉陷阱进入报错处置表：发布附件与源码 tarball 是不同下载主机；PowerShell 双引号里的 `$var:` 会被当成作用域限定符（写成 `${var}`）；终端乱码是显示层问题、不代表文件坏了。
- 产物身份补两刀：仓库名不是包名（标识对不上是常态，以清单为准）；作者在某次大版本里换掉附件名前缀是允许的，按清单 `name` 筛、不按文件名筛。名字自洽从三处扩到五处（补浏览器半边导出名与宿主半边生产者标识），并写明「客户端起来了」不等于「这个插件挂上了」。
- `references/profile-layout.md` 补 `.dsh-tarballs\` 的职责（`file:` 依赖存的是路径，文件删了后续 `pnpm install` 必失败）与「状态串是聚合原因」；`references/verification.md` 补 `/dsh-market/updates?force=1` 这条更直接的缓存刷新方式、用 `boot` 时间戳 + `Get-Process` 启动时间证明「改动是否已被冷启动加载」、以及本地产物替换的验收项；`references/pnpm-supply-chain.md` 补离线安装一节。
- 上游地址缺失时的处理顺序（`update-channels.md`）：本地产物常常没有 `repository`、registry 上也不存在，技能给出从产物自身取证的四级顺序（依赖行文件名 → 产物内文档 → 日志里的历史 URL → 停下问用户），并说明 GitHub `asset.digest` 可以零下载核校验和；日志检索同时搜仓库名 / 附件名 / sha，因为包名与它们常常不同。
- 上述最后两条来自一次新鲜会话测试：让两个没有本对话上下文的子会话只拿技能正文去跑真实任务，把它们「技能没覆盖、只能临场决定」的地方逐条折回技能。

### 0.3.0（产物身份与冷启动验证）

- 阶段 2.5 产物身份核对，配新参考 `references/artifact-identity.md`：读产物清单的 `name` / `version` / `private` / `dsh.bundle.patch`；按作者声明的分发通道取件；把 tag 解析成 commit 再和默认分支比；有校验和就核；bundle 插件查三处名字自洽（包名 / 装配条目名 / 客户端注册 id）；本地产物必须留在稳定位置并写进报告。
- 阶段 8 补第 7 条冷启动验证：带浏览器半边的插件只在客户端启动时被求值，热挂载不经过那一步，所以 `live` 只覆盖宿主半边；失败要读客户端自己的启动日志（renderer console 在里面），处置是先把包名移出 `bundles`。
- `references/profile-layout.md` 补归属判据：客户端载荷 / profile / 用户级三层，以及「载荷里被版本清单钉住的那一份不要替换」。
- `references/pnpm-supply-chain.md` 补工具自身安装脚本被白名单挡住的识别与两种处置（一次性绕过 / 持久放宽），并要求升级后跑一次真实调用而不是只看版本号。

### 0.2.0（兼容性核对成为独立阶段）

- 阶段 2 从「看一眼 engines/peers」升级为完整的兼容性核对 + 用户决定门（版本 / 类型 / 客户端三方核对），配套 `scripts/plugin-compat.mjs` 与 `references/compatibility.md`。
- 修正共享模块 fallback 的说明：它的版本不能当兼容性判据（实测它指向的是 CLI 那一份，而不是正在运行的桌面端运行时）。

### 生成说明

本仓库的 README 与其中的技能内容（`SKILL.md`、`references/`、`scripts/`）由 **DeepSeek-V4.1-Flash** 生成，来自真实 DSH 桌面端插件安装与更新过程的经验积累；「覆盖范围」一节按实际操作记录，未做过的路径均已标注。

## 许可

[MIT](./LICENSE) © 2026 Rim-World
