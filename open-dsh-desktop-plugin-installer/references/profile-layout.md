# DSH Desktop profile 布局与职责

一次插件操作会同时牵动四层：**安装**（客户端自带运行时）、**profile**（每用户的配置与依赖）、**宿主进程**（Loader 与插件实例）、**GUI/市场**（观测面）。分清这四层，才知道哪一步该改哪个文件。

## 路径

| 位置 | 内容 |
|---|---|
| `$env:DSH_HOME`（默认 `~/.dsh`） | 全部用户数据的根 |
| `$env:DSH_HOME\profiles\<profile>` | profile 根目录（桌面端 profile 固定叫 `desktop`） |
| `$env:DSH_HOME\profiles\node_modules` | **共享模块 fallback**：宿主包的软链/联结，profile 内插件靠它解析 `@deepseek-ai/*` |
| `<安装目录>\resources\app.asar` | 客户端打包的 DSH 运行时（`dsh/node_modules/**` 里有宿主自己的包） |
| `<安装目录>\resources\runtime\primary-runtime\runtime.json` | `desktopVersion` = 宿主运行时版本（**兼容性判定的依据**） |
| `<安装目录>\resources\runtime\pnpm\bin\pnpm.mjs` | 客户端自带的 pnpm（profile 操作要用它） |
| `<安装目录>\resources\runtime\bin\node.cmd` | 客户端自带的 node 启动壳（依赖 `DSH_DESKTOP_NODE_EXECUTABLE`）；用 PATH 上的 `node` 跑 `pnpm.mjs` 即可 |

Windows 安装目录通常在 `%LOCALAPPDATA%\Programs\DeepSeek Harness`；macOS 是 `/Applications/DeepSeek Harness.app/Contents/Resources`；Linux 随发行包而变。`scripts/profile-report.mjs` 会挨个探测。

## 先分清"谁的"：客户端自带的 vs 你装的

写盘前先确定你正要改的东西归谁。桌面端的文件大体分三层：

| 层 | 典型位置 | 归谁 | 动它的后果 |
|---|---|---|---|
| 客户端载荷 | `<安装目录>\resources\**`（宿主运行时、自带 node、自带 pnpm，以及一份版本清单） | 客户端 | **应用更新会整体覆盖**；载荷里的版本清单钉住"应用要调用哪个版本" |
| 插件 profile | `%DSH_HOME%\profiles\<profile>\**` | 客户端 + 你（见下一节） | 本技能的操作面 |
| 用户级工具 | 例如 `npm config get prefix` 指向的目录里的全局包 | 你 | 用户说"更新本机某个工具"通常指这里 |

三条判据，用来把"客户端载荷"和"你装的"分开：

1. **路径在不在安装目录里**：安装目录下的 `resources\...` 是应用自带的。
2. **有没有同伴版本清单**：载荷里常有 `versions.json` 之类钉住版本的文件；被钉住的版本就是"应用实际会调用的那个"。
3. **它是真目录还是链接**：`Get-Item <path> | Select-Object LinkType,Target`。若它是指向用户级安装的链接，那"版本"取决于链到谁；若是真目录（`LinkType` 为空）且带自己的一份 `package.json`，那它是自带的一份。

**不要为了让 profile 换一个包管理器版本去替换载荷里的那一份**：应用永远调用自带的那份，替换只会在下一次应用更新时被悄悄覆盖，还会让"实际用的版本"与载荷清单写的版本不一致。用户说"更新本机工具"时，指的是**用户级**那一份。（本技能做 profile 操作一律用自带那份跑，操作日志里会写它实际用的版本。）

## profile 目录里的关键文件

| 文件 | 谁拥有 | 说明 |
|---|---|---|
| `package.json` | 配置（客户端 + 你） | `dependencies` = 装了什么；`dsh.profile.bundles` = **启用**了哪些（顺序即层叠优先级）。pnpm 写前者，后者是"启用状态"的真相 |
| `pnpm-workspace.yaml` | 客户端 + pnpm | `nodeLinker: hoisted`、`autoInstallPeers: false`（所以 peer 不由 pnpm 自动安装，必须由宿主提供）、`allowBuilds`（依赖构建脚本白名单）、`minimumReleaseAgeExclude`（新发布隔离豁免） |
| `pnpm-lock.yaml` | pnpm | 精确解析结果；git 依赖在这里记录成 `https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>` + integrity |
| `.npmrc` | 你（可选） | 按 scope 指定 registry，例如 `@scope:registry=https://registry.npmjs.org/`；作用域规则优先于 `--registry` |
| `cordis.patch.yml` | **用户** | 用户的配置层：插件的启停行、各插件配置、权限预设、模型等。客户端自己会写它（例如切换权限预设时）。除"用户明确要求改某个插件的配置"外不要动 |
| `cordis.yml` | 客户端 | 空入口列表；客户端在重新组合时重写 |
| `.plugin-manager\` | 客户端内置插件管理器 | `run.json` = 正在进行的包操作（存在就别动手）；`logs\<op>\pnpm.log` = 每次操作的 pnpm 原始输出 |
| `.dsh-market\` | dsh-market 插件 | `state.json`（区域、收藏、禁用）、`log.ndjson`（市场自己的事件流）、`discovery-compatibility-v1.json` |
| `node_modules\` | pnpm | 真正落盘的插件 |

## 插件的三重身份

一个插件要同时满足三处才算"装好并启用"：

1. `dependencies` 里有它（`pnpm add` 写）；
2. `dsh.profile.bundles` 里有它（启用；不写就是装了没开）；
3. `node_modules/<pkg>` 里有它的**入口产物**（`dsh.bundle.patch` 指向的 patch 文件、`main`/`exports` 指向的 JS）。

判定"它是不是 bundle 插件"的契约是 **`package.json` 的 `dsh.bundle.patch`**；`dsh.plugin.json` 只是作者自用元数据，loader 不读它。带 `dsh.client` 的插件还有浏览器半边（由客户端的 client-modules 在页面里挂载）。

## 模块解析（为什么 peer 不用装）

profile 里的插件 `import '@deepseek-ai/dsh-tools'` 时，Node 会一路向上找到 `%DSH_HOME%\profiles\node_modules\@deepseek-ai\dsh-tools`——一个 **junction / 软链**（打包发行版里则是 ESM proxy 文件）。要点：

- **它指向哪一份，取决于谁创建或"治愈"了它，不一定是你正在跑的那个宿主。** 本机实测：这些 junction 全部创建于 2026-08-13，指向 npm 全局的 CLI 安装 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（**0.1.5-rc.3**），而桌面端跑的是 **0.1.7-rc.2**；桌面端 22:39 启动后并没有改变它们。
- 所以：peer **能解析**（大多数 `@deepseek-ai/*` 在 profile 里找得到），但**它的版本不能当兼容性判据**——要求 `>=0.1.7-rc.2` peer 的 `@klarkxy/dsh-dev-index@0.1.4` 在这台机器上照样 `live`、工具可用。判版本请用目标客户端自己的运行时版本（见 `compatibility.md`）。
- 少数包（例如 `@deepseek-ai/dsh-agent-preset-registry`）不以文件形式存在于任何地方，只在宿主进程内——profile 里解析会 `ERR_MODULE_NOT_FOUND`。**这不一定代表插件会坏**：只要插件是通过 `ctx.<service>` 用它（peer 只用于类型/服务名），运行时没问题。判断依据是插件的实际 `import` 语句。
- `autoInstallPeers: false` 是关键：pnpm 不会去 npm 上找这些宿主包（npm 上也没有），所以**不要**把 `autoInstallPeers` 打开。

## 三条安装通道与它们的边界

| 通道 | 能力 | 边界 |
|---|---|---|
| GUI「插件」页（侧边栏/设置 → 插件） | Add plugin：包名(可带版本)、git 地址、tarball、本地绝对路径；含 inspect 预检、注册表选择、pnpm 输出、回滚、**热挂载**（无需重启） | 需要人点；Bundle 卡片的开关会改写 `dsh.profile.bundles` |
| `plugin_manager` 工具 | `install_bundle` / `remove_bundle` / `set_bundle_enabled` / `inspect` / `list_bundles` | 仅 Creator 模式的预设默认启用；每次调用要求 `danger-full-access` 或逐次批准 |
| `dsh-market` 插件 | 逛精选目录、一键装、检查更新 | **只装它目录里的插件**；有 agent 正在跑时**拒绝安装**；桌面端对 `github:` 源一律拒绝（`this desktop operation is not supported by the official plugin manager`）。可当观测工具用 |
| `dsh plugin --profile desktop`（CLI） | — | **被设计性拒绝**：`profile "desktop" is managed exclusively by the Electron application`。不要试 |

## 宿主进程与"生效"

- 宿主在客户端进程内；Loader 维护一棵插件树，每个条目有 fiber。**"live" 的判定是"该条目有活着的 fiber"**，不是"配置文件里有"。
- 桌面端会监听 profile manifest 并**热挂载新启用的 bundle**；因此新装插件通常不需要重启。
- 但**替换已装插件的文件（版本升级/git 新提交）不会替换内存里的模块代**：运行中的进程继续跑旧代码，新代码要重启宿主才加载。
- 宿主重启会换 `boot` 标识（在市场 status 接口里可见），也是判断"我刚才的改动是否需要重启"的一个旁证。
