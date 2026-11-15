import {lockContextOpsInputs} from "./inputLocks.js";
import {ContextReviewCycleRequestSchema,ContextOpsContextObservationScanRequestSchema,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import {HttpError} from '../routeUtils/common.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {authorizeContextReport,withheldContextReport} from '../retrieval/contextReports.js';
import {runContextReviewCycle} from './reviewCycle.js';
import {runContextObservationScan} from './contextObservations.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
export function contextOpsRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (['context_ops.review_cycle.run','context_ops.observations.scan'] as const).map(id=>({
  definition:defs.get(id)!,successStatus:201,domainAuthorizationFirst:true,
  async resolve(_db,_raw,a){return {authority:`context-ops:${a.space_id}:${a.on_behalf_of_user_id}`,targets:{space_id:a.space_id,user_id:a.on_behalf_of_user_id},resourceType:'space',resourceId:a.space_id};},
  async authorize(db,raw,a){await lockContextOpsInputs(db,person(a),id,raw);await authorizeContextReport(db,person(a),'knowledge.maintenance.scan',raw);},
  async authorizeResult(db,raw,a){if(await withheldContextReport(db,person(a),'knowledge.maintenance.scan',raw,raw,'Context Ops receipt read'))throw hidden();},
  async execute(db,raw,a){
   const result=id==='context_ops.review_cycle.run'?await runContextReviewCycle(db,{...person(a),request:ContextReviewCycleRequestSchema.parse(raw)}):await runContextObservationScan(db,{...person(a),request:ContextOpsContextObservationScanRequestSchema.parse(raw)});
   if(await withheldContextReport(db,person(a),'knowledge.maintenance.scan',raw,result,'Context Ops result read'))throw hidden();
   return result;
  },
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'context_ops'):undefined,
 }));
}
