// Synthetic proof plugin only. No real conversations, destinations, or file copies.
import { defineRpc } from '@getpaseo/plugin';
import { buildAgentForkContextAttachment } from '@getpaseo/server/agent-activity';
import { z } from 'zod';
import { readContext, reopenForCheck } from '@server/context-read';

const capture = defineRpc({name:'capture',input:z.object({agentId:z.string(),coldOracleOnly:z.boolean().optional(),fault:z.string().optional()}),output:z.unknown()});
const create = defineRpc({name:'create',input:z.object({hostId:z.string(),agentId:z.string(),cwd:z.string(),attachment:z.unknown()}),output:z.unknown()});
const reopen=defineRpc({name:'reopen',input:z.object({agentId:z.string()}),output:z.unknown()});
export default function contribute(server: any) {
  server.handle(reopen,async({agentId}:any,{paseo}:any)=>{await reopenForCheck(paseo.agents.ref(agentId));return {ok:true};});
  server.handle(capture, async ({agentId,coldOracleOnly,fault}: any, {paseo}: any) => {
    const agent = paseo.agents.ref(agentId);
    if(!coldOracleOnly) {
      let reads=0,refreshes=0;
      const wrapped={id:agent.id,refresh:async()=>{
        const snap=await agent.refresh();refreshes++;
        if(snap&&refreshes>1&&['id','cwd','status','updatedAt'].includes(fault)) snap.agent[fault]='CHANGED';
        return snap;
      },timeline:{refetch:async()=>{
        const page=await agent.timeline.refetch({direction:'tail',limit:0});reads++;
        if(['reset','staleCursor','gap','hasOlder','hasNewer'].includes(fault)) page[fault]=true;
        if(fault==='error') page.error='synthetic error';
        if(fault==='oversized-read') page.entries.push({...page.entries[0],item:{type:'assistant_message',text:'x'.repeat(9*1024*1024)}});
        if(reads>1&&fault==='epoch') page.epoch+='changed';
        if(reads>1&&fault==='end') page.window.nextSeq++;
        return page;
      }}};
      const capture=await readContext(wrapped as any,buildAgentForkContextAttachment);
      await capture.revalidate();
      return {result:capture.result};
    }
    const before = await agent.refresh();
    if (!before || before.agent.activeTurn) throw Error('Source not idle');
    const page = await agent.timeline.refetch({direction:'tail',limit:0});
    if (page.error || page.reset || page.staleCursor || page.gap || page.hasOlder || page.hasNewer) throw Error('Incomplete timeline');
    const after = await agent.refresh();
    if (!after || after.agent.status !== 'idle' || after.agent.activeTurn || after.agent.cwd !== before.agent.cwd || (!coldOracleOnly && after.agent.updatedAt !== before.agent.updatedAt)) throw Error('Source changed');
    const result = buildAgentForkContextAttachment({
      rows:page.entries.map((row: any) => ({...row,seq:row.seqEnd})),
      agentTitle:after.agent.title,cwd:after.agent.cwd,
    });
    return {result,epoch:page.epoch,window:page.window,rowCount:page.entries.length,types:page.entries.map((r:any)=>r.item.type)};
  });
  server.handle(create,async (input:any,{paseo}:any)=>{
    const remote=await paseo.hosts.client(input.hostId);
    try {
      const agent=await remote.agents.create({agentId:input.agentId,idempotencyKey:'synthetic:'+input.agentId,cwd:input.cwd,config:{provider:'codex/gpt-5.4-mini'},attachments:[input.attachment],prompt:'SYNTHETIC_CONTINUE'});
      return {agentId:agent.id};
    } finally {await remote.dispose();}
  });
  return () => {};
}
