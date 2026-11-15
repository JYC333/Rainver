import {z} from 'zod';
import {MemoryProposalRevisionRequestSchema} from './memorySessions.js';
const id=z.string().uuid();
const receipt=z.object({id,space_id:id}).strict();
// A person's own Memory commands. Inputs name business fields only: who acts,
// provenance, owner, Agent and Room come from the authenticated actor and the
// canonical writers, never from the request (ADR 0003, B10).
const fields={type:z.string().trim().min(1).max(64),namespace:z.string().trim().min(1).max(256).optional(),sensitivity_level:z.string().trim().min(1).optional(),confidence:z.number().min(0).max(1).optional(),importance:z.number().min(0).max(1).optional(),tags:z.array(z.string()).max(64).optional(),subject_user_id:id.nullish(),memory_layer:z.string().trim().min(1).nullish()};
const create=z.object({title:z.string().trim().min(1).max(512),content:z.string().trim().min(1),...fields,access_level:z.string().trim().min(1).optional(),last_confirmed_at:z.string().datetime({offset:true}).nullish(),project_id:id.nullable().default(null)}).strict();
const update=z.object({memory_id:id,title:z.string().trim().min(1).max(512).optional(),content:z.string().trim().min(1).optional(),...fields,type:fields.type.optional(),scope:z.enum(['user','project']).optional(),project_id:id.nullish()}).strict().refine(v=>Object.keys(v).some(k=>k!=='memory_id'),'at least one memory field is required');
const target=z.object({memory_id:id}).strict();
export const MEMORY_OPERATION_SCHEMAS={
 'memory.propose_create':{input:create,output:receipt},
 'memory.propose_update':{input:update,output:receipt},
 'memory.archive':{input:target,output:receipt.extend({outcome:z.enum(['archived','proposed'])})},
 'memory.restore':{input:target,output:receipt},
 'memory.revert':{input:target,output:receipt},
 'memory.proposal.revise':{input:MemoryProposalRevisionRequestSchema.extend({proposal_id:id}).strict(),output:receipt},
} as const;
export const MEMORY_OPERATION_TITLES={
 'memory.propose_create':'Propose a memory','memory.propose_update':'Propose a memory change',
 'memory.archive':'Archive a memory','memory.restore':'Restore a memory','memory.revert':'Undo a memory revision',
 'memory.proposal.revise':'Revise a pending memory update',
} as const;
/** Proposal types and side effects as registered; archive proposes only for an entry the person does not own. */
export const MEMORY_OPERATION_EFFECTS={
 'memory.propose_create':{effects:'proposal',proposal_type:'memory_create',policy:'proposal.create'},
 'memory.propose_update':{effects:'proposal',proposal_type:'memory_update',policy:'proposal.create'},
 'memory.archive':{effects:'conditional_proposal',proposal_type:'memory_archive',policy:'memory.own.status'},
 'memory.restore':{effects:'durable',proposal_type:null,policy:'memory.own.status'},
 'memory.revert':{effects:'durable',proposal_type:null,policy:'memory.own.status'},
 'memory.proposal.revise':{effects:'durable',proposal_type:null,policy:'memory.proposal.revise'},
} as const;
