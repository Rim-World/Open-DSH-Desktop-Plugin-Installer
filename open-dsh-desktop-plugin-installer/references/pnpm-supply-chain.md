# pnpm 供应链策略、registry 与构建白名单

在 DSH profile 里跑 pnpm 会撞上三类"看起来像插件坏了、其实是包管理器策略"的问题：**新发布隔离**、**registry 滞后**、**构建脚本白名单**。这份文档是处置手册，附带"怎么验证修好了"。

## 1. 新发布隔离（minimumReleaseAge）

pnpm 11 默认启用"新发布隔离"：默认 **1440 分钟（24 小时）** 内的新版本会被隔离。

### 它在两个地方生效

1. **解析阶段**：`pnpm add <pkg>`（裸名）在隔离期内**静默**挑"够老的"那个版本，退出码仍是 0——你以为装了 latest，其实落后一版。设 `minimumReleaseAgeStrict: true` 时会改成提示/报错。
2. **lockfile 校验阶段**：只要 `pnpm-lock.yaml` 里存在一条"够年轻且未豁免"的条目，**每一次**包操作都会在
   `✗ Lockfile failed supply-chain policy check` / `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
   处失败——**包括 GUI 与市场发起的操作**。这是最容易被误判成"插件市场坏了"的一类故障。

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

### 不受隔离影响的情况

git / tarball 依赖不走 registry 解析，**不做**新发布检查；只有 registry 包（npm 上的）受它约束。

### 验证

把当前真实文件复制到一个临时目录（不要动真 stash 之外的任何东西），跑：

```powershell
node $pnpm --dir <临时目录> install --lockfile-only
```

看到 `✓ Lockfile passes supply-chain policies` 才算修好（这一步同时证明后续 GUI/市场操作不会再被拦）。

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

## 5. pnpm 会改哪些文件

跑完一次 `pnpm add` 后，被改动的通常有：`package.json`（依赖按字母序重写）、`pnpm-lock.yaml`、必要时 `pnpm-workspace.yaml`（追加豁免/占位符）。**`dsh.profile.bundles` 不由 pnpm 维护**——启用必须你自己写。

另外：pnpm 每次操作都会重解包依赖树，可能让**无关插件**的构建产物回到"未构建"状态。所以每次操作后顺手核对其它插件的入口文件仍然存在（尤其 git 源的、带 `prepare` 的）。

## 6. 回滚

写之前把 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`（有 `.npmrc` 也带上）复制到工作区的时间戳目录。回滚 = 复制回去 + 让用户重启（或让 GUI 重新读一次）。pnpm 下载残留的文件留在 `node_modules`/store 里无害，下次操作会清理。
