import {readExistingPendingPacket,visibilityForReviewScope} from '../proposals/reviewPackets.js';
import {maintenanceLineageKey,RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE} from '../retrieval/maintenance/artifacts.js';
import {ContextReviewCycleRequestSchema,ContextOpsContextObservationScanRequestSchema} from '@rainver/protocol';
import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {ContextOpsService} from './service.js';
import {discoverDiagnosticsArtifacts} from '../retrieval/evalDiagnostics.js';
import {RetrievalMaintenanceService} from '../retrieval/maintenance/service.js';
import {MemoryMaintenanceService} from '../memory/maintenance.js';
import {knowledgeRetrievalRegistry} from '../knowledge/retrievalAdapter.js';
import {pinReportReleaseBatch} from '../retrieval/reportReleaseBatch.js';
/** Discover the inputs for both command entry points before role/settings or
 * report writers can hold a later lock. Every nested gate checks this plan. */
export async function lockContextOpsInputs(db:Queryable,i:SpaceUserIdentity,operation:string,raw:unknown){
 const cycle=operation==='context_ops.review_cycle.run';
 const request=cycle?ContextReviewCycleRequestSchema.parse(raw):ContextOpsContextObservationScanRequestSchema.parse(raw);
 const limit='artifact_limit' in request?request.artifact_limit:request.limit;
 const values=await new ContextOpsService(db).discoverReportInputs({...i,windowDays:request.window_days,limit,includeSpaceOpsReports:'review_scope' in request&&request.review_scope==='space_ops'});
 if(cycle){
  const r=ContextReviewCycleRequestSchema.parse(raw);
  if(r.create_packets){
   const pending=await readExistingPendingPacket(db,i.spaceId,RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE,maintenanceLineageKey(i.spaceId,'context_ops_review_cycle'),{createdByUserId:i.userId,visibility:visibilityForReviewScope(r.review_scope)});
   if(pending)values.push({...pending,proposal_type:RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE});
  }
  const diagnostics=await discoverDiagnosticsArtifacts(db,{spaceId:i.spaceId,ownerUserId:i.userId,windowDays:r.window_days,limit:r.artifact_limit,includeMaintenanceReports:true,comparePreviousWindow:true});
  values.push(...diagnostics.rows,...diagnostics.previousRows,await new RetrievalMaintenanceService(db,knowledgeRetrievalRegistry).scan(i.spaceId,i.userId));
  if(r.include_memory_maintenance)values.push((await new MemoryMaintenanceService(db).scan({...i,limit:r.memory_limit,staleAfterDays:r.memory_stale_after_days,thinContentChars:r.memory_thin_content_chars,maxFindings:r.memory_max_findings})).report);
 }
 await pinReportReleaseBatch(db,i,values,true);
}
