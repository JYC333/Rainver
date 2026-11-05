import type { Pool } from "../../db/pool.js";
import { resolveUserActorId } from "../../db/actorResolver.js";
import { HttpError, withDbTransaction, type SpaceUserIdentity } from "../routeUtils/common.js";
import { contentReadSql, contentAccessLevelSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from "../projects/access.js";
import { HARD_TERMINAL_RUN_STATUSES } from "../runs/orchestrationResults.js";
import { appendProjectWorkEvent } from "../projectWork/eventWriter.js";
import { enqueueTaskBranchDeletes } from "../hosts/taskBranchJobs.js";
import { withdrawTaskMerges } from "../hosts/taskMerges.js";

/** One deletion path for HTTP and Agent actions. Rows and execution evidence
 * remain for audit; the Task disappears from normal reads and the Board. */
export async function deleteTask(pool: Pool, identity: SpaceUserIdentity, taskId: string,
  origin?: { actorId: string; runId: string; projectId: string; reason: string }) {
  return withDbTransaction(pool, async db => {
    const read = async (lock: boolean) => (await db.query<{id: string; project_id: string | null; deleted_at: unknown}>(
      `SELECT t.id,t.project_id,t.deleted_at FROM tasks t WHERE t.space_id=$1 AND t.id=$2
       AND ${contentReadSql("task", "t", "$3")}
       AND ${contentAccessLevelSql({definition:contentResourceDefinition("task")!,alias:"t",userExpr:"$3"})}='full'
       ${lock ? "FOR UPDATE OF t" : ""}`, [identity.spaceId,taskId,identity.userId])).rows[0];
    const observed = await read(false);
    if (!observed || origin && observed.project_id !== origin.projectId) throw new HttpError(404,"Task not found");
    if (observed.project_id) {
      await lockActiveProjectForMutation(db,identity.spaceId,observed.project_id);
      await assertProjectWriterForMutation(db,identity.spaceId,observed.project_id,identity.userId);
    }
    const task = await read(true);
    if (!task) throw new HttpError(404,"Task not found");
    if (task.project_id !== observed.project_id) throw new HttpError(409,"Task Project changed; reload before deleting");
    if (task.deleted_at) return {task_id:taskId,deleted:true};
    const active = await db.query(`SELECT r.id FROM task_runs tr JOIN runs r ON r.id=tr.run_id AND r.space_id=tr.space_id
      WHERE tr.space_id=$1 AND tr.task_id=$2 AND NOT(r.status=ANY($3::varchar[])) LIMIT 1`,
      [identity.spaceId,taskId,[...HARD_TERMINAL_RUN_STATUSES]]);
    if (active.rowCount) throw new HttpError(409,"Stop the Task's unfinished Runs before deleting it");
    const plan = await db.query(`SELECT id FROM plans WHERE space_id=$1 AND source_task_id=$2 AND status='active' LIMIT 1`,[identity.spaceId,taskId]);
    if (plan.rowCount) throw new HttpError(409,"Stop the Task's active Plan before deleting it");
    await db.query(`UPDATE tasks SET deleted_at=now(),updated_at=now() WHERE id=$1 AND space_id=$2`,[taskId,identity.spaceId]);
    if (task.project_id) await appendProjectWorkEvent(db,{
      spaceId:identity.spaceId,projectId:task.project_id,subjectType:"task",subjectId:taskId,eventKind:"task.deleted",
      actorId:origin?.actorId??await resolveUserActorId(db,identity.spaceId,identity.userId),
      runId:origin?.runId,idempotencyKey:`task.deleted:${taskId}`,
      data:{summary:"Deleted Task",reason:origin?.reason??null},
    });
    await enqueueTaskBranchDeletes(db,{spaceId:identity.spaceId,userId:identity.userId,taskId});
    await withdrawTaskMerges(db,{spaceId:identity.spaceId,taskId});
    return {task_id:taskId,deleted:true};
  });
}
