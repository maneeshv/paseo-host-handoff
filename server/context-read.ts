import type { PaseoAgentHandle } from '@getpaseo/client';
import { createHash } from 'node:crypto';
import { sourceSignature } from '@server/source-state';

type Page = Awaited<ReturnType<PaseoAgentHandle['timeline']['refetch']>>;
type Snapshot = NonNullable<Awaited<ReturnType<PaseoAgentHandle['refresh']>>>['agent'];
export const MAX_CONTEXT_READ_BYTES = 8 * 1024 * 1024;

function identity(agent: Snapshot | undefined, id: string) {
  return sourceSignature(agent,id);
}
export function validateContextPage(page: Page, agentId: string) {
  if (page.error || page.agentId !== agentId || page.projection !== 'projected' || page.direction !== 'tail' || !page.epoch ||
      [page.reset,page.staleCursor,page.gap,page.hasOlder,page.hasNewer].some(value=>value!==false)) {
    throw Error('Chat history incomplete. Try again when the agent is idle. Nothing moved.');
  }
  const serialized=JSON.stringify([page.epoch,page.window,page.startCursor,page.endCursor,page.entries]);
  if (Buffer.byteLength(serialized)>MAX_CONTEXT_READ_BYTES) throw Error('Chat history exceeds the safe full-read limit. Nothing moved.');
  for(const row of page.entries) {
    if(!Number.isSafeInteger(row.seqStart)||!Number.isSafeInteger(row.seqEnd)||row.seqStart>row.seqEnd||
       !Array.isArray(row.sourceSeqRanges)||!Array.isArray(row.collapsed)) throw Error('Unsupported chat history row. Nothing moved.');
  }
  return createHash('sha256').update(serialized).digest('hex');
}
export function canReopenForCheck(agent:Snapshot|undefined,id:string):boolean {
  try {sourceSignature(agent,id);return agent?.status==='closed';} catch {return false;}
}
// Optional explicit preparation. User-invoked checks disclose that history reads can reopen it too.
export async function reopenForCheck(handle: PaseoAgentHandle) {
  const before=(await handle.refresh())?.agent;
  if (!canReopenForCheck(before,handle.id)) {
    throw Error('Only a closed, saved, non-archived agent with no pending permission can be reopened for checking. Nothing moved.');
  }
  const stable=(a:Snapshot)=>JSON.stringify([a.id,a.cwd,a.provider,a.model,a.title,a.lastUserMessageAt,a.persistence]);
  const signature=stable(before!);
  const page=await handle.timeline.refetch({direction:'tail',limit:0});
  validateContextPage(page,handle.id);
  const after=(await handle.refresh())?.agent;
  identity(after,handle.id);
  if(after?.status!=='idle') throw Error('Paseo closed the saved session again. Nothing moved.');
  if (stable(after!)!==signature) throw Error('Source changed while reopening. Check it before trying again. Nothing moved.');
}
// Raw rows live only in this call. Only the official curator output may leave the process.
export async function readContext<T>(handle: PaseoAgentHandle, curate: (input: {
  rows: (Page['entries'][number] & {seq:number})[]; agentTitle: string|null|undefined; cwd: string;
})=>T) {
  const before=await handle.refresh();
  const signature=identity(before?.agent,handle.id);
  const page=await handle.timeline.refetch({direction:'tail',limit:0});
  const fingerprint=validateContextPage(page,handle.id);
  if(identity((await handle.refresh())?.agent,handle.id)!==signature) throw Error('Source changed while reading chat history. Nothing moved.');
  const result=curate({rows:page.entries.map(row=>({...row,seq:row.seqEnd})),agentTitle:before!.agent.title,cwd:before!.agent.cwd});
  const revalidate=async()=>{
    if(identity((await handle.refresh())?.agent,handle.id)!==signature) throw Error('Source changed since chat review. Nothing moved.');
    const latest=await handle.timeline.refetch({direction:'tail',limit:0});
    if(validateContextPage(latest,handle.id)!==fingerprint || identity((await handle.refresh())?.agent,handle.id)!==signature) {
      throw Error('Source chat changed since review. Nothing moved.');
    }
  };
  return {result,revalidate,historyHash:fingerprint};
}
