import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
export const LIMIT = 32 * 1024 * 1024;
export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export async function git(cwd: string, ...args: string[]): Promise<Buffer> {
  try { const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'buffer', maxBuffer: LIMIT, timeout: 30000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
  } catch (e) {
    // Git errors can echo file contents or configuration. Keep only the exit code.
    throw Object.assign(new Error('Git prerequisite or snapshot check failed; required objects must already exist locally (lazy fetch is disabled). Inspect the repository locally.'), {code:(e as {code?:unknown}).code});
  }
}
const text = async (cwd: string, ...args: string[]) => (await git(cwd, ...args)).toString().trim();
const split = (b: Buffer) => b.toString('utf8').split('\0').filter(Boolean);
async function config(cwd: string, ...args: string[]): Promise<string> {
  try { return await text(cwd, 'config', '--includes', ...args); }
  catch (e) { if ((e as {code?: unknown}).code === 1) return ''; throw new Error('Cannot safely read effective Git configuration'); }
}
export function safePath(p: string): void {
  if (!p || path.isAbsolute(p) || p.includes('\\') || /[\x00-\x1f\x7f:\ufffd]/.test(p) || p !== p.normalize('NFC') || p.split('/').some(x => !x || x === '.' || x === '..' || /^\.git$/i.test(x) || /[. ]$/.test(x))) {
    throw new Error('Unsafe or nonportable repository path');
  }
}
export function secretPath(p: string): boolean {
  return /(^|\/)(\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)|\.aws|\.ssh)(\/|$)/i.test(p) && !/\.env\.(example|sample|template)$/.test(p)
    || /\.(pem|p12|pfx|key|keystore)$/i.test(p);
}
export function scanBytes(b: Buffer): void {
  const s = b.toString('utf8');
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{15,}|(?:password|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9_+\/-]{16,}/i.test(s)) {
    throw new Error('Potential secret detected; remove it from transferable state/history before retrying. Content is not logged.');
  }
  if (s.startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error('Git LFS state is unsupported in v1');
}
export interface FileState { path: string; hash: string; size: number; mode: number; linkTarget?: string }
export interface Snapshot {
  root: string; relativeCwd: string; head: string; staged: string; unstaged: string;
  files: FileState[]; untracked: string[]; ignored: string[]; fingerprint: string;
  counts: { staged: number; unstaged: number; untracked: number }; bytes: number;
}
async function readRegular(root: string, p: string): Promise<Buffer> {
  safePath(p);
  let current = root;
  for (const part of p.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Blocked: ${p} has a symlink in its regular-file path`);
  }
  const stat = await lstat(current);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('Unsupported file type or file exceeds 32 MiB');
  if (!(await realpath(current)).startsWith(root + path.sep)) throw new Error('File escaped source checkout');
  return readFile(current);
}
type GitEntry = {mode: string; oid: string; path: string};
function linkTarget(p: string, bytes: Buffer, entries: GitEntry[]): string {
  const target = bytes.toString('utf8');
  // shortcut: no parent segments or link chains; extend only with equivalent escape proofs.
  try {safePath(target);} catch {throw Error(`Blocked: ${p} has an absolute, parent-relative or unsafe symlink target`);}
  const resolved = path.posix.join(path.posix.dirname(p), target);
  safePath(resolved);
  if (secretPath(resolved)) throw Error(`Blocked: ${p} links to a credential-like path`);
  if (!entries.some(e => e.path === resolved && ['100644','100755'].includes(e.mode))) {
    throw Error(`Blocked: ${p} must link directly to a tracked regular file (no folder, chain or missing target)`);
  }
  return target;
}
async function validateEntries(root: string, entries: GitEntry[]) {
  for (const entry of entries) {
    safePath(entry.path);
    if (!['100644','100755','120000'].includes(entry.mode)) throw Error(`Blocked: ${entry.path} is ${entry.mode === '160000' ? 'a submodule' : 'an unsupported Git entry'}`);
    if (secretPath(entry.path)) throw Error(`Credential-like tracked path blocks handoff: ${entry.path}`);
    if (entry.mode === '120000') linkTarget(entry.path, await git(root,'cat-file','blob',entry.oid), entries);
  }
}
async function treeEntries(root: string, head: string): Promise<GitEntry[]> {
  return split(await git(root,'ls-tree','-rz',head)).map(entry => {
    const m = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!m) throw Error('Unsupported Git tree entry');
    return {mode:m[1],oid:m[2],path:m[3]};
  });
}
export async function inspect(cwd: string): Promise<Snapshot> {
  const realCwd = await realpath(cwd);
  const root = await realpath(await text(realCwd, 'rev-parse', '--show-toplevel'));
  const relativeCwd = path.relative(root, realCwd);
  if (relativeCwd) safePath(relativeCwd);
  const head = await text(root, 'rev-parse', '--verify', 'HEAD');
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('Committed HEAD required');
  const sparse = await config(root, '--get', 'core.sparseCheckout');
  if (sparse === 'true') throw new Error('Sparse checkouts are unsupported');
  const filters = await config(root, '--get-regexp', '^filter\\.');
  if (filters) throw new Error('Effective Git filters are unsupported; file checks must not execute filters');
  const entries = split(await git(root, 'ls-files', '--stage', '-z')).map(entry => {
    const m = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!m) throw Error('Malformed Git index entry');
    safePath(m[4]);
    if (m[3] !== '0') throw Error(`Blocked: ${m[4]} has an unmerged index (stage ${m[3]})`);
    return {mode:m[1],oid:m[2],path:m[4]};
  });
  await validateEntries(root, entries);
  await validateEntries(root, await treeEntries(root,head));
  let indexBytes = 0;
  for (const entry of entries) {
    indexBytes += Number(await text(root, 'cat-file', '-s', entry.oid));
    if (indexBytes > LIMIT) throw new Error('Index exceeds 32 MiB audit limit');
    scanBytes(await git(root, 'cat-file', 'blob', entry.oid));
  }
  if (split(await git(root, 'ls-files', '-v', '-z')).some(s => /^[a-zS]/.test(s))) throw new Error('Assume-unchanged or skip-worktree index flags are unsupported');
  const normalDiff = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'];
  const stagedBytes = await git(root, ...normalDiff, '--cached', 'HEAD', '--');
  for (const match of stagedBytes.toString().matchAll(/^index [a-f0-9]+\.\.([a-f0-9]+)/gm)) {
    if (!/^0+$/.test(match[1])) scanBytes(await git(root,'cat-file','blob',match[1]));
  }
  const unstagedBytes = await git(root, ...normalDiff, '--');
  if (!(await git(root, 'diff', '--ita-visible-in-index', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--cached', 'HEAD', '--')).equals(stagedBytes)) throw new Error('Intent-to-add index entries are unsupported');
  scanBytes(stagedBytes); scanBytes(unstagedBytes);
  const untracked = split(await git(root, 'ls-files', '--others', '--exclude-standard', '-z'));
  const ignored = split(await git(root, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'));
  const paths = [...new Set([...split(await git(root, 'ls-files', '-z')), ...untracked])].sort();
  if (paths.length > 5000 || ignored.length > 20000) throw new Error('Repository exceeds v1 file-count limit');
  const files: FileState[] = []; let bytes = 0;
  const portable = new Set<string>();
  for (const p of paths) {
    safePath(p);
    if (portable.has(p.toLowerCase())) throw new Error('Case-colliding paths are unsupported');
    portable.add(p.toLowerCase());
    if (secretPath(p)) throw new Error('Credential-like file blocks handoff; ignored files are excluded automatically');
    let b: Buffer, target: string | undefined;
    try {
      // Check ancestors before lstat/readlink so no source path is followed through a link.
      let parent = root;
      for (const part of p.split('/').slice(0,-1)) {parent=path.join(parent,part); if ((await lstat(parent)).isSymbolicLink()) throw Error(`Blocked: ${p} has a symlink ancestor`);}
      if ((await lstat(path.join(root,p))).isSymbolicLink()) {
        if (!entries.some(e=>e.path===p)) throw Error(`Blocked: ${p} is an untracked symlink`);
        b=await readlink(path.join(root,p),{encoding:'buffer'});
        target=linkTarget(p,b,entries);
        await readRegular(root,path.posix.join(path.posix.dirname(p),target));
      } else b = await readRegular(root, p);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !untracked.includes(p) && !(await lstat(path.join(root,p)).catch(()=>null))?.isSymbolicLink()) continue; throw e; }
    bytes += b.length;
    if (bytes > LIMIT) throw new Error('Working files exceed 32 MiB');
    scanBytes(b);
    const mode = target !== undefined ? 0o120000 : (await lstat(path.join(root, p))).mode & 0o111 ? 0o755 : 0o644;
    files.push({path: p, hash: hash(b), size: b.length, mode, ...(target === undefined ? {} : {linkTarget:target})});
  }
  const staged = stagedBytes.toString('base64'), unstaged = unstagedBytes.toString('base64');
  const fingerprint = hash(JSON.stringify({head, staged, unstaged, files, untracked, relativeCwd}));
  const counts = {staged: split(await git(root, 'diff', '--cached', '--name-only', '-z', 'HEAD', '--')).length, unstaged: split(await git(root, 'diff', '--name-only', '-z', '--')).length, untracked: untracked.length};
  return {root, relativeCwd, head, staged, unstaged, files, untracked, ignored, fingerprint, counts, bytes};
}
export function requireUnchanged(before: Snapshot, after: Snapshot): void {
  if (before.fingerprint !== after.fingerprint || before.root !== after.root) throw new Error('Source changed since review; review a fresh snapshot');
}
export function requireReturnUnchanged(original: Snapshot, current: Snapshot): void {
  if (original.fingerprint !== current.fingerprint) throw new Error('Return divergence: original checkout changed; explicit resolution required');
}
export interface Package { version: 1; snapshot: Snapshot; bundle: string; bundleHash: string; untracked: Record<string, string> }
export async function capture(cwd: string, staging: string, reviewed: Snapshot): Promise<Package> {
  requireUnchanged(reviewed, await inspect(cwd));
  // A bundle contains history, not only the current tree. Scan every reachable blob first.
  const objects = (await text(reviewed.root, 'rev-list', '--objects', reviewed.head)).split('\n');
  if (objects.length > 20000) throw new Error('History exceeds v1 audit limit');
  let historyBytes = 0, treeEntries = 0;
  for (const object of objects) {
    const [oid, ...name] = object.split(' ');
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('Invalid Git object');
    if (name.join(' ')) { safePath(name.join(' ')); if (secretPath(name.join(' '))) throw new Error('Credential-like path in Git history blocks bundle transfer'); }
    const type = await text(reviewed.root, 'cat-file', '-t', oid);
    // rev-list names each object only once; the same blob can also have a credential filename.
    if (type === 'tree') {
      for (const entry of split(await git(reviewed.root, 'ls-tree', '-z', oid))) {
        if (++treeEntries > 20000) throw new Error('History exceeds v1 tree-entry audit limit');
        const name = entry.slice(entry.indexOf('\t') + 1);
        safePath(name);
        if (secretPath(name)) throw new Error('Credential-like path in Git history blocks bundle transfer');
      }
    }
    if (type === 'blob' || type === 'commit') {
      const size = Number(await text(reviewed.root, 'cat-file', '-s', oid));
      historyBytes += size;
      if (historyBytes > LIMIT) throw new Error('Git history exceeds 32 MiB audit limit');
      scanBytes(await git(reviewed.root, 'cat-file', type, oid));
    }
  }
  await mkdir(staging, {mode: 0o700});
  const bundlePath = path.join(staging, 'repository.bundle');
  await git(reviewed.root, 'bundle', 'create', bundlePath, 'HEAD');
  const advertised = await text(reviewed.root, 'bundle', 'list-heads', bundlePath);
  if (advertised !== reviewed.head + ' HEAD') throw new Error('Bundle HEAD changed during capture; retry from a fresh review');
  const bundle = await readFile(bundlePath);
  if (bundle.length > LIMIT) throw new Error('Bundle exceeds 32 MiB');
  await chmod(bundlePath, 0o600);
  const untracked: Record<string, string> = Object.create(null);
  for (const p of reviewed.untracked) {
    const bytes = await readRegular(reviewed.root,p);
    if (hash(bytes) !== reviewed.files.find(f=>f.path===p)?.hash) throw Error('Untracked file changed during capture');
    untracked[p] = bytes.toString('base64');
  }
  requireUnchanged(reviewed, await inspect(cwd));
  return {version: 1, snapshot: reviewed, bundle: bundle.toString('base64'), bundleHash: hash(bundle), untracked};
}
export async function restore(pkg: Package, destination: string): Promise<Snapshot> {
  if (pkg.version !== 1 || Buffer.byteLength(JSON.stringify(pkg)) > LIMIT * 4) throw new Error('Invalid or oversized handoff package');
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(pkg.snapshot.head)) throw new Error('Invalid snapshot commit');
  const bundle = Buffer.from(pkg.bundle, 'base64');
  if (hash(bundle) !== pkg.bundleHash) throw new Error('Bundle checksum mismatch');
  for (const f of pkg.snapshot.files) { safePath(f.path); if (secretPath(f.path) || ![0o644, 0o755, 0o120000].includes(f.mode)) throw new Error('Invalid manifest file'); }
  if (pkg.snapshot.relativeCwd) safePath(pkg.snapshot.relativeCwd);
  if (Object.keys(pkg.untracked).sort().join('\0') !== [...pkg.snapshot.untracked].sort().join('\0')) throw new Error('Untracked inventory mismatch');
  for (const [p, data] of Object.entries(pkg.untracked)) { safePath(p); if (secretPath(p)) throw new Error('Credential path rejected'); if (!pkg.snapshot.files.some(f=>f.path===p&&[0o644,0o755].includes(f.mode))) throw Error('Untracked entry must be a regular file'); scanBytes(Buffer.from(data, 'base64')); }
  // mkdir without recursive/exist_ok is the no-overwrite boundary.
  await mkdir(destination, {mode: 0o700});
  const bundlePath = path.join(destination, 'repository.bundle');
  await writeFile(bundlePath, bundle, {mode: 0o600, flag: 'wx'});
  const checkout = path.join(destination, 'checkout');
  await git(destination, 'clone', '--no-checkout', '--no-local', bundlePath, checkout);
  // Validate tree modes and paths before checkout can materialize a symlink.
  await validateEntries(checkout, await treeEntries(checkout,pkg.snapshot.head));
  await git(checkout, 'checkout', '--detach', pkg.snapshot.head);
  for (const [key, cached] of [['staged', true], ['unstaged', false]] as const) {
    const bytes = Buffer.from(pkg.snapshot[key], 'base64');
    if (bytes.length) {
      const file = path.join(destination, key + '.patch');
      await writeFile(file, bytes, {mode: 0o600, flag: 'wx'});
      await git(checkout, 'apply', ...(cached ? ['--index'] : []), '--binary', '--whitespace=nowarn', file);
      await inspect(checkout);
    }
  }
  await inspect(checkout); // Validate links/index before restoring untracked files.
  for (const [p, data] of Object.entries(pkg.untracked)) {
    const filename = path.join(checkout, p);
    await mkdir(path.dirname(filename), {recursive: true, mode: 0o700});
    await writeFile(filename, Buffer.from(data, 'base64'), {flag: 'wx', mode: pkg.snapshot.files.find(f => f.path === p)?.mode ?? 0o644});
  }
  const actual = await inspect(path.join(checkout, pkg.snapshot.relativeCwd));
  if (actual.fingerprint !== pkg.snapshot.fingerprint) throw new Error('Destination parity mismatch; activation blocked');
  return actual;
}
