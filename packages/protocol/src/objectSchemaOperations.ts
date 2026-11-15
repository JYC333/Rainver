import {z} from 'zod';
import {ObjectSchemaImportRequestSchema,ObjectSchemaImportResponseSchema,SpaceObjectProfileCreateProposalRequestSchema,SpaceObjectProfileStatusProposalRequestSchema,SpaceObjectProfileUpdateProposalRequestSchema} from './objectSchema.js';
import {KnowledgeObjectReceiptSchema} from './knowledgeObjectOperations.js';
const id=z.string().uuid();
// Space-wide object-kind governance. Transport inputs name business fields
// only; the proposer and Space come from the authenticated actor.
const update=SpaceObjectProfileUpdateProposalRequestSchema.innerType().extend({profile_id:id}).strict().refine(v=>Object.keys(v).some(k=>k!=='profile_id'&&k!=='rationale'),'at least one object kind field is required');
const status=SpaceObjectProfileStatusProposalRequestSchema.extend({profile_id:id}).strict();
export const OBJECT_SCHEMA_OPERATION_SCHEMAS={
 'knowledge.object_kind.propose_create':{input:SpaceObjectProfileCreateProposalRequestSchema,output:KnowledgeObjectReceiptSchema},
 'knowledge.object_kind.propose_update':{input:update,output:KnowledgeObjectReceiptSchema},
 'knowledge.object_kind.propose_deprecate':{input:status,output:KnowledgeObjectReceiptSchema},
 'knowledge.object_kind.propose_archive':{input:status,output:KnowledgeObjectReceiptSchema},
 'knowledge.object_schema.propose_import':{input:ObjectSchemaImportRequestSchema,output:ObjectSchemaImportResponseSchema.extend({space_id:id})},
} as const;
export const OBJECT_SCHEMA_OPERATION_TITLES={
 'knowledge.object_kind.propose_create':'Propose an object kind',
 'knowledge.object_kind.propose_update':'Propose an object kind change',
 'knowledge.object_kind.propose_deprecate':'Propose deprecating an object kind',
 'knowledge.object_kind.propose_archive':'Propose archiving an object kind',
 'knowledge.object_schema.propose_import':'Propose importing an object schema manifest',
} as const;
export const OBJECT_SCHEMA_PROPOSAL_TYPES={
 'knowledge.object_kind.propose_create':'object_profile_create','knowledge.object_kind.propose_update':'object_profile_update',
 'knowledge.object_kind.propose_deprecate':'object_profile_deprecate','knowledge.object_kind.propose_archive':'object_profile_archive',
 'knowledge.object_schema.propose_import':'object_profile_create',
} as const;
