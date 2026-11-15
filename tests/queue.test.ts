import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setup } from '@test/operation-fixture';
import { HandoffService } from '@server/service';

const prepare=async()=>{
  const f=await setup();f.sourceAgent.status='running';f.sourceAgent.activeTurn={turnId:'turn-1'};
  const {fingerprint,...input}=f.input;
  const service=new HandoffService(f.storage,f.transport,f.contexts);
  return {f,input,service};
};
test('closing a formerly running or waiting source never requalifies stale queued intent',async()=>{
  for(const scenario of ['running','waiting','failed','canceled']) {
    const {f,input,service}=await prepare();await service.queue(f.api,input);
    if(scenario==='waiting') f.sourceAgent.pendingPermissions=[{}];
    if(scenario==='failed'||scenario==='canceled') await service.recordTurn(input.agentId,'turn-1',scenario);
    // Manual/core closure clears live turn and permission fields; the queue must still stop.
    f.sourceAgent.status='closed';f.sourceAgent.activeTurn=null;f.sourceAgent.pendingPermissions=[];
    await service.processQueues(f.api);
    assert.equal((await service.status(input.operationId))?.state,'needs_review');
    assert.equal(f.creations(),0);assert(!f.calls.some(c=>c.action==='restore'));
  }
});
test('durable self queue includes end-of-turn work, shares normal operation and runs once',async()=>{
  const {f,input,service}=await prepare();
  assert.equal((await service.queue(f.api,input)).state,'queued');
  await service.processQueues(f.api);assert.equal(f.creations(),0);
  await writeFile(path.join(f.source,'after-queue.txt'),'synthetic last-turn change');
  await service.recordTurn(input.agentId,'turn-1','completed');
  f.sourceAgent.status='idle';f.sourceAgent.activeTurn=null;
  const reloaded=new HandoffService(f.storage,f.transport,f.contexts);
  await reloaded.processQueues(f.api);
  const op=await reloaded.status(input.operationId);assert.equal(op?.state,'ready',op?.message??'missing receipt');assert.equal(f.creations(),1);
  await reloaded.processQueues(f.api);assert.equal(f.creations(),1);
});
test('missed completion hook recovers only with fresh successful snapshot evidence',async()=>{
  const {f,input,service}=await prepare();await service.queue(f.api,input);
  f.sourceAgent.status='idle';f.sourceAgent.activeTurn=null;f.sourceAgent.attentionReason='finished';f.sourceAgent.attentionTimestamp=new Date(Date.now()+100).toISOString();
  await new HandoffService(f.storage,f.transport,f.contexts).processQueues(f.api);
  assert.equal((await service.status(input.operationId))?.state,'ready');assert.equal(f.creations(),1);
});
test('new message or a new turn cancels; failed turn requires review; permission waits',async()=>{
  for(const scenario of ['message','turn','failed','permission']) {
    const {f,input,service}=await prepare();await service.queue(f.api,input);
    f.sourceAgent.status='idle';f.sourceAgent.activeTurn=null;
    if(scenario==='message') f.sourceAgent.lastUserMessageAt='new message';
    if(scenario==='turn') await service.recordTurn(input.agentId,'turn-2');
    if(scenario==='failed') await service.recordTurn(input.agentId,'turn-1','failed');
    if(scenario==='permission') f.sourceAgent.pendingPermissions=[{}];
    await service.processQueues(f.api);
    assert.equal((await service.status(input.operationId))?.state,scenario==='permission'?'queued':scenario==='failed'?'needs_review':'canceled');
    assert.equal(f.creations(),0);assert(!f.calls.some(c=>c.action==='restore'));
  }
});
test('queue refuses missing binding, cancels before capture, and stops on changed placement or secrets',async()=>{
  for(const scenario of ['binding','cancel','cwd','secret','unknown-completion']) {
    const {f,input,service}=await prepare();
    if(scenario==='binding') {await writeFile(path.join(f.storage,'ssh-hosts.json'),'[]');await assert.rejects(service.queue(f.api,input),/Nothing queued/);continue;}
    await service.queue(f.api,input);
    if(scenario==='cancel') await service.cancel(input.operationId);
    else if(scenario!=='unknown-completion') await service.recordTurn(input.agentId,'turn-1','completed');
    f.sourceAgent.status='idle';f.sourceAgent.activeTurn=null;
    if(scenario==='cwd') f.sourceAgent.cwd+='-moved';
    if(scenario==='secret') await writeFile(path.join(f.source,'credentials.pem'),'synthetic only');
    await service.processQueues(f.api);
    assert.equal((await service.status(input.operationId))?.state,scenario==='cancel'?'canceled':'needs_review');
    assert.equal(f.creations(),0);assert(!f.calls.some(c=>c.action==='restore'));
  }
});
test('a new turn racing a busy queued capture leaves a durable stop marker and no restore',async()=>{
  const {f,input,service}=await prepare();await service.queue(f.api,input);
  await service.recordTurn(input.agentId,'turn-1','completed');f.sourceAgent.status='idle';f.sourceAgent.activeTurn=null;
  f.forkEdit(()=>service.recordTurn(input.agentId,'turn-2'));
  await service.processQueues(f.api);
  assert.equal(f.creations(),0);assert(!f.calls.some(c=>c.action==='restore'));
  assert.notEqual((await service.status(input.operationId))?.state,'ready');
});
test('concurrent queue admission permits only one operation per source',async()=>{
  const {f,input,service}=await prepare();
  const results=await Promise.allSettled([service.queue(f.api,input),service.queue(f.api,{...input,operationId:randomUUID()})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await service.operations(input.agentId)).filter(o=>o.state==='queued').length,1);
  assert.equal(f.creations(),0);
});
test('canceling a later queue while the drain runs preserves cancellation across reload',async()=>{
  const {f,input,service}=await prepare();
  const later={...input,agentId:'second-source',operationId:randomUUID()};
  await service.queue(f.api,later);await service.queue(f.api,input);
  const file=path.join(f.storage,'op-'+input.operationId+'.json');
  const first=JSON.parse(await readFile(file,'utf8'));first.createdAt='2099-01-01T00:00:00.000Z';
  await writeFile(file,JSON.stringify(first));
  await service.recordTurn(input.agentId,'turn-1','completed');
  await service.recordTurn(later.agentId,'turn-1','completed');
  f.sourceAgent.status='idle';f.sourceAgent.activeTurn=null;
  const run=f.transport.run.bind(f.transport);
  f.transport.run=async request=>{
    if(request.action==='restore') await service.cancel(later.operationId);
    return run(request);
  };
  await service.processQueues(f.api);
  assert.equal((await service.status(input.operationId))?.state,'ready');
  assert.equal((await service.status(later.operationId))?.state,'canceled');
  await new HandoffService(f.storage,f.transport,f.contexts).processQueues(f.api);
  assert.equal((await service.status(later.operationId))?.state,'canceled');assert.equal(f.creations(),1);
  assert.equal(JSON.parse(await readFile(path.join(f.storage,'queue-stop-'+later.operationId+'.json'),'utf8')).reason,'user-canceled');
});
test('new turn during destination routing blocks creation after verified restore',async()=>{
  const {f,input,service}=await prepare();await service.queue(f.api,input);
  await service.recordTurn(input.agentId,'turn-1','completed');f.sourceAgent.status='idle';f.sourceAgent.activeTurn=null;
  const client=f.api.hosts.client.bind(f.api.hosts);
  f.api.hosts.client=async host=>{
    const remote=await client(host);
    if(f.calls.some(c=>c.action==='status')) await service.recordTurn(input.agentId,'turn-2');
    return remote;
  };
  await service.processQueues(f.api);
  assert(f.calls.some(c=>c.action==='restore'));assert.equal(f.creations(),0);
  assert.match((await service.status(input.operationId))?.message??'',/superseded/);
});
