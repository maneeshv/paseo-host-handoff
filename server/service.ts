import type { PaseoApi } from '@getpaseo/client';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operationSchema, previewInput, startInput, queueInput, type Operation, type Project } from '@shared/contracts';
import { inspect, capture, requireUnchanged, scanBytes } from '@server/git-state';
import { resolveProject, type Mapping } from '@server/resolver';
import { bindingSchema, SshTransport, ConnectionUnknown, type Transport, type RemoteRequest } from '@server/transport';
import { ForkContexts, sourceIdentity, type Contexts } from '@server/context';
import { canReopenForCheck, reopenForCheck } from '@server/context-read';
import { sourceSignature } from '@server/source-state';

const originSchema = z.object({operationId:z.string().uuid(),hostId:z.string(),agentId:z.string(),cwd:z.string().startsWith('/'),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const queueRecordSchema=z.object({input:queueInput,cwd:z.string(),projectKey:z.string(),project:z.object({id:z.string(),key:z.string(),name:z.string(),path:z.string()}),turnId:z.string(),lastUserMessageAt:z.string().nullable(),createdAt:z.string(),completedAt:z.string().optional()});

export function assertIdle(a: {status: string; activeTurn?: unknown; pendingPermissions?: unknown[]}) {
  if (a.status !== 'idle' || a.activeTurn || a.pendingPermissions?.length) throw new Error('Available when the source agent is idle with no pending permission. Nothing was stopped or archived.');
}
export class HandoffService {
  private busy = new Set<string>();
  private sources = new Set<string>();
  private draining=false;
  constructor(readonly storage = path.join(homedir(), '.paseo-host-handoff'), private transport: Transport = new SshTransport(), private contexts: Contexts = new ForkContexts()) {}
  async binding(hostId: string) {
    const bindings = z.array(bindingSchema).parse(await this.load('ssh-hosts.json') ?? []);
    if (new Set(bindings.map(b=>b.hostId)).size !== bindings.length) throw Error('Duplicate SSH host bindings');
    return bindings.find(b => b.hostId === hostId);
  }
  async save(name: string, value: unknown) {
    await mkdir(this.storage, {recursive: true, mode: 0o700});
    const file = path.join(this.storage, name);
    const tmp = file + '.' + randomUUID() + '.tmp';
    await writeFile(tmp, JSON.stringify(value, null, 2), {mode: 0o600, flag: 'wx'}); await rename(tmp, file);
  }
  async load(name: string): Promise<unknown> { try {return JSON.parse(await readFile(path.join(this.storage, name), 'utf8'));} catch (e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e;} }
  async discover(paseo: PaseoApi, agentId?:string) {
    const [directory, agents] = await Promise.all([paseo.hosts.list(), paseo.agents.list()]);
    const snapshots=agents.entries.map(e=>e.agent);
    if(agentId&&!agents.entries.some(e=>e.agent.id===agentId)) {
      const source=await paseo.agents.ref(agentId).refresh();if(source) snapshots.push(source.agent);
    }
    const compatibility=await this.contexts.compatibility(paseo);
    const forkApiAvailable = compatibility.available;
    return {
      selfId: directory.self.serverId, selfLabel: directory.self.label ?? directory.self.serverId,
      hosts: await Promise.all(directory.hosts.map(async h => ({id: h.serverId ?? h.registrationId, label: h.label ?? h.serverId ?? h.registrationId, status: h.status, transport: await this.binding(h.serverId ?? '') ? 'SSH configured · select to verify' : 'SSH mapping required', sshEligible: false}))),
      agents: snapshots.map(a => ({id: a.id, title: a.title ?? a.id, cwd: a.cwd, status: a.status,updatedAt:a.updatedAt,
        canReopen:canReopenForCheck(a,a.id),
        savedSource:canReopenForCheck(a.status==='idle'?{...a,status:'closed'}:a,a.id)})),
      forkApiAvailable, blocker: compatibility.reason, contextVersion:compatibility.version,
    };
  }
  async preview(paseo: PaseoApi, raw: z.input<typeof previewInput>, deferIdle=false) {
    const input = previewInput.parse(raw);
    const source = await paseo.agents.ref(input.agentId).refresh();
    if (!source) throw new Error('Source agent no longer exists');
    const directory = await paseo.hosts.list();
    const host = directory.hosts.find(h => h.serverId === input.hostId);
    if (!host || !host.enabled || host.status !== 'online') throw new Error('Destination is missing, disabled or offline. No changes made.');
    const remote = await paseo.hosts.client(input.hostId);
    let candidates: Project[];
    let providerReady = false;
    try {
      const projects = await remote.projects.list();
      candidates = projects.projects.map(p => ({id: p.projectId, key: p.projectKey ?? '', name: p.projectDisplayName, path: p.projectRootPath}));
      const available = await remote.providers.listAvailable();
      providerReady = !available.error && available.providers.some(p=>p.provider===source.agent.provider && p.available);
    } finally { await remote.dispose(); }
    const key = source.project?.projectKey ?? null;
    const mappingName = 'mapping-' + createHash('sha256').update(JSON.stringify([key, input.hostId])).digest('hex') + '.json';
    const saved = await this.load(mappingName) as Mapping | null;
    const resolution = resolveProject(key, input.hostId, candidates, saved ?? undefined, input.projectId);
    if (input.remember && input.projectId && resolution.selected && key) await this.save(mappingName, {sourceKey: key, hostId: input.hostId, project: resolution.selected});
    const compatibility=await this.contexts.compatibility(paseo);
    const forkApiAvailable = compatibility.available;
    const blockers: string[] = [];
    if (!forkApiAvailable) blockers.push(compatibility.reason!);
    if(!deferIdle) try {sourceSignature(source.agent,input.agentId);} catch (e) {blockers.push((e as Error).message);}
    if (!source.project?.checkout.isGit) blockers.push('Git repository required');
    if (!providerReady) blockers.push('Source provider is not configured/available on the destination. No credentials are copied.');
    if (!resolution.selected) blockers.push('Choose a destination project explicitly; no folder-name guessing.');
    const binding = await this.binding(input.hostId);
    if (!binding) blockers.push('An explicitly approved SSH host/path mapping is required. Relay/online status does not prove SSH eligibility.');
    else if (resolution.selected) {
      try {await this.transport.run({action:'check',binding,projectPath:resolution.selected.path,operationId:randomUUID(),fingerprint:'0'.repeat(64)});}
      catch (e) {blockers.push((e as Error).message);}
    }
    return {agentId: input.agentId, sourceTitle: source.agent.title ?? input.agentId, sourceCwd: source.agent.cwd, sourceStatus: source.agent.status, hostId: input.hostId, projectKey: key, candidates, ...resolution, blockers, forkApiAvailable, destinationRoot: binding?.root ?? null};
  }
  async inspectSource(paseo: PaseoApi, agentId: string) {
    const source = await paseo.agents.ref(agentId).refresh();
    if (!source) throw new Error('Source agent not found');
    const sourceRevision=sourceSignature(source.agent,agentId);
    const result = await inspect(source.agent.cwd);
    const latest = await paseo.agents.ref(agentId).refresh();
    if (!latest || latest.agent.cwd !== source.agent.cwd) throw new Error('Source placement changed');
    if(sourceSignature(latest.agent,agentId)!==sourceRevision) throw Error('Source changed during file review. Nothing moved.');
    const {root, relativeCwd, head, fingerprint, bytes, counts, files, ignored} = result;
    const compatibility=await this.contexts.compatibility(paseo);
    let context;
    if(compatibility.available) {
      const chat=await this.contexts.capture(paseo,paseo.agents.ref(agentId));await chat.revalidate();
      context={itemCount:chat.result.itemCount,characters:chat.result.attachment.text.length,truncated:chat.result.attachment.text.includes('[Earlier chat history omitted]')||chat.result.attachment.text.includes('[Message truncated]'),version:chat.version};
      // Resume hooks can edit files even though no provider prompt was sent.
      requireUnchanged(result,await inspect(source.agent.cwd));
      if(sourceSignature((await paseo.agents.ref(agentId).refresh())?.agent,agentId)!==sourceRevision) throw Error('Source changed while checking saved history. Review again.');
    }
    return {root, relativeCwd, head, fingerprint, bytes, counts, files, ignored,context};
  }
  async reopenSource(paseo:PaseoApi,agentId:string) {
    const before=await sourceIdentity(paseo);
    await reopenForCheck(paseo.agents.ref(agentId));
    const after=await sourceIdentity(paseo);
    if(JSON.stringify(after)!==JSON.stringify(before)) throw Error('Source runtime changed while reopening. Check the agent before retrying. Nothing moved.');
    return {message:'Saved session reopened for checking. No prompt sent. Nothing moved.'};
  }
  async queue(paseo:PaseoApi,raw:z.input<typeof queueInput>):Promise<Operation> {
    const input=queueInput.parse(raw),requestHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if(this.busy.has(input.operationId)) throw Error('Operation already being checked');
    if(this.sources.has(input.agentId)) throw Error('Another handoff for this source is being checked');
    this.busy.add(input.operationId);
    this.sources.add(input.agentId);
    try {
      const old=await this.status(input.operationId);
      if(old) {if(old.requestHash!==requestHash) throw Error('Operation ID belongs to another request');return old;}
      const p=await this.preview(paseo,{agentId:input.agentId,hostId:input.hostId,projectId:input.projectId},true);
      if(p.blockers.length) throw Error(p.blockers.join('\n')+' Nothing queued.');
      const source=await paseo.agents.ref(input.agentId).refresh();
      if(!source||source.agent.status!=='running'||!source.agent.activeTurn?.turnId||!source.project?.projectKey) throw Error('Queue requires the current running turn and a Git project. Nothing queued.');
      if(source.agent.cwd!==p.sourceCwd||source.project.projectKey!==p.projectKey) throw Error('Source placement changed during queue review. Nothing queued.');
      if((await this.operations(input.agentId,0)).some(o=>o.state==='queued')) throw Error('A handoff is already queued for this source');
      const now=new Date().toISOString();
      await this.save('queue-'+input.operationId+'.json',{input,cwd:source.agent.cwd,projectKey:source.project.projectKey,project:p.selected!,turnId:source.agent.activeTurn.turnId,lastUserMessageAt:source.agent.lastUserMessageAt??null,createdAt:now});
      const op:Operation={id:input.operationId,agentId:input.agentId,hostId:input.hostId,state:'queued',stage:'Queued · starts after this turn',createdAt:now,updatedAt:now,requestHash,message:'Starts after this reply, once the agent is idle. Files and chat are checked again first. Stop editing after queueing. Cancel from the Handoff panel.'};
      await this.save('op-'+op.id+'.json',op);return op;
    } finally {this.busy.delete(input.operationId);this.sources.delete(input.agentId);}
  }
  async recordTurn(agentId:string,turnId:string|null,outcome?:'completed'|'failed'|'canceled') {
    for(const op of await this.operations(agentId,0)) {
      if(!['queued','checking','capturing','restoring','verifying','activating'].includes(op.state)) continue;
      const raw=await this.load('queue-'+op.id+'.json');if(!raw) continue;
      const q=queueRecordSchema.parse(raw);
      // Separate stop marker survives a hook racing the operation's receipt lock.
      if(turnId!==q.turnId||outcome==='failed'||outcome==='canceled') await this.save('queue-stop-'+op.id+'.json',{reason:turnId!==q.turnId?'new-turn':outcome});
      if(this.busy.has(op.id)) continue;
      this.busy.add(op.id);
      try {
        if(turnId!==q.turnId&&op.state==='queued') {
          await this.save('op-'+op.id+'.json',{...op,state:'canceled',updatedAt:new Date().toISOString(),message:'Canceled: a new turn started. Nothing moved.'});
        } else if(outcome==='completed'&&op.state==='queued') {
          await this.save('queue-'+op.id+'.json',{...q,completedAt:new Date().toISOString()});
        } else if(outcome&&op.state==='queued') {
          await this.save('op-'+op.id+'.json',{...op,state:'needs_review',updatedAt:new Date().toISOString(),message:'Not started: turn ended with an error or was canceled. Nothing moved.'});
        }
      } finally {this.busy.delete(op.id);}
    }
  }
  async processQueues(paseo:PaseoApi) {
    if(this.draining) return;
    this.draining=true;
    try {for(const op of await this.operations(undefined,0)) {
      if(op.state!=='queued'||this.busy.has(op.id)) continue;
      this.busy.add(op.id);
      let request:z.infer<typeof startInput>|undefined;
      try {
        const current=await this.status(op.id);
        if(current?.state!=='queued') continue;
        const q=queueRecordSchema.parse(await this.load('queue-'+op.id+'.json'));
        if(await this.load('queue-stop-'+op.id+'.json')) throw Error('Queued turn was superseded or unsuccessful.');
        const source=await paseo.agents.ref(op.agentId).refresh();
        if(!source||source.agent.cwd!==q.cwd||source.project?.projectKey!==q.projectKey) throw Error('Source placement changed.');
        if((source.agent.lastUserMessageAt??null)!==q.lastUserMessageAt||(source.agent.activeTurn&&source.agent.activeTurn.turnId!==q.turnId)) {
          await this.save('op-'+op.id+'.json',{...op,state:'canceled',updatedAt:new Date().toISOString(),message:'Canceled: a new message was sent. Nothing moved.'});continue;
        }
        if(source.agent.activeTurn||source.agent.pendingPermissions?.length) continue;
        assertIdle(source.agent);
        // A missed hook can recover only from fresh durable successful-turn evidence.
        if(!q.completedAt&&!(source.agent.attentionReason==='finished'&&source.agent.attentionTimestamp&&source.agent.attentionTimestamp>=q.createdAt&&!source.agent.lastError)) throw Error('Successful completion of the queued turn could not be verified.');
        const p=await this.preview(paseo,{agentId:op.agentId,hostId:op.hostId,projectId:q.project.id});
        if(p.blockers.length||JSON.stringify(p.selected)!==JSON.stringify(q.project)) throw Error(p.blockers.join('\n')||'Destination project mapping changed.');
        const manifest=await this.inspectSource(paseo,op.agentId);
        request=startInput.parse({...q.input,fingerprint:manifest.fingerprint});
        // Convert the durable queue receipt into the same reviewed operation, keeping its ID.
        await this.save('op-'+op.id+'.json',{...op,state:'checking',stage:'Checking after turn',requestHash:createHash('sha256').update(JSON.stringify(request)).digest('hex'),updatedAt:new Date().toISOString()});
      } catch(e) {
        await this.save('op-'+op.id+'.json',{...op,state:'needs_review',updatedAt:new Date().toISOString(),message:'Needs your review: '+(e instanceof Error?e.message:'Check failed')+' Nothing moved.'});
      } finally {this.busy.delete(op.id);}
      if(request) await this.start(paseo,request);
    }} finally {this.draining=false;}
  }
  async status(id: string): Promise<Operation | null> { z.string().uuid().parse(id); const value = await this.load('op-' + id + '.json'); return value ? operationSchema.parse(value) : null; }
  async operations(agentId?: string,limit=30): Promise<Operation[]> {
    const names = await readdir(this.storage).catch((e: NodeJS.ErrnoException) => {if (e.code === 'ENOENT') return []; throw e;});
    const all = await Promise.all(names.filter(n => /^op-[a-f0-9-]+\.json$/.test(n)).map(n => this.load(n).then(v => operationSchema.parse(v))));
    return all.filter(o => !agentId || o.agentId === agentId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,limit||undefined);
  }
  async start(paseo: PaseoApi, raw: z.input<typeof startInput>): Promise<Operation> {
    const i = startInput.parse(raw);
    if (this.busy.has(i.operationId)) throw new Error('Operation already being checked; query status');
    this.busy.add(i.operationId);
    try {
      const requestHash = createHash('sha256').update(JSON.stringify(i)).digest('hex');
      const old = await this.status(i.operationId);
      if (old) {
        if (old.requestHash !== requestHash) throw new Error('Operation ID belongs to another request');
        // Explicit same-request retries can resume file work, but never repeat agent creation.
        if (old.destinationAgentId) return this.reconcile(paseo, old.id);
        if (['ready','canceled','blocked','queued','needs_review'].includes(old.state)) return old;
      }
      // Capability gate is first: no snapshot, SSH restore, workspace or agent mutation before it.
      const now = new Date().toISOString();
      let op: Operation = old ?? {id:i.operationId,agentId:i.agentId,hostId:i.hostId,createdAt:now,updatedAt:now,state:'checking',stage:'Preflight',message:'Checking source and destination',requestHash};
      const update = async (changes: Partial<Operation>) => {op = {...op,...changes,updatedAt:new Date().toISOString()}; await this.save('op-'+op.id+'.json',op); return op;};
    const compatibility=await this.contexts.compatibility(paseo);
    if (!compatibility.available) return update({state:'blocked',message:compatibility.reason!});
      if (this.sources.has(i.agentId)) return update({state:'blocked',message:'Another handoff for this source is in progress'});
      this.sources.add(i.agentId);
      try {
        await update({});
        const preview = await this.preview(paseo,{agentId:i.agentId,hostId:i.hostId,projectId:i.projectId});
        if (preview.blockers.length) return update({state:'blocked',message:preview.blockers.join('\n')});
        const binding = (await this.binding(i.hostId))!;
        const handle = paseo.agents.ref(i.agentId);
        const source = await handle.refresh(); if (!source) throw Error('Source no longer exists');
        const sourceVersion = sourceSignature(source.agent,i.agentId);
        const queued=await this.load('queue-'+op.id+'.json');
        if(queued) {
          const q=queueRecordSchema.parse(queued);
          if(await this.load('queue-stop-'+op.id+'.json')) throw Error('Queued turn was superseded or unsuccessful. Nothing moved.');
          if(source.agent.cwd!==q.cwd||(source.agent.lastUserMessageAt??null)!==q.lastUserMessageAt||source.project?.projectKey!==q.projectKey) throw Error('Queued source changed before capture. Nothing moved.');
        }
        const reviewed = await inspect(source.agent.cwd);
        if (reviewed.fingerprint !== i.fingerprint) throw Error('Source changed since review; review again');
        let chat: Awaited<ReturnType<Contexts['capture']>>|undefined;
        const recheck = async () => {
          if(await this.load('queue-stop-'+op.id+'.json')) throw Error('Queued turn was superseded; activation blocked.');
          const latest = await handle.refresh();
          if (sourceSignature(latest?.agent,i.agentId) !== sourceVersion) throw Error('Source agent changed since review; activation blocked');
          await chat?.revalidate();
          // A history read may resume hooks; their file edits must be checked afterwards.
          requireUnchanged(reviewed,await inspect(source.agent.cwd));
          if(sourceSignature((await handle.refresh())?.agent,i.agentId)!==sourceVersion) throw Error('Source changed during final file validation; activation blocked');
          if(await this.load('queue-stop-'+op.id+'.json')) throw Error('Queued turn was superseded; activation blocked.');
        };
        const origin = source.agent.labels?.['handoff.origin'] ? originSchema.parse(JSON.parse(source.agent.labels['handoff.origin'])) : null;
        const returnGuard = origin?.hostId === i.hostId ? {cwd:origin.cwd,fingerprint:origin.fingerprint} : undefined;
        const request: RemoteRequest = {action:'check',binding,projectPath:preview.selected!.path,operationId:op.id,fingerprint:i.fingerprint,returnGuard};
        await this.transport.run(request);
        chat=await this.contexts.capture(paseo,handle);
        const fork=chat.result;
        if (!fork.attachment || fork.attachment.type !== 'text') throw Error('Chat history could not be built. Stopped before moving files.');
        scanBytes(Buffer.from(fork.attachment.text));
        await recheck();
        await update({state:'capturing',stage:'Capturing reviewed snapshot',sourceCwd:source.agent.cwd,fingerprint:i.fingerprint,parentOperationId:origin?.operationId,contextCharacters:fork.attachment.text.length,contextItems:fork.itemCount,contextVersion:chat.version});
        const pkg = await capture(source.agent.cwd,path.join(this.storage,op.id+'-capture-'+randomUUID()),reviewed);
        await recheck();
        // Persist enough to reconcile a lost reply, but never the conversation or credentials.
        await this.save('request-'+op.id+'.json',request);
        await update({state:'restoring',stage:'Transferring and restoring files',message:'Source retained. Isolated destination only.'});
        const result = await this.transport.run({...request,action:'restore',package:pkg});
        if (result.state !== 'ready' || result.fingerprint !== i.fingerprint) return update({state:result.state === 'failed'?'failed':'unverified',message:result.message,destinationCwd:result.cwd});
        await update({state:'verifying',stage:'Verifying snapshot',destinationCwd:result.cwd});
        const verified = await this.transport.run({...request,action:'status'});
        if (verified.state !== 'ready' || verified.fingerprint !== i.fingerprint || verified.cwd !== result.cwd) throw Error('Destination parity not confirmed; activation blocked');
        await recheck();
        const remote = await paseo.hosts.client(i.hostId);
        try {
          const self = (await paseo.hosts.list()).self.serverId;
          const destinationAgentId = randomUUID();
          await update({state:'activating',stage:'Starting agent',destinationAgentId,message:'Creating one fresh agent with this verified chat history. Never retried automatically.'});
          const model = source.agent.model ?? source.agent.runtimeInfo?.model;
          await recheck();
          const created = await remote.agents.create({agentId:destinationAgentId,idempotencyKey:'handoff:'+op.id,cwd:result.cwd,
            config:{provider:source.agent.provider+(model?'/'+model:''),modeId:source.agent.currentModeId ?? undefined,thinkingOptionId:source.agent.thinkingOptionId ?? undefined,featureValues:Object.fromEntries((source.agent.features??[]).map(f=>[f.id,f.value]))},
            title:source.agent.title ?? 'Handed-off work',attachments:[fork.attachment],
            prompt:'Continue the ongoing task using the attached curated conversation and this verified checkout. This is a fresh agent, not a migrated provider session. The source was retained; do not modify its checkout.',
            labels:{'handoff.operation':op.id,'handoff.origin':JSON.stringify({operationId:op.id,hostId:self,agentId:i.agentId,cwd:source.agent.cwd,fingerprint:i.fingerprint})},
          });
          const current = await created.refresh();
          if (!current || current.agent.cwd !== result.cwd || current.agent.labels['handoff.operation'] !== op.id) throw Error('Destination agent outcome not verified');
          if (current.agent.status === 'error' || current.agent.providerUnavailable) return update({state:'failed',message:'Destination agent exists but could not start. Inspect it on the destination; no duplicate will be created.'});
          if (!['idle','running'].includes(current.agent.status)) return update({state:'unverified',message:'Destination agent exists but is not ready yet. Check status; do not recreate it.'});
          return update({state:'ready',stage:'Ready',destinationWorkspaceId:current.agent.workspaceId,message:'Fresh continuation created after file/index parity. Source kept; no apply-back or merge performed.'});
        } finally {await remote.dispose();}
      } catch (e) {
        const unknown = e instanceof ConnectionUnknown || op.state === 'activating';
        const message = e instanceof Error && !('stderr' in e) && !('stdout' in e) ? e.message : 'Local Git check failed; inspect the source locally. No command output recorded.';
        return update({state:unknown?'unverified':'failed',message:message+(['restoring','verifying','activating'].includes(op.state)?' Isolated destination files may remain; no automatic cleanup.':'')});
      } finally {this.sources.delete(i.agentId);}
    } finally {this.busy.delete(i.operationId);}
  }
  async check(paseo: PaseoApi, id: string): Promise<Operation> {
    if (this.busy.has(id)) {const op = await this.status(id); if (!op) throw Error('Operation not found'); return op;}
    this.busy.add(id);
    try {return await this.reconcile(paseo,id);} finally {this.busy.delete(id);}
  }
  private async reconcile(paseo: PaseoApi, id: string): Promise<Operation> {
    const op = await this.status(id); if (!op) throw Error('Operation not found');
    if (!op.destinationAgentId && !['restoring','verifying','activating','unverified'].includes(op.state)) return op;
    let next: Operation = {...op};
    try {
      if (op.destinationAgentId) {
        const remote = await paseo.hosts.client(op.hostId);
        try {
          const destination = await remote.agents.ref(op.destinationAgentId).refresh();
          if (destination?.agent.labels['handoff.operation'] === op.id && destination.agent.cwd === op.destinationCwd) {
            if (destination.agent.status==='error' || destination.agent.providerUnavailable) next = {...op,state:'failed',message:'Destination agent exists but could not start. Inspect it; no duplicate will be created.'};
            else if (['idle','running'].includes(destination.agent.status)) next = {...op,state:'ready',stage:'Ready',destinationWorkspaceId:destination.agent.workspaceId,message:'Existing destination agent reconciled. No duplicate creation attempted.'};
            else next = {...op,state:'unverified',message:'Destination agent exists but is not ready. Check status.'};
          }
          else next = {...op,state:'unverified',message:'Agent creation outcome remains unknown. No automatic retry; inspect destination.'};
        } finally {await remote.dispose();}
      } else {
        const request = await this.load('request-'+id+'.json') as RemoteRequest | null;
        if (!request) return op;
        const result = await this.transport.run({...request,action:'status'});
        next = {...op,state:result.state==='failed'?'failed':'unverified',destinationCwd:result.cwd,message:result.state==='ready'?'Snapshot verified after reconnect. Agent was not started. Explicit recovery review required; no automatic activation.':result.message};
      }
    } catch {next = {...op,state:'unverified',message:'Cannot reconcile destination yet. Source retained. Check status when reachable.'};}
    next.updatedAt = new Date().toISOString(); await this.save('op-'+id+'.json',next); return next;
  }
  async cancel(id: string): Promise<Operation> {
    if (this.busy.has(id)) throw Error('Operation is in progress; cancellation cannot interrupt a restore or activation');
    this.busy.add(id);
    try {
    const op = await this.status(id); if (!op) throw new Error('Operation not found');
    if (!['blocked', 'canceled','queued','needs_review'].includes(op.state)) throw new Error('Outcome must be reconciled before cancellation');
    await this.save('queue-stop-'+id+'.json',{reason:'user-canceled'});
    const canceled: Operation = {...op, state: 'canceled', updatedAt: new Date().toISOString(), message: 'Canceled before remote writes. Source unchanged.'};
    await this.save('op-' + id + '.json', canceled); return canceled;
    } finally {this.busy.delete(id);}
  }
}
