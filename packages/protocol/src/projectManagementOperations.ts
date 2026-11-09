import {z} from 'zod';
import {ProjectBriefVersionWriteRequestSchema,ProjectInstructionVersionWriteRequestSchema} from './projects.js';
const id=z.string().trim().min(1).max(36);
const project={project_id:id};
const text=z.string().trim().min(1);
const optionalText=z.string().trim().nullable().optional();
export const ProjectManagementReceiptSchema=z.object({id,space_id:id,project_id:id}).strict();
const output=ProjectManagementReceiptSchema;
const summaryStrings=z.array(z.string().trim().max(120)).nullish().transform(values=>{const seen=new Set<string>();return (values??[]).filter(value=>{const key=value.toLowerCase();if(!value||seen.has(key))return false;seen.add(key);return true;});}).pipe(z.array(z.string()).max(32));
const summaryRef=z.object({source_type:z.string().trim().min(1).transform(value=>value.slice(0,256)),source_id:z.string().trim().min(1).transform(value=>value.slice(0,256)),label:z.string().trim().transform(value=>value.slice(0,256)).optional(),trust_level:z.string().trim().transform(value=>value.slice(0,256)).optional()}).strict();
export const ProjectReviewSessionReceiptSchema=ProjectManagementReceiptSchema.extend({inquiry_packet_id:id.nullable(),knowledge_packet_id:id,created_at:z.string().datetime({offset:true})}).strict();
export const NotebookChatReceiptSchema=ProjectManagementReceiptSchema.extend({session_id:id,run_id:id,job_id:id,daily_limit:z.number().int().positive(),daily_used:z.number().int().nonnegative()}).strict();
export const PROJECT_MANAGEMENT_SCHEMAS={
 'project.public_summary.save':{input:z.object({...project,summary_text:z.string().trim().min(1).max(4000),topics:summaryStrings,highlights:summaryStrings,source_refs:z.array(summaryRef).max(50).nullish().transform(value=>value??[]),redaction_version:z.string().trim().nullish().transform(value=>value||'project_public_summary.v1'),generated_by_run_id:id.nullable().default(null)}).strict(),output},
 'project.public_summary.publish':{input:z.object({...project,draft_version:z.number().int().positive()}).strict(),output},
 'project.public_summary.revoke':{input:z.object(project).strict(),output},
 'project.update':{input:z.object({...project,name:z.string().trim().nullable().optional(),description:optionalText,current_focus:optionalText,status:z.enum(['active','archived']).nullable().optional(),settings_json:z.record(z.unknown()).nullable().optional()}).strict(),output},
 'project.archive':{input:z.object(project).strict(),output},
 'project.notebook.chat':{input:z.object({...project,message:z.string().transform(v=>v.trim().slice(0,4000)).pipe(z.string().min(1)),session_id:id.nullable().default(null),source_item_ids:z.array(id).default([]).transform(ids=>ids.slice(0,20)),execution:z.object({model_provider_id:id.nullable().optional(),model_name:z.string().trim().nullable().optional()}).strict().default({})}).strict(),output:NotebookChatReceiptSchema},
 'project.focus_area.set':{input:z.object({...project,focus_area_id:id.nullable()}).strict(),output},
 'project.review_session.open':{input:z.object({...project,limit:z.number().int().default(5).transform(v=>Math.max(1,Math.min(v,20)))}).strict(),output:ProjectReviewSessionReceiptSchema},
 'project.update.report':{input:z.object({...project,summary:z.string().trim().min(1).max(8000)}).strict(),output},
 'project.update.undo':{input:z.object({...project,event_id:id}).strict(),output},
 'project.create':{input:z.object({name:text,description:optionalText,current_focus:optionalText,settings_json:z.record(z.unknown()).nullish().transform(v=>v??{}),goal:optionalText,scope_included:optionalText,scope_excluded:optionalText,success_definition:optionalText,constraints:optionalText,assumptions:optionalText}).strict(),output},
 'project.member.add':{input:z.object({...project,user_id:id,role:z.enum(['viewer','member','owner']).default('member')}).strict(),output},
 'project.member.remove':{input:z.object({...project,user_id:id}).strict(),output},
 'project.brief.create':{input:ProjectBriefVersionWriteRequestSchema.extend(project).strict(),output},
 'project.brief.submit_review':{input:z.object({...project,version_id:id}).strict(),output},
 'project.brief.publish':{input:z.object({...project,version_id:id}).strict(),output},
 'project.instruction.create':{input:ProjectInstructionVersionWriteRequestSchema.extend(project).strict(),output},
 'project.instruction.submit_review':{input:z.object({...project,version_id:id}).strict(),output},
 'project.instruction.publish':{input:z.object({...project,version_id:id}).strict(),output},
 'project.attention.set_state':{input:z.object({...project,source_type:text.max(80),source_id:id,seen_at:z.string().datetime({offset:true}).nullable().optional(),snoozed_until:z.string().datetime({offset:true}).nullable().optional(),pinned_at:z.string().datetime({offset:true}).nullable().optional()}).strict(),output},
 'decision.case.create':{input:z.object({...project,title:text,framing:optionalText,source_thread_ids:z.array(id).default([])}).strict(),output},
 'decision.option.add':{input:z.object({...project,case_id:id,title:text,description:optionalText}).strict(),output},
 'decision.criterion.add':{input:z.object({...project,case_id:id,name:text,weight:z.number().int().min(1).max(5).default(3)}).strict(),output},
 'decision.option.score':{input:z.object({...project,case_id:id,option_id:id,criterion_id:id,score:z.number().int().min(1).max(5),rationale:optionalText}).strict(),output},
 'decision.case.decide':{input:z.object({...project,case_id:id,option_id:id}).strict(),output},
 'decision.commitment.add':{input:z.object({...project,case_id:id,statement:text}).strict(),output},
 'decision.commitment.deliver':{input:z.object({...project,case_id:id,commitment_id:id,description:optionalText}).strict(),output},
} as const;
export const PROJECT_MANAGEMENT_TITLES:Record<keyof typeof PROJECT_MANAGEMENT_SCHEMAS,string>={
 'project.public_summary.save':'Save a public summary draft',
 'project.public_summary.publish':'Publish a reviewed public summary version',
 'project.public_summary.revoke':'Revoke the public summary publication',
 'project.update':'Edit a Project or change its lifecycle',
 'project.archive':'Archive a Project and stop its future work',
 'project.notebook.chat':'Discuss and edit Project notes',
 'project.focus_area.set':'Classify a Project in a focus area',
 'project.review_session.open':'Open a combined Project review session',
 'project.update.report':'Report a Project update',
 'project.update.undo':'Undo a Project update',
 'project.create':'Create a Project',
 'project.member.add':'Add or update a Project member',
 'project.member.remove':'Remove a Project member',
 'project.brief.create':'Create a Project Brief draft',
 'project.brief.submit_review':'Submit a Project Brief for review',
 'project.brief.publish':'Publish a reviewed Project Brief',
 'project.instruction.create':'Create a Project Instruction draft',
 'project.instruction.submit_review':'Submit a Project Instruction for review',
 'project.instruction.publish':'Publish a reviewed Project Instruction',
 'project.attention.set_state':'Set personal Project attention state',
 'decision.case.create':'Create a Decision Case',
 'decision.option.add':'Add a Decision Case option',
 'decision.criterion.add':'Add a Decision Case criterion',
 'decision.option.score':'Score a Decision Case option',
 'decision.case.decide':'Confirm a Decision Case option',
 'decision.commitment.add':'Add a Decision commitment',
 'decision.commitment.deliver':'Create a delivery Task from a commitment',
};
