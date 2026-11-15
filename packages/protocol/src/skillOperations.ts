import {z} from 'zod';
import {IdSchema} from './common.js';
import {SkillBindingRequestSchema,SkillReviewProposalRequestSchema,SkillLocalOverlayUpsertRequestSchema,SkillLocalOverlaySchema,SkillImportRequestSchema,SkillImportPreviewRequestSchema} from './skills.js';
const proposalReceipt=z.object({space_id:IdSchema,proposal_id:IdSchema}).strict();

const binding=SkillBindingRequestSchema.innerType().extend({skill_package_id:IdSchema}).superRefine((v,c)=>{
 const {skill_package_id:_,...body}=v;const result=SkillBindingRequestSchema.safeParse(body);
 if(!result.success)for(const issue of result.error.issues)c.addIssue(issue);
});
const review=SkillReviewProposalRequestSchema.innerType().extend({skill_package_id:IdSchema}).superRefine((v,c)=>{
 const {skill_package_id:_,...body}=v;const result=SkillReviewProposalRequestSchema.safeParse(body);
 if(!result.success)for(const issue of result.error.issues)c.addIssue(issue);
});
export const SKILL_LOCAL_OPERATION_SCHEMAS={
 'skill.binding.propose':{input:binding,output:proposalReceipt},
 'skill.review.propose':{input:review,output:proposalReceipt.extend({created:z.boolean()})},
 'skill.overlay.upsert':{input:SkillLocalOverlayUpsertRequestSchema.extend({skill_package_id:IdSchema}),output:SkillLocalOverlaySchema.strict()},
} as const;
export const SKILL_IO_JOB='skill_source_request';
export const SkillIoReceiptSchema=z.object({space_id:IdSchema,job_id:IdSchema,status:z.literal('pending')}).strict();
export const SKILL_IO_OPERATION_SCHEMAS={
 'skill.source.scan':{input:z.object({host_id:IdSchema}).strict(),output:SkillIoReceiptSchema},
 'skill.source.preview':{input:SkillImportPreviewRequestSchema,output:SkillIoReceiptSchema},
 'skill.source.import':{input:SkillImportRequestSchema,output:SkillIoReceiptSchema},
} as const;
