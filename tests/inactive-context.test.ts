import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoAgentHandle } from '@getpaseo/client';
import { readContext } from '@server/context-read';

const saved={id:'a',status:'closed',cwd:'/fixture',provider:'codex',model:'fixture',title:'fixture',updatedAt:'old',lastUserMessageAt:'old',pendingPermissions:[],archivedAt:null,persistence:{provider:'codex',sessionId:'saved'}};
function fixture() {
  let source:any={...saved},reads=0;
  let page:any={agentId:'a',projection:'projected',direction:'tail',epoch:'one',reset:false,staleCursor:false,gap:false,hasOlder:false,hasNewer:false,entries:[],window:{nextSeq:0}};
  const handle={id:'a',refresh:async()=>({agent:{...source}}),timeline:{refetch:async()=>{reads++;return {...page};}}} as unknown as PaseoAgentHandle;
  return {handle,reads:()=>reads,set:(patch:any)=>{source={...source,...patch};},page:(patch:any)=>{page={...page,...patch};}};
}
test('saved inactive capture always rereads full history across idle/closed transitions',async()=>{
  const f=fixture();const captured=await readContext(f.handle,()=>({synthetic:true}));
  assert.equal(f.reads(),1);f.set({status:'idle'});await captured.revalidate();
  f.set({status:'closed'});await captured.revalidate();assert.equal(f.reads(),3);
});
test('inactive capture rejects unsafe states before history load and never rebases saved identity',async()=>{
  for(const patch of [{status:'running'},{status:'initializing'},{status:'error'},{lastError:'failed'},{providerUnavailable:true},{activeTurn:{}},{pendingPermissions:[{}]},{archivedAt:'now'},{persistence:null},{provider:'claude'}]) {
    const f=fixture();f.set(patch);await assert.rejects(readContext(f.handle,()=>null));assert.equal(f.reads(),0);
  }
  for(const patch of [{updatedAt:'new'},{lastUserMessageAt:'new'},{cwd:'/other'},{persistence:{provider:'codex',sessionId:'other'}},{status:'running'},{lastError:'failed'},{pendingPermissions:[{}]},{labels:{changed:'yes'}}]) {
    const f=fixture();const captured=await readContext(f.handle,()=>null);f.set(patch);await assert.rejects(captured.revalidate());
  }
  for(const patch of [{epoch:'new'},{window:{nextSeq:1}},{gap:true},{hasOlder:true},{error:'failed'}]) {
    const f=fixture();const captured=await readContext(f.handle,()=>null);f.page(patch);await assert.rejects(captured.revalidate());
  }
});
