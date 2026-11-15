import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const hook=defineRpc({name:'hook',input:z.object({action:z.enum(['none','mutate','fail']).optional()}),output:z.unknown()});
export default function contribute(server:any) {
  let action='none',opens=0;
  server.handle(hook,({action:next}:any)=>{if(next) action=next;return {opens};});
  server.before('agent.session_open',async({request}:any)=>{
    opens++;
    if(!request.cwd.startsWith('/private/tmp/handoff-collector-')) throw Error('Fixture home required');
    if(action==='fail') throw Error('Synthetic resume hook failure');
    if(action==='mutate') await writeFile(path.join(request.cwd,'hook-change.txt'),'synthetic hook mutation');
    return request;
  });
  return ()=>{};
}
