import type {PaseoApi} from '@getpaseo/client';
import {z} from 'zod';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {HandoffService} from '@server/service';
import {SshPullTransport,type PullTransport} from '@server/pull-transport';
import {pullSelection,pullStartInput,pullRecoverInput} from '@shared/pull';
import type {Operation} from '@shared/contracts';
import {sourceSignature} from '@server/source-state';
import {sourceIdentity} from '@server/context';
import {inspect,restore,requireUnchanged,requireReturnUnchanged,scanBytes,type Snapshot} from '@server/git-state';
import type {PullRequest,PullExport} from '@server/pull-protocol';
import {ConnectionUnknown} from '@server/transport';

const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function completedOutbound(op:Operation) {
  return op.direction!=='pull'&&!!op.destinationAgentId&&!!op.destinationWorkspaceId&&
    (op.state==='ready'||(['unverified','failed'].includes(op.state)&&op.stage==='Ready'));
}
export async function verifyLocalReturn(destination:string,cwd:string,expected:Snapshot) {
  const root=path.join(destination,'checkout');
  for(const p of [destination,root,cwd]) {
    const st=await lstat(p);
    if(!st.isDirectory()||st.isSymbolicLink()||await realpath(p)!==p)throw Error('Return destination directory was redirected. Activation blocked.');
  }
  const actual=await inspect(cwd);
  if(actual.root!==root)throw Error('Return repository root differs from isolated checkout.');
  requireReturnUnchanged(expected,actual);
}
export class PullService {
  private busy=new Set<string>();
  private parents=new Set<string>();
  constructor(private store:HandoffService,private transport:PullTransport=new SshPullTransport(),private localIdentity=sourceIdentity){}
  private async parent(paseo:PaseoApi,raw:z.input<typeof pullSelection>,requireInactive=true) {
    const input=pullSelection.parse({coordinatorId:raw.coordinatorId,parentOperationId:raw.parentOperationId}),directory=await paseo.hosts.list();
    if(directory.self.serverId!==input.coordinatorId)throw Error('Wrong coordinating host. Open Handoff on the Mac that sent this work.');
    const parent=await this.store.status(input.parentOperationId);
    if(!parent||!completedOutbound(parent)||!parent.destinationAgentId||!parent.destinationCwd||!parent.sourceCwd||!parent.fingerprint)throw Error('A completed local outbound receipt is required.');
    const host=directory.hosts.find(h=>h.serverId===parent.hostId);
    if(!host||host.status!=='online')throw Error('Source host is offline. Nothing captured.');
    const binding=await this.store.binding(parent.hostId);
    if(!binding)throw Error('No approved outbound SSH binding for this source. Reverse SSH is not required.');
    const remote=await paseo.hosts.client(parent.hostId);
    try {
      const source=(await remote.agents.ref(parent.destinationAgentId).refresh())?.agent;
      if(!source||source.id!==parent.destinationAgentId||source.workspaceId!==parent.destinationWorkspaceId||source.cwd!==parent.destinationCwd||source.labels['handoff.operation']!==parent.id)throw Error('Source no longer matches the original outbound receipt.');
      let origin;try{origin=JSON.parse(source.labels['handoff.origin']);}catch{throw Error('Original source lineage is missing.');}
      if(origin.operationId!==parent.id||origin.hostId!==input.coordinatorId||origin.agentId!==parent.agentId||origin.cwd!==parent.sourceCwd||origin.fingerprint!==parent.fingerprint)throw Error('Remote lineage differs from the original local receipt.');
      if(requireInactive) {
        if(source.archivedAt)throw Error('Archived on source host. Unarchive it in Paseo, then Check again.');
        sourceSignature(source,source.id);
      }
      return {input,parent,source,binding,host,directory};
    } finally {await remote.dispose();}
  }
  async discover(paseo:PaseoApi) {
    const directory=await paseo.hosts.list(),candidates=[];
    for(const parent of (await this.store.operations(undefined,0)).filter(completedOutbound)) {
      const host=directory.hosts.find(h=>h.serverId===parent.hostId);
      try {
        const p=await this.parent(paseo,{coordinatorId:directory.self.serverId,parentOperationId:parent.id},false);
        let blocker:string|null=null;
        try{sourceSignature(p.source,p.source.id);}catch{blocker=p.source.archivedAt?'Archived on source host. Unarchive it in Paseo, then Check again.':'Source must be inactive, with no permission request or error.';}
        candidates.push({parentOperationId:parent.id,sourceHostId:parent.hostId,sourceHostLabel:host?.label??parent.hostId,sourceAgentId:p.source.id,title:p.source.title??p.source.id,cwd:p.source.cwd,archived:!!p.source.archivedAt,status:p.source.status,blocker});
      }catch(e){candidates.push({parentOperationId:parent.id,sourceHostId:parent.hostId,sourceHostLabel:host?.label??parent.hostId,sourceAgentId:parent.destinationAgentId!,title:parent.destinationAgentId!,cwd:parent.destinationCwd??'',archived:false,status:host?.status??'offline',blocker:(e as Error).message});}
    }
    return {coordinatorId:directory.self.serverId,coordinatorLabel:directory.self.label??directory.self.serverId,candidates};
  }
  private async original(parent:Operation) {
    const snapshot=await inspect(parent.sourceCwd!);
    if(snapshot.fingerprint!==parent.fingerprint)throw Error('Return divergence: the original local checkout changed since it was sent. Explicit resolution required; nothing overwritten.');
    return snapshot;
  }
  private request(p:Awaited<ReturnType<PullService['parent']>>,operationId:string,action:PullRequest['action'],reviewHash?:string):PullRequest {
    return {action,binding:p.binding,agentId:p.source.id,cwd:p.source.cwd,operationId,reviewHash};
  }
  async review(paseo:PaseoApi,input:z.input<typeof pullSelection>) {
    const p=await this.parent(paseo,input),local=await this.localIdentity(paseo);
    if(local.daemonVersion!=='0.15.2')throw Error('Pull destination is currently verified only on stock Paseo 0.15.2.');
    await this.original(p.parent);
    const result=await this.transport.run(this.request(p,randomUUID(),'review'));
    if(result.source.id!==p.source.id||result.source.cwd!==p.source.cwd)throw Error('Helper returned another source.');
    await this.original(p.parent);await this.parent(paseo,input);
    return {coordinatorId:input.coordinatorId,sourceHostId:p.parent.hostId,sourceAgentId:p.source.id,sourceTitle:result.source.title??p.source.id,sourceCwd:p.source.cwd,destinationHostId:input.coordinatorId,originalCwd:p.parent.sourceCwd!,parentOperationId:p.parent.id,reviewHash:result.reviewHash,manifest:result.manifest};
  }
  async start(paseo:PaseoApi,raw:z.input<typeof pullStartInput>):Promise<Operation> {
    const input=pullStartInput.parse(raw);
    if(this.busy.has(input.operationId)||this.parents.has(input.parentOperationId))throw Error('Return already in progress; follow its receipt.');
    this.busy.add(input.operationId);this.parents.add(input.parentOperationId);
    try {
      const old=await this.store.status(input.operationId),requestHash=hash(input);
      if(old&&old.requestHash!==requestHash)throw Error('Operation ID belongs to another request.');
      if(old?.destinationAgentId)return this.reconcile(paseo,old);
      const prior=(await this.store.operations(undefined,0)).find(o=>o.direction==='pull'&&o.parentOperationId===input.parentOperationId&&o.id!==input.operationId);
      if(prior)throw Error('This outbound receipt already has a return operation. Use its existing receipt; do not create another ID.');
      const now=new Date().toISOString();
      let op:Operation=old??{id:input.operationId,agentId:'pending',hostId:input.coordinatorId,coordinatorId:input.coordinatorId,direction:'pull',parentOperationId:input.parentOperationId,createdAt:now,updatedAt:now,state:'checking',stage:'Checking return',message:'Checking original lineage and source',requestHash};
      const update=async(changes:Partial<Operation>)=>{op={...op,...changes,updatedAt:new Date().toISOString()};await this.store.save('op-'+op.id+'.json',op);return op;};
      try {
        await this.store.save('pull-request-'+op.id+'.json',input);
        const p=await this.parent(paseo,input),local=await this.localIdentity(paseo);
        if(local.daemonVersion!=='0.15.2')throw Error('Unverified local destination version.');
        const available=await paseo.providers.listAvailable();if(available.error||!available.providers.some(v=>v.provider===p.source.provider&&v.available))throw Error('Source provider unavailable on this Mac. No credentials copied.');
        const original=await this.original(p.parent),signature=sourceSignature(p.source,p.source.id);
        await update({agentId:p.source.id,sourceHostId:p.parent.hostId,sourceCwd:p.source.cwd});
        const request=this.request(p,op.id,'capture',input.reviewHash);
        await this.store.save('pull-request-'+op.id+'.json',input);
        await update({state:'capturing',stage:'Capturing on source',message:'Only curated chat leaves the source. Source files and saved session are retained.'});
        const captured=await this.transport.run(request);
        if(captured.reviewHash!==input.reviewHash||captured.source.id!==p.source.id||captured.source.cwd!==p.source.cwd||!captured.package||captured.package.snapshot.fingerprint!==captured.manifest.fingerprint)throw Error('Captured package/source differs from review.');
        scanBytes(Buffer.from(captured.context.attachment.text));
        const recheck=async()=>{
          if(hash(await this.localIdentity(paseo))!==hash(local))throw Error('Local destination runtime changed.');
          const fresh=await this.parent(paseo,input);
          if(sourceSignature(fresh.source,p.source.id)!==signature||hash(fresh.binding)!==hash(p.binding))throw Error('Source or SSH binding changed.');
          const result=await this.transport.run({...request,action:'validate'});
          if(result.reviewHash!==input.reviewHash)throw Error('Source changed before activation.');
          requireUnchanged(original,await this.original(p.parent));
          const after=await this.parent(paseo,input);if(sourceSignature(after.source,p.source.id)!==signature)throw Error('Source changed after validation.');
        };
        await recheck();
        const returns=path.join(this.store.storage,'returns');await mkdir(returns,{recursive:true,mode:0o700});
        if(await realpath(returns)!==returns)throw Error('Return root contains a symlink.');
        const st=await lstat(returns);if(st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw Error('Return root must be private.');
        const destination=path.join(returns,op.id),cwd=path.join(destination,'checkout',captured.package.snapshot.relativeCwd);
        await update({state:'restoring',stage:'Restoring on this Mac',destinationCwd:cwd,fingerprint:captured.manifest.fingerprint,contextItems:captured.context.itemCount,contextCharacters:captured.context.attachment.text.length,contextVersion:'0.15.4'});
        let exists=false;try{await lstat(destination);exists=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        if(exists)await verifyLocalReturn(destination,cwd,captured.package.snapshot);
        else await restore(captured.package,destination);
        await verifyLocalReturn(destination,cwd,captured.package.snapshot);
        await update({state:'verifying',stage:'Verifying return'});await recheck();
        const destinationAgentId=randomUUID();
        await update({state:'activating',stage:'Starting local agent',destinationAgentId,message:'One predetermined local agent. Lost replies are reconciled, never recreated.'});
        await recheck();await verifyLocalReturn(destination,cwd,captured.package.snapshot);
        // Snapshot continuity, not an atomic reservation against a later source prompt.
        const a=captured.source;
        await paseo.agents.create({agentId:destinationAgentId,idempotencyKey:'handoff:'+op.id,cwd,title:a.title??'Returned work',config:{provider:a.provider+(a.model?'/'+a.model:''),modeId:a.modeId??undefined,thinkingOptionId:a.thinkingOptionId??undefined,featureValues:Object.fromEntries(a.features.map(f=>[f.id,f.value]))},attachments:[captured.context.attachment],prompt:'Continue the ongoing task using the attached curated conversation and this verified returned checkout. This is a fresh agent. Source and original checkouts are retained; do not modify them.',labels:{'handoff.operation':op.id,'handoff.parent-operation':p.parent.id,'handoff.origin':JSON.stringify({operationId:op.id,hostId:p.parent.hostId,agentId:p.source.id,cwd:p.source.cwd,fingerprint:captured.manifest.fingerprint})}});
        return await this.reconcile(paseo,op);
      } catch(e) {
        return update({state:op.destinationAgentId||e instanceof ConnectionUnknown?'unverified':'failed',message:(e instanceof Error&&!('stdout'in e)&&!('stderr'in e)?e.message:'Return failed; inspect source locally.')+' Source and original retained. Isolated artifacts may remain. Use this receipt, not a new operation.'});
      }
    }finally{this.busy.delete(input.operationId);this.parents.delete(input.parentOperationId);}
  }
  private async reconcile(paseo:PaseoApi,op:Operation) {
    if((await paseo.hosts.list()).self.serverId!==op.coordinatorId)throw Error('Wrong coordinating host.');
    let next={...op};
    if(!op.destinationAgentId)return op;
    try{
      const a=(await paseo.agents.ref(op.destinationAgentId).refresh())?.agent;
      if(!a||a.cwd!==op.destinationCwd||a.labels['handoff.operation']!==op.id)next={...op,state:'unverified',message:'Local creation outcome unknown. No duplicate create attempted.'};
      else if(a.status==='error'||a.providerUnavailable||a.lastError)next={...op,state:'failed',message:'Local agent exists but failed to start. Inspect it; do not recreate.'};
      else if(['idle','running'].includes(a.status))next={...op,state:'ready',stage:'Ready',destinationWorkspaceId:a.workspaceId,message:'Returned into a new local checkout and fresh agent. Home and original local checkout retained.'};
      else next={...op,state:'unverified',message:'Local agent exists but is not ready. Check status; do not recreate.'};
    }catch{next={...op,state:'unverified',message:'Cannot verify local agent yet. Check status; no automatic retry.'};}
    next.updatedAt=new Date().toISOString();await this.store.save('op-'+op.id+'.json',next);return next;
  }
  async check(paseo:PaseoApi,id:string) {
    const op=await this.store.status(id);if(!op||op.direction!=='pull')throw Error('Return operation not found.');
    if(this.busy.has(id))return op;
    this.busy.add(id);try{return await this.reconcile(paseo,op);}finally{this.busy.delete(id);}
  }
  async recover(paseo:PaseoApi,raw:z.input<typeof pullRecoverInput>) {
    const input=pullRecoverInput.parse(raw),op=await this.store.status(input.operationId);
    if(!op||op.direction!=='pull'||op.coordinatorId!==input.coordinatorId||(await paseo.hosts.list()).self.serverId!==input.coordinatorId)throw Error('Return receipt belongs to another coordinator.');
    if(op.destinationAgentId||!['failed','unverified'].includes(op.state))throw Error('Only pre-creation failed/unknown returns can be recovered. Check status for an existing destination ID.');
    const request=pullStartInput.parse(await this.store.load('pull-request-'+op.id+'.json'));
    if(request.operationId!==op.id||request.coordinatorId!==op.coordinatorId||hash(request)!==op.requestHash)throw Error('Persisted return request does not match receipt.');
    return this.start(paseo,request);
  }
}
