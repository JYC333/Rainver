import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {contentReadSql} from '../access/contentAccessSql.js';
import {assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {assertCurrentActor,assertOperationGrant} from '../systemActions/operations/actor.js';
import {OperationError,hidden} from '../systemActions/operations/errors.js';

/** Built only from the live, authorized Run Project's bounded Task discovery. */
export class MissingTaskTarget extends OperationError {
  constructor(private readonly hint:string){super('operation_not_found',404);}
  override body(requestId:string){const body=super.body(requestId);body.error.message=this.hint;return body;}
}
export async function missingTaskTarget(db:Queryable,taskId:string,actor:OperationActor,operationId:string):Promise<never>{
  if(actor.principal.kind!=='agent'||!actor.run_id)throw hidden();
  try{
    await assertCurrentActor(db,actor,true);
    await assertOperationGrant(db,actor,operationId);
    const run=(await db.query<{project_id:string|null}>('SELECT project_id FROM runs WHERE id=$1 AND space_id=$2',[actor.run_id,actor.space_id])).rows[0];
    if(!run?.project_id)throw hidden();
    await lockActiveProjectForMutation(db,actor.space_id,run.project_id);
    await assertProjectWriterForMutation(db,actor.space_id,run.project_id,actor.on_behalf_of_user_id!);
    // Existing same-Space targets (including private/foreign/deleted) reveal nothing.
    // Never look in another Space: such an id is indistinguishable from a random missing id.
    if((await db.query('SELECT id FROM tasks WHERE id=$1 AND space_id=$2',[taskId,actor.space_id])).rowCount)throw hidden();
    // Same canonical content predicate, ordering and 50-row bound as task.list.
    const visible=(await db.query<{id:string;title:string}>(`SELECT t.id,t.title FROM tasks t
      WHERE t.space_id=$1 AND t.project_id=$2 AND t.deleted_at IS NULL
      AND ${contentReadSql('task','t','$3')}
      ORDER BY t.updated_at DESC,t.id DESC LIMIT 50`,[actor.space_id,run.project_id,actor.on_behalf_of_user_id])).rows;
    throw new MissingTaskTarget(visible.length
      ? `No Task in this Project has id '${taskId}'. Use one of these ids exactly: ${visible.map(t=>`${t.id} — ${t.title}`).join('; ')}`
      : `No Task in this Project has id '${taskId}', and this Project has no Task yet — create one with task.create.`);
  }catch(error){if(error instanceof MissingTaskTarget)throw error;throw hidden();}
}
