import { mkdtemp, mkdir, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaseoApi, PaseoAgentCreateOptions } from '@getpaseo/client';
import { HandoffService } from '@server/service';
import type { Contexts } from '@server/context';
import { git, inspect } from '@server/git-state';
import { runProcess, ConnectionUnknown, type Binding, type Transport, type RemoteRequest } from '@server/transport';

export async function setup() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(),'handoff-operation-')));
  const source = path.join(base,'source'), storage = path.join(base,'storage'), root = path.join(base,'handoffs'), home = path.join(base,'daemon');
  for (const p of [source,storage,root,home]) await mkdir(p,{mode:0o700});
  await git(source,'init','--initial-branch=main'); await git(source,'config','user.name','Fixture'); await git(source,'config','user.email','fixture@example.invalid');
  await writeFile(path.join(source,'file.txt'),'fixture\n'); await git(source,'add','.'); await git(source,'commit','-m','test: fixture');
  const paseo = path.join(base,'paseo-fixture'); await writeFile(paseo,`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({serverId:'fixture-host',daemonVersion:'0.15.2',workerPid:123,connectedDaemon:'reachable'}));`,{mode:0o700});
  const binding: Binding = {hostId:'fixture-host',sshTarget:'fixture',node:process.execPath,paseo,home,root,approved:true};
  await writeFile(path.join(storage,'ssh-hosts.json'),JSON.stringify([binding]),{mode:0o600});
  const sourceAgent = {id:'source-agent',title:'Fixture task',provider:'codex',model:'fixture-model',cwd:source,status:'idle',updatedAt:'fixture-version',lastUserMessageAt:'2026-11-15T00:00:00.000Z',persistence:{provider:'codex',sessionId:'synthetic'},activeTurn:null as {turnId:string}|null,pendingPermissions:[] as unknown[],attentionReason:null as string|null,attentionTimestamp:null as string|null,labels:{} as Record<string,string>};
  const attachment = {type:'text' as const,mimeType:'text/plain' as const,contextKind:'chat_history' as const,title:'Chat history',text:'{"items":[{"text":"fixture conversation"}]}'};
  let created: PaseoAgentCreateOptions | undefined, creations = 0, loseActivationReply = false, destinationStatus = 'idle';
  const destination = () => created ? {agent:{id:created.agentId,cwd:created.cwd,labels:created.labels,workspaceId:'fixture-workspace',status:destinationStatus}} : null;
  const remote = {
    projects:{list:async()=>({projects:[{projectId:'project',projectKey:'remote:fixture',projectDisplayName:'Fixture',projectRootPath:source}]})},
    providers:{listAvailable:async()=>({providers:[{provider:'codex',available:true}]})},
    agents:{create:async(options:PaseoAgentCreateOptions)=>{creations++; created=options; if(loseActivationReply) throw new ConnectionUnknown('Lost creation reply'); return {refresh:async()=>destination()};},ref:()=>({refresh:async()=>destination()})},dispose:async()=>{},
  };
  let onFork = async()=>{};
  const contexts:Contexts={compatibility:async()=>({available:true,version:'0.15.2',reason:null}),capture:async()=>{await onFork();return {version:'0.15.2',result:{attachment,itemCount:1,boundaryCursor:null,boundaryMessageId:null},revalidate:async()=>{}};}};
  const api = {agents:{ref:()=>({refresh:async()=>({agent:sourceAgent,project:{projectKey:'remote:fixture',checkout:{isGit:true}}}),forkContext:async()=>{await onFork(); return {attachment,itemCount:1};}})},
    hosts:{list:async()=>({self:{serverId:'source-host'},hosts:[{serverId:'fixture-host',registrationId:'registration',label:'Fixture host',status:'online',enabled:true,targetDescription:'relay://fixture'}]}),client:async()=>remote}} as unknown as PaseoApi;
  const calls: RemoteRequest[] = [];
  let lostRestoreReply = false;
  const transport: Transport = {async run(request) {
    calls.push(request);
    const result = await runProcess(process.execPath,[path.resolve('dist/restore-helper.cjs')],JSON.stringify(request));
    if (request.action==='restore' && lostRestoreReply) {lostRestoreReply=false; throw new ConnectionUnknown('Lost restore reply');}
    return result;
  }};
  const fingerprint = (await inspect(source)).fingerprint;
  const input = {operationId:randomUUID(),agentId:'source-agent',hostId:'fixture-host',projectId:'project',fingerprint,confirmed:true as const};
  return {source,storage,root,api,transport,contexts,input,attachment,calls,sourceAgent,created:()=>created,creations:()=>creations,
    forkEdit(fn:()=>Promise<void>) {onFork=fn;},loseRestore(){lostRestoreReply=true;},loseActivation(){loseActivationReply=true;},destinationStatus(s:string){destinationStatus=s;}};
}
