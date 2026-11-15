import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoAgentHandle } from '@getpaseo/client';
import { reopenForCheck } from '@server/context-read';

const saved={id:'a',status:'closed',cwd:'/fixture',provider:'codex',model:'test',title:'fixture',updatedAt:'old',lastUserMessageAt:'old',pendingPermissions:[],archivedAt:null,persistence:{provider:'codex',sessionId:'saved'}};
const page={agentId:'a',projection:'projected',direction:'tail',epoch:'one',reset:false,staleCursor:false,gap:false,hasOlder:false,hasNewer:false,entries:[]};
function fixture(before:unknown=saved,after:unknown={...saved,status:'idle',updatedAt:'hydrated'},fault={}) {
  let reads=0,refreshes=0;
  const handle={id:'a',refresh:async()=>({agent:++refreshes===1?before:after}),timeline:{refetch:async()=>{reads++;return {...page,...fault};}},reload:()=>{throw Error('must not reload');},send:()=>{throw Error('must not prompt');}} as unknown as PaseoAgentHandle;
  return {handle,reads:()=>reads};
}
test('explicit reopen accepts only closed saved sources and never calls send/reload',async()=>{
  const f=fixture();await reopenForCheck(f.handle);assert.equal(f.reads(),1);
  for(const patch of [{status:'running'},{status:'idle'},{activeTurn:{turnId:'t'}},{pendingPermissions:[{}]},{archivedAt:'yes'},{persistence:null}]) {
    const f=fixture({...saved,...patch});await assert.rejects(reopenForCheck(f.handle),/Only a closed/);assert.equal(f.reads(),0);
  }
});
test('reopen rejects post-load busy, changed identity/session/message or incomplete history',async()=>{
  for(const patch of [{status:'running'},{cwd:'/other'},{id:'b'},{activeTurn:{}},{pendingPermissions:[{}]},{archivedAt:'yes'},{lastUserMessageAt:'new prompt'},{persistence:{provider:'codex',sessionId:'different'}}]) {
    const f=fixture(saved,{...saved,status:'idle',...patch});await assert.rejects(reopenForCheck(f.handle));
  }
  for(const key of ['reset','staleCursor','gap','hasOlder','hasNewer','error']) {
    const f=fixture(saved,{...saved,status:'idle'},{[key]:true});await assert.rejects(reopenForCheck(f.handle),/incomplete/);
  }
});
