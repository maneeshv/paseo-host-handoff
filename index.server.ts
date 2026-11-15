import { defineAgentTool, type PluginServerContext } from '@getpaseo/plugin/server';
import { z } from 'zod';
import { discover, preview, inspectSource, reopenSource, start, status, cancel, listOperations, previewInput, startInput } from '@shared/contracts';
import { HandoffService } from '@server/service';
import type { PaseoApi, PaseoAgentTimelineSubscription } from '@getpaseo/client';
import { queue, queueInput } from '@shared/contracts';
import {pullDiscover,pullReview,pullStart,pullSelection,pullStartInput,pullRecover,pullRecoverInput} from '@shared/pull';
import {PullService} from '@server/pull-service';

export default function contribute(server: PluginServerContext) {
  const service = new HandoffService();
  const pulls=new PullService(service);
  const check=async(paseo:PaseoApi,id:string)=>(await service.status(id))?.direction==='pull'?pulls.check(paseo,id):service.check(paseo,id);
  server.handle(pullDiscover,(_, {paseo})=>pulls.discover(paseo));
  server.handle(pullReview,(input,{paseo})=>pulls.review(paseo,input));
  server.handle(pullStart,(input,{paseo})=>pulls.start(paseo,input));
  server.handle(pullRecover,(input,{paseo})=>pulls.recover(paseo,input));
  let timer:ReturnType<typeof setTimeout>|undefined,stopped=false;
  const watches=new Map<string,PaseoAgentTimelineSubscription>();
  const syncWatches=async(paseo:PaseoApi)=>{
    const queued=(await service.operations(undefined,0)).filter(o=>o.state==='queued');
    const ids=new Set(queued.map(o=>o.agentId));
    for(const [id,unsubscribe] of watches) if(!ids.has(id)) {unsubscribe();watches.delete(id);}
    for(const id of ids) if(!watches.has(id)&&!stopped) {
      const unsubscribe=paseo.agents.ref(id).timeline.subscribe(event=>{
        if(['turn_completed','turn_failed','turn_canceled','attention_required','subscription_restored'].includes(event.event.type)) wake(paseo);
      });
      watches.set(id,unsubscribe);void unsubscribe.ready.catch(()=>{watches.delete(id);});
    }
  };
  const wake=(paseo:PaseoApi)=>{
    if(stopped||timer) return;
    timer=setTimeout(()=>{timer=undefined;void service.processQueues(paseo).then(()=>syncWatches(paseo)).catch(()=>console.error('Handoff queue needs review; reopen the panel.'));},100);
  };
  // On reload, the first ordinary host interaction restores watchers and reconciles disk records.
  // No provider session is opened, and no background connection/authentication is invented.
  server.handle(discover, (input, {paseo}) => {wake(paseo);return service.discover(paseo,input.agentId);});
  server.handle(preview, (input, {paseo}) => service.preview(paseo, input));
  server.handle(inspectSource, (input, {paseo}) => service.inspectSource(paseo, input.agentId));
  server.handle(reopenSource,(input,{paseo})=>service.reopenSource(paseo,input.agentId));
  server.handle(start, (input, {paseo}) => service.start(paseo, input));
  server.handle(status, (input,{paseo}) => check(paseo,input.operationId));
  server.handle(cancel, input => service.cancel(input.operationId));
  server.handle(listOperations, (input,{paseo}) => {wake(paseo);return service.operations(input.agentId);});
  server.handle(queue,async(input,{paseo})=>{const op=await service.queue(paseo,input);wake(paseo);return op;});
  const discoverTool = defineAgentTool({name: 'handoff_discover', description: 'Discover registered handoff hosts and source agents. Online does not imply SSH readiness. Read-only.', input: z.object({}).strict(),
    async execute(_, {paseo}) {wake(paseo);return {structuredContent: await service.discover(paseo)};}});
  const previewTool = defineAgentTool({name: 'handoff_preview', description: 'Resolve handoff project using the same resolver as the UI. Missing/ambiguous matches require explicit project selection. No remote writes.', input: previewInput.omit({agentId: true}),
    async execute(input, {paseo, agent}) {return {structuredContent: await service.preview(paseo, {...input, agentId: agent.id})};}});
  const inspectTool = defineAgentTool({name: 'handoff_inspect', description: 'Review local Git files and curated chat counts for an inactive agent, including a safely saved closed Codex source on verified releases. Reading saved history may reopen normal provider/MCP runtimes and run session-open hooks, without sending a prompt. The current running agent cannot snapshot itself. Raw chat is transient; this returns counts, not conversation text, and writes no remote files.', input: z.object({agentId: z.string().min(1)}).strict(),
    async execute(input, {paseo}) {return {structuredContent: await service.inspectSource(paseo, input.agentId)};}});
  const reopenTool=defineAgentTool({name:'handoff_reopen',description:'On explicit user request, reopen this safely saved closed Codex agent through public history loading. Runs normal session-open hooks and provider/MCP runtime but sends no prompt. Paseo may close it again. Does not start a handoff. Running/archived/permission/error sources are rejected.',input:z.object({agentId:z.string().min(1)}).strict(),
    async execute(input,{paseo}) {return {structuredContent:await service.reopenSource(paseo,input.agentId)};}});
  const startTool = defineAgentTool({name: 'handoff_start', description: 'Initiate a reviewed inactive-source handoff only on an explicit user request naming the resolved host/project. Saved closed Codex history may be reopened through normal session-open hooks/provider/MCP runtime without a source prompt. Snapshot continuation is not exclusive ownership; do not start new source work during transfer. A running agent handing itself off must use handoff_queue. Reuse operationId; never retry with new IDs.', input: startInput,
    async execute(input, {paseo}) {return {structuredContent: await service.start(paseo, input)};}});
  const queueTool=defineAgentTool({name:'handoff_queue',description:'On explicit user request naming this resolved host/project, queue your own handoff after this successful turn. Stop editing after queueing. Files and chat are checked once idle. Unknown versions or missing approved SSH binding reject immediately. A new prompt cancels. No transfer if a choice or secret exclusion needs review.',input:queueInput.omit({agentId:true}),
    async execute(input,{paseo,agent}) {const op=await service.queue(paseo,{...input,agentId:agent.id});wake(paseo);return {structuredContent:op};}});
  const statusTool = defineAgentTool({name: 'handoff_status', description: 'Read an operation receipt. Unverified is not success; do not blindly recreate a destination.', input: z.object({operationId: z.string().uuid()}).strict(),
    async execute(input,{paseo}) {return {structuredContent: await check(paseo,input.operationId)};}});
  const pullDiscoverTool=defineAgentTool({name:'handoff_return_discover',description:'Discover completed outbound handoffs that this local coordinator can bring back using existing outbound SSH. Reads source metadata, not history. Does not unarchive or transfer.',input:z.object({}).strict(),async execute(_,{paseo}){return {structuredContent:await pulls.discover(paseo)};}});
  const pullReviewTool=defineAgentTool({name:'handoff_return_review',description:'On request, check a completed outbound continuation for return into this coordinator. Source-side history reading may resume normal provider/MCP/hooks, without a prompt. Only curated chat leaves source. Archived/busy sources and original checkout divergence block.',input:pullSelection,async execute(input,{paseo}){return {structuredContent:await pulls.review(paseo,input)};}});
  const pullStartTool=defineAgentTool({name:'handoff_return_start',description:'On explicit user authorization, bring the reviewed continuation back to this local coordinator using outbound SSH. Separate new checkout, source/original retained. One return per outbound receipt. Reuse exact operationId on recovery; unknown creation never retries. No exclusive ownership or merge.',input:pullStartInput,async execute(input,{paseo}){return {structuredContent:await pulls.start(paseo,input)};}});
  const pullRecoverTool=defineAgentTool({name:'handoff_return_recover',description:'Explicitly retry a failed/unknown return only when no destination ID was allocated. Loads the original persisted reviewed request and same operation ID, rechecks source and original checkout. Never retries unknown agent creation.',input:pullRecoverInput,async execute(input,{paseo}){return {structuredContent:await pulls.recover(paseo,input)};}});
  const removes=[
    server.before('agent.session_open', ({request},{paseo}) => {wake(paseo);return {...request, tools: [...request.tools, discoverTool, previewTool, inspectTool, reopenTool,startTool, queueTool,statusTool,pullDiscoverTool,pullReviewTool,pullStartTool,pullRecoverTool]};}),
    server.addHook('agent.turn.before',async(event,{paseo})=>{await service.recordTurn(event.agent.id,event.turnId);wake(paseo);}),
    server.addHook('agent.turn.after',async(event,{paseo})=>{await service.recordTurn(event.agent.id,event.turnId,event.outcome.kind);wake(paseo);}),
    server.addHook('agent.permission.after',async(_event,{paseo})=>{wake(paseo);}),
  ];
  return ()=>{stopped=true;if(timer)clearTimeout(timer);for(const stop of watches.values())stop();for(const remove of removes)remove();};
}
