import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, inspect, capture } from '@server/git-state';
import { runProcess, sshArgs, ConnectionUnknown, type Binding, type RemoteRequest } from '@server/transport';

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(),'handoff-transport-')));
  const source = path.join(base,'source'), root = path.join(base,'handoffs'), home = path.join(base,'daemon');
  for (const p of [source,root,home]) await mkdir(p,{mode:0o700});
  await git(source,'init','--initial-branch=main'); await git(source,'config','user.name','Fixture'); await git(source,'config','user.email','fixture@example.invalid');
  await writeFile(path.join(source,'file.txt'),'base\n'); await git(source,'add','.'); await git(source,'commit','-m','test: fixture');
  await writeFile(path.join(source,'file.txt'),'staged\n'); await git(source,'add','.'); await writeFile(path.join(source,'file.txt'),'unstaged\n');
  const paseo = path.join(base,'paseo-fixture');
  await writeFile(paseo,`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({serverId:'fixture-host',daemonVersion:'0.15.2',workerPid:123,connectedDaemon:'reachable'}));`,{mode:0o700});
  const binding: Binding = {hostId:'fixture-host',sshTarget:'fixture',node:process.execPath,paseo,home,root,approved:true};
  const snapshot = await inspect(source), pkg = await capture(source,path.join(base,'capture'),snapshot);
  const request: RemoteRequest = {action:'check',binding,projectPath:source,operationId:randomUUID(),fingerprint:snapshot.fingerprint};
  const run = (r: RemoteRequest) => runProcess(process.execPath,[path.resolve('dist/restore-helper.cjs')],JSON.stringify(r));
  return {base,source,root,binding,snapshot,pkg,request,run};
}
test('real helper process: read-only preflight, restore parity and duplicate retry', async () => {
  const f = await fixture();
  assert.equal((await f.run(f.request)).state,'absent'); assert.deepEqual(await readdir(f.root),[]);
  const restored = await f.run({...f.request,action:'restore',package:f.pkg});
  assert.equal(restored.state,'ready'); assert.equal(restored.fingerprint,f.snapshot.fingerprint);
  assert.equal((await inspect(restored.cwd)).fingerprint,f.snapshot.fingerprint);
  assert.deepEqual(await f.run({...f.request,action:'restore',package:f.pkg}),restored);
  assert.equal((await readdir(f.root)).length,1);
  await assert.rejects(f.run({...f.request,action:'status',fingerprint:'b'.repeat(64)}),/another request/);
  await writeFile(path.join(restored.cwd,'file.txt'),'destination changed');
  await assert.rejects(f.run({...f.request,action:'status'}),/Destination changed/);
});
test('identity mismatch, unsafe mapping and return divergence stop before writing', async () => {
  const f = await fixture();
  await assert.rejects(f.run({...f.request,binding:{...f.binding,hostId:'wrong'}}),/identity/);
  await assert.rejects(f.run({...f.request,binding:{...f.binding,root:f.source}}),/separate/);
  await writeFile(path.join(f.source,'file.txt'),'diverged');
  await assert.rejects(f.run({...f.request,action:'restore',package:f.pkg,returnGuard:{cwd:f.source,fingerprint:f.snapshot.fingerprint}}),/Return divergence/);
  assert.deepEqual(await readdir(f.root),[]);
});
test('partial and failed restore receipts are retained, never overwritten on retry', async () => {
  const f = await fixture(); const partial = path.join(f.root,f.request.operationId); await mkdir(partial,{mode:0o700});
  assert.equal((await f.run({...f.request,action:'restore',package:f.pkg})).state,'unverified');
  assert.deepEqual(await readdir(partial),[]);
  const request = {...f.request,operationId:randomUUID(),action:'restore' as const,package:{...f.pkg,bundleHash:'0'.repeat(64)}};
  assert.equal((await f.run(request)).state,'failed');
  const before = await readFile(path.join(f.root,request.operationId,'receipt.json'),'utf8');
  assert.equal((await f.run({...request,package:f.pkg})).state,'failed');
  assert.equal(await readFile(path.join(f.root,request.operationId,'receipt.json'),'utf8'),before);
});
test('disconnected helper is unknown; SSH invocation is strict and rejects shell targets', async () => {
  await assert.rejects(runProcess(process.execPath,['-e','process.exit(1)'],'{}'),ConnectionUnknown);
  const f = await fixture(); const args = sshArgs(f.binding,"console.log('safe')");
  assert(args.includes('StrictHostKeyChecking=yes')); assert(args.includes('ForwardAgent=no')); assert(args.includes('BatchMode=yes'));
  assert.throws(()=>sshArgs({...f.binding,sshTarget:'host;touch /tmp/no'},''));
  assert(!args.join(' ').includes(f.pkg.bundle));
});
