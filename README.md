# Open-DSH-Desktop-Plugin-Installer

这是一个给 DSH Desktop（DeepSeek Harness 桌面客户端）用的 Agent Skill，解决插件安装和更新里官方面板管不到的那些事：在 DSH Desktop 的 profile 上按真实语义完成插件的安装、升级、启用、停用、卸载和回滚。

技能按固定顺序做三件事。

1. **先核对，再要权限，最后由用户决定。** 拿到一个插件，先读它的声明：支持什么版本，属于哪一类（宿主半边、浏览器半边、普通依赖，或者没有 bundle 契约、装了也不生效），再对照实际在用的客户端（Desktop 还是 WebUI，什么版本）。结论汇报给用户，装不装由用户决定。写 profile 之前先申请完整文件权限，并说明原因。
2. **官方面板做不到时，手工把同样的操作做完。** 安装、升级、启用、停用、卸载都覆盖。pnpm 的供应链策略、镜像滞后、git 依赖构建白名单挡住安装时，按处置手册解决；清单写坏或安装失败时，按备份回滚。
3. **「装上了」和「能用」分开验证。** 先核对来源装出来到底是哪个包：名字、分发通道、默认分支和发布产物的差别、校验和。`state: live` 只说明宿主半边挂上了；带浏览器半边的插件，要冷启动客户端才算验证过。

## 为什么桌面端插件难装

DSH Desktop 的 profile 由 Electron 客户端独占，三条常规通道各有边界：

- `dsh plugin --profile desktop` 会被明确拒绝：`profile "desktop" is managed exclusively by the Electron application`。
- 插件市场（dsh-market）只装自己精选目录里的插件；检测到 agent 正在运行时会拒绝安装；对 `github:` 源在桌面端一律拒绝，日志写 `this desktop operation is not supported by the official plugin manager`。
- pnpm 11 的供应链策略（新发布版本隔离 24 小时）、镜像滞后、git 依赖构建白名单，常常让「插件坏了」的表象下面实际是包管理器的问题。

技能把这些边界和对策整理成一条流程：侦察 → 核对产物身份 → 核对兼容性（版本、类型、客户端，交用户决定）→ 核对更新（每个包按自己的分发通道，市场的空白行不算答案）→ 检查网络和镜像 → 备份 → 安装（npm 钉版本、git 钉提交、本地产物换文件加离线安装）→ 启用 → 用宿主接口验证 → 报告是否需要重启。

## 覆盖范围

覆盖范围只写实测过的内容。没实测过的路径，技能不会打包票，会在报告里明说。

生效范围只有 DSH Desktop 的 `desktop` profile。它不替代官方 GUI，也不是跨端通用的 DSH 插件管理器。

文档里的第三方插件一律用「插件 A / B / C」指代。版本号、报错原文和实测数据保持真实。

### 已实测

测试区间 2026-09-27 至 2026-10-11，Windows 加 DSH Desktop，运行时 0.1.7-rc.2 和 0.2.0-rc.2 两代都跑过，用客户端自带的 pnpm 11.7.0。

| 路径 | 实测内容 |
|---|---|
| 兼容性核对（版本 + 类型） | 对已装插件、本地目录、registry 元数据三类目标判定 `engines.dsh`、`engines.node`、插件类型和 peer 旁证；用一个合成的 `engines.dsh=">=0.2.0 <0.3.0"` 包验证了不兼容分支（退出码 3）和未知分支（退出码 4）；registry 查询约 1.2 秒。同一轮实测确认：PATH 上的 `dsh` CLI 是 0.1.5-rc.3，桌面端运行时是 0.1.7-rc.2，共享模块 fallback 指向的也是 CLI 那份，这两者都不能当桌面端的兼容性判据 |
| 安装 npm 包 | 装插件 A（npm 源）0.1.3，装完在宿主里确认 `live` |
| 升级 npm 包 | 插件 A 升到 0.1.4。镜像没同步，用 scope 级 `.npmrc` 解决 |
| 升级 git 源插件 | 插件 B、C（git 源）从 1.65.1 升到 1.66.2，含它们的 `prepare` 构建和 `allowBuilds` 键。另做过一次只换提交、版本号不变的窄更新，改 4 个文件，无构建步骤 |
| 换 `file:` 本地产物（发布附件新版） | 从 Release 下载新版附件，和作者公布的校验和比对一致；换掉 profile 里的文件，改依赖行路径，`pnpm install --offline` 完成，耗时 3.7 秒，不碰远端依赖；旧产物保留，可回滚。同一轮实测确认：市场接口对这类包只给 `kind=linked`，版本字段为空，`updateAvailable:false`，这不等于「已最新」。还用当前产物的 sha256 和它所属版本的发布校验和比过，证明手上这份是官方产物 |
| 启用 | 追加到 `dsh.profile.bundles`，宿主热挂载，不用重启 |
| 停用 | 移出 `dsh.profile.bundles`：几秒内卸下该行，状态变 `disabled`、`bundle:false`，进 `unbundled`；依赖和文件保留，不用重启；加回去就恢复 `live` |
| 卸载 | 按官方顺序，先停用再 `pnpm remove`：依赖、`installed`、`activation`、`node_modules`、`unbundled` 全部回到基线，其余插件仍 live，不用重启 |
| 从备份回滚 | 一次真实损坏（清单被写坏、宿主插件列表全空）后恢复三个文件，宿主自动回到全 live、无诊断、和基线逐字节一致 |
| pnpm 策略修复 | 修好「同一包名多条豁免规则只有第一条生效」造成的全局阻塞；之后用户自己在市场里的更新也恢复正常 |
| 可观测验证 | 用 `/dsh-market/installed`（Loader 实况）、`updates/summary`、市场日志和插件管理器日志判定结果 |
| 更新后的宿主半边实况核对 | 用插件**自己的**宿主路由判定"挂没挂上"，而不是只看市场那条 `state`；核实过「条目激活期校验不通过 → `fiberPhase=FAILED` → 它自己的路由整条 404 → 按需资产块整批取不到」这条链路，并实测了修法与复验 |
| 四处落账一致性的判据 | 依赖行、`pnpm-lock.yaml`、`node_modules\<pkg>\package.json`、`node_modules\.modules.yaml` 四处本应一致；漂移时 `pnpm install` 会按依赖行把已落盘的版本静默改回去，所以判据是"先只读报出现状、由用户决定以哪一份为准" |
| 写前备份 | 每次改动前把 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 复制到带时间戳的目录 |

安装、升级、启用是在真实第三方插件上做的；停用、卸载、回滚的演练对象是一份本地临时 bundle（自建的空实现，`file:` 源）。第三方插件停用或卸载时自身会有什么副作用，没有验证过，技能不对此负责。

### 未验证

| 路径 | 现状 |
|---|---|
| 顺序颠倒地卸载（还启用着就 `pnpm remove`） | 没演练过。按官方说明，应该先停用再移除 |
| 第三方插件（npm、git 源）停用或卸载时的自身副作用 | 没验证过，演练对象是本地 `file:` 临时 bundle |
| 纯客户端插件（只有 `dsh.client`，没有宿主半边）的完整生命周期 | 没验证过 |
| 「有哪些插件能更新」的逐通道核对 | 通道规则实测过，市场对 `linked` 类包没有版本信息也实测过。但更新发现要逐个包去问它自己的上游（registry、git HEAD、Releases），没有一个接口能一次覆盖所有包。技能因此要求把每个包的通道写进报告，不给一句整体的「都已最新」 |
| 类型结论之后的功能冒烟 | 没验证过。`dsh.client.platform: "web"` 只说明在加载路径上，装完还得用 `live` 和实际功能确认。另外 `live` 只覆盖宿主半边，带浏览器半边的插件要冷启动才算验证过，技能会把这一点写进报告 |
| 浏览器半边冷启动失败 | 能定位、能恢复：失败记录在客户端自己的启动日志里（含 renderer console），技能给了读法，处置是把包名移出 `bundles`。预判手段只有一条离线检查：五处名字（包名、装配条目名、客户端注册 id、浏览器半边导出名、宿主半边生产者标识）是否自洽 |
| Creator 模式的 `plugin_manager` 工具路径 | 没用过（本机会话没有这个工具） |
| macOS / Linux | 技能里的路径探测覆盖了这两个平台，但只在 Windows 上跑过 |
| 技能中枢的「从仓库导入 + 上游更新跟踪」整合 | 没验证过（本地按普通用户技能放置） |

## 适用场景

- 「帮我装 / 更新 / 停用 / 卸载某个 DSH 插件」「插件装不上」「更新失败」
- 「有几个插件能更新」「帮我看看哪些能更新，然后更新掉」（尤其是市场显示「无可用更新」、用户却确认上游发了新版时）
- 插件市场报「插件目录加载失败」或 `The operation was aborted due to timeout`
- pnpm 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`、`Lockfile failed supply-chain policy check`、`ERR_PNPM_NO_MATCHING_VERSION`、`ERR_PNPM_IGNORED_BUILDS`
- 更新完某个插件后，它的界面功能或设置栏消失，插件页显示「异常」
- 「市场接口说这个插件 live，但它没反应」——要判定某个插件的宿主半边到底挂没挂上
- 需要安装指定版本，或把 GitHub 源插件更新到最新提交
- 要求「别重复安装」「先看看装了什么」

## 做不到
- 管理所有插件
- 确保插件能用
- 修改不适配的插件使其适配

## 核心能力

- **兼容性核对**：一条命令给出插件声明的 `engines.dsh`、`engines.node`、peer，插件类型，以及目标客户端自己的版本（Desktop 读 `runtime.json` 的 `desktopVersion`，WebUI 读 CLI 版本），结论分兼容、未知、不兼容三档，附退出码。装不装由用户决定。实测确认 PATH 上的 CLI 版本和共享 fallback 的版本都不能当桌面端判据。
- **产物身份核对**：来源（URL、本地 tarball、口述包名）不等于包本身。读产物清单确认 `name`、`version`、`private`、`dsh.bundle.patch`；按作者声明的分发通道取件；核校验和；分清默认分支和发布产物；改过名的包做五处名字自洽检查。只错后两处（导出名、生产者标识）时，宿主照样 `live`、诊断为空，客户端也可能照常启动、只是这个插件不出现。
- **按 profile 的真实语义操作**：依赖（`dependencies`）、启用（`dsh.profile.bundles`）、文件（`node_modules`）三处一次改齐，分清「装了」和「启用了」。
- **两种「没生效」分得清**：没有 `dsh.bundle.patch` 的包不激活任何层；替换文件不会替换内存里的模块代，要重启。
- **pnpm 的 24 小时隔离和静默降级**：要最新版就显式钉版本加写豁免。一次性绕过（`--config.minimum-release-age=0`）和持久豁免是两件事，都要做。
- **豁免规则的坑**：`minimumReleaseAgeExclude` 同一包名只能有一条规则，多个版本用 `||` 并成一条。pnpm 自己会往里追加行，技能会检查并指出。
- **镜像滞后**：给单个 scope 配 `.npmrc` 指向官方源。作用域规则优先于 `--registry`，GUI 和市场同样受益。
- **GitHub 源更新**：解析 HEAD 提交，写精确的 `allowBuilds` tarball 键，构建给足超时和重试。
- **更新发现按通道做**：更新有三条通道（registry 版本、git 提交、发布附件），市场更新表只覆盖前两条。本地 tarball 属于 `linked` 类，`updateAvailable:false` 的意思是「不知道」，不是「已最新」。
- **换本地产物有独立流程**：`file:` 依赖存的是路径，更新就是换文件加改依赖行，`pnpm add` 用不上。先用当前产物的 sha256 对比作者校验和，证明手上这份是谁的，再换。
- **验证分两层**：`live` 加零诊断只证明宿主半边；带浏览器半边的插件要冷启动。客户端起不来时读它自己的启动日志，不是 profile 的包操作日志。
- **市场说 `live` 不等于宿主半边活着**：市场那条 `state` 是市场自己的记账，插件页的「异常」才是宿主 Loader 报的 `fiberPhase=FAILED`。技能要求取一条**插件自己的**可观测面（宿主路由、工具表）当实况证据。
- **更新后"界面功能消失"先探宿主路由**：插件可以把部分界面功能放在自己的资产路由下按需取；宿主半边没挂上时这些块整批 404，界面看起来像"功能被删了"。判据是"已注册的 exact 路由回它自己的响应"——未知路径 GET 回 404 空体、非 GET/HEAD 回 405 空体，405 不代表路由在。
- **激活期校验会让条目静默失败**：插件导出 `Config`（schemastery）时，Cordis 会在 apply 之前用它校验该行的配置；插件新版本收紧了 schema、而 profile 里存着旧版本写下的值，就会在激活期直接失败，插件自己的代码一行都不跑。技能给了只读排查（用插件包自己导出的 `Config` 校验现存值）与修法（改用户配置层里那一项，宿主会重新激活该条目）。
- **四个落账点**：依赖行、`pnpm-lock.yaml`、`node_modules\<pkg>\package.json`、`node_modules\.modules.yaml`。发现漂移时不要用 `pnpm install` 去对齐——pnpm 按依赖行重解，会把已落盘的版本静默改回去。
- **分清「客户端自带的」和「用户装的」**：改动前先确定文件归谁。客户端载荷里被版本清单钉住的那份，不要替换。
- **幂等**：已经装了、已启用、版本满足要求，就只报告，不重装。
- **更新和启用分开**：更新不动 `dsh.profile.bundles`。宿主对没启用的包写的状态串是聚合原因，不代表用户主动关过它。要不要启用，交给用户决定。
- **先读日志再动手**：`.plugin-manager\logs\*\pnpm.log` 和 `.dsh-market\log.ndjson` 里往往已经有真正的报错文本，用户转述的原因常常只是猜测。侦察阶段先搜一遍这次要动的包。
- **三个会伪装成「操作失败」的坑**：发布附件和源码 tarball 走不同下载主机，一条超时不能说明仓库拉不动；PowerShell 双引号里的 `$var:` 会被当成作用域限定符，让整条命令解析失败；终端中文乱码是显示层问题，不代表文件坏了。

## 安装

**方式一：让 DSH 自己导入。** 在 DSH 里把本仓库作为技能来源导入（设置 → 技能 → 从 GitHub 仓库导入），选择仓库中的 `open-dsh-desktop-plugin-installer/`。这条路径没有实测过，导入后请确认技能出现在技能列表里。

**方式二：手动放置（实测过）。**

```bash
git clone https://github.com/Rim-World/Open-DSH-Desktop-Plugin-Installer
cp -r Open-DSH-Desktop-Plugin-Installer/open-dsh-desktop-plugin-installer ~/.dsh/skills/
```

Windows（PowerShell）：

```powershell
Copy-Item -Recurse .\Open-DSH-Desktop-Plugin-Installer\open-dsh-desktop-plugin-installer "$env:USERPROFILE\.dsh\skills\"
```

装一份就够：`~/.dsh/skills/`（DSH 技能中枢可管理）或 `~/.agents/skills/`（跨工具通用），二选一。两个根都放会出现同名冲突。安装后不用重启：DSH 会监听技能根目录，新技能在下一个模型步骤就能看到。

## 快速开始

技能被触发后，第一件事是跑只读快照，不需要任何依赖：

```bash
node open-dsh-desktop-plugin-installer/scripts/profile-report.mjs
```

它会打印：profile 和运行时版本、每个依赖的规格与实际安装版本、`dsh.profile.bundles` 的启用状态、`allowBuilds` 和 `minimumReleaseAgeExclude` 里的可疑规则、市场最近的错误事件，以及一个 **attention** 汇总（例如「装了但没启用」「豁免规则重复导致失效」「占位符没填」）。

装某个插件之前，再跑兼容性核对，「该不该装」以它为准：

```bash
# 装之前：从 registry 读元数据，约 1 到 2 秒
node open-dsh-desktop-plugin-installer/scripts/plugin-compat.mjs --spec '@scope/plugin-name'
# 已经装着的这一份，或本地 checkout（离线）
node open-dsh-desktop-plugin-installer/scripts/plugin-compat.mjs --installed plugin-name
node open-dsh-desktop-plugin-installer/scripts/plugin-compat.mjs --dir ./some-plugin
```

输出是插件声明的版本范围、插件类型、实际在用的客户端版本，以及 `✅ 兼容 / ⚠️ 未知 / ❌ 不兼容`（退出码 `0/3/4`；加 `--json` 输出机器可读结果）。不兼容时技能默认不装，会先把冲突项讲清楚，再让用户选。

## 前置条件

- 一台装了 DSH Desktop 的机器。技能用客户端自带的 pnpm：`<安装目录>/resources/runtime/pnpm/bin/pnpm.mjs`。
- 桌面客户端正在运行。`/dsh-market/*` 接口、热挂载、`boot` 时间戳都以它为前提；客户端没开时安装本身能做，但验证做不了，报告里要说明。
- 会话有完整文件权限。profile 在 `~/.dsh` 下，在会话工作区之外，`workspace-write` 会被文件沙箱拒绝。技能第一步就是申请这个权限并说明原因。
- 可选：`gh` CLI 或 `git`，只在拉 git 源插件时需要。

## 设计原则（这些是做法，不是保证）

- **只读优先。** 先侦察，再要权限，再备份，最后才写文件。
- **不碰用户的配置层。** `cordis.patch.yml` 是用户自己的插件开关和配置，客户端会自己维护它；除非用户明确要求改某个插件的配置，技能不改。真要改时也只改已经定位到的那一项配置值，并且改完立刻复验（宿主会重新激活该条目）。
- **幂等。** 已经满足要求就只报告，不重装。
- **写前备份，坏了能回。** 改前把 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（必要时含 `.npmrc`）备份到工作区的带时间戳目录。回滚实测过：一次真实损坏靠恢复这三个文件回到基线。
- **manifest 只做结构化编辑。** 演练中唯一一次真正的破坏就是手拼 JSON 拼错了。技能要求改完立刻解析校验（`ConvertFrom-Json` 或 `JSON.parse`）。
- **如实报告。** 替换文件后旧模块还在内存里跑，报告要说明是否需要重启；没验证过的路径直接说没验证过。判据分四层：来源是什么、宿主半边是否 live、浏览器半边是否冷启动过、功能是否正常。一层一层说，上一层不顶替下一层。

## 目录结构

```text
.
├── README.md
├── EVALUATION.md                        # 评估提示词：改动技能后在新鲜会话里重跑
├── LICENSE
└── open-dsh-desktop-plugin-installer/
    ├── SKILL.md                          # 主流程：触发条件、阶段、覆盖范围
    ├── references/
    │   ├── profile-layout.md             # 目录和文件职责、归属判据、模块解析、三条安装通道的边界
    │   ├── compatibility.md              # 版本、类型、客户端三方核对，汇报模板，决定门
    │   ├── artifact-identity.md          # 产物身份：清单字段、分发通道、tag 与默认分支、校验和、五处名字自洽
    │   ├── update-channels.md            # 更新发现（三条通道）、本地产物替换、取件与命令陷阱
    │   ├── pnpm-supply-chain.md          # 24 小时隔离、豁免规则、registry scope、构建白名单、超时重试、离线安装
    │   ├── verification.md               # 可观测判据：本地接口、日志、探针（含宿主路由探针与激活期校验）、冷启动验证、成功清单
    │   └── troubleshooting.md            # 常见报错对照表（含"更新后功能消失 / 插件页异常"的分诊）
    └── scripts/
        ├── profile-report.mjs            # 只读快照：profile、运行时、已装清单、可疑策略规则（无依赖）
        └── plugin-compat.mjs             # 只读兼容性核对：声明范围、插件类型、客户端版本，给结论和退出码
```

## 版本与生成说明

版本号见 `SKILL.md` frontmatter 的 `metadata.version`，`metadata.updated` 随每次改动更新。本机 DSH 安装的那份与仓库 `main` 保持同步。技能正文和参考文档不写具体排查日期，只保留可复用的判据。

### 0.6.0（更新后的宿主半边核对、激活期校验、四个落账点）

- 修正一处判据：市场接口的 `state: live` 是市场自己的记账，**不等于**宿主 Loader 里那条 fiber 真的 ACTIVE（实测过「市场说 `live`、插件页显示「异常」」的组合）。SKILL.md 的「判据的边界」与 `verification.md` 第 1 节同步改写。
- `verification.md` 第 5 节新增两个小节：**路由探针**（用插件自己的宿主路由判定宿主半边挂没挂上；未知路径 GET 回 404 空体、非 GET/HEAD 回 405 空体，405 不代表路由存在）与**激活期卡住**（插件导出 `Config` 时 Cordis 在 apply 之前校验该行配置，插件新版本收紧 schema 会让旧值当场失败、条目直接 failed 且插件自己的代码一行都不跑；附只读排查与改配置值的修法）。
- SKILL.md 阶段 8 新增第 8 条「宿主半边到底挂上了吗」；阶段 1 新增"四点一致性"核对；`description` 增加触发信号「更新后界面功能或设置栏消失 / 插件页显示「异常」」；一句话流程补上这两处复验动作。
- `profile-layout.md` 新增「四个落账点」一节：依赖行、`pnpm-lock.yaml`、`node_modules\<pkg>\package.json`、`node_modules\.modules.yaml` 四处漂移时，`pnpm install` 会按依赖行把已落盘的版本静默改回去，正确做法是先只读报现状、由用户决定以哪一份为准。同时修正 `cordis.yml` 那一行（它是组合后的完整入口列表，不是空列表），并写明修配置值要改哪两处。
- `troubleshooting.md` 新增四行：市场说 `live` 与插件页「异常」并存、更新后界面功能或设置栏消失、激活期 `invalid config`、四处落账不一致却想 `pnpm install` 对齐。
- `EVALUATION.md` 新增两个提示词：更新后界面消失 / 插件页异常的分诊、四处落账一致性的判定。

### 0.5.0（判据统一、结构整理、脱敏）

- 名字自洽判据全文统一为五处。0.4.0 里 SKILL.md 的四个位置和 `verification.md` 的成功清单还写着「三处」，与 `artifact-identity.md` 不一致；模型不打开参考文档时就会漏查后两处。
- 报错对照表从 SKILL.md 移到新的 `references/troubleshooting.md`，正文只留两条通用原则；阶段 2.6 的命令与终端陷阱收敛为指针，细节单点维护在 `update-channels.md`。
- frontmatter 的 description 从约 1300 字压缩到约 400 字，实现细节移入正文，每个会话常驻的元数据变短。
- 侦察阶段新增一条：确认桌面客户端正在运行。全部验证判据都以它为前提，此前没有写明。
- 新增处置：pnpm 重解包导致无关插件入口文件丢失时，重跑该包的安装让 `prepare` 重新执行，仍失败就回滚本次操作。
- `verification.md` 的文件级检查改为按清单读 patch 路径，不再硬编码 `cordis.patch.yml` 文件名。
- 技能文档与 README 里的真实插件、仓库名全部脱敏为「插件 A / B / C」或占位符；版本号、报错原文和实测数据不变。
- 新增 `EVALUATION.md`，收录三个可重跑的评估提示词。
- `scripts/plugin-compat.mjs` 删除未使用的 `listDirs`，补上 asar 偏移量处理的注释。

### 0.4.0（更新判据与本地产物替换）

- 新增 `references/update-channels.md`：更新有三条互不相通的通道（registry 版本、git 提交、发布附件），市场表只覆盖前两条。本地 tarball 属 `linked` 类，`current` 和 `latest` 为空，`updateAvailable` 恒为 `false`，意思是「我不知道」，不是「已最新」。附本地产物替换步骤、报告模板，以及用当前产物 sha256 对比作者校验和的来源证明。
- SKILL.md 新增阶段 2.6「更新核对」：先取市场表全局视图（`/dsh-market/updates?force=1`，顺带刷新缓存），再对 `linked` 类包逐个回到发布通道核对，读 Releases，排除 `draft`，`prerelease` 交用户判断；报告分开写「可检测」和「可安装」，然后停下让用户决定。
- 「更新不等于启用」写进流程：宿主对未启用包写的状态串是聚合原因，市场自己的禁用清单可能是空的，不从这行字反推用户意图，也不顺手把包加回 `bundles`。
- 阶段 5 增「换 `file:` 本地产物」：改依赖行路径加 `pnpm install --offline`，本地产物更新不需要网络，也避免顺带重解析远端依赖而超时；用 lockfile 里旧文件名零处引用、新文件名有条目来验证。
- 报错处置表新增三条：发布附件和源码 tarball 是不同下载主机；PowerShell 双引号里的 `$var:` 会被当成作用域限定符，写成 `${var}`；终端乱码是显示层问题，不代表文件坏了。
- 产物身份两处补强：仓库名不是包名，标识对不上是常态，以清单为准；作者可以在大版本里换附件名前缀，按清单 `name` 筛而不是按文件名筛。名字自洽从三处扩到五处，并写明「客户端起来了」不等于「这个插件挂上了」。
- 三篇参考文档补内容：`profile-layout.md` 补 `.dsh-tarballs\` 的职责和「状态串是聚合原因」；`verification.md` 补 `force=1` 缓存刷新、用 `boot` 时间戳加 `Get-Process` 启动时间证明改动已被冷启动加载、本地产物替换的验收项；`pnpm-supply-chain.md` 补离线安装。
- 上游地址缺失时给出四级取证顺序：依赖行文件名、产物内文档、日志里的历史 URL、停下问用户。GitHub 的 `asset.digest` 可以零下载核校验和。日志检索要同时搜仓库名、附件名和提交 sha，因为包名常常和它们不同。
- 以上最后两条来自一次新鲜会话测试：两个没有本对话上下文的子会话只拿技能正文跑真实任务，把它们只能临场决定的地方逐条折回技能。

### 0.3.0（产物身份与冷启动验证）

- 新增阶段 2.5 产物身份核对和 `references/artifact-identity.md`：读清单的 `name`、`version`、`private`、`dsh.bundle.patch`；按声明的分发通道取件；tag 解析成 commit 再和默认分支比；有校验和就核；bundle 插件查名字自洽（当时是三处）；本地产物留在稳定位置并写进报告。
- 阶段 8 补第 7 条冷启动验证：浏览器半边只在客户端启动时被求值，`live` 只覆盖宿主半边；失败读客户端自己的启动日志，先把包名移出 `bundles` 恢复。
- `profile-layout.md` 补归属判据：客户端载荷、profile、用户级三层；载荷里被版本清单钉住的那份不要替换。
- `pnpm-supply-chain.md` 补「工具自身的安装脚本被白名单挡住」的识别和两种处置（一次性绕过、持久放宽），升级后要跑一次真实调用，不能只看版本号。

### 0.2.0（兼容性核对成为独立阶段）

- 阶段 2 从「看一眼 engines 和 peers」升级为完整核对加用户决定门（版本、类型、客户端三方核对），配套 `scripts/plugin-compat.mjs` 和 `references/compatibility.md`。
- 修正共享模块 fallback 的说明：它的版本不能当兼容性判据。实测它指向的是 CLI 那份，不是正在运行的桌面端运行时。

### 生成说明

0.4.0 及之前的技能内容由 DeepSeek-V4.1-Flash 生成，来自真实 DSH 桌面端插件安装和更新过程的积累，「覆盖范围」按实际操作记录。0.5.0 的判据统一、结构整理和脱敏在 ZCode 会话中完成，改动以 git 历史为准。0.6.0 补充的是更新后宿主半边的核对判据、激活期校验的处置与四个落账点的一致性规则。

## 许可

[MIT](./LICENSE) © 2026 Rim-World
