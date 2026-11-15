import {z} from 'zod';

/** Evolution target/signal ids are opaque server ids (no format narrowing versus the legacy routes). */
const id=z.string().min(1).max(128);
/** The supported (non-retired) target registrations; archived rows keep historical labels only. */
export const EvolutionTargetTypeSchema=z.enum(['agent_version','memory','knowledge','workflow','project_folder','system']);
export const EvolutionTargetRiskSchema=z.enum(['low','medium','high','critical']);
export const EvolutionTargetStatusSchema=z.enum(['active','paused','archived']);
/** Every severity a signal emitter or the manual signal dialog writes. */
export const EvolutionSignalSeveritySchema=z.enum(['info','warning','error','low','medium','high','critical']);
export const EvolutionSignalTriageStatusSchema=z.enum(['new','acknowledged','dismissed','actioned']);
const text=(max:number)=>z.string().trim().max(max).nullable();
const json=z.record(z.string(),z.unknown());
const targetFields={
 target_ref_type:text(64).optional(),target_ref_id:text(128).optional(),capability_key:text(128).optional(),
 current_version_id:z.string().min(1).max(36).nullable().optional(),
 target_name:text(256).optional(),purpose:text(4000).optional(),
 engine_policy_json:json.optional(),metadata_json:json.optional(),
};
/** Identity only. Targets and signals are reread through their authorized GET readers. */
export const EvolutionTargetReceiptSchema=z.object({space_id:id,target_id:id}).strict();
export const EvolutionSignalReceiptSchema=z.object({space_id:id,target_id:id,signal_id:id}).strict();
export const EVOLUTION_OPERATION_SCHEMAS={
 'evolution.target.create':{input:z.object({...targetFields,target_type:EvolutionTargetTypeSchema,risk_level:EvolutionTargetRiskSchema.default('medium'),status:EvolutionTargetStatusSchema.default('active'),enabled:z.boolean().default(true)}).strict(),output:EvolutionTargetReceiptSchema},
 /** A partial edit: an omitted field keeps its value; `null` clears a nullable one. */
 'evolution.target.update':{input:z.object({...targetFields,target_id:id,target_type:EvolutionTargetTypeSchema.nullable().optional(),risk_level:EvolutionTargetRiskSchema.nullable().optional(),status:EvolutionTargetStatusSchema.nullable().optional(),enabled:z.boolean().nullable().optional(),engine_policy_json:json.nullable().optional(),metadata_json:json.nullable().optional()}).strict(),output:EvolutionTargetReceiptSchema},
 /** A person's explicit observation on a target this Space can read. */
 'evolution.signal.create':{input:z.object({target_id:id,signal_type:z.string().trim().min(1).max(128),source_type:z.string().trim().min(1).max(64),source_id:text(128).optional(),severity:EvolutionSignalSeveritySchema.default('info'),summary:text(4000).optional(),payload_json:json.default({})}).strict(),output:EvolutionSignalReceiptSchema},
 /** Space-scoped triage; the dismiss URL pins `dismissed`. Never changes autonomous review consumption. */
 'evolution.signal.triage':{input:z.object({signal_id:id,triage_status:EvolutionSignalTriageStatusSchema,triage_note:text(4000).optional()}).strict(),output:EvolutionSignalReceiptSchema},
} as const;
export type EvolutionOperationId=keyof typeof EVOLUTION_OPERATION_SCHEMAS;
export const EVOLUTION_OPERATION_TITLES:Record<EvolutionOperationId,string>={
 'evolution.target.create':'Create an Evolution target','evolution.target.update':'Edit an Evolution target',
 'evolution.signal.create':'Record an Evolution signal','evolution.signal.triage':'Triage an Evolution signal',
};
/** The validated input a writer receives (defaults applied). */
export type EvolutionOperationInput<Id extends EvolutionOperationId>=z.output<(typeof EVOLUTION_OPERATION_SCHEMAS)[Id]['input']>;
