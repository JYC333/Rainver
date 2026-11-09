import {listResearchOperationRefs} from './researchOperationDiscovery.js';
import type {OperationActor,RegisteredSystemActionDefinition as SystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {assertResearchCallReadable} from './researchCallAccess.js';
import {assertThreadReadable} from '../inquiry/threadAccess.js';
import {ResearchOperationCancelService,ResearchCancellationConflict,ResearchCancellationInputError} from './researchOperationCancel.js';
import {OperationError,OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
type Input={operation_id:string;project_id?:string;reason?:string};
/** Safe domain error: constructed only after live Run/Project authorization and canonical list filtering. */
class MissingResearchTarget extends OperationError {
  constructor(private readonly hint:string) {super('operation_not_found',404);}
  override body(requestId:string) { const body=super.body(requestId); body.error.message=this.hint; return body; }
}
async function missingTarget(db:Queryable,input:Input,actor:OperationActor):Promise<never> {
  if (!actor.run_id || actor.principal.kind!=='agent') throw hidden();
  // Existing ids in this Space (another Project or a private call) get no discovery hint.
  // Other Spaces are never consulted: their ids behave exactly like random missing ids.
  if ((await db.query('SELECT id FROM project_operations WHERE id=$1 AND space_id=$2',[input.operation_id,actor.space_id])).rows.length) throw hidden();
  const run=(await db.query<{project_id:string}>('SELECT project_id FROM runs WHERE id=$1 AND space_id=$2',[actor.run_id,actor.space_id])).rows[0];
  if (!run?.project_id || input.project_id && input.project_id!==run.project_id) throw hidden();
  const identity={spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!};
  try {
    await assertProjectWriter(db,identity.spaceId,run.project_id,identity.userId);
    const visible=await listResearchOperationRefs(db,identity,run.project_id);
    throw new MissingResearchTarget(visible.length
      ? `No research Operation has id '${input.operation_id}'. Use one of these ids exactly: ${visible.map(row=>`${row.operation_id} — ${row.title} (${row.status})`).join('; ')}`
      : `No research Operation has id '${input.operation_id}', and this Project has no research running.`);
  } catch(error) { if(error instanceof MissingResearchTarget) throw error; throw hidden(); }
}
async function target(db:Queryable,input:Input,actor:OperationActor,lock=false) {
  const row=(await db.query<{project_id:string;research_call_json:unknown}>(`SELECT project_id,research_call_json FROM project_operations WHERE id=$1 AND space_id=$2 AND kind='research' ${lock?"FOR UPDATE":""}`,[input.operation_id,actor.space_id])).rows[0];
  if(!row) return missingTarget(db,input,actor);
  if(input.project_id && row.project_id!==input.project_id) throw hidden();
  if(actor.run_id) {
    const run=(await db.query<{project_id:string}>('SELECT project_id FROM runs WHERE id=$1 AND space_id=$2',[actor.run_id,actor.space_id])).rows[0];
    if(run?.project_id!==row.project_id) throw hidden();
  }
  return row;
}
export async function authorizeResearchCancellation(db:Queryable,input:Input,actor:OperationActor) {
  const row=await target(db,input,actor),identity={spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!};
  await assertProjectWriter(db,identity.spaceId,row.project_id,identity.userId,{allowArchived:true});
  // Serialize Project archive and authority changes with the mutation/replay.
  try { await lockActiveProjectForMutation(db,identity.spaceId,row.project_id); }
  catch(error) { if(error instanceof HttpError && error.statusCode===409) throw new OperationBusinessError('operation_conflict',409,'research'); throw error; }
  await assertProjectWriterForMutation(db,identity.spaceId,row.project_id,identity.userId);
  const locked=await target(db,input,actor,true);
  if(locked.project_id!==row.project_id) throw hidden();
  const call=await assertResearchCallReadable(db,identity,row.project_id,locked.research_call_json,undefined,'stop');
  if(call)await assertThreadReadable(db,identity,row.project_id,call.thread_id,'change');
}
/** One production pilot, using the existing cancellation service and its atomic Job intent. No approval mapping. */
export function researchCancelRegistration(definitions:ReadonlyMap<string,SystemActionDefinition>):OperationRegistration {
  return {
    definition:definitions.get('research.cancel_acquisition')!,
    async resolve(db,raw,actor) {
      const input=raw as Input,row=await target(db,input,actor);
      return {authority:actor.run_id?`project:${row.project_id}:run:${actor.run_id}`:`project:${row.project_id}`,targets:{project_id:row.project_id,operation_id:input.operation_id},resourceType:'project_operation',resourceId:input.operation_id};
    },
    normalizeInput(raw,scope) {
      return {...raw as Input,project_id:(scope.targets as {project_id:string}).project_id};
    },
    authorize:(db,input,actor)=>authorizeResearchCancellation(db,input as Input,actor),
    authorizeResult:(db,output,actor)=>authorizeResearchCancellation(db,output as Input,actor),
    async execute(db,raw,actor) {
      const input=raw as Input,row=await target(db,input,actor);
      return new ResearchOperationCancelService(db).cancelOperation({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!},row.project_id,input.operation_id,input.reason);
    },
    classifyError(error) {
      if(error instanceof ResearchCancellationConflict)return new OperationBusinessError('operation_conflict',409,'research');
      if(error instanceof ResearchCancellationInputError)return new OperationBusinessError('operation_invalid_input',422,'research');
      // Other HttpErrors (including private 403/404) are left to the core's hidden/internal mapping.
      return undefined;
    }
  };
}
