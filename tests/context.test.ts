import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDaemonIdentity } from '@server/context';
test('only proven exact live source releases with matching identity and worker qualify',()=>{
  const status={serverId:'source',daemonVersion:'0.15.2',workerPid:123,connectedDaemon:'reachable'};
  assert.equal(validateDaemonIdentity(status,'source').daemonVersion,'0.15.2');
  assert.equal(validateDaemonIdentity({...status,daemonVersion:'0.15.4'},'source').daemonVersion,'0.15.4');
  for(const daemonVersion of ['0.15.3','0.15.4-beta.1','0.16.0','v0.15.2','0.15.2+custom','latest']) assert.throws(()=>validateDaemonIdentity({...status,daemonVersion},'source'));
  for(const patch of [{connectedDaemon:'unreachable'},{serverId:'other'},{workerPid:undefined},{daemonVersion:undefined}]) assert.throws(()=>validateDaemonIdentity({...status,...patch},'source'));
});
