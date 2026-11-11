import {z} from 'zod';
import {ProjectResearchInitialIntakeRequestSchema} from './projectResearch.js';
import {ResearchResultAdoptionSchema} from './researchCalls.js';
import {RESEARCH_QUESTION_MAX_LENGTH} from './researchDiscovery.js';
const id=z.string().trim().min(1).max(36);
const project={project_id:id};
/** Body-free receipts: callers read current content through the owning GET. */
const receipt=z.object({id,project_id:id,space_id:id}).strict();
const operationTarget=z.object({...project,operation_id:id}).strict();
const isoDate=z.string().trim().min(1).max(64).refine(value=>!Number.isNaN(Date.parse(value)),'Expected an ISO date');
/** Domain request keys stay separate from the transport Idempotency-Key. */
const domainKey=z.string().trim().min(1).max(128);
/** Upper bound of already-scanned items one incremental update request may name. */
export const RESEARCH_TRIGGER_MAX_SOURCE_ITEMS=500;
/** Policy action per command; see SYSTEM_ACTIONS for the retained legacy gate each reuses. */
export const RESEARCH_CONTROL_POLICY={
 'research.intake.start':'source.connection.manage',
 'research.workflow.trigger':'source.connection.manage',
 'research.workflow.history_backfill':'source.backfill.plan',
 'research.question.resolve':'source.connection.manage',
 'research.checkpoint.decide':'research.workspace.update',
 'research.operation.retry':'research.workspace.update',
 'research.operation.reconcile':'research.workspace.update',
 'research.operation.item_limit':'source.backfill.manage',
 'research.operation.rescan':'source.backfill.manage',
 'research.result.adopt':'research.result.adopt',
 'research.acquisition.start':'research.acquisition.start',
 'research.standing.action':'research.workspace.update',
 'research.report.integrity':'research.workspace.update',
 'project.corpus.backfill_sources':'research.workspace.update',
 'research.question.refine':'research.workspace.update',
} as const;
export const RESEARCH_CONTROL_SCHEMAS={
 'research.intake.start':{input:ProjectResearchInitialIntakeRequestSchema.omit({idempotency_key:true}).extend({...project,workflow_id:id.optional(),thread_id:id.optional(),idempotency_key:domainKey.optional()}).strict(),output:receipt.extend({workflow_id:id.nullable(),source_channel_ids:z.array(id).max(100),source_binding_ids:z.array(id).max(100)}).strict()},
 /**
  * `source_item_ids` names already-scanned items of the Workflow's own monitors
  * (each must still be readable in full); omitted or `[]` (equivalent: the
  * operation normalizes `[]` away before its request fingerprint), the update
  * scans its channels first. `idempotency_key` is the business key of one update, kept
  * in the Operation (a later request with it replays that Operation); it is not
  * the transport Idempotency-Key. `run_kind` is the historical body marker.
  */
 'research.workflow.trigger':{input:z.object({...project,workflow_id:id,run_kind:z.literal('incremental').optional(),source_item_ids:z.array(id).max(RESEARCH_TRIGGER_MAX_SOURCE_ITEMS).optional(),idempotency_key:domainKey.optional()}).strict(),output:receipt},
 'research.workflow.history_backfill':{input:z.object({...project,workflow_id:id,from:isoDate,to:isoDate.optional(),max_items:z.number().int().min(1).max(10_000).optional(),idempotency_key:domainKey.optional()}).strict(),output:receipt},
 'research.question.resolve':{input:z.object({...project,workflow_id:id,strategy:z.enum(['rescreen','synthesis_only','apply_forward'])}).strict(),output:receipt.extend({operation_id:id.nullable()}).strict()},
 'research.checkpoint.decide':{input:z.object({...project,workflow_id:id,checkpoint_id:id,decision:z.enum(['approved','rejected','waived']),reason:z.string().trim().max(2000).nullable().optional()}).strict(),output:receipt.extend({workflow_id:id}).strict()},
 'research.operation.retry':{input:operationTarget,output:receipt},
 'research.operation.reconcile':{input:operationTarget,output:receipt.extend({before_status:z.string().max(40),after_status:z.string().max(40)}).strict()},
 'research.operation.item_limit':{input:operationTarget.extend({max_items:z.number().int().min(1).max(10_000)}).strict(),output:receipt},
 'research.operation.rescan':{input:operationTarget,output:receipt},
 'research.result.adopt':{input:ResearchResultAdoptionSchema.extend({...project,operation_id:id}).strict(),output:receipt.extend({thread_id:id}).strict()},
 'research.acquisition.start':{input:z.object({...project,thread_id:id,idempotency_key:domainKey,intent_note:z.string().trim().min(1).max(4000),max_items:z.number().int().min(1).max(2000).optional(),since:isoDate.optional()}).strict(),output:receipt.extend({thread_id:id,status:z.enum(['queued','already_starting'])}).strict()},
 'research.standing.action':{input:z.object({...project,advice_id:id}).strict(),output:receipt.extend({thread_id:id}).strict()},
 'research.report.integrity':{input:z.object({...project,report_id:id}).strict(),output:receipt.extend({report_id:id}).strict()},
 'research.question.refine':{input:z.object({...project,thread_id:id,research_question:z.string().trim().min(1).max(RESEARCH_QUESTION_MAX_LENGTH),message:z.string().trim().min(1).max(20_000),establish_assessment_baseline:z.boolean().optional(),execution:z.object({model_provider_id:id.optional(),model_name:z.string().trim().min(1).max(200).optional()}).strict().default({})}).strict(),output:receipt.extend({thread_id:id,session_id:id,job_id:id}).strict()},
 'project.corpus.backfill_sources':{input:z.object(project).strict(),output:z.object({project_id:id,space_id:id,source_items:z.number().int().nonnegative(),source_objects:z.number().int().nonnegative(),evidence_items:z.number().int().nonnegative(),evidence_objects:z.number().int().nonnegative(),source_decisions:z.number().int().nonnegative(),archived_source_items:z.number().int().nonnegative()}).strict()},
} as const;
export const RESEARCH_CONTROL_TITLES:Record<keyof typeof RESEARCH_CONTROL_SCHEMAS,string>={
 'research.intake.start':'Start the initial Research material intake',
 'research.workflow.trigger':'Queue an incremental Research update',
 'research.workflow.history_backfill':'Start a bounded earlier Research history import',
 'research.question.resolve':'Resolve a changed Research question',
 'research.checkpoint.decide':'Decide a Research workflow checkpoint',
 'research.operation.retry':'Retry a failed Research operation',
 'research.operation.reconcile':'Reconcile a Research operation projection',
 'research.operation.item_limit':'Raise an active Research operation item limit',
 'research.operation.rescan':'Rescan empty Research history windows',
 'research.result.adopt':'Assess a Research result in Inquiry Verify',
 'research.acquisition.start':'Start a Research call for an accepted question',
 'research.standing.action':'Raise standing Research advice as a question',
 'research.report.integrity':'Record a Research report integrity check',
 'project.corpus.backfill_sources':'Rebuild Project Corpus from linked Source material',
 'research.question.refine':'Queue one Research question refinement turn',
};
