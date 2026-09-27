# 兼容性核对：支持版本 + 插件类型 + 你的客户端

装一个和客户端不匹配的插件，代价不是"装错了再卸掉"这么轻：它可能让整棵插件树出问题，也可能**装得上、显示 live、但功能就是不对**（因为加载器不强制 `engines.dsh`，见下）。所以动手前先核对三件事，**把结论汇报给用户，由用户决定**。

一条命令拿到全部判据：

```powershell
node scripts/plugin-compat.mjs --spec '<name[@version|tag]>'   # 装之前（需要网络）
node scripts/plugin-compat.mjs --installed <name>              # 已装的那一份（离线）
node scripts/plugin-compat.mjs --dir <本地目录|checkout>        # 本地源（离线）
```

退出码：`0` 兼容 / `3` 不兼容 / `4` 未知（缺声明）/ `1` 读不到元数据。加 `--json` 给机器读。

## 1. 判据只有一个：**目标客户端自己的**运行时版本

| 你要装进哪里 | 版本从哪读 | 本机实测 |
|---|---|---|
| DSH Desktop（`profile=desktop`，Electron 独占） | `<安装目录>\resources\runtime\primary-runtime\runtime.json` 的 `desktopVersion`；asar 根 `package.json` 的 `@deepseek-ai/dsh-desktop` 是同一个号 | **0.1.7-rc.2** |
| DSH WebUI（`profile=web` 等，由外部 CLI 启动） | 运行它的那个 `dsh` CLI 的版本（`dsh --version`，或读 `<prefix>\node_modules\@deepseek-ai\dsh\package.json`） | **0.1.5-rc.3** |

**两个实测到的陷阱**（都会把人带偏）：

- 这台机器上 PATH 里的 CLI 是 `0.1.5-rc.3`，桌面端运行时是 `0.1.7-rc.2`。**用 CLI 版本判断桌面端是错的**，反过来也一样。同一台机器可以同时有 `desktop` 和 `web` 两个 profile，各自装着一套不同的插件、各自有不同的锚点版本。
- **共享 fallback 的版本不是判据**：`%DSH_HOME%\profiles\node_modules\@deepseek-ai\*` 在本机指向 **CLI 那一份 0.1.5-rc.3**（junction 创建于 2026-08-13，桌面端 22:39 启动后并未改变它）。而 `@klarkxy/dsh-dev-index@0.1.4` 的 peer 要求是 `>=0.1.7-rc.2`，它在桌面端**照样 live、工具可用**。结论：fallback 只能当旁证——它能解析到什么版本，和宿主实际用哪一套并不总是一致。

## 2. 插件声明：缺声明 = 未知，不是不兼容

| 字段 | 含义 | 缺失时怎么说 |
|---|---|---|
| `engines.dsh` | 作者声明的宿主版本范围。**加载器不强制它**（`dsh-dev-index` 作者 README 明写"加载器不强制 `engines.dsh`"），所以不满足范围也可能装得上——这正是要先核对的原因 | "插件没声明支持范围，**未知**" |
| `engines.node` | 对 Node 的要求；和运行时 node（本机 24.21.0）比 | 同上 |
| `peerDependencies` 的 `@deepseek-ai/*` | 宿主包。`autoInstallPeers: false`，由共享 fallback 提供；**只有在插件真的 `import` 它时才要紧**（只通过 `ctx.<service>` 用的，解析不到也没关系） | 逐条列出范围，别下结论 |
| `dsh.bundle.patch` | **loader 契约**：有这个才是"bundle 插件" | 没有 → 见下"普通依赖" |

本机实测：desktop profile 的 10 个第三方插件里**只有 2 个**声明了 `engines.dsh`。所以"未声明"是常态——不要拿它当拒绝安装的理由，但也不能反过来拍胸脯保证。

## 3. 插件类型：宿主半边 / 浏览器半边 / 两者 / 普通依赖

| 证据 | 结论 |
|---|---|
| `dsh.bundle.patch` 存在 | **宿主半边**：向组合里插入 Loader 行（`lib/*.js` 之类的宿主代码） |
| `dsh.client` 存在，且 `exports["./client"]` 有值 | **浏览器半边**：宿主扫描 Loader row 上的 `dsh.client`，组合成 `window.__DSH_BOOT__`，在 `/plugins` 下提供 bundle（客户端模块系统） |
| 两者都有 | 宿主 + 界面：**Desktop 与 WebUI 都加载同一套 web 客户端协议** |
| 两者都没有 | **普通依赖**：官方文档原文——"没有 `dsh.bundle` 声明的包仍然可以安装，但只作为普通依赖：`dsh plugin` 会打印警告，且不激活任何层" |
| 只有 `dsh.client`、没有 patch | 界面代码在，但没有行把它挂成 Loader row → **不生效**，除非有别的 patch 行引用它 |

关于 `platform`：文档里 `dsh.client.platform` 的取值是 `'web'`（本机 10 个插件里带客户端半边的清一色 `platform: web`）。**`platform: 'web'` 不等于"只支持 WebUI"**——桌面端本身就是"web 客户端 + 宿主"。桌面端真正的差异不在插件类型，而在：profile 由客户端独占（`dsh plugin --profile desktop` 被拒）、市场对 git 源一律拒绝、以及插件自己可能写死了某些假设。

所以类型结论只能说到"**两端都在加载路径上**"；**"能用"必须装完实测**（`/dsh-market/installed` 的 `state: live` + 功能冒烟）。

## 4. 汇报什么、然后由用户决定

把脚本输出原样转述，别加保证。结构建议：

```
插件：<name>@<version>（来源：registry / 本地目录 / 已装）
它声明支持：engines.dsh=<范围或"未声明">；engines.node=<范围>；peer=n 项
它是哪一类：宿主半边 + 浏览器半边（两端都在加载路径上）
你的客户端：DSH Desktop 0.1.7-rc.2（profile=desktop，客户端独占）
判定：✅ 兼容 / ⚠️ 未知（没声明支持范围）/ ❌ 不兼容（<具体冲突项>）
需要你决定：① 按计划安装  ② 换一个满足范围的版本  ③ 取消
```

**决定门（不许跳）**：

- **不兼容**：默认**不安装**。先把冲突项讲清楚，再让用户在 ① 换版本 ② 换插件 ③ 明知有风险仍要装 之间选。
- **未知**：可以建议装，但要说明"作者没声明范围，无法预先保证"，并确认用户接受。
- **兼容**：按流程推进，仍然要说明"类型结论不等于已验证"。

用户坚持要装不兼容的版本：写清风险 → 按 SKILL.md 阶段 4 备好三个文件 → 装完**立刻**做阶段 8 的验证 → 把"已知不兼容但仍安装"写进最终报告。

## 5. 排错

| 现象 | 处置 |
|---|---|
| `读不到元数据：超时` | 这台机器对 registry 的连接偶尔要十几秒。默认预算已是 60 s；重试一次，或改用 `--spec <name>@<精确版本>`（只取单个版本文档，响应更小），或退回 `pnpm view`（注意：本机实测 `pnpm view` 一次跑了 **3 分钟以上**，别用它当快速路径） |
| 私有 scope 取不到 | 脚本按 `.npmrc` 解析 registry：`<profile>\.npmrc` → `$DSH_HOME\.npmrc` → `~\.npmrc`，scope 规则优先；必要时 `--registry <url>` 覆盖 |
| 想完全离线 | 用 `--installed` / `--dir`，加 `--offline` |
| 脚本报 `semver` 相关 | 它从共享 fallback 借 `semver`；借不到会退回粗略比较器（输出里 `--json` 的 `semver` 字段会写 `rough-comparator`），此时复杂范围请人工再看一眼 |
