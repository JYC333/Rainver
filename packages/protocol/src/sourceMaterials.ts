import {z} from 'zod';
import {IdSchema} from './common.js';
/** Agent-selected reading content; all text remains Agent-provided, not verified. */
const SearchResultUrlSchema=z.string().url().max(4096).refine(s=>{try{const u=new URL(s);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/[\r\n]/.test(s);}catch{return false;}},'Expected an HTTP(S) URL without credentials');
export const SourceMaterialReadingContentSchema=z.object({
 kind:z.enum(['article','repository','other']),
 /** Provenance: retrieved source text or the Agent's own synthesis. Says nothing about markup. */
 format:z.enum(['source_text','agent_summary']),
 /** Markup of `text`, declared by the submitter: `markdown` is parsed into headings, lists, code and tables;
  *  `plain` (or absent, as in every earlier submission) is shown literally. Never inferred from the text. */
 syntax:z.enum(['plain','markdown']).optional(),
 text:z.string().trim().min(1).max(60000),
 sources:z.array(SearchResultUrlSchema).min(1).max(10),
}).strict();
export const SourceMaterialContentUnavailableReasonSchema=z.enum(['not_read','access_denied','unavailable','unsupported','policy_restricted']);
export type SourceMaterialContentUnavailableReason=z.infer<typeof SourceMaterialContentUnavailableReasonSchema>;
export const SourceMaterialReadingInfoSchema=SourceMaterialReadingContentSchema.omit({text:true}).extend({method:z.enum(['agent','extractor'])});
export type SourceMaterialReadingInfo=z.infer<typeof SourceMaterialReadingInfoSchema>;
/** Agent-provided material, not independently verified search/tool evidence. */
export const SourceMaterialSubmissionSchema=z.object({
 processing_id:IdSchema,
 status:z.enum(['succeeded','failed']),
 items:z.array(z.object({
  url:z.string().url().max(4096).refine(s=>{try{const u=new URL(s);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/[\r\n]/.test(s);}catch{return false;}},'Expected an HTTP(S) URL without credentials'),
  title:z.string().trim().min(1).max(512),summary:z.string().trim().min(1).max(2000).nullable(),observed_at:z.string().datetime({offset:true}),
  content:SourceMaterialReadingContentSchema.nullish(),
  unavailable_reason:SourceMaterialContentUnavailableReasonSchema.nullish(),
  /** Publication time stated by the source itself; null when not stated. Never the observation time. */
  published_at:z.string().datetime({offset:true}).nullish(),
  /** A release or update claim must cite the page that evidences it. */
  change:z.object({kind:z.enum(['new_publication','release','update']),evidence_url:SearchResultUrlSchema}).strict().nullish(),
  /** The collecting Agent's topic judgment for a followed goal (same Run and budget). */
  topic_judgment:z.object({importance:z.enum(['important','not_selected']),reason:z.string().trim().min(1).max(500)}).strict().nullish(),
 }).strict()).max(100),
 /** Topic judgment could not be completed in this Run; candidates are still kept. */
 judgment_failure:z.object({message:z.string().trim().min(1).max(500)}).strict().nullish(),
 failure:z.object({code:z.enum(['unavailable','permission_denied','failed']),message:z.string().min(1).max(500)}).strict().nullable(),
 coverage:z.object({truncated:z.boolean(),exhaustive:z.literal(false),limitations:z.array(z.string().max(500)).max(10)}).strict(),
}).strict().superRefine((v,c)=>{if(v.status==='failed'&&(!v.failure||v.items.length))c.addIssue({code:z.ZodIssueCode.custom,path:['failure'],message:'Failed searches require a failure and zero items'});if(v.items.reduce((n,i)=>n+(i.content?.text.length??0)+(i.summary?.length??0),0)>200000||new TextEncoder().encode(JSON.stringify(v)).length>350000)c.addIssue({code:z.ZodIssueCode.custom,path:['items'],message:'Total reading text exceeds 200000 characters; submit fewer useful items'});if(v.status==='succeeded'&&v.failure)c.addIssue({code:z.ZodIssueCode.custom,path:['failure'],message:'Successful searches must have failure:null'});});
export type SourceMaterialSubmission=z.infer<typeof SourceMaterialSubmissionSchema>;

export interface SourceMaterialProcessingState {status:string;execution?:{agent_id:string;agent_name:string;profile_id:string;profile_name:string;runtime_key:string};can_prepare?:boolean;processing_id?:string;run_id?:string;error?:string|null;reason?:string|null;source_id?:string;source_name?:string;can_request_consent?:boolean;}

/** The selected Agent uses this feedback surface in its ordinary ACP tool loop. */
export const SourceMaterialInvestigationSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('search'),query:z.string().trim().min(2).max(300)}).strict(),
 z.object({operation:z.literal('read'),item_id:IdSchema}).strict(),
 z.object({operation:z.literal('check'),draft:z.string().trim().min(1).max(60000),questions:z.array(z.object({question:z.string().trim().min(1).max(500),finding:z.string().trim().min(1).max(2000),explanation:z.string().trim().min(1).max(3000),evidence_urls:z.array(SearchResultUrlSchema).min(1).max(10),limitations:z.string().trim().min(1).max(1500),alternative:z.string().trim().min(1).max(1500)}).strict()).min(1).max(3),historical_comparison:z.string().trim().min(1).max(3000),remaining_gaps:z.array(z.string().trim().min(1).max(500)).max(8),stop_reason:z.string().trim().min(1).max(500)}).strict(),
]);
export type SourceMaterialInvestigation=z.infer<typeof SourceMaterialInvestigationSchema>;
