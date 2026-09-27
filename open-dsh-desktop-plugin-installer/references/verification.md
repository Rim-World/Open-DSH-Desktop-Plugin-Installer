# 验证：可观测的判据与接口

原则：**用宿主自己给出的状态判定成功**，不要用"文件在不在"或"pnpm 退出码是 0"。

## 0. 找到服务端口

`$env:DSH_WEB_URL`（例如 `http://127.0.0.1:19387`）；没有该变量时看客户端的本地服务端口。应用外壳页 `/` 需要登录态（会 401），但 `/dsh-market/*` 这些路由是**仅回环**的，无需鉴权即可读；**POST 路由要求同源**，必须带 `Origin` 与 `Referer`：

```powershell
$H = @{ 'Origin' = $base; 'Referer' = "$base/"; 'Content-Type' = 'application/json' }
```

## 1. 插件是否真的 live —— `/dsh-market/installed`

```powershell
$j = (Invoke-WebRequest "$base/dsh-market/installed" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
$j.activation.PSObject.Properties | ForEach-Object { "{0,-32} {1,-8} bundle={2} hot={3}" -f $_.Name, $_.Value.state, $_.Value.bundle, $_.Value.hot }
"unbundled: $($j.unbundled -join ',')  diagnostics: $($j.diagnostics.findings.Count)"
```

字段含义（这个接口的设计原则是"**观测优于推断**"）：

| 字段 | 含义 |
|---|---|
| `activation.<pkg>.state` | `live` = **Loader 里存在有活 fiber 的条目**（真在跑）；`restart` = 在 bundle 层但这次没挂上，重启生效；`inert` = 只是普通依赖（库）；`broken` = 声明了 dsh 元数据但入口产物缺失/加载失败；`disabled` = 被开关或补丁层关掉 |
| `.bundle` | 是否在 `dsh.profile.bundles` 里 |
| `.hot` | 是否经由热挂载（无需重启）而 live |
| `unbundled` | 装了、声明了 bundle、但**没被启用**的包——"装了没开"就是这个 |
| `diagnostics.findings` | 清单层的诊断（应为空） |
| `live` | 市场自己的热挂载列表（正常为空） |
| `bundles` | 当前启用的 bundle 列表（不含客户端内置的） |

**注意**：`live` 只说明"这一行挂着"。**替换了插件文件（升级）后它依然显示 live**，因为进程持有的是旧模块代——那种情况必须重启，别用 `live` 反推"新版本已生效"。

## 2. 宿主状态 —— `/dsh-market/status`

```powershell
$s = (Invoke-WebRequest "$base/dsh-market/status" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
"boot=$($s.boot) region=$($s.region) runningAgents=$($s.runningAgents -join ',') error=$($s.error)"
```

- `boot`：宿主本次启动的标识。**重启后会变**——用它判断"这个改动是不是已经重启生效"或"用户刚刚重启过"。
- `runningAgents`：市场上报的"正在运行的 agent"。市场正是用它在安装前拦截（有 agent 在跑就 409 拒绝安装），所以"用户在 GUI 里点安装失败"有时是它。
- `error`：上一次操作的错误文本（含 pnpm 的原始诊断），排错第一手材料。

## 3. 版本是否已最新 —— `/dsh-market/api/v1/updates/summary`

```powershell
$u = (Invoke-WebRequest "$base/dsh-market/api/v1/updates/summary" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
"checked=$($u.checked) updatable=$($u.updatable)"
$u.packages | ForEach-Object { "{0,-26} {1,-44} -> {2}" -f $_.name, $_.installedVersion, $_.latestVersion }
```

- `source` 为 `npm` 时版本是 semver；为 `github` 时是**提交 sha**（对照 `installedVersion`/`latestVersion` 判断是否需要更新）。
- **这个接口有缓存**：你从外面改了 profile 之后它可能仍报旧值。使缓存失效的幂等做法——重设一次同一区域：

  ```powershell
  Invoke-WebRequest "$base/dsh-market/region" -Method POST -Headers $H -Body '{"region":"china"}' -UseBasicParsing
  ```

  然后再查 summary，`updatable` 应为 0（或只剩确实还没更新的）。

## 4. 日志（第一现场）

| 文件 | 看什么 |
|---|---|
| `<profile>\.dsh-market\log.ndjson` | 一行一个 JSON：`at` / `level` / `event` / `detail`。关键事件：`registry`（目录拉取失败）、`updates`（来源查询超时）、`install`、`update`、`update-rollback`、`region`。搜 `failed` 与 `error` |
| `<profile>\.plugin-manager\logs\<op>\pnpm.log` | 官方管理器每次操作的 pnpm 原始输出，`ERR_PNPM_*` 码就在这里 |
| `%DSH_HOME%\.dsh-market\state.json` | 市场自身设置（区域、禁用、收藏）——判断"是谁改了设置"时看它的时间戳 |

按时间戳比对文件改动，是回答"这个改动是不是我做的"最可靠的方式：

```powershell
Get-ChildItem <profile> -Recurse -File -Force | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-30) -and $_.FullName -notlike "*\node_modules\*" } | Sort-Object LastWriteTime | Format-Table LastWriteTime, Length, FullName
```

## 5. 文件级检查

```powershell
# 版本
(Get-Content <profile>\node_modules\<pkg>\package.json -Raw | ConvertFrom-Json).version
# 入口产物（bundle patch 与 main/exports 指向的文件都要在）
Test-Path <profile>\node_modules\<pkg>\cordis.patch.yml
# 其它插件是否被依赖树重解包搞坏
foreach ($p in @('dsh-skill-hub','dshmarket')) { "{0} files={1}" -f $p, (Get-ChildItem "<profile>\node_modules\$p" -Recurse -File | Measure-Object).Count }
```

**解析探针**（确认插件真的能加载，而不只是文件存在）——在插件目录里放一个临时 `.mjs`，跑完删掉：

```js
// 放在 <profile>\node_modules\<pkg>\.probe.mjs
for (const spec of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools']) {
  try { await import(spec); console.log(spec, '=> OK'); }
  catch (e) { console.log(spec, '=> FAIL', e.code ?? e.message); }
}
try { const m = await import('./lib/index.js'); console.log('entry OK, inject =', JSON.stringify(m.inject)); }
catch (e) { console.log('entry FAIL', e.code ?? e.message); }
```

```powershell
node "<profile>\node_modules\<pkg>\.probe.mjs"; Remove-Item "<profile>\node_modules\<pkg>\.probe.mjs"
```

## 6. 策略级检查（保证以后 GUI 也能装）

把**当前真实文件**复制到工作区一个临时目录，跑一次离线解析：

```powershell
$sc = "<workspace>\lockfile-check"
New-Item -ItemType Directory -Path $sc | Out-Null
Copy-Item <profile>\package.json,<profile>\pnpm-workspace.yaml,<profile>\pnpm-lock.yaml,<profile>\.npmrc $sc -Force
node $pnpm --dir $sc install --lockfile-only
```

期望：`✓ Lockfile passes supply-chain policies` 且 exit 0。若不是，回到 `pnpm-supply-chain.md` 处理豁免规则。（`Copy-Item` 的目标目录必须先存在，否则 PowerShell 会把它当成文件名建出一个同名文件。）

## 7. 成功清单

- [ ] `node_modules\<pkg>` 版本 = 目标版本（或 git 提交 = 目标 sha）
- [ ] `dsh.profile.bundles` 含该包名（启用）
- [ ] `/dsh-market/installed`：`state=live`、`bundle=true`、`unbundled` 空、`diagnostics` 空
- [ ] `/dsh-market/api/v1/updates/summary`（缓存失效后）：该包不在 `updatable` 里
- [ ] 离线 `install --lockfile-only` 通过（后续 GUI/市场操作不被拦）
- [ ] 其它插件仍 live、入口文件仍在
- [ ] 已告知用户"是否需要重启"、备份与回滚方式
