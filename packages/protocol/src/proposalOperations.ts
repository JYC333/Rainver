import {EvolutionBundleDecisionReceiptSchema} from './evolutionBundle.js';
import {z} from 'zod';
import {IdSchema} from './common.js';
import {type ProposalApprovalOut,type ProposalOut,ProposalOutSchema,ProposalApprovalOutSchema,ProposalAcceptOutSchema,CodePatchDecisionReceiptSchema} from './proposals.js';
export const ProposalEgressConsentInputSchema:z.ZodType<{proposal_id:string;grant_id?:string|null}>=z.object({proposal_id:IdSchema,grant_id:IdSchema.nullish()}).strict();
const output:z.ZodType<ProposalApprovalOut>=ProposalApprovalOutSchema.strict();
export const PROPOSAL_CONSENT_OPERATION_SCHEMAS={
 'proposal.egress.approve':{input:ProposalEgressConsentInputSchema,output},
} as const;

const rejectionInput:z.ZodType<{proposal_id:string}>=z.object({proposal_id:IdSchema}).strict();
const rejectionOutput:z.ZodType<ProposalOut>=ProposalOutSchema;
export const PROPOSAL_REJECTION_OPERATION_SCHEMAS={
 'proposal.reject':{input:rejectionInput,output:rejectionOutput},
} as const;

export const PROPOSAL_APPLY_OPERATION_SCHEMAS={
 'proposal.accept':{input:z.object({proposal_id:IdSchema,confirm_incomplete_patch:z.preprocess(v=>v==='true'?true:v==='false'?false:v,z.boolean()).default(false),
  /** The revision the decider was shown (a card's `card_revision`): refused (409 `proposal_revision_changed`) once the Proposal changed since. */
  expected_revision:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),output:ProposalAcceptOutSchema},
 'proposal.rollback':{input:rejectionInput,output:CodePatchDecisionReceiptSchema},
} as const;

const bundleDecision=z.object({proposal_id:IdSchema,decision:z.enum(['approve','reject']),note:z.string().trim().nullable().optional()}).strict();
const bundleReceipt=z.object({space_id:IdSchema,bundle_id:IdSchema,decisions:z.array(bundleDecision),decision:EvolutionBundleDecisionReceiptSchema.nullable()}).strict();
export const BUNDLE_DECISION_OPERATION_SCHEMAS={
 'evolution.bundle.decide':{input:z.object({bundle_id:IdSchema,decisions:z.array(bundleDecision).min(1).max(100)}).strict(),output:bundleReceipt},
 'evolution.bundle.approve':{input:z.object({bundle_id:IdSchema,proposal_ids:z.array(IdSchema).min(1).max(100)}).strict(),output:bundleReceipt},
 'evolution.bundle.reject':{input:z.object({bundle_id:IdSchema,proposal_ids:z.array(IdSchema).min(1).max(100)}).strict(),output:bundleReceipt},
 'evolution.bundle.rollback':{input:z.object({bundle_id:IdSchema}).strict(),output:bundleReceipt},
} as const;
