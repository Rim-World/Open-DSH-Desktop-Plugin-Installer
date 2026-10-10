---
name: open-dsh-desktop-plugin-installer
description: "在 DSH Desktop（Electron 客户端）的 profile 上安装、升级、启用、停用、卸载插件，装坏时按备份回滚。动手前先做三项只读核对——插件声明的支持范围与类型、来源产物到底是哪个包、哪些包按各自的分发通道有更新——结论交用户决定；再处置 pnpm 供应链策略、镜像滞后、git 构建白名单挡路的问题。只适用于桌面端 profile；`state: live` 只覆盖宿主半边，带浏览器半边的插件要冷启动客户端才算验证过。触发场景：用户说「装/更新/停用/卸载 DSH 插件」「这个插件能不能装」「它支持我这个版本吗」「有几个插件能更新」「帮我更新一下」「插件装不上」「更新失败」「插件市场目录加载失败」「装完一重启客户端就起不来/白屏」，或要装指定版本、要给 GitHub 源的插件更新，或 pnpm 报 ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION / NO_MATCHING_VERSION / ERR_PNPM_IGNORED_BUILDS / Lockfile failed supply-chain policy / EPERM rename，或要求别重复安装；插件更新后某个界面功能或设置栏消失、插件页显示「异常」时也用本技能。"
whenToUse: 目标是 DSH Desktop 的插件生命周期操作（含「这个插件能不能装到我这台机器上」「有哪些能更新」这类先验问题），而官方 GUI / 市场 / CLI 走不通、需要版本级控制、或市场的更新表对某个包根本没有版本信息时。
metadata:
  version: "0.6.0"
  upstream: https://github.com/Rim-World/Open-DSH-Desktop-Plugin-Installer
  updated: "2026-10-11"
  scope: "DSH Desktop (Electron) profile, Windows; 停用/卸载/回滚只在本地临时 bundle 上演练过——见「覆盖范围」"
---

# Open DSH Desktop Plugin Installer

DSH Desktop 的插件不是"复制一个目录"就完事的：一个插件要同时存在于三处——**依赖**（`package.json` 的 `dependencies`）、**启用**（`dsh.profile.bundles` 列表）、**落盘**（`node_modules`）。官方面板做这三步；当它做不到时，本技能按同样的语义手工完成，并且每一步都可验证、可回滚。

先读 `references/profile-layout.md` 了解目录与文件职责（含「这个文件归客户端还是归你」的判据）；要判断「这个插件能不能装到我这个客户端」时读 `references/compatibility.md` 并跑 `scripts/plugin-compat.mjs`；**要装的东西是从 URL / 本地文件 / 别人给的地址来的**，先读 `references/artifact-identity.md` 钉住它到底是哪个包；**用户问「有几个能更新 / 帮我更新」或要换一个本地产物（`file:` 依赖、发布附件）时**，读 `references/update-channels.md`——"没有更新"这句话很可能只是一个接口对该包沉默，见阶段 2.6；涉及 pnpm 报错时读 `references/pnpm-supply-chain.md`；需要可观测证据、或要判断某个插件的宿主半边到底挂没挂上时读 `references/verification.md`；遇到报错先查 `references/troubleshooting.md` 的对照表。`scripts/profile-report.mjs` 一条命令给出当前 profile 的完整快照（只读，先跑它）。

## 何时走哪条路（按优先级）

| 场景 | 走这里 |
|---|---|
| 「这个插件支持我的版本吗 / 它是给桌面端还是网页端的」 | 阶段 2：`scripts/plugin-compat.mjs` 出结论，**汇报给用户由用户决定**。已经装着且已启用时，转阶段 9 只报告、不重装 |
| 「拿到一个仓库地址 / 本地 tarball / 别人口述的包名，不确定装出来是哪个包」 | 阶段 2.5：产物身份核对（`references/artifact-identity.md`）——**写盘前**做；名字对不上就先问用户 |
| 「有几个插件能更新 / 帮我更新一下」 | 阶段 2.6 + `references/update-channels.md`：**不要**把市场的更新表当完整答案——它对本地产物（`linked`）没有版本信息，`updateAvailable:false` 在那里只表示"不知道"；逐个包按它自己的分发通道核对 |
| 「装着的这个插件是本地 tarball / 发布附件，怎么换新版」 | `references/update-channels.md` 第 3 节：换文件 + 改依赖行的路径 + `install --offline`；全程不需要 registry |
| 普通安装（npm 包、GUI 能用） | GUI：侧边栏/设置 →「插件」→ Add plugin（支持 npm 名、git 地址、tarball、本地绝对路径；内含 inspect、注册表选择、回滚、热挂载） |
| 会话在 Creator 模式 | `plugin_manager` 工具（`install_bundle` / `remove_bundle` / `set_bundle_enabled`），要求 `danger-full-access` 或逐次批准 |
| GUI 拒绝、需要精确版本、git 源更新、pnpm 报策略错 | **本技能**（直接操作 profile） |
| 只想开关某个插件 | 改 `dsh.profile.bundles`，或 GUI 的开关；不要动用户的 `cordis.patch.yml` 配置行。停用与启用两个方向都已实测 |
| 卸载插件 | GUI「插件」页的卸载，或按阶段 7 的顺序手工做（已实测，见「卸载 / 禁用」） |

市场（dsh-market）不是安装通道：它只装自己精选目录里的插件，检测到有 agent 在跑时直接拒绝安装，且对 git 源（`github:`）在桌面端一律拒绝（其日志写 `this desktop operation is not supported by the official plugin manager`）。它可以当**观测工具**（见下）。

## 覆盖范围：先说清本技能验证过什么

这条规则比任何步骤都重要：**不要在没做过的路径上给用户保证**。

已实测（Windows + DSH Desktop，运行时 `0.1.7-rc.2` 与 `0.2.0-rc.2` 两代都做过，自带 pnpm `11.7.0`）：

| 路径 | 实测内容 |
|---|---|
| **兼容性核对（版本 + 类型）** | 对已装插件、本地目录、registry（`--spec`，约 1.2 s）三类目标判定 `engines.dsh` / `engines.node` / 类型（宿主半边 / 浏览器半边 / 普通依赖）/ peer 旁证；用一个合成的 `engines.dsh=">=0.2.0 <0.3.0"` 包验证了 ❌ 分支与退出码 `3`，`⚠️ 未知` 走退出码 `4` |
| 安装 npm 包 | 装进 profile 并确认宿主 `live` |
| 升级 npm 包 | 含镜像滞后时用 scope 级 `.npmrc` 绕过 |
| 升级 git 源插件 | 含 `prepare` 构建与 `allowBuilds` 键；也做过只换提交、版本号不变的窄更新（改的是 4 个文件、无构建步骤） |
| **换 `file:` 本地产物（发布附件新版）** | 下载新版附件 → 与作者校验和比对 → 换 profile 内文件 → 改依赖行路径 → `pnpm install --offline` 落地（3.7 s，不触碰远端依赖）；旧产物保留可回滚。同一次还实测了：**市场接口对这类包给 `kind=linked`、版本字段为空、`updateAvailable:false`**——它不是"已最新" |
| 启用 | 写进 `dsh.profile.bundles`，宿主热挂载，无需重启 |
| **停用** | 移出 `dsh.profile.bundles`：宿主数秒内卸下该行，状态变 `disabled`、`bundle:false`、进入 `unbundled`；**依赖与 `node_modules` 文件保留**；无需重启 |
| **卸载** | 按官方顺序（先停用 → 再 `pnpm remove`）：依赖、`installed`、`activation`、`node_modules`、`unbundled` 全部回到基线，其余插件仍 `live` |
| **从备份回滚** | 在一次真实损坏（manifest 写坏、宿主丢失整个插件列表）后恢复三个文件，宿主自动回到"全 live、无诊断、与基线逐字节一致" |
| 策略与镜像 | 修复失效的 `minimumReleaseAgeExclude`、scope 级 `.npmrc`、`allowBuilds` 键 |
| **更新后的宿主半边实况核对** | 用插件自己的宿主路由（而不是市场那条 `state`）判定"挂没挂上"；核实过「条目激活期校验不通过 → 该条目 failed → 它的按需资产块整批 404」这条链路，并实测了修法与复验 |
| 验证 | 用宿主接口与日志判定结果，而不是看文件在不在 |

**停用 / 卸载 / 回滚**的演练对象是一份**本地临时 bundle**（自己的空实现，`file:` 源）；安装、升级、换本地产物、启用则在真实第三方插件上做过。**未验证**：停用/卸载**第三方**（npm / git 源）插件时插件自身的副作用、**顺序颠倒**（仍启用着就 `pnpm remove`）、纯客户端插件（只有 `dsh.client`、无宿主半边）的完整生命周期、Creator 模式的 `plugin_manager` 工具路径、macOS/Linux 上的行为，以及类型结论之后的**功能冒烟**——"两端都在加载路径上"不等于"功能一定正常"。碰到这些场景，先把不确定性说清楚，再考虑走 GUI。

**判据的边界（补上的一条）**：`diagnostics` 由宿主 Loader 给出，但市场接口那条 `state: live` 是市场自己的记账，**不能替代宿主 Loader 的条目实况**——实测过「市场说 `live`、插件页显示「异常」」的组合，所以"清单干净"之后还要取一条插件自己的可观测面（阶段 8 第 8 条）。`state: live` 也只覆盖宿主半边；带浏览器半边的插件要冷启动客户端才算验证过（机制与读日志的位置见 `references/verification.md` 第 6 节）。产物身份核对是**离线**的，不依赖网络；其中"五处名字自洽"是唯一能预判客户端启动失败的检查，但它只判注册键对不对，不判功能。

## 阶段 0 — 先要权限

直接写 profile 需要完整文件权限（profile 在 `~/.dsh` 下，位于会话工作区之外，`workspace-write` 会被文件沙箱拒绝）。

- 先向用户申请 `danger-full-access`（或对每条命令单独批准），并说明原因：要写 `%DSH_HOME%\profiles\<profile>`、要跑 profile 自己的 pnpm、要改 `package.json`。不要用"绕过去"的手法尝试。
- 权限到手前只做只读侦察。
- **用户只是问"为什么会失败 / 怎么修"时，不要顺手去修**：停在"只读侦察 + 诊断 + 修法"，把要不要动手交给他。阶段 1、阶段 2、阶段 3 的诊断部分，以及 `pnpm-supply-chain.md` 的只读替代，全都不需要写权限。

## 阶段 1 — 侦察（只读）

```powershell
node scripts/profile-report.mjs            # 自动定位 DSH_HOME / profile / 运行时版本
```

要点：

- **profile 目录**：`$env:DSH_PROFILE_DIR`（会话已给）；否则 `$env:DSH_HOME\profiles\<profile>`。桌面端固定叫 `desktop`。
- **确认桌面客户端正在运行**：后面的全部验证判据（`/dsh-market/*` 接口、热挂载、`boot` 时间戳）都依赖它。`profile-report.mjs` 的市场探测连不上或 `DSH_WEB_URL` 缺失时，先请用户启动客户端再进入写盘阶段；客户端没开时仍可完成安装本身，但「启用后即 live」无从验证，要在报告里说明。
- **宿主运行时版本**（决定兼容性，别拿 CLI 的版本当它）：`<安装目录>\resources\runtime\primary-runtime\runtime.json` 的 `desktopVersion`；asar 内 `dsh/package.json` 的 `version` 是同一件事。
- **pnpm 用 profile 自带的那个**：`<安装目录>\resources\runtime\pnpm\bin\pnpm.mjs`，用 PATH 上的 `node` 跑（`node <pnpm.mjs> …`）。不要用系统 npm/pnpm 去装 profile 依赖，也不要在 profile 目录外跑。
- **`dsh plugin --profile desktop` 是被拒绝的**（启动器硬编码该 profile 归 Electron 客户端所有）。不要浪费时间去试它或用 `--dump-config`。
- 看有没有别的插件操作正在跑：`<profile>\.plugin-manager\run.json` 存在就等它结束再动。
- **先搜一遍这两个日志里有没有你这次要动的包**（`<profile>\.plugin-manager\logs\*\pnpm.log`、`<profile>\.dsh-market\log.ndjson`）——同一条命令之前失败过时，真正的报错文本就在那里，而用户转述的原因往往只是猜测。这一步很便宜，能省掉一次盲目重试。**不要只搜包名**：仓库名 / 附件文件名 / 提交 sha 都可能出现，而它们常与包名不同；包名 0 命中不等于没有记录，换关键词再搜一次。
- 顺手记下**每个包属于哪条分发通道**（npm 版本 / `github:` 提交 / `file:` 本地产物）——阶段 2.6 的更新核对要按通道分别做。
- **动手前核一次"四点一致性"**：同一个包"装了什么"记在四处——依赖行（`dependencies`）、`pnpm-lock.yaml`、`node_modules\<pkg>\package.json`、`node_modules\.modules.yaml`。出现"依赖行还是旧版本、`node_modules` 里已是新版本"这类漂移时，**不要用 `pnpm install` 去对齐**：pnpm 按依赖行重解，会把已落盘的新版本静默改回去。先只读地报出现状、问清这份漂移是谁造成的（有些作者的发版流程只更新文件、不改依赖行），再由用户决定以哪一份为准。逐项判据见 `references/profile-layout.md` 的「四个落账点」一节。
- 先把「用户装了哪些插件、各自版本/来源」记下来，便于事后比对（`profile-report.mjs` 会打印）。

## 阶段 2 — 兼容性核对：版本 + 类型 + 客户端，然后交给用户决定

装一个和宿主不兼容的插件会连累整棵树；更麻烦的是**加载器不强制 `engines.dsh`**——范围不满足的插件也可能装得上、显示 live，但功能就是不对。所以这一段是**写盘前的决定门**；判定规则、汇报模板与排错见 `references/compatibility.md`。

```powershell
node scripts/plugin-compat.mjs --installed <pkg>              # ① 先看已经装着的这一份（离线，零成本）
node scripts/plugin-compat.mjs --dir <本地目录|checkout>       # ② 本地源（离线）
node scripts/plugin-compat.mjs --spec '<pkg>@<version|tag>'   # ③ 最后才查 registry（需要网络，约 1–2 秒）
```

**先走 ①**：如果它**已经装着、已经启用、版本又正好是要的那个**，那就没有"装不装"可决定了——直接转阶段 9，**只报告，不重装**（用户说"别重复安装"时尤其如此）。只有确实要新装/升级/换版本时，才用 ③ 去问 registry。

它一次给出四件事：插件声明的 `engines.dsh` / `engines.node` / peer；它是哪一类（宿主半边 / 浏览器半边 / 两者 / **普通依赖**）；**目标客户端自己的**版本；以及 `✅ 兼容` / `⚠️ 未知` / `❌ 不兼容`。退出码 `0` / `3` / `4` / `1`，`--json` 给机器读。

判据要点（都有实测依据，别改）：

1. **锚点只能是目标客户端的版本**：Desktop 读 `runtime.json` 的 `desktopVersion`，WebUI 读运行该 profile 的 CLI 版本。本机 PATH 上的 `dsh` 是 `0.1.5-rc.3` 而桌面端运行时是 `0.1.7-rc.2`——拿 CLI 版本判断桌面端必然错。共享 fallback 里的 `@deepseek-ai/*` 版本**也不是**判据（本机它指向 CLI 那一份，而 peer 要求 `>=0.1.7-rc.2` 的某第三方插件照样 live）。
2. **缺声明 = 未知，不是不兼容**：本机 10 个第三方插件里只有 2 个声明了 `engines.dsh`。如实说"未知"，别拍胸脯。
3. **没有 `dsh.bundle.patch` 就不是 bundle 插件**：官方文档明说这类包可以安装，但只作普通依赖、**不激活任何层**。"装了完全没反应"多半是这个原因。
4. **`dsh.client.platform` 是 `web`**，不代表"只支持 WebUI"——桌面端本身就是"web 客户端 + 宿主"。类型结论只说明"在加载路径上"；**"能用"必须装完用宿主的 `state: live` 实测**。
5. **peer 只看插件是否真的 `import` 它**：只通过 `ctx.<service>` 引用的（例如 `@deepseek-ai/dsh-agent-preset-registry`，profile 里解析不到），没问题。
6. **解析探针**（本地目录/已有 checkout 时最有用）：在插件目录放一个临时 `.mjs`，用 `import.meta.resolve()` 和动态 `import()` 验证它的真实依赖能解析、模块能加载；验证完删掉。它回答"装上会不会立刻炸"，与"该不该装"互补。

**然后停下，把结论汇报给用户**，给三个选项：① 按计划安装 ② 换一个满足范围的版本（`--spec <name>@<版本>` 重新核对）③ 取消。**不兼容时默认不安装**；用户明知风险仍要装，就写清风险、先备份（阶段 4）、装完立刻验证（阶段 8），并把"已知不兼容但仍安装"写进最终报告。**不要替用户决定。**

## 阶段 2.5 — 产物身份核对（写盘前）

阶段 2 说"这个插件支不支持我的客户端"；这一步说更前面的事：**你手上的来源装出来到底是哪个包**。完整判据与报告模板见 `references/artifact-identity.md`，最少做四件事：

1. 读**产物自己**的 `package.json`：`name` / `version` / `private` / `dsh.bundle.patch`。**依赖表和 `dsh.profile.bundles` 都用清单里的 `name`**，不是你输入的那个字符串。
2. 名字对不上就停下来问用户（"你给的标识是一个名字，装进去的包是另一个名字"）。装错包比装不上更贵：它会把一个来源不明的依赖写进 profile，而且报告里那一行会和你声称装的东西对不上。
3. 按作者声明的**分发通道**取件：宣告只发发布附件的，registry 上的同名包就是另一个项目；宣告只发 registry 的，git 源会拿到未发布的开发状态。作者给了校验和就先核一遍（注意 HTTP 取回可能是字节数组，先转文本再比）。
4. **默认分支 ≠ 发布产物**：把 tag 解析成 commit，和默认分支 HEAD 比一比；不同就把差别讲给用户，并优先**钉提交 / 钉产物**，不要在 profile 里留一个浮动分支引用。

**bundle 插件还要多做一步自洽检查**——它是唯一能预判"装上会不会在客户端启动时崩"的离线检查：包名、补丁文件里 entry 的 `name`、浏览器半边注册自己用的 id、浏览器半边的导出名、宿主半边的生产者标识，**五处必须一致**（判据与真实案例见 `references/artifact-identity.md` 第 5 节）。改名时漏掉后两处的包会表现成"宿主半边照样 `live`、诊断为空，一重启客户端起不来"。顺手确认用户那一层 `cordis.patch.yml` 里没有同名的 `insert`（两种接入方式只能选一种，都做会插两次）。

**仓库名不是包名**：仓库可以改名、包可以改名、同名包可以属于另一个项目。"你给的标识 ≠ 清单里的 `name`"不是异常，而是常态——**以清单为准**，并把两边都讲给用户。作者在某次大版本里换掉**附件名前缀**也是允许的，所以按清单过滤，别按文件名过滤。

## 阶段 2.6 — 更新核对：「有几个能更新」不能只看一个接口

完整判据见 `references/update-channels.md`。核心只有一句：

**更新有三个互不相通的通道（registry 版本 / git 提交 / 发布附件），而市场表格只覆盖前两个。** 本地 tarball 属于 `linked` 类——它的 `current` 与 `latest` 都是空的、`updateAvailable` 恒为 `false`。**这个 `false` 的意思是"我不知道"，不是"它是最新的"。** 把这一行读成"无需更新"，就会漏掉真正的更新。

所以核对流程是：

1. 先用市场的更新表拿全局视图（`/dsh-market/updates?force=1`，`force` 会顺手刷新缓存，比"重设区域"更直接）。引用它的 `checked`（扫了几个包）而不是只引用 `updatable`——`updatable: 0` 只有在 `checked` 等于你预期的包数时才说明"都看过了、没有更新"。
2. 对每个 `linked` 类（以及任何版本字段为空的）包，**回到它自己的分发通道**去核对：读仓库的 Releases，先排除 `draft`，把 `prerelease` 交用户判断；取版本更高、且与本地同族的那个附件。
3. 写报告时把「可检测」（旧 → 新，附提交号 / 版本号 / 附件名）与「可安装」（通道、要改哪一行、要不要构建）分开说，然后**停下让用户决定**。
4. 动手前，**先用当前落盘产物的 sha256 与它所属版本发布的校验和比一次**：一致才说明你换的是官方产物；不一致就先停下问清楚来源。

**更新 ≠ 启用。** 一个包可以装了但没启用（不在 `dsh.profile.bundles` 里）；宿主对它写的状态串（"已停用(市场开关或补丁层)"）是**聚合原因**，不代表用户主动关过它。更新只动依赖与文件，**不要顺手启用**；更新完把"它现在是启用还是停用"如实告诉用户，由他决定要不要开。

**用户口述的状态与 manifest 冲突时，以 manifest 为准，但不静默改**：用户说"它没启用"而 `bundles` 里其实有它（或反过来）是常见情形——他的印象可能来自上一个版本的表现、来自界面没出现，或单纯记错。这时**只报告事实与可能的机制**，把开关留给用户：不要为了"符合他的描述"去停用，也不要"顺手改成一致"。

### 命令与终端上的自伤陷阱（会伪装成"操作失败"）

三条在这个阶段反复出现过：PowerShell 双引号里的 `$var:` 会被当成作用域限定符（写成 `${var}`）；终端中文乱码是显示层问题，不代表文件坏了；发布附件与源码 tarball 走不同下载主机，一条通道超时不能推出"这个仓库拉不动"。判别与处置见 `references/update-channels.md` 第 5、6 节。

这个阶段的产物通常需要**换掉 profile 里的一个文件**，落地方式见 `references/update-channels.md` 第 3 节（改依赖行路径 + `pnpm install --offline`，不需要 registry）。

## 阶段 3 — 网络与镜像（先解决，别等中途失败）

- **registry 滞后**：`node $pnpm config get registry` 看当前镜像（国内机器常是 `registry.npmmirror.com`）。镜像对新发布有滞后；当目标版本镜像还没有、而 `package.json` 已钉住它时，**每一次走默认镜像的 pnpm 操作都会 `ERR_PNPM_NO_MATCHING_VERSION`**（连无关的 git 插件更新也会被挡住）。
  解法：在 profile 里放一个 `.npmrc`，**只给该 scope** 指官方源：

  ```
  @scope:registry=https://registry.npmjs.org/
  ```

  作用域规则的优先级高于 `--registry`，所以 GUI/市场（它们会显式传 `--registry`）也一并受益。
- **GitHub**：`api.github.com` 一般可用；`codeload.github.com` 直连**时好时坏**（会挂到超时）。pnpm 用不了 `gh-proxy` 这类"路径前缀代理"，所以正确做法不是换 URL，而是**加长等待并重试**：`--fetch-timeout=600000 --fetch-retries=6`。下载大 tarball 时给足时间（含它自己的 `prepare` 构建，几分钟是正常的）。
- **dsh-market 报「插件目录加载失败 / The operation was aborted due to timeout」**：那是它自己取目录/来源超时，不是插件坏了。可切区域（设置 → 插件市场 → 高级 → 区域 → 国内：目录走腾讯 npm 镜像、GitHub 走 gh-proxy），或稍后重试。
- **GitHub 来源的插件**：先用 `git ls-remote https://github.com/<owner>/<repo> HEAD` 或 `GET https://api.github.com/repos/<owner>/<repo>/commits?per_page=1` 拿到目标提交 sha，后面 registry 与 `allowBuilds` 都要用它。

## 阶段 4 — 备份（写之前）

把将要改的文件复制到会话工作区里一个带时间戳的目录：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（有 `.npmrc` 也复制）。同时记下回滚命令。**`cordis.patch.yml` 不要纳入"我要改的文件"**——那是用户的配置层（插件的开关与配置行），客户端自己会写它。

**回滚怎么做（已实测）**：把这三个文件复制回去就行——宿主会自己重读清单。实测在一次真实损坏（`package.json` 非法、插件列表全空）后，恢复后立刻回到"全 live、无诊断、与基线逐字节一致"。回滚后如果 `node_modules` 里还留着一个已不在依赖表里的目录，直接删掉（下一次 pnpm 操作也会清理它）。

**改 manifest 的唯一正确姿势**：结构化编辑（JSON 解析后改字段再写回，或用精确文本替换整行），**改完立刻解析校验**。手写字符串拼 JSON 是本技能演练中唯一一次真正的破坏来源。

## 阶段 5 — 安装 npm 包（要最新版就别用裸名）

关键事实：pnpm 有一条 24 小时"新发布隔离"策略（`minimumReleaseAge`，默认 1440 分钟）。

- **裸名安装会静默降级**：`pnpm add <pkg>` 在隔离期内会挑"够老的"那个版本，退出码仍是 0——你以为装的是 latest，其实是上一版。
- **要最新版就必须两件事一起做**：① 显式钉版本；② 把该版本写进 `minimumReleaseAgeExclude`（否则 lockfile 的供应链校验会拦住**之后所有**操作，包括 GUI 和市场的）。
- **`minimumReleaseAgeExclude` 一个包名只能有一条规则**！pnpm 的版本策略只取"第一个匹配到包名的规则"，同一包名的第二条及以后**完全不生效**。多版本用 `||` 并成一条：

  ```yaml
  minimumReleaseAgeExclude:
    - some-plugin@0.1.12||0.1.14||0.1.15
    - '@scope/pkg@1.2.3||1.2.4'
  ```

- **一次性绕过**（它的存在就是为了让 install 能起步）：

  ```powershell
  node $pnpm add --config.minimum-release-age=0 '<pkg>@<exact-version>'
  ```

  这个"绕过"和上面的"豁免条目"是两件事：前者让**本次**命令能跑（否则 lockfile 里任何一条年轻条目都会让校验失败），后者让**以后**的 GUI/市场操作不再被拦。都要做。

- 装完立刻核对：`package.json` 的版本、`node_modules/<pkg>/package.json` 的版本、以及**其它插件的入口文件是否还在**（pnpm 会整体重解包依赖树，偶尔会让某个插件的构建产物"回到原始状态"）。发现丢失时，对该包按依赖行里已有的 specifier 重跑一次 `pnpm add --config.minimum-release-age=0`，让它的 `prepare` 重新执行；仍失败就回滚本次操作（阶段 4 备份）并如实报告。
- 版本选择优先级：用户点名的版本 > 官方 registry 的 `latest` > 镜像能给的成熟版本。镜像还没有最新版时，不要用"降级"糊弄过去——用阶段 3 的 scope `.npmrc` 解决。

### 换掉一个 `file:` 本地产物（发布附件的新版）

不涉及 registry，`pnpm add` 那套也用不上：改的是**文件与依赖行里的路径**。步骤、验证与报告模板见 `references/update-channels.md` 第 3 节，要点是：下载后先核作者校验和 → 复制进 profile 的稳定位置再核一次 → 结构化改依赖行 → `node pnpm.mjs install --offline` 落地（本地文件更新不需要网络，`--offline` 还避免顺带重解析远端依赖而超时）→ 旧产物**保留**以便回滚 → 数 lockfile 里新旧文件名的引用数（旧应为 0）。

## 阶段 6 — 安装 git 依赖（GitHub 源）

```powershell
node $pnpm add --config.minimum-release-age=0 'github:<owner>/<repo>'          # 跟随默认分支 HEAD
node $pnpm add --config.minimum-release-age=0 'github:<owner>/<repo>#<sha>'    # 钉提交
```

- 这类包的 `prepare` 脚本会真的执行（要用它自己的 devDependencies 构建），所以：
  - 先算好它将被解包成的**精确 tarball URL**：`https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>`（就是阶段 3 拿到的 HEAD sha）；
  - 在 `pnpm-workspace.yaml` 的 `allowBuilds` 里给出**精确键**：

    ```yaml
    allowBuilds:
      dshmarket@https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>: true
    ```

  - 若 pnpm 报 `ERR_PNPM_IGNORED_BUILDS`，或它自己往文件里写了 `…: set this to true or false` 的占位符，把值改成 `true` 后重跑。
- 给足超时（几个 GB 的 devDeps + 构建，5–10 分钟是正常的）。构建失败就看它打印的构建日志，别急着换版本。
- 更新完成后，旧提交的 `allowBuilds` 键在 `pnpm-lock.yaml` 不再引用它（可 `Select-String` 搜旧 sha，应为 0 次）时再删，保持文件干净。

## 阶段 7 — 启用并让它生效

依赖装好**不等于**插件启用。启用 = 把包名加进 `package.json` 的 `dsh.profile.bundles`（追加到末尾；顺序就是层叠优先级）：

```json
"dsh": { "profile": { "bundles": [ "...", "@scope/pkg" ] } }
```

- 桌面端会监听 manifest 并**热挂载**新增的 bundle 行（可以用阶段 8 的接口立刻确认，不必重启）。
- **替换已装插件的文件（升级）需要重启宿主**才能加载新的模块代；运行中的进程仍持有旧代码。不要在没重启的情况下声称"新功能已生效"。
- 永远不要为了生效去改用户的 `cordis.patch.yml`（改它只会引入意外）。

### 停用 / 卸载（顺序已实测）

**停用**（保留依赖，只是不再加载）：

1. 把包名从 `package.json` 的 `dsh.profile.bundles` 移除。**用结构化 JSON 编辑，不要做字符串拼接**（原因见下面的教训）。
2. 数秒后查 `/dsh-market/installed`：该包 `state` 变 `disabled`（原因串："已停用(市场开关或补丁层),重启后保持关闭"）、`bundle:false`、`hot:false`，并出现在 `unbundled` 里；依赖与 `node_modules` 里的文件都还在。**不需要重启。**
3. 想恢复：把包名加回 `bundles`，秒级回到 `live`。

**卸载**（官方顺序：先停用，再移除）：

1. 先按上面的步骤把它移出 `bundles`。次序颠倒会让运行中的实例先丢文件（这一条按官方说明执行，本技能未单独演练颠倒的情形）。
2. `node $pnpm remove --config.minimum-release-age=0 <pkg>`
3. 复验：`installed` 不再有它、`activation` 不再有它、`unbundled` 为空、`node_modules/<pkg>` 已消失、其余插件仍 `live`、`diagnostics` 为 0。**实测无需重启。**

### 两条被演练撞出来的真实教训

- **写坏 `package.json` = 整个插件列表消失。** 用字符串/正则拼 JSON 很容易漏一个逗号或引号；清单一旦非法，宿主就读不出任何插件——市场接口的 `installed`、`activation`、`bundles` 会同时变空（本次演练真的发生过）。**改完立刻**用 `ConvertFrom-Json`（或 `JSON.parse`）校验；坏了就从阶段 4 的备份恢复。
- **Windows 上 pnpm 可能报 `EPERM … rename 'package.json.<随机数>' -> 'package.json'`。** 宿主或监视器短暂占用文件时会发生。这一次 `pnpm add` 是**完全失败**的——依赖根本没写进去，别按"退出码非 0 但仍装上了"来理解。处置：稍等片刻重试同一条命令；若这次操作已经改坏了清单，用备份恢复。

## 阶段 8 — 验证（要有可观测证据）

优先用宿主自己给出的状态，而不是"文件在不在"：见 `references/verification.md`。至少做到：

1. `GET http://127.0.0.1:<port>/dsh-market/installed` → 目标插件 `state: "live"`、`bundle: true`，`unbundled` 为空、`diagnostics.findings` 为空。它能证明"这一行在 bundle 层、市场认为它挂着"，但**不是 fiber 实况**（见第 8 条），也不是文件级的证据。
2. `GET /dsh-market/api/v1/updates/summary` → 确认已装版本与上游版本一致（`updatable` 不再包含它）；注意它**有缓存**，外部改动后需要一次使缓存失效的操作（例如重设同一区域）才会刷新。
3. 文件级：版本号正确、入口文件存在、解析探针能 `import()`。
4. **功能冒烟（零风险、不用改盘）**：如果插件包里有 `dsh.plugin.json`，把它 `contributes.tools` / `contributes.skills` 列出的东西**对着自己会话的工具表 / 技能目录核一遍**——工具在、技能在，就说明宿主半边真的挂上了，比 `state: live` 强得多。注意 `dsh.plugin.json` 是**作者自用的元数据，官方 loader 并不读它**（loader 认 `package.json` 的 `dsh.bundle.patch`），所以它只能当线索，不能当契约。
5. 策略级：把当前真实文件复制到临时目录跑 `node <pnpm.mjs> install --lockfile-only`，应输出 `✓ Lockfile passes supply-chain policies`。这样验证的是"以后 GUI/市场操作不会再被拦"。
6. 市场日志（`<profile>\.dsh-market\log.ndjson`）与插件管理器日志（`<profile>\.plugin-manager\logs\*\pnpm.log`）是排错的第一现场，出错时先读它们，而不是猜。

7. **带浏览器半边的插件（`dsh.client`）必须冷启动才算验证过。** 上面六步都只覆盖**宿主半边**：热挂载不会求值浏览器半边，所以 `live` + 0 诊断并不等于"能用"。要么让用户重启客户端并确认起得来，要么在报告里明说"浏览器半边未验证"。客户端起不来时**别在 profile 日志里找原因**——去客户端自己的用户数据目录读它的启动/崩溃日志，真正的错误在其中的 renderer console 里；宿主报的那句"某条 entry 没有激活 / import failed"只是症状。把该包名移出 `dsh.profile.bundles` 就能立刻恢复。机制与读法见 `references/verification.md` 第 6 节。

任何一步失败：用阶段 4 的备份恢复 manifest/lockfile（pnpm 下载残留的文件可以留，下次操作会清理），然后如实报告实际状态。

8. **宿主半边到底挂上了吗（更新之后尤其要做）**：拿那个插件**自己的**一个宿主路由请求一次，看它回不回自己的响应。别用 404/405 下结论——未知路径 GET 回 404 空体，非 GET/HEAD 的未知路径回 405 空体（核心 webServer 的兜底），整条前缀都回 404 空体才说明**它的路由一条都没注册**，也就是宿主半边没挂上（这时插件页那条会显示「异常」，因为宿主 Loader 报的是 `fiberPhase=FAILED`）。最常见的原因不在安装：插件的新版本**收紧了它自己的 `Config` schema**，而 profile 里存着旧版本写下的值，激活期校验直接失败，插件自己的 init 一行都不跑。判定与修法见 `references/verification.md` 第 5 节的两个小节（路由探针 / 激活期卡住）。

## 阶段 9 — 交付与幂等

- **幂等**：动手前先查 profile-report 的输出——已经装了且已启用、版本满足要求，就**只报告、不重装**；用户明确说"别重复安装"时更是如此。
- 报告里要写清：装/升到了哪个版本（或哪个提交）、是否已 live、**是否需要重启**才生效、改了哪几个文件、备份在哪、怎么回滚。
- 如果这次的改动同时修好了用户的既有故障（例如某条豁免规则失效导致的全局阻塞），一并说明——用户需要知道"为什么之前装不上"。

## 常见报错 → 处置

全部报错的对照表在 `references/troubleshooting.md`：`ERR_PNPM_*` 与供应链策略、registry 与下载超时、市场接口异常、`EPERM rename`、冷启动失败等。两条通用原则：

- 先搜 `<profile>\.plugin-manager\logs\*\pnpm.log` 与 `<profile>\.dsh-market\log.ndjson`——同一条命令之前失败过时，真正的报错文本就在那里。检索时仓库名 / 附件名 / 提交 sha 都要试，别只搜包名（包名 0 命中不等于没有记录）。
- pnpm 报错后先确认它到底改没改盘：`EPERM … rename` 是**整体失败**（依赖没写进去）；清单被改坏的迹象是市场接口的 `installed` / `activation` / `bundles` 同时为空，此时用阶段 4 的备份恢复三个文件。
- 症状不在 pnpm 侧时（例如"更新后某个界面功能消失"、插件页显示「异常」），先按阶段 8 第 8 条判定宿主半边挂没挂上，再看 `references/troubleshooting.md` 里对应那几行的处置。

## 一句话流程

要权限 → 读 profile / 运行时 / 已装清单（**含先搜一遍日志里有没有这次要动的包**、并核一次四点一致性）→ **核对产物身份（清单 `name`/`version`、分发通道、tag 与 HEAD、校验和、五处名字自洽）** → **核对兼容性（引擎范围、插件类型、客户端版本）并汇报给用户、由用户决定** → **若是"更新"：按每个包自己的通道核对可更新版本（市场的 `linked` 行不算答案），把结论交给用户** → 解决 registry 与 GitHub 链路 → 备份 → 按通道落地（npm 钉版本 + 绕过 + 豁免 / git 钉提交 + `allowBuilds` / `file:` 换文件 + 改依赖行 + `install --offline`）→ 写进 `dsh.profile.bundles`（**更新不自动等于启用，问过用户再动**）→ 用宿主的接口验证 live、再取一条插件自己的实况（宿主路由 / 工具表）→ **带浏览器半边的说明"冷启动才算验证过"或完成冷启动** → 报告是否需要重启、备份在哪、怎么回滚。
