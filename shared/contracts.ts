import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const projectSchema = z.object({id: z.string(), key: z.string(), name: z.string(), path: z.string()});
export type Project = z.infer<typeof projectSchema>;
export const hostSchema = z.object({id: z.string(), label: z.string(), status: z.string(), transport: z.string(), sshEligible: z.boolean()});
export const discoverOutput = z.object({
  selfId: z.string(), selfLabel: z.string(), hosts: z.array(hostSchema),
  agents: z.array(z.object({id: z.string(), title: z.string(), cwd: z.string(), status: z.string(),updatedAt:z.string(),canReopen:z.boolean(),savedSource:z.boolean()})),
  forkApiAvailable: z.boolean(), blocker: z.string().nullable(), contextVersion:z.string().nullable(),
});
export const discover = defineRpc({name: 'handoff.discover', input: z.object({agentId:z.string().optional()}).strict(), output: discoverOutput});
export const previewInput = z.object({agentId: z.string().min(1), hostId: z.string().min(1), projectId: z.string().optional(), remember: z.boolean().default(false)}).strict();
export const previewOutput = z.object({
  agentId: z.string(), sourceTitle: z.string(), sourceCwd: z.string(), sourceStatus: z.string(),
  hostId: z.string(), projectKey: z.string().nullable(), candidates: z.array(projectSchema),
  selected: projectSchema.nullable(), match: z.enum(['remembered', 'exact', 'selected', 'ambiguous', 'missing']),
  blockers: z.array(z.string()), forkApiAvailable: z.boolean(),
  destinationRoot: z.string().nullable(),
});
export const preview = defineRpc({name: 'handoff.preview', input: previewInput, output: previewOutput});
export const manifestSchema = z.object({
  root: z.string(), relativeCwd: z.string(), head: z.string(), fingerprint: z.string(), bytes: z.number(),
  counts: z.object({staged: z.number(), unstaged: z.number(), untracked: z.number()}),
  files: z.array(z.object({path: z.string(), hash: z.string(), size: z.number(), mode: z.number(), linkTarget:z.string().optional()})),
  ignored: z.array(z.string()),
  context:z.object({itemCount:z.number(),characters:z.number(),truncated:z.boolean(),version:z.string()}).optional(),
});
export const inspectSource = defineRpc({name: 'handoff.inspect', input: z.object({agentId: z.string().min(1)}).strict(), output: manifestSchema});
export const reopenSource = defineRpc({name:'handoff.reopen',input:z.object({agentId:z.string().min(1)}).strict(),output:z.object({message:z.string()})});
export const operationSchema = z.object({
  id: z.string(), agentId: z.string(), hostId: z.string(), createdAt: z.string(), updatedAt: z.string(),
  state: z.enum(['queued','needs_review','blocked', 'canceled', 'checking', 'capturing', 'restoring', 'verifying', 'activating', 'ready', 'failed', 'unverified']),
  stage: z.string(), message: z.string(), destinationAgentId: z.string().optional(), destinationWorkspaceId: z.string().optional(),
  requestHash: z.string().optional(),
  destinationCwd: z.string().optional(), sourceCwd: z.string().optional(), fingerprint: z.string().optional(),
  parentOperationId: z.string().optional(), contextCharacters: z.number().optional(),contextItems:z.number().optional(),contextVersion:z.string().optional(),
  direction:z.enum(['push','pull']).optional(),coordinatorId:z.string().optional(),sourceHostId:z.string().optional(),
});
export type Operation = z.infer<typeof operationSchema>;
export const startInput = z.object({operationId: z.string().uuid(), agentId: z.string().min(1), hostId: z.string().min(1), projectId: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true)}).strict();
export const start = defineRpc({name: 'handoff.start', input: startInput, output: operationSchema});
export const queueInput=startInput.omit({fingerprint:true});
export const queue=defineRpc({name:'handoff.queue',input:queueInput,output:operationSchema});
export const status = defineRpc({name: 'handoff.status', input: z.object({operationId: z.string().uuid()}).strict(), output: operationSchema.nullable()});
export const cancel = defineRpc({name: 'handoff.cancel', input: z.object({operationId: z.string().uuid()}).strict(), output: operationSchema});
export const listOperations = defineRpc({name: 'handoff.operations', input: z.object({agentId: z.string().optional()}).strict(), output: z.array(operationSchema)});
export type Preview = z.infer<typeof previewOutput>;
export type Manifest = z.infer<typeof manifestSchema>;
