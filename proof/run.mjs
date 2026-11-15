// TEST HARNESS: internal native operation and fixture seeding are test-only oracles.
// Production candidate is proof/plugin.ts and uses only public imports/APIs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const version=process.argv[2];
const destinationVersion=process.argv[3]??version;
assert(['0.15.2','0.15.4'].includes(version));
const root=path.resolve('proof',version);
const require=createRequire(path.join(root,'package.json'));
const module=async name=>import(pathToFileURL(require.resolve(name)).href);
const {createPaseoDaemon}=await module('@getpaseo/server');
const serverRoot=path.dirname(require.resolve('@getpaseo/server'));
const internal=async file=>import(pathToFileURL(path.join(serverRoot,file)).href);
const {createTestAgentClients}=await internal('test-utils/fake-agent-client.js');
const {BuiltinPluginLoader}=await internal('plugins/builtin/index.js');
const {DaemonClient}=await module('@getpaseo/client/internal/daemon-client');
const {createPaseoClient}=await module('@getpaseo/client');
const {default:pino}=await module('pino');
const exec=promisify(execFile);
const runRoot=process.env.HANDOFF_PROOF_ROOT;
assert(runRoot?.startsWith('/private/tmp/handoff-stock-'),'Use proof/launch.mjs for isolated HOME and environment');
const plugin=path.join(runRoot,'plugin');
await mkdir(plugin);
await writeFile(path.join(plugin,'paseo-plugin.json'),JSON.stringify({id:'handoff-proof',requirements:{paseo:version}}));
const bundle=await build({entryPoints:['proof/plugin.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(plugin,'index.server.ts'),alias:{'@getpaseo/server/agent-activity':require.resolve('@getpaseo/server/agent-activity')},nodePaths:[path.join(root,'node_modules')],external:['@getpaseo/plugin','@getpaseo/plugin/*','zod'],metafile:true});
await writeFile(path.join(runRoot,'bundle-meta.json'),JSON.stringify(bundle.metafile,null,2));
const bundleBytes=await readFile(path.join(plugin,'index.server.ts'));
const evidence={version,runRoot,bundleBytes:bundleBytes.length,bundleSha256:createHash('sha256').update(bundleBytes).digest('hex'),cases:[],failures:[]};
evidence.closure=await Promise.all(Object.keys(bundle.metafile.inputs).map(async file=>({file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')})));
evidence.lockSha256=createHash('sha256').update(await readFile(path.join(root,'package-lock.json'))).digest('hex');
const active=[];
async function daemon(name,historyEvents) {
  const home=path.join(runRoot,name),cwd=path.join(home,'workspace');
  await mkdir(cwd,{recursive:true});
  const received=[];
  let factory=createPaseoDaemon,clients=createTestAgentClients,Loader=BuiltinPluginLoader;
  if(name==='destination'&&destinationVersion!==version) {
    const req=createRequire(path.resolve('proof',destinationVersion,'package.json'));
    const serverFile=req.resolve('@getpaseo/server');
    factory=(await import(pathToFileURL(serverFile).href)).createPaseoDaemon;
    clients=(await import(pathToFileURL(path.join(path.dirname(serverFile),'test-utils/fake-agent-client.js')).href)).createTestAgentClients;
    Loader=(await import(pathToFileURL(path.join(path.dirname(serverFile),'plugins/builtin/index.js')).href)).BuiltinPluginLoader;
  }
  const d=await factory({paseoHome:home,listen:'127.0.0.1:0',corsAllowedOrigins:[],hostnames:true,mcpEnabled:false,staticDir:cwd,agentStoragePath:path.join(home,'agents'),relayEnabled:false,appBaseUrl:'https://app.paseo.sh',voiceLlmProvider:null,pluginsEnabled:true,resumeOnStartup:false,agentClients:clients({historyEvents,onStartTurn:prompt=>received.push(prompt)})},pino({level:'silent'}),{builtinPlugins:new Loader(undefined,[])});
  await d.start();
  const url='ws://127.0.0.1:'+d.getListenTarget().port+'/ws';
  const oracle=new DaemonClient({url,clientId:'handoff-oracle-'+randomUUID()});await oracle.connect();
  const api=createPaseoClient({url});await api.connect();
  const state={d,api,oracle,cwd,home,url,received};active.push(state);
  return state;
}
async function close(a) {
  await a.api.close();await a.oracle.close();await a.d.stop();await a.d.agentManager.flush();
  active.splice(active.indexOf(a),1);
}
const fixtures={
  empty:[],
  merged:[{type:'user_message',messageId:'u1',text:'User part one '},{type:'user_message',messageId:'u1',text:'part two'},{type:'assistant_message',messageId:'a1',text:'Assistant part one '},{type:'assistant_message',messageId:'a1',text:'part two'}],
  exclusions:[{type:'user_message',text:'VISIBLE_USER'},{type:'reasoning',text:'EXCLUDED_REASONING_SENTINEL'},{type:'tool_call',callId:'mcp1',name:'mcp__external__lookup',status:'running',detail:{type:'unknown',input:{secret:'EXCLUDED_RAW_INPUT_SENTINEL'}}},{type:'tool_call',callId:'mcp1',name:'mcp__external__lookup',status:'completed',detail:{type:'unknown',input:{secret:'EXCLUDED_RAW_INPUT_SENTINEL'},output:{ok:true}}},{type:'assistant_message',text:'VISIBLE_ANSWER'}],
  counted:[{type:'plugin',id:'proof',pluginId:'handoff-proof',kind:'fixture',version:1,data:{synthetic:true}},{type:'notification',level:'info',message:'NON_TEXT_NOTIFICATION'},{type:'error',message:'SYNTHETIC_ERROR'},{type:'compaction',status:'completed'},{type:'assistant_message',text:'After compaction'}],
  truncation:Array.from({length:16},(_,i)=>({type:i%2?'assistant_message':'user_message',messageId:'long-'+i,text:'segment-'+i+' '+('x'.repeat(9000))})),
  oversized:[{type:'user_message',text:'OLD_MESSAGE'},{type:'assistant_message',text:'z'.repeat(150000)}],
};
async function compare(state,name,agent,coldOracleOnly=false,expectedCold) {
  const candidate=await state.oracle.invokePluginRpc('handoff-proof','capture',{agentId:agent.id,coldOracleOnly});
  const native=await state.oracle.buildAgentForkContext(agent.id);
  assert.equal(native.error,null);
  const expected=expectedCold??{attachment:native.attachment,itemCount:native.itemCount,boundaryCursor:native.boundaryCursor,boundaryMessageId:native.boundaryMessageId};
  assert.deepEqual(candidate.result,expected,name);
  assert.equal(candidate.result.boundaryCursor,null);assert.equal(candidate.result.boundaryMessageId,null);
  assert(!candidate.result.attachment.text.includes('EXCLUDED_REASONING_SENTINEL'));
  assert(!candidate.result.attachment.text.includes('EXCLUDED_RAW_INPUT_SENTINEL'));
  const result={name,itemCount:native.itemCount,characters:native.attachment.text.length,sha256:createHash('sha256').update(JSON.stringify(expected)).digest('hex')};
  evidence.cases.push(result);console.log('PASS',JSON.stringify(result));return expected;
}
try {
  const source=await daemon('source');
  assert.equal(source.oracle.getLastServerInfoMessage().version,version);
  const cliPackage=JSON.parse(await readFile(path.join(root,'node_modules/@getpaseo/cli/package.json'),'utf8'));
  const cli=path.join(root,'node_modules/@getpaseo/cli',cliPackage.bin.paseo);
  const cliResult=JSON.parse((await exec(process.execPath,[cli,'daemon','status','--host',source.url,'--json'],{env:process.env,timeout:10000})).stdout);
  const status=cliResult.data??cliResult;
  assert.equal(status.connectedDaemon,'reachable');assert.equal(status.daemonVersion,version);assert.equal(status.serverId,(await source.api.hosts.list()).self.serverId);
  evidence.versionSource={kind:'public-cli-live-status',version:status.daemonVersion,workerPidPresent:typeof status.workerPid==='number',identityMatches:true};
  await source.oracle.installDirectoryPlugin(plugin);
  let transfer;
  for(const [name,items] of Object.entries(fixtures)) {
    const agent=await source.api.agents.create({cwd:source.cwd,config:{provider:'codex/gpt-5.4-mini'},title:name});
    for(const item of items) await source.d.agentManager.appendTimelineItem(agent.id,item);
    transfer=await compare(source,'loaded/'+name,agent);
  }
  for(const [name,items] of Object.entries(fixtures)) {
    const events=items.map((item,index)=>({type:'timeline',provider:'codex',item,turnId:'synthetic-turn',timestamp:new Date(1700000000000+index).toISOString()}));
    let cold=await daemon('cold-'+name,events);
    const agent=await cold.api.agents.create({cwd:cold.cwd,title:'cold-'+name,config:{provider:'codex/gpt-5.4-mini'}});
    await close(cold);
    cold=await daemon('cold-'+name,events);
    assert.equal(cold.d.agentManager.getAgent(agent.id),null,'must be cold before API read');
    const coldNative=await cold.oracle.buildAgentForkContext(agent.id);
    assert.equal(coldNative.error,null);
    const expectedCold={attachment:coldNative.attachment,itemCount:coldNative.itemCount,boundaryCursor:coldNative.boundaryCursor,boundaryMessageId:coldNative.boundaryMessageId};
    assert.equal((await cold.api.agents.ref(agent.id).refresh()).agent.status,'idle');
    await close(cold);
    cold=await daemon('cold-'+name,events);
    assert.equal(cold.d.agentManager.getAgent(agent.id),null,'candidate must independently start cold');
    await cold.oracle.installDirectoryPlugin(plugin);
    const context=await compare(cold,'saved-inactive/'+name,agent,false,expectedCold);
    assert.equal((await cold.api.agents.ref(agent.id).refresh()).agent.status,'idle');
    if(items.length) assert(context.itemCount>0,'cold fixture must not disappear');
    await close(cold);
    cold=await daemon('cold-'+name,events);
    assert.equal(cold.d.agentManager.getAgent(agent.id),null,'explicit preparation independently starts cold');
    await cold.oracle.installDirectoryPlugin(plugin);
    await cold.oracle.invokePluginRpc('handoff-proof','reopen',{agentId:agent.id});
    assert.equal((await cold.api.agents.ref(agent.id).refresh()).agent.status,'idle');
    await compare(cold,'explicit-reopen/'+name,agent,false,expectedCold);
    assert.equal(cold.received.length,0,'reopening must never start a provider turn');
    assert.equal((await cold.api.agents.list()).entries.length,1,'no destination created by reopening');
    await close(cold);
  }
  const destination=await daemon('destination');
  assert.equal(destination.oracle.getLastServerInfoMessage().version,destinationVersion);
  evidence.destinationVersion=destinationVersion;
  evidence.destinationLockSha256=createHash('sha256').update(await readFile(path.resolve('proof',destinationVersion,'package-lock.json'))).digest('hex');
  const faultAgent=await source.api.agents.create({cwd:source.cwd,config:{provider:'codex/gpt-5.4-mini'},title:'Fault injection'});
  await source.d.agentManager.appendTimelineItem(faultAgent.id,{type:'user_message',text:'Synthetic fault test'});
  for(const fault of ['reset','staleCursor','gap','hasOlder','hasNewer','error','oversized-read','id','cwd','status','updatedAt','epoch','end']) {
    await assert.rejects(source.oracle.invokePluginRpc('handoff-proof','capture',{agentId:faultAgent.id,fault}),/incomplete|limit|changed|idle/);
    assert.equal((await destination.api.agents.list()).entries.length,0);
    evidence.cases.push({name:'guard/'+fault,rejected:true,destinations:0});
  }
  let finish;
  const blockedTurn=new Promise(resolve=>{finish=resolve;});
  source.d.agentManager.registerClient('codex',createTestAgentClients({beforeTurnComplete:()=>blockedTurn}).codex);
  const running=await source.api.agents.create({cwd:source.cwd,config:{provider:'codex/gpt-5.4-mini'},prompt:'Synthetic in-flight guard'});
  try {
    const until=Date.now()+10000;
    while((await running.refresh()).agent.status!=='running') {assert(Date.now()<until);await new Promise(r=>setTimeout(r,20));}
    await assert.rejects(source.oracle.invokePluginRpc('handoff-proof','capture',{agentId:running.id}),/idle/);
    assert.equal((await destination.api.agents.list()).entries.length,0);
    evidence.cases.push({name:'guard/real-synthetic-inflight',rejected:true,destinations:0});
  } finally {finish();await running.waitForFinish(10000);}
  const destinationId=destination.d.getServerId();
  await source.api.hosts.add({connection:destination.url,label:'Synthetic destination'});
  const until=Date.now()+10000;
  while(!(await source.api.hosts.list()).hosts.some(h=>h.serverId===destinationId&&h.status==='online')) {
    assert(Date.now()<until,'route did not become ready');await new Promise(r=>setTimeout(r,30));
  }
  const agentId=randomUUID();
  assert.equal(transfer.attachment.contextKind,'chat_history');
  assert.equal(transfer.attachment.type,'text');
  // Lose the successful create reply at the caller boundary; recover by fixed identity,
  // never issue another create. This is reply-loss simulation, not a physical network test.
  await source.oracle.invokePluginRpc('handoff-proof','create',{hostId:destinationId,agentId,cwd:destination.cwd,attachment:transfer.attachment});
  const remote=await source.api.hosts.client(destinationId);
  const recovered=await remote.agents.ref(agentId).refresh();assert.equal(recovered.agent.id,agentId);
  await remote.agents.ref(agentId).waitForFinish(10000);
  const list=await remote.agents.list();assert.equal(list.entries.filter(e=>e.agent.id===agentId).length,1);
  assert.equal(destination.received.length,1);
  const serialized=JSON.stringify(destination.received[0]);
  assert(serialized.includes(JSON.stringify(transfer.attachment.text).slice(1,-1)),'curated attachment unchanged at provider');
  assert(serialized.indexOf('chat-history-summary')<serialized.indexOf('SYNTHETIC_CONTINUE'),'context must precede prompt');
  evidence.cases.push({name:'routed-create/lost-reply-reconcile',destinationVersion,agents:1,providerTurns:1,contextKind:'chat_history',contextUnchanged:true,contextBeforePrompt:true});
  await remote.dispose();
  evidence.nativeVersion=source.oracle.getLastServerInfoMessage().version;
  evidence.partial=false;
} catch(error) {evidence.failures.push(String(error.stack??error));console.error(error);process.exitCode=1;}
finally {
  for(const a of active.reverse()) {await a.api.close().catch(()=>{});await a.oracle.close().catch(()=>{});await a.d.stop().catch(()=>{});await a.d.agentManager.flush().catch(()=>{});}
  const resultFile=destinationVersion===version?'result.json':'destination-'+destinationVersion+'.json';
  await writeFile(path.join(root,resultFile),JSON.stringify(evidence,null,2));
  console.log('Evidence:',path.join(root,resultFile));
}
process.exit(process.exitCode??0);
