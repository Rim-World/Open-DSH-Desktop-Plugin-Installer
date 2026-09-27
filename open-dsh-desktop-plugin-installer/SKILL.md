---
name: open-dsh-desktop-plugin-installer
description: 为 DSH Desktop（Electron 客户端）的 profile 安装、升级、启用、停用、卸载插件，并在 pnpm 供应链策略、镜像滞后、git 构建白名单把安装挡住时给出处置；改坏清单或安装失败时按备份回滚。桌面端 profile 由客户端独占：`dsh plugin --profile desktop` 被明确拒绝，dsh-market 对 git 源的插件一律拒绝，所以只能「按 profile 的真实语义写文件 + 跑它自己的 pnpm」。触发场景：用户说「装/更新/停用/卸载 DSH 插件」「插件装不上」「更新失败」「插件市场目录加载失败」，或 pnpm 报 ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION / NO_MATCHING_VERSION / ERR_PNPM_IGNORED_BUILDS / Lockfile failed supply-chain policy / EPERM rename，或要装指定版本、要给 GitHub 源的插件更新，或要求别重复安装。Install, update, enable, disable or remove a plugin in a DSH Desktop profile, and repair pnpm supply-chain / registry / build-approval failures.
whenToUse: 目标是 DSH Desktop 的插件生命周期操作，而官方 GUI / 市场 / CLI 走不通或需要版本级控制时。
---

# Open DSH Desktop Plugin Installer

DSH Desktop 的插件不是"复制一个目录"就完事的：一个插件要同时存在于三处——**依赖**（`package.json` 的 `dependencies`）、**启用**（`dsh.profile.bundles` 列表）、**落盘**（`node_modules`）。官方面板做这三步；当它做不到时，本技能按同样的语义手工完成，并且每一步都可验证、可回滚。

先读 `references/profile-layout.md` 了解目录与文件职责；涉及 pnpm 报错时读 `references/pnpm-supply-chain.md`；需要可观测证据时读 `references/verification.md`。`scripts/profile-report.mjs` 一条命令给出当前 profile 的完整快照（只读，先跑它）。

## 何时走哪条路（按优先级）

| 场景 | 走这里 |
|---|---|
| 普通安装（npm 包、GUI 能用） | GUI：侧边栏/设置 →「插件」→ Add plugin（支持 npm 名、git 地址、tarball、本地绝对路径；内含 inspect、注册表选择、回滚、热挂载） |
| 会话在 Creator 模式 | `plugin_manager` 工具（`install_bundle` / `remove_bundle` / `set_bundle_enabled`），要求 `danger-full-access` 或逐次批准 |
| GUI 拒绝、需要精确版本、git 源更新、pnpm 报策略错 | **本技能**（直接操作 profile） |
| 只想开关某个插件 | 改 `dsh.profile.bundles`，或 GUI 的开关；不要动用户的 `cordis.patch.yml` 配置行。停用与启用两个方向都已实测 |
| 卸载插件 | GUI「插件」页的卸载，或按阶段 7 的顺序手工做（已实测，见「卸载 / 禁用」） |

市场（dsh-market）不是安装通道：它只装自己精选目录里的插件，检测到有 agent 在跑时直接拒绝安装，且对 git 源（`github:`）在桌面端一律拒绝（其日志写 `this desktop operation is not supported by the official plugin manager`）。它可以当**观测工具**（见下）。

## 覆盖范围：先说清本技能验证过什么

这条规则比任何步骤都重要：**不要在没做过的路径上给用户保证**。

已实测（Windows + DSH Desktop 运行时 `0.1.7-rc.2` + 自带 pnpm `11.7.0`）：

| 路径 | 实测内容 |
|---|---|
| 安装 npm 包 | 装进 profile 并确认宿主 `live` |
| 升级 npm 包 | 含镜像滞后时用 scope 级 `.npmrc` 绕过 |
| 升级 git 源插件 | 含 `prepare` 构建与 `allowBuilds` 键 |
| 启用 | 写进 `dsh.profile.bundles`，宿主热挂载，无需重启 |
| **停用** | 移出 `dsh.profile.bundles`：宿主数秒内卸下该行，状态变 `disabled`、`bundle:false`、进入 `unbundled`；**依赖与 `node_modules` 文件保留**；无需重启 |
| **卸载** | 按官方顺序（先停用 → 再 `pnpm remove`）：依赖、`installed`、`activation`、`node_modules`、`unbundled` 全部回到基线，其余插件仍 `live` |
| **从备份回滚** | 在一次真实损坏（manifest 写坏、宿主丢失整个插件列表）后恢复三个文件，宿主自动回到"全 live、无诊断、与基线逐字节一致" |
| 策略与镜像 | 修复失效的 `minimumReleaseAgeExclude`、scope 级 `.npmrc`、`allowBuilds` 键 |
| 验证 | 用宿主接口与日志判定结果，而不是看文件在不在 |

演练对象是一份**本地临时 bundle**（自己的空实现，`file:` 源）。**未验证**：停用/卸载**第三方**（npm / git 源）插件时插件自身的副作用、**顺序颠倒**（仍启用着就 `pnpm remove`）、纯客户端插件（只有 `dsh.client`、无宿主半边）的完整生命周期、Creator 模式的 `plugin_manager` 工具路径、macOS/Linux 上的行为。碰到这些场景，先把不确定性说清楚，再考虑走 GUI。

## 阶段 0 — 先要权限

直接写 profile 需要完整文件权限（profile 在 `~/.dsh` 下，位于会话工作区之外，`workspace-write` 会被文件沙箱拒绝）。

- 先向用户申请 `danger-full-access`（或对每条命令单独批准），并说明原因：要写 `%DSH_HOME%\profiles\<profile>`、要跑 profile 自己的 pnpm、要改 `package.json`。不要用"绕过去"的手法尝试。
- 权限到手前只做只读侦察。

## 阶段 1 — 侦察（只读）

```powershell
node scripts/profile-report.mjs            # 自动定位 DSH_HOME / profile / 运行时版本
```

要点：

- **profile 目录**：`$env:DSH_PROFILE_DIR`（会话已给）；否则 `$env:DSH_HOME\profiles\<profile>`。桌面端固定叫 `desktop`。
- **宿主运行时版本**（决定兼容性，别拿 CLI 的版本当它）：`<安装目录>\resources\runtime\primary-runtime\runtime.json` 的 `desktopVersion`；asar 内 `dsh/package.json` 的 `version` 是同一件事。
- **pnpm 用 profile 自带的那个**：`<安装目录>\resources\runtime\pnpm\bin\pnpm.mjs`，用 PATH 上的 `node` 跑（`node <pnpm.mjs> …`）。不要用系统 npm/pnpm 去装 profile 依赖，也不要在 profile 目录外跑。
- **`dsh plugin --profile desktop` 是被拒绝的**（启动器硬编码该 profile 归 Electron 客户端所有）。不要浪费时间去试它或用 `--dump-config`。
- 看有没有别的插件操作正在跑：`<profile>\.plugin-manager\run.json` 存在就等它结束再动。
- 先把「用户装了哪些插件、各自版本/来源」记下来，便于事后比对（`profile-report.mjs` 会打印）。

## 阶段 2 — 兼容性预检（写之前必须做）

装一个和宿主不兼容的插件会连累整棵树。拿到 spec 后先问 registry 要元数据：

```powershell
node $pnpm view '<pkg>@<version>' engines peerDependencies dsh --json
node $pnpm view '<pkg>' versions --json           # 有哪些版本
```

逐项判定：

1. **`engines.dsh`** 必须包含宿主运行时版本（例如宿主 `0.1.7-rc.2`，插件要求 `>=0.1.7-rc.2 <0.2.0` ✓）。
2. **`dsh.bundle.patch`** 存在才是一个"bundle 插件"（`dsh.plugin.json` 不是 loader 契约，仅作者自用）。
3. **`peerDependencies` 里的宿主包**（`@deepseek-ai/*`）由 profile 的模块 fallback 提供：`%DSH_HOME%\profiles\node_modules\@deepseek-ai\*`。有些宿主包**只存在于宿主进程内**、profile 里解析不到（例如 `@deepseek-ai/dsh-agent-preset-registry`）；如果插件只是通过 `ctx.<service>` 用它，就没问题——**判断标准是它是否真的 `import` 该包**，读一遍 `lib/*.js` 的 import。
4. **服务契约**：宿主插件可导出 `inject = [...]`；确认宿主提供这些服务（常见：`systemPrompt`、`tools`、`agentPresets`、`skill`）。
5. **解析探针**（最能提前发现"装上就炸"）：在插件目录放一个临时 `.mjs`，用 `import.meta.resolve()` 和动态 `import()` 验证它的真实依赖能解析、模块能加载；验证完删掉。

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
    - dsh-opencode-go@0.1.12||0.1.14||0.1.15
    - '@scope/pkg@1.2.3||1.2.4'
  ```

- **一次性绕过**（它的存在就是为了让 install 能起步）：

  ```powershell
  node $pnpm add --config.minimum-release-age=0 '<pkg>@<exact-version>'
  ```

  这个"绕过"和上面的"豁免条目"是两件事：前者让**本次**命令能跑（否则 lockfile 里任何一条年轻条目都会让校验失败），后者让**以后**的 GUI/市场操作不再被拦。都要做。

- 装完立刻核对：`package.json` 的版本、`node_modules/<pkg>/package.json` 的版本、以及**其它插件的入口文件是否还在**（pnpm 会整体重解包依赖树，偶尔会让某个插件的构建产物"回到原始状态"）。
- 版本选择优先级：用户点名的版本 > 官方 registry 的 `latest` > 镜像能给的成熟版本。镜像还没有最新版时，不要用"降级"糊弄过去——用阶段 3 的 scope `.npmrc` 解决。

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

1. `GET http://127.0.0.1:<port>/dsh-market/installed` → 目标插件 `state: "live"`、`bundle: true`，`unbundled` 为空、`diagnostics.findings` 为空。这是**宿主 Loader 的实况**（它按"有活着的 fiber"判定），比读文件强。
2. `GET /dsh-market/api/v1/updates/summary` → 确认已装版本与上游版本一致（`updatable` 不再包含它）；注意它**有缓存**，外部改动后需要一次使缓存失效的操作（例如重设同一区域）才会刷新。
3. 文件级：版本号正确、入口文件存在、解析探针能 `import()`。
4. 策略级：把当前真实文件复制到临时目录跑 `node <pnpm.mjs> install --lockfile-only`，应输出 `✓ Lockfile passes supply-chain policies`。这样验证的是"以后 GUI/市场操作不会再被拦"。
5. 市场日志（`<profile>\.dsh-market\log.ndjson`）与插件管理器日志（`<profile>\.plugin-manager\logs\*\pnpm.log`）是排错的第一现场，出错时先读它们，而不是猜。

任何一步失败：用阶段 4 的备份恢复 manifest/lockfile（pnpm 下载残留的文件可以留，下次操作会清理），然后如实报告实际状态。

## 阶段 9 — 交付与幂等

- **幂等**：动手前先查 profile-report 的输出——已经装了且已启用、版本满足要求，就**只报告、不重装**；用户明确说"别重复安装"时更是如此。
- 报告里要写清：装/升到了哪个版本（或哪个提交）、是否已 live、**是否需要重启**才生效、改了哪几个文件、备份在哪、怎么回滚。
- 如果这次的改动同时修好了用户的既有故障（例如某条豁免规则失效导致的全局阻塞），一并说明——用户需要知道"为什么之前装不上"。

## 常见报错 → 处置

| 报错 | 含义 | 处置 |
|---|---|---|
| `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（`Lockfile failed supply-chain policy check`） | lockfile 里有年轻条目且未被豁免；它会拦住一切操作 | 本次命令加 `--config.minimum-release-age=0`；把该版本并进 `minimumReleaseAgeExclude`（**同一包名只留一条**，多个版本用 `||`） |
| `ERR_PNPM_NO_MATCHING_VERSION` | 当前 registry 没有这个版本（镜像滞后 / 装错源） | 查多个 registry；给该 scope 配 `.npmrc` 指向官方源 |
| `ERR_PNPM_IGNORED_BUILDS` / `set this to true or false` | git 依赖的构建脚本未被允许 | 在 `allowBuilds` 写精确 tarball 键（值 `true`）后重跑 |
| `this desktop operation is not supported by the official plugin manager` | 桌面端 profile 不接受该操作（市场/CLI 路径） | 走 GUI 的「插件」页，或用本技能直接写 profile |
| `profile "desktop" is managed exclusively by the Electron application` | CLI 被设计性拒绝 | 不要用 CLI 管理桌面端 profile |
| 下载超时（`codeload` / `[23] operation was aborted due to timeout`） | GitHub 直连不稳 | 加长等待重试：`--fetch-timeout=600000 --fetch-retries=6` |
| `EPERM … rename 'package.json.<随机数>' -> 'package.json'` | Windows 上 pnpm 的原子改名撞上文件占用 | 这条命令是**整体失败**的（依赖没写进去）：稍等再重试；若清单已被改坏，用备份恢复 |
| 市场接口的 `installed` / `activation` / `bundles` 同时为空 | `package.json` 非法（多半是被手写坏的） | 立刻解析校验；从备份恢复三个文件，宿主会自行重读 |
| 插件装了但界面没变化 | 运行中进程仍持旧模块 | 重启 DSH；替换文件不会热换模块代 |

## 一句话流程

要权限 → 读 profile/运行时/已装清单 → 查兼容性（engines/peers/服务/探针）→ 解决 registry 与 GitHub 链路 → 备份 → 钉版本安装（绕过 + 豁免）→ 需要时补 `allowBuilds` → 写进 `dsh.profile.bundles` → 用宿主的接口验证 live → 报告是否需要重启。
