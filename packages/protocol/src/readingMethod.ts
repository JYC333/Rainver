import {z} from 'zod';
import {SourceMaterialReadingContentSchema} from './sourceMaterials.js';
export const ReadingMethodSampleSchema=z.object({name:z.string().trim().min(1).max(120),pages:z.array(z.object({url:SourceMaterialReadingContentSchema.shape.sources.element.refine(value=>value.length<=2048,'URL exceeds 2048 characters'),text:z.string().min(1).max(8000)}).strict()).min(2).max(3)}).strict();
export const MethodTargetSchema=z.enum(['reading.project_investigation','prompt.revision.method']);
export const ReadingMethodDraftSchema=z.object({target_key:MethodTargetSchema.optional(),item_id:z.string().min(1).nullish().transform(v=>v??null),project_id:z.string().nullable().optional(),parent_version_id:z.string().min(1),reason:z.string().trim().min(1).max(1200),method:z.string().trim().min(40).max(12000)}).strict();
export const ReadingMethodTrialSchema=z.object({target_key:MethodTargetSchema.optional(),provider_id:z.string().min(1).optional(),model:z.string().trim().min(1).max(200).optional(),item_id:z.string().min(1),project_id:z.string().nullable().optional(),candidate_version_id:z.string().min(1),candidate_content_hash:z.string().regex(/^[a-f0-9]{64}$/),case_id:z.string().min(1),agent_id:z.string().min(1).optional(),runtime_profile_id:z.string().min(1).optional(),retry_of:z.string().min(1).optional()}).strict().refine(v=>Boolean(v.agent_id)===Boolean(v.runtime_profile_id),'Legacy execution requires both Agent and Profile').refine(v=>!v.agent_id||(!v.provider_id&&!v.model),'Do not mix legacy CLI and API execution');
export const ReadingMethodJudgeSchema=z.object({judgment:z.enum(['better','same','worse','unknown']),reason:z.string().trim().min(1).max(1600)}).strict();
export interface ReadingMethodTrialView {id:string;status:string;candidate_version_id:string;baseline_version_id:string;baseline_version?:number;candidate_version?:number;stale:boolean;visibility:'visible'|'withheld';baseline:ReadingMethodTrialOutput|null;candidate:ReadingMethodTrialOutput|null;judgment:string|null;reason:string|null;case_name:string;execution_name?:string;}
export interface ReadingMethodTrialOutput {run_id:string;status:string;text:string|null;seconds:number|null;cost_usd:number|null;}
export interface ReadingMethodContext {target_key?:string;api_execution?:{usable:boolean;name:string|null;reason:string|null};revision_method?:{version_id:string;version:number;method:string};generations?:ReadingMethodGenerationView[];effective_content_hash?:string|null;item_id:string|null;item_title:string;project_id:string|null;project_name:string|null;can_manage:boolean;initialized:boolean;effective_version_id:string|null;effective_version:number|null;effective_scope:string|null;method:string|null;result_provenance:{version_id:string;version:number;run_id:string|null;content_hash:string|null}|null;versions:Array<{id:string;version:number;status:string;method:string;reason:string|null;content_hash:string}>;cases:Array<{id:string;name:string;stale?:boolean}>;trials:ReadingMethodTrialView[];promotion?:{id:string;status:string;candidate_version_id:string}|null;runtimes:Array<{agent_id:string;runtime_profile_id:string;name:string;usable:boolean;reason:string|null}>;}
/** Server-owned fictional fixture: a controlled input, never evidence about a real product. */
export const READING_METHOD_FIXTURE={name:'Homepage → documentation → example (offline)',pages:[{url:'https://example.org/flow',text:'Flow is a fictional workflow product. Its homepage describes automation. Documentation is at https://example.org/flow/docs/retries . This synthetic fixture is not evidence about a real product.'},{url:'https://example.org/flow/docs/retries',text:'Flow retries transient failures using bounded exponential backoff. An idempotency key must be supplied by the caller. At most three retries are supported; permanent validation errors are not retried. Example: submit({idempotency_key: stable_event_id, retry:{max:3}}). Storage of idempotency records and operation-specific retry safety remain integration costs.'}]};

/** Only a person's description is accepted. Logs need a separately authorized evidence provider. */
export const ReadingMethodGenerationSchema = z.object({
  target_key:z.enum(['reading.project_investigation','prompt.revision.method']).optional(), source_kind: z.literal('description'), item_id: z.string().min(1).nullish().transform(v=>v??null), project_id: z.string().nullable().optional(),
  parent_version_id: z.string().min(1), parent_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  description: z.string().trim().min(1).max(2400), agent_id: z.string().min(1).optional(), runtime_profile_id: z.string().min(1).optional(),
  provider_id:z.string().min(1).optional(), model:z.string().trim().min(1).max(200).optional(),
  retry_of: z.string().min(1).optional(),
}).strict().refine(v=>Boolean(v.agent_id)===Boolean(v.runtime_profile_id),'Legacy execution requires both Agent and Profile').refine(v=>!v.agent_id||(!v.provider_id&&!v.model),'Do not mix legacy CLI and API execution');
export const ReadingMethodGeneratedOutputSchema = z.object({
  schema: z.literal('reading_method_revision.v1'), method: z.string().trim().min(40).max(12000).refine(value=>!/\{\{[^}]+\}\}/.test(value),"Method variables are code-owned"),
  summary: z.string().trim().min(1).max(1600), changes: z.array(z.string().trim().min(1).max(400)).min(1).max(8),
}).strict();
export interface ReadingMethodGenerationView {
  id: string; status: string; visibility: 'visible'|'withheld'; stale: boolean; description: string|null;
  parent_version_id: string; candidate_version_id: string|null; candidate_version: number|null;
  method: string|null; baseline_method: string|null; summary: string|null; changes: string[];
  execution_name: string|null; seconds: number|null; cost_usd: number|null;
}

export const PROMPT_REVISION_FIXTURE={name:'Controlled prompt revision (offline)',pages:[{url:'https://example.org/prompt-revision/target',text:'Summarize the supplied release notes in the user language. Cite only supplied evidence. Do not browse or infer missing facts. Return a concise summary and unknowns.'},{url:'https://example.org/prompt-revision/feedback',text:'The summary repeats marketing claims. Separate verified changes, their practical impact and unverified claims. Preserve language, evidence-only and no-browsing constraints. Return a complete revised prompt plus explanation; this is synthetic wiring, not semantic acceptance.'}]};
