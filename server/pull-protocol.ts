import {z} from 'zod';
import {bindingSchema} from '@server/transport';
import {manifestSchema} from '@shared/contracts';
import type {Package} from '@server/git-state';

export const pullRequestSchema=z.object({action:z.enum(['review','capture','validate']),binding:bindingSchema,agentId:z.string().uuid(),cwd:z.string().startsWith('/'),operationId:z.string().uuid(),reviewHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export type PullRequest=z.infer<typeof pullRequestSchema>;
export const pullExportSchema=z.object({
  reviewHash:z.string().regex(/^[a-f0-9]{64}$/),manifest:manifestSchema,
  source:z.object({id:z.string(),cwd:z.string(),title:z.string().nullable(),provider:z.string(),model:z.string().nullable(),modeId:z.string().nullable(),thinkingOptionId:z.string().nullable(),features:z.array(z.object({id:z.string(),value:z.unknown()}))}).strict(),
  context:z.object({attachment:z.object({type:z.literal('text'),mimeType:z.literal('text/plain'),contextKind:z.literal('chat_history'),title:z.string(),text:z.string().max(101000)}).strict(),itemCount:z.number().int().nonnegative(),boundaryCursor:z.null(),boundaryMessageId:z.null()}).strict(),
  package:z.custom<Package>(v=>typeof v==='object'&&v!==null).optional(),
}).strict();
export type PullExport=z.infer<typeof pullExportSchema>;
