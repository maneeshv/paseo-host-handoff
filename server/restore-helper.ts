import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspect, restore, LIMIT, git } from '@server/git-state';
import type { RemoteRequest, RemoteResult } from '@server/transport';

const exec = promisify(execFile);
function absolute(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !p.startsWith('/') || p === '/' || path.posix.normalize(p) !== p || /[\x00-\x1f\x7f]/.test(p)) throw Error('Invalid absolute destination path');
}
async function noLinks(p: string) {
  absolute(p);
  if (await realpath(p) !== p) throw Error('Destination path contains a symlink');
  const s = await lstat(p);
  if (!s.isDirectory()) throw Error('Destination directory required');
}
async function save(file: string, value: unknown) {
  const temp = file + '.' + randomUUID();
  await writeFile(temp, JSON.stringify(value), {flag: 'wx', mode: 0o600}); await rename(temp, file);
}
export async function handle(request: RemoteRequest): Promise<RemoteResult> {
  if (!request || !['check','restore','status'].includes(request.action) || !/^[a-f0-9-]{36}$/.test(request.operationId) || !/^[a-f0-9]{64}$/.test(request.fingerprint)) throw Error('Invalid transport request');
  const b = request.binding;
  if (!b || b.approved !== true || typeof b.hostId !== 'string') throw Error('Explicit SSH binding approval required');
  for (const p of [b.node,b.paseo,b.home,b.root,request.projectPath]) absolute(p);
  const {stdout} = await exec(b.paseo, ['daemon','status','--home',b.home,'--json'], {timeout:15000, maxBuffer:1048576, env:{PATH:path.dirname(b.node)+':'+(process.env.PATH??'/usr/bin:/bin'),HOME:process.env.HOME}});
  const daemon = JSON.parse(stdout);
  if (daemon.serverId !== b.hostId || daemon.connectedDaemon !== 'reachable') throw Error('SSH destination daemon identity/reachability mismatch');
  // Destination-only 0.15.0 compatibility is proven separately; it is not a supported source curator.
  if (!['0.15.0','0.15.2','0.15.4'].includes(daemon.daemonVersion) || !Number.isSafeInteger(daemon.workerPid) || daemon.workerPid<=0) throw Error('Destination Paseo version/worker is unverified. Nothing written.');
  await noLinks(b.root); await noLinks(request.projectPath);
  if (b.root === b.home || b.root === request.projectPath || b.root.startsWith(request.projectPath + '/')) throw Error('Handoff root must be separate from daemon home and matched project');
  const rootStat = await lstat(b.root);
  if (rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077) !== 0) throw Error('Handoff root must be owned by the SSH user and private (0700)');
  await access(b.root, constants.W_OK);
  const projectRoot = (await git(request.projectPath,'rev-parse','--show-toplevel')).toString().trim();
  if (projectRoot !== request.projectPath) throw Error('Matched project is no longer the selected Git root');
  if (request.returnGuard) {
    absolute(request.returnGuard.cwd);
    if ((await inspect(request.returnGuard.cwd)).fingerprint !== request.returnGuard.fingerprint) throw Error('Return divergence: original checkout changed; explicit resolution required');
  }
  const opDir = path.join(b.root,request.operationId), receipt = path.join(opDir,'receipt.json');
  const expectedCwd = path.join(opDir,'payload','checkout',request.package?.snapshot.relativeCwd ?? '');
  let existing: (RemoteResult & {requestFingerprint:string; projectPath:string}) | null = null;
  try { existing = JSON.parse(await readFile(receipt,'utf8')); }
  catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Unreadable remote receipt; manual reconciliation required');}
  if (existing) {
    if (existing.requestFingerprint !== request.fingerprint || existing.projectPath !== request.projectPath) throw Error('Remote operation ID belongs to another request');
    if (existing.state === 'ready') {
      if ((await inspect(existing.cwd)).fingerprint !== request.fingerprint) throw Error('Destination changed after restore; explicit resolution required');
    }
    return {state:existing.state,cwd:existing.cwd,fingerprint:existing.fingerprint,message:existing.message};
  }
  try {await lstat(opDir); return {state:'unverified',cwd:expectedCwd,message:'Partial operation without receipt. Inspect before cleanup; do not retry with a new ID.'};}
  catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
  if (request.action !== 'restore') return {state:'absent',cwd:expectedCwd,message:'SSH identity, project and private destination root verified. No files written.'};
  if (!request.package || request.package.snapshot.fingerprint !== request.fingerprint) throw Error('Package does not match reviewed fingerprint');
  await mkdir(opDir,{mode:0o700}); // Atomic operation claim. Never reuse or overwrite another directory.
  const record = {state:'unverified',cwd:expectedCwd,message:'Restore was started; outcome requires verification',requestFingerprint:request.fingerprint,projectPath:request.projectPath};
  await save(receipt,record);
  try {
    const snapshot = await restore(request.package,path.join(opDir,'payload'));
    const result = {state:'ready' as const,cwd:path.join(snapshot.root,snapshot.relativeCwd),fingerprint:snapshot.fingerprint,message:'File and index parity verified; no agent has been started.'};
    await save(receipt,{...record,...result}); return result;
  } catch {
    const result = {state:'failed' as const,cwd:expectedCwd,message:'Restore failed. Partial checkout retained; explicit inspection and cleanup required. No agent started.'};
    await save(receipt,{...record,...result}); return result;
  }
}
async function main() {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {bytes += chunk.length; if (bytes > LIMIT * 4) throw Error('Oversized transfer'); chunks.push(chunk);}
  const request = JSON.parse(Buffer.concat(chunks).toString());
  const result = await handle(request);
  process.stdout.write(JSON.stringify({ok:true,result}));
}
void main().catch(e => {
  // Subprocess diagnostics can contain source bytes; expose only our bounded validation errors.
  const error = e instanceof Error && !('stderr' in e) && !('stdout' in e) && !('syscall' in e) ? e.message : 'Destination prerequisite check failed; inspect configuration locally.';
  process.stdout.write(JSON.stringify({ok:false,error}));
});
