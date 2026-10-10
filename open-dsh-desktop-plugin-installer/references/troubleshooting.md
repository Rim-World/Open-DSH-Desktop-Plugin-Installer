# 常见报错 → 处置对照表

SKILL.md 阶段流程中撞到的报错在这里对照。两条通用原则（SKILL.md「常见报错」一节）同样适用：先搜 `.plugin-manager\logs\*\pnpm.log` 与 `.dsh-market\log.ndjson`，再确认 pnpm 到底改没改盘。深挖细节的文档在各行右列标注。

| 报错 | 含义 | 处置 |
|---|---|---|
| `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（`Lockfile failed supply-chain policy check`） | lockfile 里有年轻条目且未被豁免。pnpm **先写 lockfile、再校验**，所以哪怕只有一次更新失败，那条年轻条目也已经留在 lockfile 里——它会拦住一切操作（含无关插件、GUI、市场） | 本次命令加 `--config.minimum-release-age=0`；把该版本并进 `minimumReleaseAgeExclude`（**同一包名只留一条**，多个版本用 `||`）。不要去"修"被连累的其它插件。详见 `pnpm-supply-chain.md` 第 1 节 |
| `ERR_PNPM_NO_MATCHING_VERSION` | 当前 registry 没有这个版本（镜像滞后 / 装错源） | 查多个 registry；给该 scope 配 `.npmrc` 指向官方源。详见 `pnpm-supply-chain.md` 第 2 节 |
| `ERR_PNPM_IGNORED_BUILDS` / `set this to true or false` | git 依赖的构建脚本未被允许 | 在 `allowBuilds` 写精确 tarball 键（值 `true`）后重跑。详见 `pnpm-supply-chain.md` 第 3 节 |
| `this desktop operation is not supported by the official plugin manager` | 桌面端 profile 不接受该操作（市场/CLI 路径） | 走 GUI 的「插件」页，或用本技能直接写 profile |
| `profile "desktop" is managed exclusively by the Electron application` | CLI 被设计性拒绝 | 不要用 CLI 管理桌面端 profile |
| 下载超时（`codeload` / `[23] operation was aborted due to timeout`） | GitHub 直连不稳 | 先用 `--fetch-timeout=600000 --fetch-retries=6`；**发布附件与源码 tarball 走不同主机**，一条通道超时不等于这个仓库拉不动——换通道（Release 附件）往往能下载。先搜插件管理器日志，那里通常已有真正的报错文本。详见 `pnpm-supply-chain.md` 第 4 节 |
| 市场更新表里某个包是 `kind=linked`、版本字段为空、`updateAvailable:false` | 这个接口**不覆盖本地产物**（`file:` tarball / 发布附件），"false"表示"不知道"而非"已最新" | 回到它自己的发布通道核对（Releases 的附件名 + 校验和）；报告里为这类包单独说明，别把它算进"已最新"。详见 `update-channels.md` 第 1 节 |
| 换了本地产物但版本没变 | `file:` 依赖记的是**路径**：只换了文件名没改依赖行，或改了依赖行没重新安装 | 结构化改依赖行 → `install --offline`；用 lockfile 里旧文件名 0 处、新文件名有条目来确认，而不是看目录里有没有新文件。详见 `update-channels.md` 第 3 节 |
| 终端里中文显示成乱码 | 控制台编码 ≠ 文件编码（显示层问题） | 判文件好坏看 `ConvertFrom-Json` / 哈希，不要因为乱码重写文件 |
| 命令报"变量引用无效"后整条退出 | PowerShell 双引号里的 `$var:` 被当成作用域限定符，与操作本身无关 | 把变量写成 `${var}`；不要把它当成"这次操作失败了" |
| `EPERM … rename 'package.json.<随机数>' -> 'package.json'` | Windows 上 pnpm 的原子改名撞上文件占用 | 这条命令是**整体失败**的（依赖没写进去）：稍等再重试；若清单已被改坏，用备份恢复 |
| 市场接口的 `installed` / `activation` / `bundles` 同时为空 | `package.json` 非法（多半是被手写坏的） | 立刻解析校验；从备份恢复三个文件，宿主会自行重读 |
| `engines.dsh` 不包含当前客户端版本 | 作者声明的支持范围与你的客户端不符（加载器不会替你拦） | 先跑 `plugin-compat.mjs`，把冲突项讲清楚，让用户选：换版本 / 换插件 / 明知风险仍安装（备份 + 装后立刻验证） |
| 插件装上、也 live，但**完全没反应** | 这个包没有 `dsh.bundle.patch`（不是 bundle 插件，只是普通依赖），或它的浏览器半边没有 patch 行把它挂成 Loader row | 官方文档：这类包可以安装，但不激活任何层。别当"装好了"，回去看作者的安装说明 |
| 插件装了但界面没变化 | 运行中进程仍持旧模块 | 重启 DSH；替换文件不会热换模块代 |
| 冷启动后客户端起不来 / 白屏，宿主只说某条 entry `did not activate` / `import failed` | 失败在**浏览器半边**；宿主那句是症状，原因在客户端启动日志的 renderer console 里 | 读客户端用户数据目录下的启动/崩溃日志（`verification.md` 第 6 节）；先把该包名移出 `dsh.profile.bundles` 恢复可用，再按 `artifact-identity.md` 第 5 节查五处名字是否自洽 |
| 客户端报某注册键**重复注册**，或启动报重复 entry id | 同一个东西被登记了两次：两种接入方式都用了（`bundles` 里一条 + 手写一条 `insert`），或包改名后内部 id 与包名不一致 | 先确认接入方式只有一种；再核对 `artifact-identity.md` 第 5 节的五处名字（包名 / entry `name` / 客户端注册 id / 浏览器半边导出名 / 宿主半边生产者标识）是否一致 |
| 其它插件的入口文件在安装后消失 | pnpm 整体重解包依赖树，把无关插件的构建产物退回"未构建"状态 | 对该包按依赖行里已有的 specifier 重跑一次 `pnpm add --config.minimum-release-age=0`，让 `prepare` 重新执行；仍失败就回滚本次操作。详见 `pnpm-supply-chain.md` 第 5 节 |
| 市场接口说某个插件 `live`，插件页却显示「异常」，它的界面功能也少了 | 两个面说的不是一件事：市场那条 `state` 是市场自己的记账，插件页的「异常」是宿主 Loader 报的 `fiberPhase=FAILED`。条目激活失败时它自己的宿主路由一条都不会注册，插件的按需资产块因此整批 404，浏览器侧那些功能各自退役 | 用插件自己的宿主路由判定：未知路径 GET 回 404 空体、非 GET/HEAD 回 405 空体，别拿 405 当"路由在"；整条前缀 404 才说明没挂上。详见 `verification.md` 第 5 节的「路由探针」 |
| 更新后某个插件的界面功能 / 设置栏消失 | 与上一行同源：宿主半边没挂上时，插件的按需资产块整批 404，页面侧那些功能各自退役——看起来像"安装不完整"，其实文件都在 | 先探宿主路由，再按激活期校验排查；**不要**先重装或怀疑文件没复制全。详见 `verification.md` 第 5 节 |
| 激活期抛 `invalid config: … expected boolean but got …`（多半只在日志/诊断里，界面上看不到） | 插件的新版本收紧了它自己的 `Config` schema，而 profile 里存着旧版本写下的值。Cordis 在 apply **之前**校验，条目直接 failed，插件自己的 init 一行都不跑 | 用插件包导出的 `Config` 校验 profile 里现存的值，把冲突的那一项改成新 schema 接受且语义等价的值；宿主会重新激活该条目，改完用路由探针复验。详见 `verification.md` 第 5 节的「激活期卡住」 |
| 依赖行还是旧版本、`node_modules` 里已是新版本（四处落账不一致），想 `pnpm install` 对齐 | 四个落账点（依赖行 / `pnpm-lock.yaml` / `node_modules\<pkg>\package.json` / `node_modules\.modules.yaml`）漂移。pnpm 按**依赖行**重解，`install` 会把已落盘的新版本静默改回去 | 不要直接 `install`：先只读地报出现状，问清漂移的来源与用户意图，再由用户决定以哪一份为准。详见 `profile-layout.md` 的「四个落账点」一节 |
