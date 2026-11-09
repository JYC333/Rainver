import { runReadSql, artifactReadSql } from '../access/contentAccessSql.js';
import { contentDecisionFromDb } from '../access/contentAccessQuery.js';
import type { OperationActor, OperationInput, RegisteredSystemActionDefinition } from '@rainver/protocol';
import type { Queryable } from '../routeUtils/common.js';
import { HttpError } from '../routeUtils/common.js';
import { hidden, OperationBusinessError } from '../systemActions/operations/errors.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { assertProjectWriter, assertProjectWriterForMutation, lockActiveProjectForMutation } from './access.js';
import { ProjectOperationService } from './projectOperationService.js';
import { ProjectOperationTerminalConflict } from './projectOperationRepository.js';
import { authorizeResearchCancellation } from '../projectResearch/researchCancelOperation.js';

type Create = OperationInput<'project.operation.create'>;
type Cancel = OperationInput<'project.operation.cancel'>;
const identity = (actor:OperationActor) => ({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!});
async function authorize(db:Queryable, input:Create|Cancel|Pick<Create,'project_id'>, actor:OperationActor) {
  const person = identity(actor);
  await assertProjectWriter(db, person.spaceId, input.project_id, person.userId, {allowArchived:true});
  try { await lockActiveProjectForMutation(db, person.spaceId, input.project_id); }
  catch(error) {
    if(error instanceof HttpError && error.statusCode===409) throw new OperationBusinessError('operation_conflict',409,'projects');
    throw error;
  }
  await assertProjectWriterForMutation(db, person.spaceId, input.project_id, person.userId);
  for (const [type, id] of [
    ['run', 'initiating_run_id' in input ? input.initiating_run_id : null],
    ['artifact', 'plan_artifact_id' in input ? input.plan_artifact_id : null],
  ] as const) {
    if (!id) continue;
    const table = type === 'run' ? 'runs' : 'artifacts';
    const read = type === 'run' ? runReadSql('$4', 'ref', {includeOversight:false}) : artifactReadSql('$4', 'ref');
    const reference = await db.query(
      `SELECT ref.id FROM ${table} ref WHERE ref.id=$1 AND ref.space_id=$2 AND ref.project_id=$3 AND ${read} FOR SHARE OF ref`,
      [id, person.spaceId, input.project_id, person.userId]);
    if (!reference.rows.length || await contentDecisionFromDb(db,person,type,id,{includeOversight:false}) !== 'full') throw hidden();
  }
  if ('operation_id' in input) {
    const row = (await db.query<{kind:string}>(
      'SELECT kind FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',
      [input.operation_id,person.spaceId,input.project_id])).rows[0];
    if(!row) throw hidden();
    // Reuse the stop/audience closure; generic cancellation keeps its own terminal contract.
    if(row.kind==='research') await authorizeResearchCancellation(db,input,actor);
  }
}
function receipt(row:Record<string,unknown>) {
  return {id:row.id,project_id:row.project_id,kind:row.kind,status:row.status,version:row.version};
}
export function projectOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[] {
  return (['create','cancel'] as const).map(kind=>({
    definition:definitions.get(`project.operation.${kind}`)!,
    successStatus:kind==='create'?201:200,
    async resolve(_db,raw) {
      const input=raw as Create|Cancel;
      return {authority:`project:${input.project_id}`,targets:input,resourceType:'project_operation',resourceId:'operation_id' in input?input.operation_id:input.project_id};
    },
    authorize:(db,raw,actor)=>authorize(db,raw as Create|Cancel,actor),
    async authorizeResult(db,raw,actor) {
      const output=raw as {id:string;project_id:string};
      // Create receipts contain no private content; cancellation still rechecks stop authority.
      await authorize(db,kind==='cancel'?{project_id:output.project_id,operation_id:output.id}:{project_id:output.project_id},actor);
    },
    async execute(db,raw,actor) {
      const service=new ProjectOperationService(db),input=raw as Create|Cancel;
      return receipt(kind==='create'
        ? await service.create(identity(actor),input.project_id,raw as Create)
        : await service.cancel(identity(actor),input.project_id,(raw as Cancel).operation_id));
    },
    classifyError(error) {
      if(error instanceof ProjectOperationTerminalConflict) return new OperationBusinessError('operation_conflict',409,'projects');
      return undefined;
    },
  }));
}
