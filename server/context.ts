import type { PaseoApi, PaseoAgentHandle } from '@getpaseo/client';
import { buildAgentForkContextAttachment as curate0152 } from '@getpaseo/server/agent-activity';
import { buildAgentForkContextAttachment as curate0154 } from 'paseo-server-0154/agent-activity';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readContext } from '@server/context-read';

const exec=promisify(execFile);
export const PROVEN_VERSIONS=['0.15.2','0.15.4'] as const;
const identitySchema=z.object({serverId:z.string().min(1),daemonVersion:z.string().min(1),workerPid:z.number().int().positive(),connectedDaemon:z.literal('reachable')});
export type DaemonIdentity=z.infer<typeof identitySchema>;
export function validateDaemonIdentity(value:unknown,serverId:string):DaemonIdentity {
  const identity=identitySchema.parse(value);
  if(identity.serverId!==serverId) throw Error('Source CLI targets a different Paseo host. Nothing changed.');
  if(!PROVEN_VERSIONS.some(v=>v===identity.daemonVersion)) throw Error(`Handoff unavailable on Paseo ${identity.daemonVersion}. Chat history has not been verified for this version. Preview still works. Nothing changed.`);
  return identity;
}
export async function sourceIdentity(paseo:PaseoApi):Promise<DaemonIdentity> {
  const self=(await paseo.hosts.list()).self.serverId;
  const home=process.env.PASEO_HOME??path.join(homedir(),'.paseo');
  let value:unknown;
  try {
    const {stdout}=await exec('paseo',['daemon','status','--home',home,'--json'],{timeout:10000,maxBuffer:1048576,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
    value=JSON.parse(stdout);
  } catch {throw Error('Cannot verify source Paseo version with the public CLI. Install the official paseo CLI on this daemon host and check its home. Preview still works.');}
  return validateDaemonIdentity(value,self);
}
export type ContextResult=ReturnType<typeof curate0152>;
export interface Contexts {
  compatibility(paseo:PaseoApi):Promise<{available:boolean;version:string|null;reason:string|null}>;
  capture(paseo:PaseoApi,handle:PaseoAgentHandle):Promise<{result:ContextResult;version:string;revalidate():Promise<void>}>;
}
export class ForkContexts implements Contexts {
  async compatibility(paseo:PaseoApi) {
    try {const identity=await sourceIdentity(paseo);return {available:true,version:identity.daemonVersion,reason:null};}
    catch(e) {return {available:false,version:null,reason:e instanceof Error?e.message:'Cannot verify source Paseo version'};}
  }
  async capture(paseo:PaseoApi,handle:PaseoAgentHandle) {
    const identity=await sourceIdentity(paseo);
    // No method-name detection: no released public forkContext capability has been proven yet.
    const curator=identity.daemonVersion==='0.15.2'?curate0152:curate0154;
    const capture=await readContext(handle,curator);
    return {...capture,version:identity.daemonVersion,revalidate:async()=>{
      const latest=await sourceIdentity(paseo);
      if(latest.workerPid!==identity.workerPid||latest.daemonVersion!==identity.daemonVersion||latest.serverId!==identity.serverId) throw Error('Source Paseo runtime changed. Review again; activation blocked.');
      await capture.revalidate();
    }};
  }
}
