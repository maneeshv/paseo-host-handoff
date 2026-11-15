import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import type { Package } from '@server/git-state';
import { helperSource } from '@server/generated-helper';

const absolute = z.string().startsWith('/').refine(p => p !== '/' && path.posix.normalize(p) === p && !/[\x00-\x1f\x7f]/.test(p));
export const bindingSchema = z.object({
  hostId: z.string().min(1), sshTarget: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/),
  node: absolute, paseo: absolute, home: absolute, root: absolute,
  approved: z.literal(true),
}).strict();
export type Binding = z.infer<typeof bindingSchema>;
export interface RemoteRequest {
  action: 'check' | 'restore' | 'status'; binding: Binding; projectPath: string;
  operationId: string; fingerprint: string; package?: Package;
  returnGuard?: {cwd: string; fingerprint: string};
}
export interface RemoteResult {state: 'absent' | 'ready' | 'failed' | 'unverified'; cwd: string; fingerprint?: string; message: string}
export interface Transport {run(request: RemoteRequest): Promise<RemoteResult>}
export class ConnectionUnknown extends Error {}

// The payload travels only on stdin; neither repository bytes nor conversation enter argv.
const remoteResultSchema=z.object({state:z.enum(['absent','ready','failed','unverified']),cwd:z.string(),fingerprint:z.string().optional(),message:z.string()}).strict();
export function runProcess<T=RemoteResult>(command: string, args: string[], input: string, schema:z.ZodType<T>=remoteResultSchema as unknown as z.ZodType<T>, maxBytes=1048576): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['pipe','pipe','pipe'], env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8'}});
    const chunks:Buffer[]=[];let size = 0, done = false;
    const timer = setTimeout(() => { child.kill(); finish(new ConnectionUnknown('Connection timed out; outcome unknown. Check status before retrying.')); }, 180000);
    function finish(error?: Error, value?: T) {if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value!);}
    child.on('error', () => finish(new ConnectionUnknown('SSH/helper could not start. No automatic retry.')));
    child.stderr.resume(); // Never surface arbitrary SSH/Git stderr, which may contain private data.
    child.stdout.on('data', (chunk: Buffer) => {size += chunk.length; if (size > maxBytes) {child.kill(); finish(new ConnectionUnknown('Oversized helper response; check status.'));} else chunks.push(chunk);});
    child.on('close', code => {
      if (code !== 0) return finish(new ConnectionUnknown('SSH/helper disconnected; outcome unknown. Check status.'));
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString());
        if (response.ok !== true) return finish(new Error(typeof response.error === 'string' ? response.error : 'Remote check failed'));
        const result = schema.parse(response.result);
        finish(undefined, result);
      } catch {finish(new ConnectionUnknown('Invalid helper response; check status.'));}
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function sshArgs(binding: Binding, script: string): string[] {
  bindingSchema.parse(binding);
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  return ['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','ConnectTimeout=10', '--', binding.sshTarget,
    `${quote(binding.node)} -e ${quote(script)}`];
}
export class SshTransport implements Transport {
  async run(request: RemoteRequest): Promise<RemoteResult> {
    return runProcess('ssh', sshArgs(request.binding, helperSource), JSON.stringify(request));
  }
}
