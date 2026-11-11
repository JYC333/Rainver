import {z} from 'zod';
import {RunLiveInputRequestSchema} from './acp.js';
import {QuotaRecoveryUpdateSchema} from './subscriptionQuota.js';
const id=z.string().trim().min(1).max(36);
const run={run_id:id};
const receipt=z.object({id,space_id:id,run_id:id}).strict();
const reason=z.string().max(2000).nullable().optional();
/** Person Run controls. Process, Host and provider work happens after commit or
 * in the Run's Job; receipts carry identities and the state the command set. */
export const RUN_OPERATION_SCHEMAS={
 'run.stop':{input:z.object({...run,reason}).strict(),output:receipt.extend({status:z.string().max(40)}).strict()},
 'run.abandon':{input:z.object({...run,reason}).strict(),output:receipt.extend({status:z.literal('cancelled'),abandoned_at:z.string()}).strict()},
 'run.resume':{input:z.object(run).strict(),output:receipt.extend({status:z.string().max(40),resumed_at:z.string(),resume_kind:z.enum(['new_attempt','same_attempt'])}).strict()},
 'run.execute':{input:z.object(run).strict(),output:receipt.extend({job_id:id}).strict()},
 'run.finalize':{input:z.object(run).strict(),output:receipt},
 'run.quota_recovery.update':{input:QuotaRecoveryUpdateSchema.extend(run).strict(),output:receipt},
 'run.live_input.submit':{input:RunLiveInputRequestSchema.extend(run).strict(),output:receipt.extend({message_id:id,binding_id:z.string().uuid()}).strict()},
} as const;
export const RUN_OPERATION_TITLES:Record<keyof typeof RUN_OPERATION_SCHEMAS,string>={
 'run.stop':'Stop a Run',
 'run.abandon':'Abandon a Run waiting for review',
 'run.resume':'Resume a Run waiting for review',
 'run.execute':'Queue a queued Run for execution',
 'run.finalize':'Finalize a terminal Run',
 'run.quota_recovery.update':'Choose how a quota-held Run recovers',
 'run.live_input.submit':'Send additional input to a running turn',
};
