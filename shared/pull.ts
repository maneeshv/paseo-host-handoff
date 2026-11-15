import {defineRpc} from '@getpaseo/plugin';
import {z} from 'zod';
import {manifestSchema,operationSchema} from '@shared/contracts';

export const pullSelection=z.object({coordinatorId:z.string().min(1),parentOperationId:z.string().uuid()}).strict();
export const pullReviewSchema=z.object({
  coordinatorId:z.string(),sourceHostId:z.string(),sourceAgentId:z.string(),sourceTitle:z.string(),sourceCwd:z.string(),
  destinationHostId:z.string(),originalCwd:z.string(),parentOperationId:z.string(),
  reviewHash:z.string().regex(/^[a-f0-9]{64}$/),manifest:manifestSchema,
});
export const pullStartInput=pullSelection.extend({operationId:z.string().uuid(),reviewHash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)}).strict();
export const pullDiscover=defineRpc({name:'handoff.pull-discover',input:z.object({}).strict(),output:z.object({coordinatorId:z.string(),coordinatorLabel:z.string(),candidates:z.array(z.object({parentOperationId:z.string(),sourceHostId:z.string(),sourceHostLabel:z.string(),sourceAgentId:z.string(),title:z.string(),cwd:z.string(),archived:z.boolean(),status:z.string(),blocker:z.string().nullable()}))})});
export const pullReview=defineRpc({name:'handoff.pull-review',input:pullSelection,output:pullReviewSchema});
export const pullStart=defineRpc({name:'handoff.pull-start',input:pullStartInput,output:operationSchema});
export const pullRecoverInput=z.object({coordinatorId:z.string().min(1),operationId:z.string().uuid(),confirmed:z.literal(true)}).strict();
export const pullRecover=defineRpc({name:'handoff.pull-recover',input:pullRecoverInput,output:operationSchema});
