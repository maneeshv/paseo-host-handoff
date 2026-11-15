// Isolated stock-runtime characterization only. Internal lifecycle controls are test oracles.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';

const version = process.argv[2] ?? '0.15.2';
assert(['0.15.2','0.15.4'].includes(version));
if (!process.env.HANDOFF_COLLECTOR_ROOT) {
  const root = await mkdtemp('/private/tmp/handoff-collector-');
  await mkdir(path.join(root,'home')); await mkdir(path.join(root,'tmp'));
  const child = spawn(process.execPath,[process.argv[1],version],{stdio:'inherit',env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),PASEO_HOME:path.join(root,'home','.paseo'),HANDOFF_COLLECTOR_ROOT:root,LANG:'en_US.UTF-8'}});
  child.on('exit', code=>{process.exitCode=code??1;});
} else {
  const req=createRequire(path.resolve('proof',version,'package.json'));
  const module=async name=>import(pathToFileURL(req.resolve(name)).href);
  const {createPaseoDaemon}=await module('@getpaseo/server');
  const internal=async file=>import(pathToFileURL(path.join(path.dirname(req.resolve('@getpaseo/server')),file)).href);
  const {createTestAgentClients}=await internal('test-utils/fake-agent-client.js');
  const {BuiltinPluginLoader}=await internal('plugins/builtin/index.js');
  const {createIdleRuntimeCleanup}=await internal('agent/idle-runtime-cleanup/index.js');
  const {createPaseoClient}=await module('@getpaseo/client');
  const {DaemonClient}=await module('@getpaseo/client/internal/daemon-client');
  const {default:pino}=await module('pino');
  const {buildAgentForkContextAttachment:curate}=await module('@getpaseo/server/agent-activity');
  const root=process.env.HANDOFF_COLLECTOR_ROOT,home=path.join(root,'daemon'),cwd=path.join(root,'workspace');
  await mkdir(cwd); let turns=0;
  await build({entryPoints:['server/context-read.ts','server/git-state.ts'],outdir:path.join(root,'candidate'),bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'}});
  const {readContext}=await import(pathToFileURL(path.join(root,'candidate/context-read.mjs')).href);
  const {inspect,requireUnchanged,git}=await import(pathToFileURL(path.join(root,'candidate/git-state.mjs')).href);
  await git(cwd,'init','--initial-branch=main');await git(cwd,'config','user.name','Fixture');await git(cwd,'config','user.email','fixture@example.invalid');
  await writeFile(path.join(cwd,'tracked.txt'),'synthetic');await git(cwd,'add','.');await git(cwd,'commit','-m','test: synthetic collector fixture');
  const plugin=path.join(root,'plugin');await mkdir(plugin);
  await writeFile(path.join(plugin,'paseo-plugin.json'),JSON.stringify({id:'collector-proof',requirements:{paseo:version}}));
  await build({entryPoints:['proof/collector-plugin.ts'],outfile:path.join(plugin,'index.server.ts'),bundle:true,platform:'node',format:'esm',external:['@getpaseo/plugin','@getpaseo/plugin/*','zod']});
  const historyEvents=[{type:'timeline',provider:'codex',item:{type:'user_message',text:'SYNTHETIC_PERSISTED'},timestamp:'2020-01-01T00:00:00.000Z'}];
  const d=await createPaseoDaemon({paseoHome:home,listen:'127.0.0.1:0',corsAllowedOrigins:[],mcpEnabled:false,staticDir:cwd,agentStoragePath:path.join(home,'agents'),relayEnabled:false,appBaseUrl:'https://app.paseo.sh',voiceLlmProvider:null,pluginsEnabled:true,resumeOnStartup:false,agentClients:createTestAgentClients({historyEvents,onStartTurn:()=>turns++})},pino({level:'silent'}),{builtinPlugins:new BuiltinPluginLoader(undefined,[])});
  let api,oracle,cleanup;
  try {
    await d.start(); const url='ws://127.0.0.1:'+d.getListenTarget().port+'/ws';
    api=createPaseoClient({url,capabilities:{plugin_timeline_items:true,timeline_notifications:true,reasoning_merge_enum:true}});await api.connect();oracle=new DaemonClient({url,clientId:'collector-proof'});await oracle.connect();
    await oracle.installDirectoryPlugin(plugin);
    const agent=await api.agents.create({cwd,config:{provider:'codex/gpt-5.4-mini'},title:'collector-only-fixture'});
    await agent.timeline.refetch({direction:'tail',limit:0});
    await d.agentManager.appendTimelineItem(agent.id,{type:'user_message',text:'SYNTHETIC_USER'});
    await d.agentManager.appendTimelineItem(agent.id,{type:'plugin',id:'ephemeral',pluginId:'fixture',kind:'fixture',version:1,data:{synthetic:true}});
    const before=(await agent.refresh()).agent;
    const beforePage=await agent.timeline.refetch({direction:'tail',limit:0});
    assert.deepEqual(beforePage.entries.map(r=>r.item.type),['user_message','plugin']);
    const beforeFork=await oracle.buildAgentForkContext(agent.id);
    cleanup=createIdleRuntimeCleanup({enabled:true,runtimes:()=>d.agentManager.getRuntimeCleanupCandidates(),logger:pino({level:'silent'}),now:()=>Date.now()+2*60*60*1000,schedule:()=>()=>{}});
    const collected=await cleanup.sweep();assert.equal(collected.collected.length,1);
    const closed=(await agent.refresh()).agent;assert.equal(closed.status,'closed');
    const reopenedPage=await agent.timeline.refetch({direction:'tail',limit:0});
    const reopened=(await agent.refresh()).agent;
    const reopenedFork=await oracle.buildAgentForkContext(agent.id);
    assert.equal(reopened.status,'idle');assert.equal(turns,0);
    const pick=a=>({status:a.status,updatedAt:a.updatedAt,lastUserMessageAt:a.lastUserMessageAt,persistence:a.persistence});
    const result={version,root,before:pick(before),closed:pick(closed),reopened:pick(reopened),epochUnchanged:beforePage.epoch===reopenedPage.epoch,rowsUnchanged:JSON.stringify(beforePage.entries)===JSON.stringify(reopenedPage.entries),contextUnchanged:JSON.stringify(beforeFork.attachment)===JSON.stringify(reopenedFork.attachment),counts:[beforeFork.itemCount,reopenedFork.itemCount],providerTurns:turns,agents:(await api.agents.list()).entries.length};
    assert(result.epochUnchanged&&result.rowsUnchanged&&result.contextUnchanged);assert.deepEqual(result.counts,[2,2]);assert.equal(result.agents,1);
    const stable=a=>({...pick(a),status:undefined});assert.deepEqual(stable(before),stable(closed));assert.deepEqual(stable(before),stable(reopened));
    const opens=async()=>(await oracle.invokePluginRpc('collector-proof','hook',{})).opens;
    assert.equal(await opens(),2,'create plus one real resume hook');
    const reviewed=await inspect(cwd);
    const capture=await readContext(agent,curate);assert.deepEqual(capture.result.attachment,reopenedFork.attachment);assert.equal(capture.result.itemCount,2);
    await cleanup.sweep();await capture.revalidate();assert.equal(await opens(),3);
    // Collection after a successful full page but before the final metadata refresh.
    const wrapped={id:agent.id,refresh:()=>agent.refresh(),timeline:{refetch:async options=>{const page=await agent.timeline.refetch(options);await cleanup.sweep();return page;}}};
    const racing=await readContext(wrapped,curate);await racing.revalidate();assert.equal((await agent.refresh()).agent.status,'closed');
    assert.deepEqual(racing.result,capture.result);
    // A manual close has no public collector-provenance token; it is saved inactivity too.
    await agent.timeline.refetch({direction:'tail',limit:0});await d.agentManager.closeAgent(agent.id);
    const manual=await readContext(agent,curate);assert.deepEqual(manual.result,capture.result);
    await cleanup.sweep();await oracle.invokePluginRpc('collector-proof','hook',{action:'mutate'});
    await capture.revalidate();
    const changed=await inspect(cwd);assert.throws(()=>requireUnchanged(reviewed,changed),/changed/);
    await cleanup.sweep();await oracle.invokePluginRpc('collector-proof','hook',{action:'fail'});
    await assert.rejects(capture.revalidate(),/incomplete|hook|failed/i);
    assert.equal(turns,0);assert.equal((await api.agents.list()).entries.length,1);
    assert.equal(await opens(),8,'one bounded open per read that encountered a collected runtime; no keepalive loop');
    result.regressions={closedBeforeRead:true,collectedAfterRead:true,collectedBeforeRevalidation:true,manualClose:true,resumeHookMutationCaught:true,resumeHookFailureRejected:true,providerTurns:turns,destinationAgents:0,opens:await opens()};
    await writeFile(path.resolve('proof',version,'collector.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
  } finally {await cleanup?.close();await api?.close();await oracle?.close();await d.stop();await d.agentManager.flush();}
  process.exit(0);
}
