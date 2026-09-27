#!/usr/bin/env node
/**
 * plugin-compat.mjs — 装之前先核对，只读，不改任何文件。
 *
 * 回答三个问题，并把结论留给用户决定：
 *   1. 插件**声明**支持什么：engines.dsh / engines.node / peerDependencies / 它是哪一类插件；
 *   2. 它是**哪一类**插件：宿主半边（dsh.bundle.patch）、浏览器半边（dsh.client + exports["./client"]），
 *      还是两者都有，或者只是个普通依赖（装了也不会激活任何层）；
 *   3. 你打算装进去的**客户端是什么版本**：Desktop（Electron）读 runtime.json 的 desktopVersion；
 *      WebUI 读运行该 profile 的 dsh CLI 版本。两者可能不同——不要用一个去判断另一个。
 *
 * Usage:
 *   node plugin-compat.mjs --installed <name>            # 读 profile 里已装的那一份（离线）
 *   node plugin-compat.mjs --dir <path>                  # 读本地目录 / checkout（离线）
 *   node plugin-compat.mjs --spec <name[@version|tag]>   # 从 registry 读元数据（需要网络）
 *   node plugin-compat.mjs --spec a --spec b --json
 *
 * 可选：--profile <name>（默认 desktop） --home <DSH_HOME> --install "<…>\resources"
 *       --registry <url>（覆盖 .npmrc） --offline --timeout <ms> --json
 *
 * 退出码：0 = 兼容；3 = 不兼容；4 = 未知（缺声明，需要用户决定）；1 = 用法或加载错误。
 * 结论只作汇报用——**不要替用户决定**，见 references/compatibility.md 的"决定门"。
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const all = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === name) out.push(argv[++i]);
  return out;
};
const arg = (name, fallback = undefined) => all(name)[0] ?? fallback;
const flag = (name) => argv.includes(name);

const specs = all('--spec');
const installed = all('--installed');
const dirs = all('--dir');
const profileName = arg('--profile') ?? process.env.DSH_PROFILE ?? 'desktop';
const dshHome = arg('--home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = process.env.DSH_PROFILE_DIR && !arg('--profile')
  ? process.env.DSH_PROFILE_DIR
  : join(dshHome, 'profiles', profileName);
const profilesDir = join(dshHome, 'profiles');
const installHint = arg('--install');
const registryOverride = arg('--registry');
const offline = flag('--offline');
// 60 s：这台机器上 registry 的首次连接偶尔要十几秒；用 --timeout 调。
const timeoutMs = Number(arg('--timeout', '60000'));
const asJson = flag('--json');

if (!specs.length && !installed.length && !dirs.length) {
  console.error('用法：node plugin-compat.mjs (--spec <name[@version]> | --installed <name> | --dir <path>) [--profile desktop] [--json]');
  process.exit(1);
}

const out = [];
const section = (title) => out.push('', `=== ${title} ===`);
const line = (text = '') => out.push(text);
const field = (label, value) => out.push(`${String(label).padEnd(24)} ${value}`);

// ---------------------------------------------------------------- helpers

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const listDirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

/** Read one file out of an Electron asar archive (header parse, no extraction). */
function readFromAsar(asarPath, wanted) {
  let fd;
  try {
    fd = openSync(asarPath, 'r');
    const sizeBuf = Buffer.alloc(16);
    readSync(fd, sizeBuf, 0, 16, 0);
    const headerSize = sizeBuf.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerSize);
    readSync(fd, headerBuf, 0, headerSize, 16);
    const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''));
    const base = 16 + headerSize;
    let node = header;
    for (const part of wanted.split('/')) {
      node = node?.files?.[part];
      if (!node) return null;
    }
    const buf = Buffer.alloc(node.size + 8);
    readSync(fd, buf, 0, buf.length, base + Number(node.offset) - 2);
    const text = buf.toString('utf8');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function findResourcesDir() {
  const candidates = [
    installHint,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'DeepSeek Harness', 'resources'),
    '/Applications/DeepSeek Harness.app/Contents/Resources',
    '/opt/DeepSeek Harness/resources',
    '/usr/lib/deepseek-harness/resources',
  ].filter(Boolean);
  return candidates.find((dir) => existsSync(join(dir, 'runtime', 'primary-runtime', 'runtime.json'))) ?? null;
}

/**
 * semver 从共享 fallback (`$DSH_HOME/profiles/node_modules/semver`) 借；借不到就退回
 * 一个只认常见写法的粗略比较器（会在报告里标注）。
 */
function loadSemver() {
  try {
    const require = createRequire(join(profilesDir, 'node_modules', '_plugin-compat.mjs'));
    const semver = require('semver');
    return typeof semver?.satisfies === 'function' ? semver : null;
  } catch {
    return null;
  }
}

const parseVersion = (value) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
};

/** 粗略比较：只处理 >=, >, <=, <, =, ^x.y.z, ~x.y.z, *, x，以及 || 并集。 */
function roughSatisfies(range, version) {
  const v = parseVersion(version);
  if (!v) return null;
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i += 1) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
    if (a.pre === b.pre) return 0;
    if (a.pre === null) return 1;
    if (b.pre === null) return -1;
    return a.pre < b.pre ? -1 : 1;
  };
  const test = (alternative) => alternative.trim().split(/\s+/).every((token) => {
    if (!token || token === '*' || token === 'x') return true;
    const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
    if (!m) return true;
    const op = m[1] ?? '=';
    const target = m[2];
    if (op === '^' || op === '~') {
      const t = parseVersion(target);
      if (!t) return true;
      const upper = op === '^'
        ? { nums: [t.nums[0] + 1, 0, 0], pre: null }
        : { nums: [t.nums[0], t.nums[1] + 1, 0], pre: null };
      return cmp(v, t) >= 0 && cmp(v, upper) < 0;
    }
    const t = parseVersion(target);
    if (!t) return true;
    const d = cmp(v, t);
    if (op === '>=') return d >= 0;
    if (op === '>') return d > 0;
    if (op === '<=') return d <= 0;
    if (op === '<') return d < 0;
    return d === 0;
  });
  return String(range).split('||').some(test);
}

function satisfies(range, version, semver) {
  if (!range || !version) return null;
  if (semver) {
    try { return semver.satisfies(version, range, { includePrerelease: true }); } catch { /* fall through */ }
  }
  return roughSatisfies(range, version);
}

// ---------------------------------------------------------------- 1. 客户端（把插件装到哪里）

section('1. 目标客户端（插件要装进去的地方）');
field('DSH_HOME', dshHome);
field('profile', profileName);
field('profile dir', `${profileDir}${existsSync(profileDir) ? '' : '  (missing!)'}`);

const resources = findResourcesDir();
let hostVersion = null;
let shellVersion = null;
let runtimeNode = null;
let runtimePnpm = null;
if (resources) {
  const runtime = readJson(join(resources, 'runtime', 'primary-runtime', 'runtime.json'));
  if (runtime?.desktopVersion) hostVersion = runtime.desktopVersion;
  runtimeNode = runtime?.node ?? null;
  runtimePnpm = runtime?.pnpm ?? null;
  const shell = readFromAsar(join(resources, 'app.asar'), 'package.json');
  if (shell?.version) shellVersion = shell.version;
}

/** 外部 dsh CLI（npm 全局装的那份）——只有 WebUI profile 才以它为准。 */
function findCliVersion() {
  const roots = [];
  for (const part of String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!part) continue;
    roots.push(join(part, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    roots.push(join(part, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  if (process.env.APPDATA) roots.unshift(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  for (const path of roots) {
    const pkg = readJson(path);
    if (pkg?.version) return { version: pkg.version, path };
  }
  return null;
}
const cli = findCliVersion();

const isDesktop = Boolean(resources) && profileName === 'desktop';
const clientKind = isDesktop
  ? 'DSH Desktop (Electron)'
  : (profileName === 'web' ? 'DSH WebUI' : `DSH profile "${profileName}"`);
const anchor = isDesktop ? hostVersion : (cli?.version ?? null);

field('客户端类型', clientKind);
field('兼容性判据（版本）', `${anchor ?? '(未知——无法判定)'}${isDesktop ? '   <- runtime.json 的 desktopVersion' : '   <- 运行该 profile 的 dsh CLI'}`);
if (shellVersion) field('桌面壳版本', `@deepseek-ai/dsh-desktop ${shellVersion}`);
if (cli) field('PATH 上的 dsh CLI', `${cli.version}${isDesktop ? '   (不要用它判断桌面端)' : ''}`);
else if (!isDesktop) field('PATH 上的 dsh CLI', '(未找到——无法判定 web profile 的兼容性)');
field('运行时 node / pnpm', `${runtimeNode ?? '?'} / ${runtimePnpm ?? '?'}   (本脚本 node ${process.version})`);

// ---------------------------------------------------------------- registry

function readNpmrcRegistries() {
  const files = [
    join(profileDir, '.npmrc'),
    join(dshHome, '.npmrc'),
    join(homedir(), '.npmrc'),
  ];
  const defaults = [];
  const scoped = new Map();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const text = raw.replace(/#.*$/, '').trim();
      if (!text.includes('=')) continue;
      const [key, ...rest] = text.split('=');
      const value = rest.join('=').trim().replace(/\/$/, '');
      if (!/^https?:/.test(value)) continue;
      if (key.trim() === 'registry') defaults.push(value);
      else if (/^@[^:]+:registry$/.test(key.trim())) scoped.set(key.trim().slice(0, -':registry'.length), value);
    }
  }
  if (registryOverride) defaults.unshift(registryOverride.replace(/\/$/, ''));
  return { defaults, scoped };
}
const registries = readNpmrcRegistries();
const registryFor = (name) => {
  const scope = name.startsWith('@') ? name.split('/')[0] : null;
  if (scope && registries.scoped.has(scope)) return registries.scoped.get(scope);
  return registries.defaults[0] ?? 'https://registry.npmjs.org';
};

const splitSpec = (spec) => {
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  const name = at === -1 ? spec : spec.slice(0, at);
  const range = at === -1 ? null : spec.slice(at + 1);
  return { name, range: range || null };
};

async function httpJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length'));
    if (length > 12 * 1024 * 1024) throw new Error(`响应过大（${length} 字节）——请改用 --spec name@exact-version`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 从 registry 取某个版本的完整 manifest（走 .npmrc 里该 scope 的 registry）。 */
async function resolveFromRegistry(spec, semver) {
  const { name, range } = splitSpec(spec);
  const registry = registryFor(name);
  const encoded = name.startsWith('@') ? `@${name.slice(1).replace('/', '%2f')}` : name;
  if (range && semver?.valid(range)) {
    const manifest = await httpJson(`${registry}/${encoded}/${range}`);
    return { name, version: manifest.version, manifest, registry, spec, versions: null };
  }
  const doc = await httpJson(`${registry}/${encoded}`);
  const versions = Object.keys(doc.versions ?? {});
  if (!versions.length) throw new Error('registry 响应里没有 versions');
  const tags = doc['dist-tags'] ?? {};
  let picked = null;
  if (range && tags[range]) picked = tags[range];
  else if (range && semver) picked = semver.maxSatisfying(versions, range);
  else if (range && versions.includes(range)) picked = range;
  else if (!range) picked = tags.latest ?? versions[versions.length - 1];
  if (!picked) throw new Error(`在 ${name} 里找不到匹配 "${range}" 的版本（可用：${versions.slice(-6).join(', ')}）`);
  return { name, version: picked, manifest: doc.versions[picked], registry, spec, versions };
}

// ---------------------------------------------------------------- 2. 插件的声明

const semver = loadSemver();
section('2. 插件声明（它说自己支持什么、是哪一类）');

const targets = [];

for (const name of installed) {
  const dir = join(profileDir, 'node_modules', ...name.split('/'));
  const manifest = readJson(join(dir, 'package.json'));
  if (!manifest) { targets.push({ kind: 'installed', name, dir, error: `node_modules 里没有 ${name}` }); continue; }
  targets.push({ kind: 'installed', name, dir, version: manifest.version, manifest, local: true });
}
for (const raw of dirs) {
  const dir = isAbsolute(raw) ? raw : resolvePath(process.cwd(), raw);
  const manifest = readJson(join(dir, 'package.json'));
  if (!manifest) { targets.push({ kind: 'dir', name: raw, dir, error: `${dir} 下没有可解析的 package.json` }); continue; }
  targets.push({ kind: 'dir', name: manifest.name ?? raw, dir, version: manifest.version, manifest, local: true });
}
for (const spec of specs) {
  if (offline) { targets.push({ kind: 'spec', name: spec, error: '--offline 下不能查 registry' }); continue; }
  try {
    const resolved = await resolveFromRegistry(spec, semver);
    targets.push({ kind: 'spec', ...resolved, local: false });
  } catch (error) {
    targets.push({ kind: 'spec', name: spec, error: `${error.name === 'AbortError' ? `超时（${timeoutMs} ms）` : error.message}` });
  }
}

const results = [];

for (const target of targets) {
  out.push('');
  line(`--- ${target.name}${target.version ? `@${target.version}` : ''}  [${target.kind === 'installed' ? '已装' : target.kind === 'dir' ? '本地目录' : 'registry'}]`);
  if (target.error) {
    field('  结果', `读不到元数据：${target.error}`);
    results.push({ ...target, verdict: 'error' });
    continue;
  }
  const manifest = target.manifest;
  const enginesDsh = manifest.engines?.dsh ?? null;
  const enginesNode = manifest.engines?.node ?? null;
  const patch = manifest.dsh?.bundle?.patch ?? null;
  const client = manifest.dsh?.client ?? null;
  const clientExport = manifest.exports?.['./client'] ?? null;
  const peers = Object.entries(manifest.peerDependencies ?? {});

  field('  engines.dsh', enginesDsh ?? '(未声明 → 支持范围未知，不等于不兼容)');
  field('  engines.node', enginesNode ?? '(未声明)');
  field('  宿主半边', patch ? `dsh.bundle.patch = ${patch}` : '(无 → 装了也不会激活任何层，只是普通依赖)');
  if (patch && target.local) {
    const patchPath = join(target.dir, patch);
    field('  宿主半边文件', existsSync(patchPath) ? `存在：${patch}` : `缺失：${patchPath}`);
  }
  field('  浏览器半边', client
    ? `dsh.client platform=${client.platform ?? '(未写)'}${client.immediately ? ' immediately' : ''}${client.inject ? ` inject=[${client.inject.length}]` : ''}`
    : '(无 → 没有界面部分，只影响宿主)');
  if (client) field('  client 导出', clientExport ? String(typeof clientExport === 'string' ? clientExport : JSON.stringify(clientExport)) : '(缺少 exports["./client"] → 浏览器半边挂不上)');
  if (client && target.local && typeof clientExport === 'string') {
    field('  client 文件', existsSync(join(target.dir, clientExport)) ? `存在：${clientExport}` : `缺失：${clientExport}`);
  }
  field('  peer 依赖', peers.length ? peers.map(([n, r]) => `${n}@${r}`).join('\n' + ' '.repeat(26)) : '(无)');

  // ---- 类型判定
  let typeVerdict;
  if (patch && client) typeVerdict = '宿主 + 浏览器半边（两端都可用，装后要实测 live）';
  else if (patch) typeVerdict = '只有宿主半边（没有界面部分）';
  else if (client) typeVerdict = '只有浏览器半边（需要 patch 行把它挂成 Loader row，否则不生效）';
  else typeVerdict = '普通依赖（无 dsh.bundle.patch → 官方文档：可安装但不激活任何层）';
  if (client && client.platform && client.platform !== 'web') {
    typeVerdict += ` ⚠️ platform="${client.platform}" 不是文档化的 "web"，需要确认它支持哪个客户端`;
  }

  // ---- 版本判定
  const dshOk = enginesDsh && anchor ? satisfies(enginesDsh, anchor, semver) : null;
  const nodeOk = enginesNode ? satisfies(enginesNode, runtimeNode ?? process.version.replace(/^v/, ''), semver) : null;

  const fallbackIssues = [];
  for (const [name, range] of peers) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    const dir = join(profilesDir, 'node_modules', ...name.split('/'));
    const pkg = readJson(join(dir, 'package.json'));
    if (!pkg) {
      fallbackIssues.push(`${name}@${range}: 共享 fallback 里没有——若插件只是通过 ctx.<service> 引用它（import 里没有）就没问题，读一遍它的 import 语句`);
      continue;
    }
    const ok = satisfies(range, pkg.version, semver);
    if (ok === false) {
      fallbackIssues.push(`${name}@${range}: fallback 当前指向 ${pkg.version}（不满足该范围）——这不等于插件会坏：宿主在启动时会提供自己的服务，实测这种不一致可以正常工作，但要用解析探针确认能 import`);
    }
  }

  const conflicts = [];
  if (dshOk === false) conflicts.push(`engines.dsh = ${enginesDsh} 不包含目标客户端版本 ${anchor}`);
  if (nodeOk === false) conflicts.push(`engines.node = ${enginesNode} 不包含运行时 node ${runtimeNode ?? process.version}`);

  let verdict;
  if (conflicts.length) verdict = 'incompatible';
  else if (!enginesDsh) verdict = 'unknown';
  else verdict = 'compatible';

  results.push({ ...target, enginesDsh, enginesNode, peerCount: peers.length, typeVerdict, verdict, conflicts, fallbackIssues, anchor, clientKind });

  field('  类型判定', typeVerdict);
  field('  engines.dsh vs 客户端', dshOk === null ? `➖ 无声明/无判据（客户端版本 ${anchor ?? '未知'}）` : dshOk ? `✅ ${enginesDsh} 包含 ${anchor}` : `❌ ${enginesDsh} 不包含 ${anchor}`);
  if (enginesNode) field('  engines.node vs 运行时', nodeOk ? `✅ ${enginesNode} 包含 ${runtimeNode ?? process.version}` : `❌ ${enginesNode} 不包含 ${runtimeNode ?? process.version}`);
  if (fallbackIssues.length) {
    field('  peer 解析提示', `${fallbackIssues.length} 条`);
    for (const issue of fallbackIssues) line(`      · ${issue}`);
  }
}

// ---------------------------------------------------------------- 结论

section('3. 结论与需要用户决定的事');
const incompatible = results.filter((r) => r.verdict === 'incompatible');
const unknown = results.filter((r) => r.verdict === 'unknown');
const errored = results.filter((r) => r.verdict === 'error');

for (const r of results) {
  const label = r.verdict === 'compatible' ? '✅ 兼容'
    : r.verdict === 'unknown' ? '⚠️ 未知（插件没声明 engines.dsh）'
      : r.verdict === 'incompatible' ? '❌ 不兼容'
        : '✖ 读取失败';
  field(r.version ? `${r.name}@${r.version}` : r.name, `${label}${r.conflicts?.length ? ` —— ${r.conflicts.join('；')}` : ''}${r.error ? ` —— ${r.error}` : ''}`);
}
line();
line('把上面的结论汇报给用户，并让他决定（不要替用户决定）：');
line('  ① 按原计划安装（兼容，或用户明确说"我知道风险，继续"）；');
line('  ② 换一个满足范围的版本（改用 --spec <name>@<version> 重新核对）；');
line('  ③ 取消，或改用其它插件。');
line('不兼容时默认**不安装**。用户坚持要装：先备份（SKILL.md 阶段 4），装完立刻用阶段 8 验证，并把风险写进报告。');

const report = {
  profile: profileName,
  clientKind,
  anchor,
  shellVersion,
  cliVersion: cli?.version ?? null,
  hostVersion: hostVersion ?? null,
  semver: semver ? 'shared-fallback' : 'rough-comparator',
  results: results.map((r) => ({
    name: r.name, version: r.version ?? null, kind: r.kind, source: r.dir ?? r.registry ?? null,
    enginesDsh: r.enginesDsh ?? null, enginesNode: r.enginesNode ?? null,
    type: r.typeVerdict ?? null, verdict: r.verdict, conflicts: r.conflicts ?? [], peerHints: r.fallbackIssues ?? [],
    error: r.error ?? null,
  })),
  summary: { compatible: results.length - incompatible.length - unknown.length - errored.length, unknown: unknown.length, incompatible: incompatible.length, errors: errored.length },
};

if (asJson) console.log(JSON.stringify(report, null, 2));
else console.log(out.join('\n'));

// 用 exitCode 而不是 process.exit()：Windows 上 Node 24 里"fetch 之后立刻 process.exit()"
// 会撞 libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), async.c），
// 退出码变成 0xC0000409。让事件循环自己收尾就没这个问题（实测）。
process.exitCode = errored.length ? 1 : incompatible.length ? 3 : unknown.length ? 4 : 0;
