import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaseoApi, PaseoAgentCreateOptions } from '@getpaseo/client';
import { HandoffService } from '@server/service';
import type { Contexts } from '@server/context';
import { git, inspect } from '@server/git-state';
import { runProcess, ConnectionUnknown, type Binding, type Transport, type RemoteRequest } from '@server/transport';

import { setup } from '@test/operation-fixture';
test('final context revalidation hook mutation blocks activation after remote restore',async()=>{
  const f=await setup();const capture=f.contexts.capture.bind(f.contexts);
  f.contexts.capture=async(...args)=>{
    const chat=await capture(...args);
    return {...chat,revalidate:async()=>{
      const op=JSON.parse(await readFile(path.join(f.storage,'op-'+f.input.operationId+'.json'),'utf8'));
      if(op.state==='activating') await writeFile(path.join(f.source,'final-hook.txt'),'synthetic final resume hook');
    }};
  };
  const op=await new HandoffService(f.storage,f.transport,f.contexts).start(f.api,f.input);
  assert.notEqual(op.state,'ready');assert.match(op.message,/changed/);
  assert(f.calls.some(c=>c.action==='restore'));assert.equal(f.creations(),0);
  assert.equal((await readdir(f.root)).length,1,'verified isolated files remain recoverable');
});
test('file review rejects changes made by a saved-session opening hook',async()=>{
  const f=await setup();f.sourceAgent.status='closed';
  f.forkEdit(()=>writeFile(path.join(f.source,'hook-change.txt'),'synthetic opening hook'));
  await assert.rejects(new HandoffService(f.storage,f.transport,f.contexts).inspectSource(f.api,f.input.agentId),/changed/);
  assert.equal(f.creations(),0);assert.equal(f.calls.length,0);
});
test('saved inactive source may be collected during restore without losing snapshot validation',async()=>{
  const f=await setup();f.sourceAgent.status='closed';
  const original=f.transport.run.bind(f.transport);
  f.transport.run=async r=>{const result=await original(r);f.sourceAgent.status=r.action==='restore'?'closed':'idle';return result;};
  const op=await new HandoffService(f.storage,f.transport,f.contexts).start(f.api,f.input);
  assert.equal(op.state,'ready',op.message);assert.equal(f.creations(),1);
  assert.equal((await inspect(f.source)).fingerprint,f.input.fingerprint);
});
test('source change after final check is not an atomic cross-host reservation',async()=>{
  const f=await setup();const remote=await f.api.hosts.client('fixture-host');
  const create=remote.agents.create.bind(remote.agents);
  remote.agents.create=async options=>{f.sourceAgent.updatedAt='concurrent-new-prompt';f.sourceAgent.status='running';return create(options);};
  const op=await new HandoffService(f.storage,f.transport,f.contexts).start(f.api,f.input);
  assert.equal(op.state,'ready');assert.equal(f.creations(),1);
  assert.equal(f.sourceAgent.status,'running');assert.equal((await inspect(f.source)).fingerprint,f.input.fingerprint);
});
test('shared operation restores exact files, forwards untouched fork context and never creates twice',async()=>{
  const f = await setup(), service = new HandoffService(f.storage,f.transport,f.contexts);
  const op = await service.start(f.api,f.input);
  assert.equal(op.state,'ready',op.message); assert.equal(f.creations(),1);
  assert.strictEqual(f.created()?.attachments?.[0],f.attachment);
  assert.equal(f.created()?.config.provider,'codex/fixture-model');
  assert.equal((await inspect(op.destinationCwd!)).fingerprint,f.input.fingerprint);
  assert.equal((await new HandoffService(f.storage,f.transport,f.contexts).start(f.api,f.input)).state,'ready');
  assert.equal(f.creations(),1); assert.equal((await readdir(f.root)).length,1);
  assert.equal((await inspect(f.source)).fingerprint,f.input.fingerprint);
});
test('lost restore reply resumes by same operation receipt, with one destination',async()=>{
  const f = await setup(); f.loseRestore();
  assert.equal((await new HandoffService(f.storage,f.transport,f.contexts).start(f.api,f.input)).state,'unverified');
  assert.equal(f.creations(),0);
  const result = await new HandoffService(f.storage,f.transport,f.contexts).start(f.api,f.input);
  assert.equal(result.state,'ready',result.message); assert.equal(f.creations(),1); assert.equal((await readdir(f.root)).length,1);
});
test('lost activation reply reconciles deterministic agent id without another create',async()=>{
  const f = await setup(); f.loseActivation(); const service = new HandoffService(f.storage,f.transport,f.contexts);
  assert.equal((await service.start(f.api,f.input)).state,'unverified'); assert.equal(f.creations(),1);
  assert.equal((await new HandoffService(f.storage,f.transport,f.contexts).start(f.api,f.input)).state,'ready'); assert.equal(f.creations(),1);
});
test('concurrent source edit while obtaining context prevents any remote restore',async()=>{
  const f = await setup(); f.forkEdit(()=>writeFile(path.join(f.source,'file.txt'),'concurrent edit'));
  const op = await new HandoffService(f.storage,f.transport,f.contexts).start(f.api,f.input);
  assert.equal(op.state,'failed'); assert.match(op.message,/changed/);
  assert(!f.calls.some(c=>c.action==='restore')); assert.equal(f.creations(),0); assert.deepEqual(await readdir(f.root),[]);
});
test('return carries lineage and checks original divergence before transfer',async()=>{
  const f = await setup(); const old = f.input.fingerprint;
  f.sourceAgent.labels['handoff.origin']=JSON.stringify({operationId:randomUUID(),hostId:'fixture-host',agentId:'original',cwd:f.source,fingerprint:old});
  await writeFile(path.join(f.source,'file.txt'),'return-side work');
  f.input.fingerprint = (await inspect(f.source)).fingerprint;
  const op = await new HandoffService(f.storage,f.transport,f.contexts).start(f.api,f.input);
  assert.equal(op.state,'failed'); assert.match(op.message,/Return divergence/); assert.equal(f.creations(),0);
  assert(!f.calls.some(c=>c.action==='restore')); assert.deepEqual(await readdir(f.root),[]);
});
test('destination startup failure retains identity and never reports Ready',async()=>{
  const f = await setup(); f.destinationStatus('error'); const service = new HandoffService(f.storage,f.transport,f.contexts);
  const op = await service.start(f.api,f.input); assert.equal(op.state,'failed'); assert(op.destinationAgentId);
  assert.equal((await service.check(f.api,op.id)).state,'failed'); assert.equal((await service.start(f.api,f.input)).state,'failed');
  assert.equal(f.creations(),1);
});
test('status reconciliation and start mutations are serialized per operation',async()=>{
  const f = await setup(); f.loseRestore();
  const service = new HandoffService(f.storage,f.transport,f.contexts);
  assert.equal((await service.start(f.api,f.input)).state,'unverified');
  let release!:()=>void, entered!:()=>void;
  const waiting = new Promise<void>(r=>{release=r;}), seen = new Promise<void>(r=>{entered=r;});
  const original = f.transport.run.bind(f.transport);
  f.transport.run = async request => {if (request.action==='status') {entered(); await waiting;} return original(request);};
  const checking = service.check(f.api,f.input.operationId); await seen;
  await assert.rejects(service.start(f.api,f.input),/already/); release(); await checking;
  f.transport.run = original;
  const resumed = await service.start(f.api,f.input); assert.equal(resumed.state,'ready',resumed.message);
  assert.equal((await service.status(resumed.id))?.destinationAgentId,resumed.destinationAgentId); assert.equal(f.creations(),1);
});
