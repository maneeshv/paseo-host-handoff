import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import { HandoffService, assertIdle } from '@server/service';
import { resolveProject, isSshTransport } from '@server/resolver';
const p = {id:'p1', key:'remote:example/repo', name:'repo', path:'/repos/repo'};
test('matching exact, missing, ambiguous, explicit and revalidated mappings', () => {
  assert.equal(resolveProject(p.key,'h',[p]).match,'exact');
  assert.equal(resolveProject('local:source','h',[p]).match,'missing');
  assert.equal(resolveProject(p.key,'h',[p,{...p,id:'p2'}]).match,'ambiguous');
  assert.equal(resolveProject(p.key,'h',[p,{...p,id:'p2'}],undefined,'p2').selected?.id,'p2');
  const saved = {sourceKey:p.key,hostId:'h',project:p};
  assert.equal(resolveProject(p.key,'h',[p],saved).match,'remembered');
  assert.equal(resolveProject(p.key,'h',[{...p,path:'/moved'}],saved).match,'exact');
  assert.throws(() => resolveProject(p.key,'h',[p],undefined,'deleted'),/no longer/);
});
test('relay is not SSH and running source is not idle', () => {
  assert(!isSshTransport('relay://host')); assert(isSshTransport('ssh://host'));
  assert.throws(()=>assertIdle({status:'running'}),/idle/);
  assert.throws(()=>assertIdle({status:'idle',activeTurn:{}}),/idle/);
  assertIdle({status:'idle'});
});
test('unverified context compatibility gates before all remote work; receipt survives retry/reload/cancel', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'handoff-service-test-'));
  const contexts={compatibility:async()=>({available:false,version:null,reason:'Unverified source version'}),capture:async()=>{throw Error('must not capture');}};
  const service = new HandoffService(dir,undefined,contexts);
  const api = {agents:{ref:()=>({})},hosts:{client:()=>{throw Error('must not route');}}} as unknown as PaseoApi;
  const input = {operationId:randomUUID(),agentId:'a',hostId:'h',projectId:'p',fingerprint:'a'.repeat(64),confirmed:true as const};
  const first = await service.start(api,input); assert.equal(first.state,'blocked'); assert.match(first.message,/Unverified/);
  assert.deepEqual(await new HandoffService(dir).start(api,input),first);
  assert.equal((await service.operations()).length,1);
  await assert.rejects(service.start(api,{...input,hostId:'another'}),/another request/);
  assert.equal((await service.cancel(first.id)).state,'canceled');
  assert.equal((await service.start(api,input)).state,'canceled');
});
test('offline and missing hosts fail preview before routing', async () => {
  const api = {agents:{ref:()=>({refresh:async()=>({agent:{},project:null})})}, hosts:{list:async()=>({self:{serverId:'self'},hosts:[]}),client:()=>{throw Error('must not route');}}} as unknown as PaseoApi;
  await assert.rejects(new HandoffService().preview(api,{agentId:'a',hostId:'missing'}),/offline/);
});
test('discovery adds the exact old source outside the list page without loading its history',async()=>{
  const contexts={compatibility:async()=>({available:true,version:'0.15.2',reason:null}),capture:async()=>{throw Error('no context read');}};
  const a={id:'old',title:'saved',provider:'codex',cwd:'/fixture',status:'closed',updatedAt:'now',archivedAt:null,pendingPermissions:[],persistence:{provider:'codex',sessionId:'saved'}};
  const api={hosts:{list:async()=>({self:{serverId:'source'},hosts:[]})},agents:{list:async()=>({entries:[]}),ref:(id:string)=>({refresh:async()=>({agent:{...a,id},project:null}),timeline:{refetch:()=>{throw Error('must not hydrate');}}})}} as unknown as PaseoApi;
  const result=await new HandoffService(undefined,undefined,contexts).discover(api,'old');
  assert.equal(result.agents.length,1);assert.equal(result.agents[0].canReopen,true);assert.equal(result.agents[0].savedSource,true);assert.equal(result.agents[0].updatedAt,'now');
});
