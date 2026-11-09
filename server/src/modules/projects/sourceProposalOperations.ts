import type {OperationActor,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {discoverMonitorParent,lockMonitorParent,SourceMonitorScopeConflict} from '../sources/sourceMonitorParent.js';
import {SourceBackfillMutationError} from '../sources/sourceBackfillErrors.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from './access.js';
import {ProjectSourceProposalService} from './projectSourceProposalService.js';
import {ProjectSourceMutationError} from './projectSourceMutationError.js';
type Input={project_id:string;binding_id:string};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function discover(db:Queryable,i:Input,a:OperationActor){
 const binding=(await db.query<{id:string;source_channel_id:string;source_connection_id:string}>(`SELECT b.id,b.source_channel_id,ch.source_connection_id FROM project_source_bindings b JOIN source_channels ch ON ch.id=b.source_channel_id AND ch.space_id=b.space_id WHERE b.id=$1 AND b.space_id=$2 AND b.project_id=$3 AND b.status='active' AND ch.status<>'archived'`,[i.binding_id,a.space_id,i.project_id])).rows[0];
 if(!binding)throw hidden();return {binding,parent:await discoverMonitorParent(db,person(a),binding.source_connection_id)};
}
export function projectSourceProposalRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{return [{
 definition:definitions.get('project.source.propose_backfill')!,successStatus:201,
 async resolve(db,raw,a){const i=raw as Input,closure=await discover(db,i,a);return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id,binding_id:i.binding_id,source_channel_id:closure.binding.source_channel_id,source_connection_id:closure.parent.id},resourceType:'source_backfill_plan',resourceId:null,closure};},
 async authorize(db,raw,a,scope){const i=raw as Input,before=(scope as typeof scope&{closure:Awaited<ReturnType<typeof discover>>}).closure,p=person(a);
  await assertProjectWriter(db,a.space_id,i.project_id,p.userId,{allowArchived:true});
  for(const id of [...new Set([i.project_id,before.parent.project_id].filter((v):v is string=>!!v))].sort()){try{await lockActiveProjectForMutation(db,a.space_id,id);}catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'projects');throw e;}await assertProjectWriterForMutation(db,a.space_id,id,p.userId);}
  await lockMonitorParent(db,p,before.parent);
  // The expected Source parent is already locked. Recheck the channel under
  // that parent without discovering or acquiring a different parent lock late.
  if(!(await db.query("SELECT id FROM source_channels WHERE id=$1 AND space_id=$2 AND source_connection_id=$3 AND status<>'archived' FOR SHARE",[before.binding.source_channel_id,a.space_id,before.parent.id])).rows.length)throw hidden();
  const current=(await db.query<{source_channel_id:string}>('SELECT source_channel_id FROM project_source_bindings WHERE id=$1 AND space_id=$2 AND project_id=$3 AND status=\'active\' FOR UPDATE',[i.binding_id,a.space_id,i.project_id])).rows[0];if(!current)throw hidden();if(current.source_channel_id!==before.binding.source_channel_id)throw new OperationError('operation_conflict',409,false,'projects');
 },
 async authorizeResult(db,raw,a){const out=raw as {space_id:string;project_id:string;binding_id:string;operation_id:string;plan_id:string;proposal_id:string};if(out.space_id!==a.space_id)throw hidden();await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);
  if(!(await db.query(`SELECT plan.id FROM source_backfill_plans plan JOIN project_operations op ON op.id=plan.project_operation_id AND op.space_id=plan.space_id JOIN proposals p ON p.id=plan.proposal_id AND p.space_id=plan.space_id WHERE plan.id=$1 AND plan.space_id=$2 AND plan.project_source_binding_id=$3 AND op.id=$4 AND op.project_id=$5 AND p.id=$6 AND p.project_id=$5`,[out.plan_id,a.space_id,out.binding_id,out.operation_id,out.project_id,out.proposal_id])).rows.length)throw hidden();
 },
 async execute(db,raw,a){const i=raw as Input,result=await new ProjectSourceProposalService(db,config).proposeBackfill(person(a),i.project_id,i.binding_id,raw as Record<string,unknown>);return {space_id:a.space_id,project_id:i.project_id,binding_id:i.binding_id,operation_id:result.operation.id,plan_id:result.plan.id,proposal_id:result.proposal.id,source_channel_id:result.plan.source_channel_id};},
 classifyError(e){if(e instanceof ProjectSourceMutationError||e instanceof SourceBackfillMutationError||e instanceof SourceMonitorScopeConflict)return new OperationBusinessError(e.statusCode===422?'operation_invalid_input':'operation_conflict',e.statusCode===422?422:409,'projects');return undefined;},
 }];}
