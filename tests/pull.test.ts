import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,symlink,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import type {PaseoApi,PaseoAgentCreateOptions} from '@getpaseo/client';
import {setup} from '@test/operation-fixture';
import {HandoffService} from '@server/service';
import {PullService,verifyLocalReturn,completedOutbound} from '@server/pull-service';
import {approvedSourceRoot} from '@server/capture-helper';
import {capture,inspect,git} from '@server/git-state';
import type {PullExport,PullRequest} from '@server/pull-protocol';
import {ConnectionUnknown,runProcess} from '@server/transport';
import {z} from 'zod';

async function fixture(){
  const f=await setup(),store=new HandoffService(f.storage),parentId=randomUUID(),sourceId=randomUUID();
  const parent={id:parentId,agentId:f.sourceAgent.id,hostId:'fixture-host',state:'ready' as const,stage:'Ready',message:'fixture',createdAt:'2026-01-01',updatedAt:'2026-01-01',destinationAgentId:sourceId,destinationWorkspaceId:'remote-workspace',destinationCwd:f.source,sourceCwd:f.source,fingerprint:(await inspect(f.source)).fingerprint};
  await store.save('op-'+parentId+'.json',parent);
  const source={...f.sourceAgent,id:sourceId,workspaceId:'remote-workspace',archivedAt:null as string|null,labels:{'handoff.operation':parentId,'handoff.origin':JSON.stringify({operationId:parentId,hostId:'source-host',agentId:parent.agentId,cwd:parent.sourceCwd,fingerprint:parent.fingerprint})}};
  let creates=0,created:PaseoAgentCreateOptions|undefined,lost=false,hook:(r:PullRequest)=>Promise<void>=async()=>{};
  const remote={agents:{ref:()=>({refresh:async()=>({agent:source})})},dispose:async()=>{}};
  const api={hosts:{list:()=>f.api.hosts.list(),client:async()=>remote},providers:{listAvailable:async()=>({providers:[{provider:'codex',available:true}]})},agents:{create:async(o:PaseoAgentCreateOptions)=>{creates++;created=o;if(lost)throw new ConnectionUnknown('lost');return {id:o.agentId};},ref:(id:string)=>({refresh:async()=>created?.agentId===id?{agent:{id,cwd:created.cwd,labels:created.labels,status:'idle',workspaceId:'return-workspace'}}:null})}} as unknown as PaseoApi;
  const local=async()=>({serverId:'source-host',daemonVersion:'0.15.2',workerPid:123,connectedDaemon:'reachable' as const});
  const transport={run:async(r:PullRequest):Promise<PullExport>=>{
    await hook(r);const snap=await inspect(f.source);
    const {root,relativeCwd,head,fingerprint,bytes,counts,files,ignored}=snap;
    return {reviewHash:'a'.repeat(64),manifest:{root,relativeCwd,head,fingerprint,bytes,counts,files,ignored,context:{itemCount:1,characters:f.attachment.text.length,truncated:false,version:'0.15.4'}},source:{id:source.id,cwd:source.cwd,title:source.title,provider:source.provider,model:source.model,modeId:null,thinkingOptionId:null,features:[]},context:{attachment:f.attachment,itemCount:1,boundaryCursor:null,boundaryMessageId:null},package:r.action==='capture'?await capture(f.source,path.join(f.root,'capture-'+randomUUID()),snap):undefined};
  }};
  const selection={coordinatorId:'source-host',parentOperationId:parentId};
  const input={...selection,operationId:randomUUID(),reviewHash:'a'.repeat(64),confirmed:true as const};
  return {...f,store,source,parent,api,local,transport,selection,input,service:()=>new PullService(store,transport,local),creates:()=>creates,created:()=>created,lose:()=>lost=true,hook:(fn:typeof hook)=>hook=fn};
}
test('pull restores parity into isolated local checkout, preserves lineage and never duplicates across reload',async()=>{
  const f=await fixture(),s=f.service();const review=await s.review(f.api,f.selection);assert.equal(review.sourceHostId,'fixture-host');assert.equal(review.destinationHostId,'source-host');
  const op=await s.start(f.api,f.input);assert.equal(op.state,'ready',op.message);assert.equal(f.creates(),1);assert.notEqual(op.destinationCwd,f.source);
  assert.equal((await inspect(op.destinationCwd!)).fingerprint,f.parent.fingerprint);assert.equal((await inspect(f.source.cwd)).fingerprint,f.parent.fingerprint);
  assert.equal(JSON.parse(f.created()!.labels!['handoff.origin']).hostId,'fixture-host');assert.equal(f.created()!.labels!['handoff.parent-operation'],f.parent.id);
  assert.equal((await f.service().start(f.api,f.input)).state,'ready');assert.equal(f.creates(),1);
  await assert.rejects(s.start(f.api,{...f.input,operationId:randomUUID()}),/already has/);
});
test('wrong coordinator, archive, active turn, permission, lineage, original divergence block',async()=>{
  for(const kind of ['coordinator','archived','running','permission','lineage','divergence']){
    const f=await fixture();
    if(kind==='archived')f.source.archivedAt='now';if(kind==='running')f.source.status='running';if(kind==='permission')f.source.pendingPermissions.push({});if(kind==='lineage')f.source.labels['handoff.origin']='{}';if(kind==='divergence')await writeFile(path.join(f.source.cwd,'file.txt'),'changed');
    await assert.rejects(f.service().review(f.api,{...f.selection,...(kind==='coordinator'?{coordinatorId:'other'}:{})}));assert.equal(f.creates(),0);
  }
});
test('lost create reply reconciles predetermined identity after reload with exactly one create',async()=>{
  const f=await fixture();f.lose();const op=await f.service().start(f.api,f.input);assert.equal(op.state,'unverified');assert(op.destinationAgentId);
  assert.equal((await f.service().check(f.api,op.id)).state,'ready');assert.equal((await f.service().start(f.api,f.input)).state,'ready');assert.equal(f.creates(),1);
});
test('source drift during final remote check blocks local activation, retains isolated files',async()=>{
  const f=await fixture();f.hook(async()=>{const op=await f.store.status(f.input.operationId);if(op?.state==='activating')f.source.updatedAt='new-turn';});
  const op=await f.service().start(f.api,f.input);assert.notEqual(op.state,'ready');assert.match(op.message,/Source changed/);assert.equal(f.creates(),0);assert(op.destinationCwd);
});
test('capture disconnect can recover only the same reviewed operation before any create',async()=>{
  const f=await fixture();let once=true;f.hook(async r=>{if(r.action==='capture'&&once){once=false;throw new ConnectionUnknown('capture disconnected');}});
  assert.equal((await f.service().start(f.api,f.input)).state,'unverified');assert.equal(f.creates(),0);
  assert.equal((await f.service().recover(f.api,{operationId:f.input.operationId,coordinatorId:f.input.coordinatorId,confirmed:true})).state,'ready');assert.equal(f.creates(),1);
});
test('concurrent return requests serialize parent admission',async()=>{
  const f=await fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  f.hook(async r=>{if(r.action==='capture'){entered();await wait;}});const s=f.service(),first=s.start(f.api,f.input);await started;
  await assert.rejects(s.start(f.api,{...f.input,operationId:randomUUID()}),/in progress/);release();assert.equal((await first).state,'ready');assert.equal(f.creates(),1);
});
test('bounded transport rejects oversized response and preserves split UTF-8',async()=>{
  await assert.rejects(runProcess(process.execPath,['-e','process.stdout.write("x".repeat(10000))'],'',z.any(),100),/Oversized/);
  const result=await runProcess(process.execPath,['-e','const b=Buffer.from(JSON.stringify({ok:true,result:"hello 🌍"}));for(const x of b)process.stdout.write(Buffer.from([x]));'],'',z.string(),1024);assert.equal(result,'hello 🌍');
});
test('source cwd cannot inherit an ancestor repository outside its approved root',async()=>{
  const f=await fixture(),approved=path.join(f.source.cwd,'private'),cwd=path.join(approved,'checkout');await mkdir(cwd,{recursive:true});
  await assert.rejects(approvedSourceRoot(cwd,approved),/escapes/);
});
test('retained destination or checkout directory symlinks cannot redirect activation',async()=>{
  const f=await fixture(),op=await f.service().start(f.api,f.input);assert.equal(op.state,'ready');
  const expected=await inspect(f.source.cwd),destination=path.dirname(op.destinationCwd!),moved=destination+'-retained';
  await rename(destination,moved);await symlink(moved,destination);
  await assert.rejects(verifyLocalReturn(destination,op.destinationCwd!,expected),/redirected/);
  const fresh=path.join(f.root,'linked-checkout');await mkdir(fresh);await symlink(path.join(moved,'checkout'),path.join(fresh,'checkout'));
  await assert.rejects(verifyLocalReturn(fresh,path.join(fresh,'checkout'),expected),/redirected/);
});
test('historical Ready remains discoverable after reconciliation closes it, without relaxing live guards',async()=>{
  const f=await fixture();f.source.status='closed';f.source.archivedAt='now';
  const downgraded=await f.store.check(f.api,f.parent.id);assert.equal(downgraded.state,'unverified');assert.equal(downgraded.stage,'Ready');
  const candidates=(await f.service().discover(f.api)).candidates;assert.equal(candidates.length,1);assert.match(candidates[0].blocker!,/Archived/);
  await assert.rejects(f.service().review(f.api,f.selection),/Archived/);assert.equal(f.creates(),0);
  f.source.archivedAt=null;f.source.workspaceId='moved';
  const rejected=await f.service().start(f.api,f.input);assert.equal(rejected.state,'failed');assert.match(rejected.message,/no longer matches/);assert.equal(f.creates(),0);
  for(const state of ['unverified','failed'] as const)assert(completedOutbound({...f.parent,state}));
  for(const state of ['canceled','checking','activating'] as const)assert(!completedOutbound({...f.parent,state}));
  assert(!completedOutbound({...f.parent,state:'unverified',stage:'Starting agent'}));
  assert(!completedOutbound({...f.parent,state:'unverified',destinationWorkspaceId:undefined}));
  assert(!completedOutbound({...f.parent,direction:'pull'}));
});
