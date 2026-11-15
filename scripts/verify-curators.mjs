import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const require=createRequire(path.resolve('package.json'));
let checked=0;
for(const [version,name] of [['0.15.2','@getpaseo/server'],['0.15.4','paseo-server-0154']]) {
  const proof=JSON.parse(await readFile(`proof/${version}/result.json`,'utf8'));
  assert.equal(proof.failures.length,0);assert.equal(proof.cases.length,33);
  assert.equal(proof.cases.filter(c=>c.name.startsWith('saved-inactive/')).length,6);
  const collector=JSON.parse(await readFile(`proof/${version}/collector.json`,'utf8'));
  assert(collector.epochUnchanged&&collector.rowsUnchanged&&collector.contextUnchanged);
  assert.deepEqual(collector.counts,[2,2]);assert.equal(collector.agents,1);assert.equal(collector.providerTurns,0);
  assert(collector.regressions.collectedAfterRead&&collector.regressions.collectedBeforeRevalidation&&collector.regressions.resumeHookMutationCaught&&collector.regressions.resumeHookFailureRejected);
  const helper=require.resolve(name+'/agent-activity');
  const serverRoot=helper.slice(0,helper.indexOf('/dist/'));
  const local=createRequire(helper);
  const protocol=local.resolve('@getpaseo/protocol/tool-name-normalization');
  const protocolRoot=protocol.slice(0,protocol.indexOf('/dist/'));
  for(const entry of proof.closure) {
    const marker=entry.file.includes('/@getpaseo/server/')?'/@getpaseo/server/':entry.file.includes('/@getpaseo/protocol/')?'/@getpaseo/protocol/':null;
    if(!marker) continue;
    const file=path.join(marker.includes('/server/')?serverRoot:protocolRoot,entry.file.split(marker)[1]);
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),entry.sha256,`Unproven curator dependency: ${file}`);checked++;
  }
}
const destinationProof=JSON.parse(await readFile('proof/0.15.2/destination-0.15.0.json','utf8'));
assert.equal(destinationProof.failures.length,0);assert.equal(destinationProof.destinationVersion,'0.15.0');
assert(destinationProof.cases.some(c=>c.name==='routed-create/lost-reply-reconcile'&&c.contextKind==='chat_history'&&c.contextUnchanged&&c.contextBeforePrompt&&c.agents===1));
console.log(`Verified ${checked} bundled curator dependency files against stock runtime proof.`);
