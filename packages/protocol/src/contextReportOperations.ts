import {MemoryMaintenanceScanRequestSchema,MemoryMaintenanceJobCreateRequestSchema} from './memorySessions.js';
import {z} from 'zod';
import {RetrievalMaintenanceScanRequestSchema} from './knowledgeRetrieval.js';
import {RetrievalEvalReportRequestSchema} from './knowledgeRetrieval.js';
import {RetrievalCalibrationDecisionRequestSchema} from './knowledgeRetrieval.js';
import {RetrievalEvalDiagnosticsReportRequestSchema} from './knowledgeRetrieval.js';
import {ClaimCandidatePacketCreateRequestSchema} from './knowledge.js';
import {ClaimContradictionScanRequestSchema} from './claimReviewLoop.js';
import {RelationDiscoveryScanRequestSchema} from './relationDiscovery.js';
import {ObjectSchemaSuggestionScanRequestSchema} from './objectSchema.js';
const receipt=z.object({id:z.string().uuid(),space_id:z.string().uuid(),job_id:z.string().uuid(),status:z.literal('pending')}).strict();
export const CONTEXT_REPORT_OPERATION_SCHEMAS={
 'knowledge.maintenance.scan':{input:RetrievalMaintenanceScanRequestSchema.strict(),output:receipt},
 'knowledge.eval.report':{input:RetrievalEvalReportRequestSchema.strict(),output:receipt},
 'knowledge.eval.calibration.record':{input:RetrievalCalibrationDecisionRequestSchema.strict(),output:receipt},
 'knowledge.eval.diagnostics.report':{input:RetrievalEvalDiagnosticsReportRequestSchema.strict(),output:receipt},
 'knowledge.claim.candidate_packet.create':{input:ClaimCandidatePacketCreateRequestSchema,output:receipt},
 'knowledge.claim.contradictions.scan':{input:ClaimContradictionScanRequestSchema.strict(),output:receipt},
 'knowledge.relation.discovery.scan':{input:RelationDiscoveryScanRequestSchema.strict(),output:receipt},
 'knowledge.object_schema.suggestions.scan':{input:ObjectSchemaSuggestionScanRequestSchema.strict(),output:receipt},
 'memory.maintenance.scan':{input:MemoryMaintenanceScanRequestSchema.strict().refine(v=>!v.create_packet||v.persist_report,'create_packet requires persist_report'),output:receipt},
 'memory.maintenance.job.create':{input:MemoryMaintenanceJobCreateRequestSchema.strict().refine(v=>!v.create_packet||v.persist_report,'create_packet requires persist_report'),output:receipt},
 'memory.maintenance.job.run':{input:z.object({job_id:z.string().uuid()}).strict(),output:receipt},
 'memory.consolidation.run':{input:z.object({batch_limit:z.number().int().min(1).max(500).default(50),activity_ids:z.array(z.string().uuid()).optional()}).strict(),output:receipt},
} as const;
