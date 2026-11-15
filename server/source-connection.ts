import { createPaseoApi } from '@getpaseo/client';
import { createHostClient } from '@getpaseo/client/node';
import { readDaemonInstance, readLocalCredentialForTarget } from 'paseo-server-0154/daemon-control';
import {randomUUID} from 'node:crypto';

// Exported SDK composition, also used by the official CLI. Credentials never leave this process.
export async function connectSource(home: string, expectedHost: string) {
  const instance = await readDaemonInstance(home);
  if (!instance?.listen || !readLocalCredentialForTarget(home, instance.listen)) throw Error('Source local authentication is unavailable. Nothing captured.');
  const driver = createHostClient(instance.listen, {
    clientId:'handoff-capture-'+randomUUID(),
    localCredential: () => readLocalCredentialForTarget(home, instance.listen!) ?? undefined,
    reconnect: {enabled:false}, connectTimeoutMs:10000,
    capabilities:{plugin_timeline_items:true,timeline_notifications:true,reasoning_merge_enum:true},
    logger:{debug(){},info(){},warn(){},error(){}},
  });
  const api = createPaseoApi(driver);
  try {
    await driver.connect();
    if ((await api.hosts.list()).self.serverId !== expectedHost) throw Error('Source authenticated host identity differs from approved binding.');
    return {api,close:async()=>{await api.dispose();await driver.close();}};
  } catch (error) {await api.dispose();await driver.close();throw error;}
}
