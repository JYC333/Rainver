import {z} from 'zod';
import {IdSchema} from './common.js';
import {RuntimeContextPolicyResolveRequestSchema,RuntimeContextResolvedPolicySchema,TurnContextRequestSchema} from './runtimeContext.js';

/** Job type of a queued Runtime Context preview; its envelope is released only by the owning result reader. */
export const RUNTIME_CONTEXT_PREVIEW_JOB='runtime_context_preview';
export const RuntimeContextPreviewReceiptSchema=z.object({space_id:IdSchema,job_id:IdSchema,status:z.literal('pending')}).strict();
export const RUNTIME_CONTEXT_REQUEST_OPERATION_SCHEMAS={
 /** The effective merged policy over scopes the person can read; a read-only query. */
 'runtime_context.policy.resolve':{input:RuntimeContextPolicyResolveRequestSchema,output:RuntimeContextResolvedPolicySchema},
 /**
  * Plans a turn's context without executing it. Acquisition can call an
  * embedding provider and records context-injection reads, so it runs in a
  * single-attempt Job; `GET /runtime-context/preview-requests/:jobId` releases
  * the envelope under the person's current Work Context and object access.
  */
 'runtime_context.preview.request':{input:TurnContextRequestSchema,output:RuntimeContextPreviewReceiptSchema},
} as const;
export type RuntimeContextRequestOperationId=keyof typeof RUNTIME_CONTEXT_REQUEST_OPERATION_SCHEMAS;
export const RUNTIME_CONTEXT_REQUEST_OPERATION_TITLES:Record<RuntimeContextRequestOperationId,string>={
 'runtime_context.policy.resolve':'Resolve the effective Runtime Context Policy',
 'runtime_context.preview.request':'Preview a turn’s Runtime Context',
};
