import {z} from 'zod';
import {ProjectResearchInitialIntakeRequestSchema,ProjectResearchQuestionRefinementSchema} from './projectResearch.js';
const id=z.string().trim().min(1).max(36);
const project={project_id:id};
const receipt=z.object({id,project_id:id,space_id:id}).strict();
const checklistText=z.string().transform(s=>s.trim().slice(0,2000)).pipe(z.string().min(1));
const strings=z.array(z.string()).transform(xs=>xs.filter(s=>s.trim().length>0));
const nullableText=z.string().transform(s=>s.trim()||null).nullable();
const cardText=z.string().nullish().transform(s=>(s??'').trim().slice(0,4000));
const support=z.enum(['unsupported','supported','partial','gap_declared']);
const claimFields={support_status:support.optional(),planned_experiment_ids:strings.optional(),citation_anchors:strings.optional(),unresolved_gap:z.boolean().optional(),gap_reason:nullableText.optional()};
export const RESEARCH_WORKSPACE_SCHEMAS={
 'research.question.assessment.confirm':{input:z.object({...project,thread_id:id,refinement:ProjectResearchQuestionRefinementSchema,manually_adjusted:z.boolean().default(false)}).strict(),output:receipt.extend({thread_id:id}).strict()},
 'research.intake.draft':{input:ProjectResearchInitialIntakeRequestSchema.omit({idempotency_key:true}).extend({...project,thread_id:id,workflow_id:id.nullable().default(null),query_strategy_id:id.nullable().default(null),source_channel_ids:z.array(id).default([]),question_refinement:z.record(z.unknown()).refine(value=>JSON.stringify(value).length<=20000).nullable().default(null)}).strict(),output:receipt},
 'research.workflow.stage.record':{input:z.object({...project,workflow_id:id,stage_key:z.string().trim().min(1).max(120),run_id:id.nullable().default(null)}).strict(),output:receipt},
 'research.intake.limit':{input:z.object({...project,workflow_id:id.nullable().default(null),max_items:z.coerce.number().int().min(1).max(10000)}).strict(),output:receipt},
 'research.standing.dismiss':{input:z.object({...project,advice_id:id}).strict(),output:receipt},
 'research.standing.retry':{input:z.object({...project,batch_id:id}).strict(),output:receipt},
 'research.area.initialize':{input:z.object(project).strict(),output:receipt},
 'research.evidence_card.update':{input:z.object({...project,source_item_id:id,why_md:cardText,how_md:cardText,what_md:cardText}).strict(),output:receipt},
 'research.checklist.create':{input:z.object({...project,text:checklistText}).strict(),output:receipt},
 'research.checklist.update':{input:z.object({...project,item_id:id,text:checklistText.optional(),status:z.enum(['open','done','dismissed']).optional(),sort_order:z.number().int().nonnegative().optional()}).strict(),output:receipt},
 'research.checklist.delete':{input:z.object({...project,item_id:id}).strict(),output:receipt},
 'research.claim.link':{input:z.object({...project,claim_id:id,workflow_id:id.nullable().default(null),...claimFields,support_status:support.default('unsupported'),planned_experiment_ids:strings.default([]),citation_anchors:strings.default([]),unresolved_gap:z.boolean().default(false),gap_reason:nullableText.default(null)}).strict(),output:receipt},
 'research.claim.update':{input:z.object({...project,claim_link_id:id,...claimFields}).strict(),output:receipt},
 'research.screening.configure':{input:z.object({...project,include_keywords:strings.default([]),exclude_keywords:strings.default([]),domain_criteria:z.record(z.string(),strings).default({}),source_restrictions:strings.default([]),required_evidence_fields:strings.default([]),date_range_start:nullableText.default(null),date_range_end:nullableText.default(null)}).strict(),output:receipt},
} as const;
export const RESEARCH_WORKSPACE_TITLES:Record<keyof typeof RESEARCH_WORKSPACE_SCHEMAS,string>={
 'research.question.assessment.confirm':'Confirm a Research question assessment framework',
 'research.intake.draft':'Save an initial Research intake draft',
 'research.workflow.stage.record':'Record a Research workflow stage',
 'research.intake.limit':'Set the initial Research item limit',
 'research.standing.dismiss':'Dismiss standing Research advice',
 'research.standing.retry':'Retry a standing comparison batch',
 'research.area.initialize':'Initialize the Research notebook area',
 'research.evidence_card.update':'Edit a Research evidence card',
 'research.checklist.create':'Add a Research checklist item',
 'research.checklist.update':'Edit a Research checklist item',
 'research.checklist.delete':'Delete a Research checklist item',
 'research.claim.link':'Link a readable Claim to Research',
 'research.claim.update':'Update a Research Claim link',
 'research.screening.configure':'Configure Research screening criteria',
};
