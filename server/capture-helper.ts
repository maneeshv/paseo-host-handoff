import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {buildAgentForkContextAttachment} from 'paseo-server-0154/agent-activity';
import {connectSource} from '@server/source-connection';
import {readContext} from '@server/context-read';
import {sourceSignature} from '@server/source-state';
import {inspect,capture,requireUnchanged,scanBytes,git} from '@server/git-state';
import {pullRequestSchema,pullExportSchema,type PullExport} from '@server/pull-protocol';

const exec=promisify(execFile),hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function approvedSourceRoot(cwd:string,approvedRoot:string) {
  const root=(await git(cwd,'rev-parse','--show-toplevel')).toString().trim();
  if(!root.startsWith(approvedRoot+'/')||await realpath(root)!==root)throw Error('Discovered Git root escapes the approved source root.');
  return root;
}
export async function captureSource(raw:unknown):Promise<PullExport> {
  const request=pullRequestSchema.parse(raw),b=request.binding;
  if(!request.cwd.startsWith(b.root+'/')||await realpath(b.root)!==b.root||await realpath(request.cwd)!==request.cwd) throw Error('Pull source must be inside the approved private handoff root without directory links.');
  const st=await lstat(b.root);if(!st.isDirectory()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw Error('Source capture root must be private and owned by the SSH user.');
  const approvedGitRoot=await approvedSourceRoot(request.cwd,b.root);
  const identity=async()=>{
    const {stdout}=await exec(b.paseo,['daemon','status','--home',b.home,'--json'],{timeout:15000,maxBuffer:1048576,env:{PATH:path.dirname(b.node)+':/usr/bin:/bin',HOME:process.env.HOME}});
    const s=JSON.parse(stdout);
    if(s.serverId!==b.hostId||s.connectedDaemon!=='reachable'||s.daemonVersion!=='0.15.4'||!Number.isSafeInteger(s.workerPid)||s.workerPid<=0)throw Error('Pull requires the authenticated source host on verified stock Paseo 0.15.4.');
    return {host:s.serverId,version:s.daemonVersion,worker:s.workerPid};
  };
  const daemon=await identity(),connection=await connectSource(b.home,b.hostId);
  try {
    const handle=connection.api.agents.ref(request.agentId),before=(await handle.refresh())?.agent;
    const signature=sourceSignature(before,request.agentId);
    if(before!.cwd!==request.cwd)throw Error('Pull source placement changed.');
    const files=await inspect(request.cwd);
    if(files.root!==approvedGitRoot)throw Error('Source Git root changed.');
    const chat=await readContext(handle,buildAgentForkContextAttachment);
    try{scanBytes(Buffer.from(chat.result.attachment.text));}catch{throw Error('Curated chat contains a potential secret.');}
    const revalidate=async()=>{
      if(hash(await identity())!==hash(daemon))throw Error('Source worker/version changed. Review again.');
      await chat.revalidate();
      if(await approvedSourceRoot(request.cwd,b.root)!==approvedGitRoot)throw Error('Source Git root changed.');
      requireUnchanged(files,await inspect(request.cwd));
      if(sourceSignature((await handle.refresh())?.agent,request.agentId)!==signature)throw Error('Source changed after history/file checks.');
    };
    await revalidate();
    const reviewHash=hash([daemon,signature,chat.historyHash,files.fingerprint,chat.result]);
    if(request.reviewHash&&request.reviewHash!==reviewHash)throw Error('Source changed since return review. Nothing activated.');
    if(request.action!=='review'&&!request.reviewHash)throw Error('Reviewed source hash is required.');
    let pkg;
    if(request.action==='capture') {
      pkg=await capture(request.cwd,path.join(b.root,'pull-capture-'+request.operationId+'-'+randomUUID()),files);
      await revalidate();
    }
    const {root,relativeCwd,head,fingerprint,bytes,counts,ignored,files:entries}=files;
    return pullExportSchema.parse({reviewHash,manifest:{root,relativeCwd,head,fingerprint,bytes,counts,ignored,files:entries,context:{itemCount:chat.result.itemCount,characters:chat.result.attachment.text.length,truncated:/\[(Earlier chat history omitted|Message truncated)\]/.test(chat.result.attachment.text),version:daemon.version}},source:{id:before!.id,cwd:before!.cwd,title:before!.title??null,provider:before!.provider,model:before!.model??before!.runtimeInfo?.model??null,modeId:before!.currentModeId??null,thinkingOptionId:before!.thinkingOptionId??null,features:(before!.features??[]).map(f=>({id:f.id,value:f.value}))},context:chat.result,package:pkg});
  } finally {await connection.close();}
}
