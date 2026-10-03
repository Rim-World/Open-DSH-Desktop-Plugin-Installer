# pnpm 供应链策略、registry 与构建白名单

在 DSH profile 里跑 pnpm 会撞上三类"看起来像插件坏了、其实是包管理器策略"的问题：**新发布隔离**、**registry 滞后**、**构建脚本白名单**。这份文档是处置手册，附带"怎么验证修好了"。

## 1. 新发布隔离（minimumReleaseAge）

pnpm 11 默认启用"新发布隔离"：默认 **1440 分钟（24 小时）** 内的新版本会被隔离。

### 它在两个地方生效

1. **解析阶段**：`pnpm add <pkg>`（裸名）在隔离期内**静默**挑"够老的"那个版本，退出码仍是 0——你以为装了 latest，其实落后一版。设 `minimumReleaseAgeStrict: true` 时会改成提示/报错。
2. **lockfile 校验阶段**：只要 `pnpm-lock.yaml` 里存在一条"够年轻且未豁免"的条目，**每一次**包操作都会在
   `✗ Lockfile failed supply-chain policy check` / `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
   处失败——**包括 GUI 与市场发起的操作**。这是最容易被误判成"插件市场坏了"的一类故障。

   **注意顺序：pnpm 先把新版本写进 lockfile，然后才做校验。** 所以哪怕只有**一次**更新失败，那条年轻条目也已经留在 lockfile 里了——这就是"我更新 A 插件失败，为什么 B 插件、GUI、市场全都动不了"的答案。修法只有把那条条目豁免掉（或回滚 lockfile），而不是去修 B 插件。

```text
✗ Lockfile failed supply-chain policy check (271 entries in 742ms)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
  <pkg>@<version> was published at <ISO8601>, within the minimumReleaseAge cutoff (<ISO8601>)
```

### 正确做法：一次性绕过 + 持久豁免

```powershell
# ① 让本次命令能起步（dash 形式的 config 键与 pnpm 的 CLI 约定一致）
node $pnpm add --config.minimum-release-age=0 '<pkg>@<exact-version>'

# ② 让以后的 GUI/市场操作不再被拦：把该版本写进 pnpm-workspace.yaml
```

```yaml
minimumReleaseAgeExclude:
  - <pkg>@<exact-version>
```

### 陷阱：同一包名只能有一条规则

pnpm 的版本策略在按包名查询时**只取第一个匹配到该包名的规则**。所以

```yaml
# ✗ 后面两条形同没写：0.1.14 / 0.1.15 依然会被判违规
minimumReleaseAgeExclude:
  - dsh-opencode-go@0.1.12
  - dsh-opencode-go@0.1.14
  - dsh-opencode-go@0.1.15
```

必须用 `||` 并成一条（解析器支持精确版本并集）：

```yaml
# ✓
minimumReleaseAgeExclude:
  - dsh-opencode-go@0.1.12||0.1.14||0.1.15
  - '@scope/pkg@1.2.3||1.2.4'
```

**这个坑会自己长出来**：pnpm 自己不满足时会往 `pnpm-workspace.yaml` **追加**一行豁免（GUI 装新版、市场更新都会触发），于是同一包名下就有了多条——第二条起全部失效，下一次操作立刻又报违规。**每次安装/更新后检查这个文件是否有同名的多行，有就并成一条。**

**版本差异提醒（未实测，先验证再用）**：上面"用 `||` 并成一条"的结论是在客户端自带的 pnpm **11.7.0** 上实测出来的。第三方插件 `dshmarket` 自己的源码注释声称 pnpm **12.4.1** 反而会拒绝这种联合写法、更希望看到**裸包名**。如果哪天客户端自带的 pnpm 升到 12.x，先在临时目录上实测联合写法是否还被接受，再决定用哪种写法——不要照搬本文。判定只要一条只读命令：把 profile 的四个文件复制到临时目录，用**那个具体版本**跑 `install --lockfile-only`（见 `verification.md` 第 7 节，期望输出 `✓ Lockfile passes supply-chain policies`）。联合写法在 pnpm **12.8.1** 上实测是被接受的，但结论是**按版本**的——换版本就重测一次，别把它当通则。

### 不受隔离影响的情况

git / tarball 依赖不走 registry 解析，**不做**新发布检查；只有 registry 包（npm 上的）受它约束。

### 验证

把当前真实文件复制到一个临时目录（不要动真 stash 之外的任何东西），跑：

```powershell
node $pnpm --dir <临时目录> install --lockfile-only
```

看到 `✓ Lockfile passes supply-chain policies` 才算修好（这一步同时证明后续 GUI/市场操作不会再被拦）。

**只读替代（用户只是问"怎么修"、或本次不允许写盘时）**：下面三步都不写盘，足以定位并给出修法——真正改写文件前再按阶段 0 征得许可。

1. 读 `<profile>\.plugin-manager\logs\*\pnpm.log` 最近一次失败的原文：它会**点名**是哪个包、哪个版本、发布时间与截止时间；
2. 用 packument 的 `time` 字段核对该版本的发布时间是否落在 24 小时内：`https://<registry>/<urlencoded-name>` 的 `time[<version>]`；
3. 检查 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 是否有同名多行（"明明写过豁免还是被拦"就是这个）。

## 2. Registry 与镜像滞后

```powershell
node $pnpm config get registry          # 当前默认源（国内机器常是 registry.npmmirror.com）
node $pnpm view '<pkg>' versions --json # 这个源有哪些版本
```

镜像（npmmirror 等）对新发布有滞后。**当 `package.json` 钉住了一个镜像还没有的版本时，所有走默认源的 pnpm 操作都会失败**：

```text
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for <pkg>@<version> while fetching it from <registry>
```

不要去"降级"来绕过，而是给该 scope 单独指定源——在 profile 目录放 `.npmrc`：

```
@scope:registry=https://registry.npmjs.org/
```

要点：

- **只影响该 scope**，其它包照旧走默认镜像（国内速度不受影响）。
- **作用域规则的优先级高于 `--registry`**：GUI 与市场会显式传 `--registry <镜像>`，但它们对该 scope 依然会走官方源，所以这个办法对它们同样有效。
- 判断"哪个源有目标版本"：直接对多个源取 packument（`https://<registry>/<urlencoded-name>`），比较 `dist-tags.latest` 与 `versions`。

## 3. 构建脚本白名单（allowBuilds）

git 依赖（`github:owner/repo`、tarball）常常带 `prepare`/`postinstall`：pnpm 会真的执行它们（并用该依赖自己的 devDependencies 构建）。pnpm 11 默认**不信任**依赖的构建脚本，需要显式允许：

```text
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: <name>@<exact tarball url>
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

非交互环境（GUI、脚本）下 pnpm 还会往 `pnpm-workspace.yaml` 写占位符：

```yaml
allowBuilds:
  <name>@https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>: set this to true or false
```

处置：

1. 先拿到将被使用的**精确 tarball URL**：`https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>`（sha 来自 `git ls-remote`/GitHub API 的 HEAD）。
2. 在 `allowBuilds` 写精确键，值为 `true`：
   ```yaml
   allowBuilds:
     dshmarket@https://codeload.github.com/dsh-market/dsh-market/tar.gz/180c3144…: true
   ```
3. 重跑同一条 `pnpm add`。构建需要联网拉 devDependencies，**给足超时**（`--fetch-timeout=600000 --fetch-retries=6`），几分钟到十几分钟都属正常。
4. 更新到新提交后，旧提交的键会被新 lockfile 弃用；确认 `pnpm-lock.yaml` 里已搜不到旧 sha（0 次）再删除旧键。

**顺序陷阱**：不要"预判"删掉仍被当前 lockfile 引用的旧键——那会让本来没事的操作报 `ERR_PNPM_IGNORED_BUILDS`。先完成更新（lockfile 转向新提交），再清理。

### 同一条策略也会挡住"工具自己"的安装脚本

`allow-scripts` 这类白名单不只作用于**依赖**，也作用于你**通过包管理器安装或升级的工具本身**。当某个工具带 `preinstall` / `postinstall`（常见于需要落地原生二进制、或改写自己启动壳的包）而它不在白名单里时：

- 命令**退出码为 0**，版本号也会变成目标版本，看起来成功了；
- 但脚本没跑，工具可能**什么都不输出、也不报错**（启动壳指向了那一步本该产出的东西），等于装坏了。

所以"升级本机工具"这类任务有两个动作不能省：

1. **升级后跑一次真实调用**，不要只看版本打印。用一条本来就会产出内容的命令确认它还活着——被挡住的安装可能连 `--version` 都是空输出且退出码 `0`。
2. **明确报告你有没有改用户的全局配置**。修法二选一，并说清选的是哪个：
   - 一次性：`npm install -g --allow-scripts=<pkg> <pkg>@<version>`（不改配置文件，适合"只想把这次做完"）；
   - 持久：把该包加进用户级 npmrc 的 `allow-scripts` 列表（下次同类升级不会再坏，但这是**永久放宽一条安装期执行权限**，先征得用户同意再改）。

npm 会提示"命令行给出了 `--allow-scripts`，所以文件里的 `allow-scripts` 被忽略"——这是一次性绕过生效的正常现象，不代表配置文件被改了。

## 4. 网络超时

```text
[23] The operation was aborted due to timeout
```

- GitHub 的 `codeload.github.com` 直连在国内网络下**时好时坏**（可能挂到几十秒无响应）。
- pnpm 用不了 `gh-proxy` 这类"路径前缀代理"（它不是 HTTP CONNECT 代理），所以**换 URL 不是解法**；加长等待并重试才是：
  ```powershell
  node $pnpm add --config.minimum-release-age=0 --fetch-timeout=600000 --fetch-retries=6 '<spec>'
  ```
- 排查链路可用 `node -e "fetch(url,{method:'HEAD'})"` 或 `git ls-remote https://github.com/<owner>/<repo> HEAD`；`api.github.com` 通不代表 `codeload` 通，反之亦然。
- **`codeload` 与发布附件是不同主机**：前者是 `github:` 与 `/tar.gz/<sha>` 的取件路径，后者（Release asset）走另一条链路。同一时刻经常是"源码 tarball 超时、Release 附件能下"（或相反）。一条通道失败**不能**推出"这个仓库拉不动"——先用另一条通道试一次，再谈结论。
- **本地 `file:` 依赖的更新根本不需要网络**：`node $pnpm install --offline` 只从 store 与本地文件解析，不会去 HEAD/GET 依赖树里那些 `github:` / URL 依赖。要替换的本地产物顺手就落地了，也就不会被某个无关远端超时连累。真缺包时 pnpm 会明确报错，再摘掉 `--offline` 重跑即可。

## 5. pnpm 会改哪些文件

跑完一次 `pnpm add` 后，被改动的通常有：`package.json`（依赖按字母序重写）、`pnpm-lock.yaml`、必要时 `pnpm-workspace.yaml`（追加豁免/占位符）。**`dsh.profile.bundles` 不由 pnpm 维护**——启用必须你自己写。

另外：pnpm 每次操作都会重解包依赖树，可能让**无关插件**的构建产物回到"未构建"状态。所以每次操作后顺手核对其它插件的入口文件仍然存在（尤其 git 源的、带 `prepare` 的）。

## 6. 回滚

写之前把 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`（有 `.npmrc` 也带上）复制到工作区的时间戳目录。回滚 = 复制回去 + 让用户重启（或让 GUI 重新读一次）。pnpm 下载残留的文件留在 `node_modules`/store 里无害，下次操作会清理。
