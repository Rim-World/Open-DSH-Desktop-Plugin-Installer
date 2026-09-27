#!/usr/bin/env node
/**
 * profile-report.mjs — read-only snapshot of a DSH profile, for plugin work.
 *
 * Prints everything an installer needs before touching anything: where the
 * profile is, which runtime version it must stay compatible with, what is
 * installed vs. enabled, and which pnpm policy landmines are already armed
 * (dead minimumReleaseAgeExclude rules, build-approval placeholders, ...).
 *
 * Usage:
 *   node profile-report.mjs [--profile desktop] [--home <DSH_HOME>]
 *                           [--install "<app resources dir>"] [--no-probe] [--json]
 *
 * No dependencies, no network required (the market probe is the only optional
 * HTTP call and is skipped with --no-probe).
 */

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(name);

const profileName = arg('--profile') ?? process.env.DSH_PROFILE ?? 'desktop';
const dshHome = arg('--home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = process.env.DSH_PROFILE_DIR && !arg('--profile')
  ? process.env.DSH_PROFILE_DIR
  : join(dshHome, 'profiles', profileName);
const installHint = arg('--install');

const out = [];
const section = (title) => out.push('', `=== ${title} ===`);
const line = (text = '') => out.push(text);
const field = (label, value) => out.push(`${String(label).padEnd(26)} ${value}`);
const attention = [];

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
    // Entry offsets have been observed one byte off; read a little extra and
    // start at the first '{' so the parse is robust either way.
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

/** Minimal line parser for the few pnpm-workspace.yaml keys this report needs. */
function parseWorkspaceYaml(text) {
  const result = { nodeLinker: null, autoInstallPeers: null, allowBuilds: [], minimumReleaseAgeExclude: [] };
  const lines = text.split(/\r?\n/);
  let block = null;
  for (const raw of lines) {
    const stripped = raw.replace(/#.*$/, '').trimEnd();
    if (!stripped.trim()) continue;
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(stripped);
    if (top && !stripped.startsWith('  ')) {
      block = top[1];
      const value = top[2].trim();
      if (block === 'nodeLinker' && value) result.nodeLinker = value;
      if (block === 'autoInstallPeers' && value) result.autoInstallPeers = value;
      continue;
    }
    if (block === 'allowBuilds') {
      // Keys are package names or `<name>@https://codeload.../tar.gz/<sha>`, so
      // the key/value split has to be the LAST ": " on the line, not the first.
      const idx = stripped.lastIndexOf(': ');
      if (stripped.trim().startsWith('-') || idx === -1) continue;
      const key = stripped.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
      result.allowBuilds.push({ key, value: stripped.slice(idx + 2).trim() });
    } else if (block === 'minimumReleaseAgeExclude') {
      const m = /^\s*-\s*(.+)$/.exec(stripped);
      if (m) result.minimumReleaseAgeExclude.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
    }
  }
  return result;
}

/** Locate the desktop app's resources directory (runtime.json + app.asar live here). */
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

// ---------------------------------------------------------------- 1. environment

section('1. environment');
field('DSH_HOME', dshHome);
field('profile', profileName);
field('profile dir', `${profileDir}${existsSync(profileDir) ? '' : '  (missing!)'}`);
field('DSH_WEB_URL', process.env.DSH_WEB_URL ?? '(unset)');
field('node (this script)', process.version);

const resources = findResourcesDir();
field('app resources dir', resources ?? '(not found — pass --install "<...>\\resources")');

let hostVersion = null;
if (resources) {
  const runtime = readJson(join(resources, 'runtime', 'primary-runtime', 'runtime.json'));
  if (runtime?.desktopVersion) hostVersion = runtime.desktopVersion;
  const asarVersion = readFromAsar(join(resources, 'app.asar'), 'dsh/package.json')?.version;
  field('host runtime version', hostVersion ?? asarVersion ?? '(unknown)');
  if (asarVersion && hostVersion && asarVersion !== hostVersion) {
    field('asar dsh/package.json', `${asarVersion} (differs from runtime.json)`);
  }
  const pnpm = join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs');
  field('bundled pnpm', existsSync(pnpm) ? pnpm : '(missing)');
  if (pnpm && existsSync(pnpm)) {
    const pkg = readJson(join(resources, 'runtime', 'pnpm', 'package.json'));
    if (pkg?.version) field('bundled pnpm version', pkg.version);
  }
}

// ---------------------------------------------------------------- 2. manifest

section('2. manifest (installed vs. enabled)');
const manifest = readJson(join(profileDir, 'package.json'));
const deps = Object.entries(manifest?.dependencies ?? {});
const bundles = manifest?.dsh?.profile?.bundles ?? [];
const bundleSet = new Set(bundles);
if (manifest) {
  field('patchReload', manifest.dsh?.profile?.patchReload ?? '(default: live)');
  line('  dependencies:');
  for (const [name, spec] of deps) line(`    ${name.padEnd(34)} ${spec}${bundleSet.has(name) ? '' : '   [not enabled]'}`);
  line('  dsh.profile.bundles:');
  for (const name of bundles) line(`    ${name}${deps.some(([d]) => d === name) ? '' : '   [installation-owned / in-box]'}`);
  const notEnabled = deps.map(([n]) => n).filter((n) => !bundleSet.has(n));
  const missing = bundles.filter((n) => !deps.some(([d]) => d === n) && !n.startsWith('@deepseek-ai/'));
  if (notEnabled.length) attention.push(`installed but not enabled (not in dsh.profile.bundles): ${notEnabled.join(', ')}`);
  if (missing.length) attention.push(`enabled but not a dependency (check the spec): ${missing.join(', ')}`);
} else {
  line('  (package.json not readable)');
}

// ---------------------------------------------------------------- 3. pnpm policy

section('3. pnpm policy (pnpm-workspace.yaml / .npmrc)');
const wsPath = join(profileDir, 'pnpm-workspace.yaml');
if (existsSync(wsPath)) {
  const ws = parseWorkspaceYaml(readFileSync(wsPath, 'utf8'));
  field('nodeLinker', ws.nodeLinker ?? '(unset)');
  field('autoInstallPeers', ws.autoInstallPeers ?? '(unset)');
  line('  allowBuilds:');
  for (const { key, value } of ws.allowBuilds.length ? ws.allowBuilds : [{ key: '(none)', value: '' }]) {
    const placeholder = /set this to true or false/.test(value);
    line(`    ${placeholder ? '!! ' : '   '}${key}${value ? ' => ' + value : ''}`);
    if (placeholder) attention.push(`allowBuilds placeholder must be set to true/false: ${key}`);
  }
  line('  minimumReleaseAgeExclude:');
  const byName = new Map();
  for (const rule of ws.minimumReleaseAgeExclude) {
    line(`    ${rule}`);
    const at = rule.startsWith('@') ? rule.indexOf('@', 1) : rule.indexOf('@');
    const name = at === -1 ? rule : rule.slice(0, at);
    byName.set(name, (byName.get(name) ?? 0) + 1);
  }
  for (const [name, count] of byName) {
    if (count > 1) {
      attention.push(`minimumReleaseAgeExclude has ${count} rules for "${name}": pnpm only honours the FIRST one — merge them with '||' (e.g. name@1.2.3||1.2.4)`);
    }
  }
  if (!ws.minimumReleaseAgeExclude.length) line('    (none)');
} else {
  line('  pnpm-workspace.yaml missing');
}

const npmrcPath = join(profileDir, '.npmrc');
field('.npmrc', existsSync(npmrcPath) ? '' : '(none)');
if (existsSync(npmrcPath)) {
  for (const l of readFileSync(npmrcPath, 'utf8').split(/\r?\n/)) {
    const t = l.trim();
    if (t && !t.startsWith('#')) line(`    ${t}`);
  }
}

// ---------------------------------------------------------------- 4. lockfile + node_modules

section('4. lockfile and installed artifacts');
const lockPath = join(profileDir, 'pnpm-lock.yaml');
field('pnpm-lock.yaml', existsSync(lockPath) ? `${statSync(lockPath).size} bytes` : '(missing)');
const modulesDir = join(profileDir, 'node_modules');
for (const [name, spec] of deps) {
  const dir = join(modulesDir, ...name.split('/'));
  const pkg = readJson(join(dir, 'package.json'));
  if (!pkg) {
    line(`  ${name.padEnd(34)} MISSING in node_modules   (spec: ${spec})`);
    attention.push(`${name} is declared but missing from node_modules`);
    continue;
  }
  const entry = pkg.dsh?.bundle?.patch ? 'bundle' : (pkg.main ?? '(no main)');
  const patchOk = pkg.dsh?.bundle?.patch ? existsSync(join(dir, pkg.dsh.bundle.patch)) : true;
  line(`  ${name.padEnd(34)} ${String(pkg.version).padEnd(12)} entry=${entry}${patchOk ? '' : '  [patch file MISSING]'}`);
  if (!patchOk) attention.push(`${name}: dsh.bundle.patch points at a file that does not exist`);
}

// ---------------------------------------------------------------- 5. operations in flight

section('5. plugin manager state');
const pmDir = join(profileDir, '.plugin-manager');
field('run.json (an operation is running)', existsSync(join(pmDir, 'run.json')) ? 'YES — wait for it' : 'no');
if (existsSync(join(pmDir, 'run.json'))) attention.push('.plugin-manager/run.json exists: another package operation is in flight');
const logsDir = join(pmDir, 'logs');
const recent = listDirs(logsDir)
  .map((name) => ({ name, at: statSync(join(logsDir, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at)
  .slice(0, 3);
for (const { name, at } of recent) line(`  last op ${name}  ${new Date(at).toISOString()}`);

// ---------------------------------------------------------------- 6. market (optional probe)

section('6. dsh-market');
const marketState = readJson(join(profileDir, '.dsh-market', 'state.json'));
field('state.json', marketState ? JSON.stringify(marketState) : '(none)');
const marketLog = join(profileDir, '.dsh-market', 'log.ndjson');
if (existsSync(marketLog)) {
  const lines = readFileSync(marketLog, 'utf8').trimEnd().split(/\r?\n/);
  line('  last events:');
  for (const l of lines.slice(-5)) {
    try {
      const e = JSON.parse(l);
      line(`    ${e.at} [${e.level}] ${e.event}: ${String(e.detail ?? '').slice(0, 120)}`);
    } catch { line(`    ${l.slice(0, 140)}`); }
  }
}
if (!flag('--no-probe')) {
  const base = process.env.DSH_WEB_URL;
  if (!base) line('  (no DSH_WEB_URL — skipping HTTP probe)');
  else {
    const headers = { Origin: base, Referer: `${base}/` };
    const getJson = async (path) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`${base}${path}`, { headers, signal: controller.signal });
        return res.ok ? await res.json() : { error: `HTTP ${res.status}` };
      } catch (error) {
        return { error: error.name === 'AbortError' ? 'timeout' : String(error.cause?.code ?? error.message) };
      } finally {
        clearTimeout(timer);
      }
    };
    const status = await getJson('/dsh-market/status');
    field('  status.boot', status.boot ?? status.error ?? '(unreachable)');
    field('  status.region', status.region ?? '-');
    field('  status.runningAgents', Array.isArray(status.runningAgents) ? status.runningAgents.join(', ') || '(none)' : '-');
    if (status.error) attention.push(`market status unreachable: ${status.error}`);
    const installed = await getJson('/dsh-market/installed');
    if (installed.activation) {
      line('  activation (loader ground truth):');
      for (const [name, value] of Object.entries(installed.activation)) {
        const bad = value.state !== 'live';
        line(`    ${bad ? '!! ' : '   '}${name.padEnd(32)} ${value.state}  bundle=${value.bundle} hot=${value.hot}`);
        if (bad) attention.push(`${name}: market reports state=${value.state} (${(value.reasons ?? []).join('; ')})`);
      }
      field('  unbundled', (installed.unbundled ?? []).join(', ') || '(none)');
      field('  diagnostics', `${(installed.diagnostics?.findings ?? []).length} finding(s)`);
    }
  }
}

// ---------------------------------------------------------------- summary

section('attention');
if (attention.length === 0) line('  nothing flagged');
for (const item of attention) line(`  - ${item}`);

const text = out.join('\n');
if (flag('--json')) {
  console.log(JSON.stringify({ profile: profileName, profileDir, hostVersion, attention, report: text }, null, 2));
} else {
  console.log(text);
}
