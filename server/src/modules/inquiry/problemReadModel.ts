import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectReadable } from "../projects/access.js";
import { threadReadableSql } from "./threadAccess.js";
/** Compact facts only. Never aggregate Step/Iteration/close-out bodies here. */
export const PROBLEM_SUMMARY_SQL = `jsonb_build_object(
 'round_number',COALESCE(boundary.round_number,0)+1,
 'round_started_at',boundary.created_at,
 'round_start_ref',jsonb_build_object('kind',CASE WHEN boundary.id IS NULL THEN 'thread' ELSE 'round_closeout' END,'id',COALESCE(boundary.id,t.object_id)),
 'version',t.version,'revision',t.problem_revision,
 'current_focus',CASE WHEN primary_step.id IS NULL THEN NULL ELSE jsonb_build_object('step_id',primary_step.id,'method_version',primary_step.method_version,'stage',primary_step.method_stage,'work_kind',primary_step.work_kind) END)`;
export const PROBLEM_SUMMARY_JOINS = `LEFT JOIN LATERAL (SELECT id,round_number,created_at FROM inquiry_round_closeouts WHERE thread_id=t.object_id AND space_id=t.space_id ORDER BY round_number DESC LIMIT 1) boundary ON true
 LEFT JOIN inquiry_thread_steps primary_step ON primary_step.thread_id=t.object_id AND primary_step.space_id=t.space_id AND primary_step.slot='primary' AND primary_step.status='in_progress'`;
export async function problemSummaries(db: Queryable, identity: SpaceUserIdentity, projectId: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
  const rows = await db.query<{
    id: string;
    summary: Record<string, unknown>;
  }>(`SELECT t.object_id AS id,${PROBLEM_SUMMARY_SQL} AS summary FROM inquiry_threads t JOIN space_objects so ON so.id=t.object_id AND so.space_id=t.space_id ${PROBLEM_SUMMARY_JOINS} WHERE t.space_id=$1 AND t.project_id=$2 AND t.object_id=ANY($3::varchar[]) AND ${threadReadableSql("so", "$4", "read_content")}`, [identity.spaceId, projectId, ids, identity.userId]);
  return new Map(rows.rows.map(r => [r.id, r.summary]));
}
export async function problemThreadPage(db: Queryable, identity: SpaceUserIdentity, projectId: string, options: {
  kind?: string;
  limit?: number;
  after_thread_id?: string;
} = {}) {
  await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100);
  const rows = await db.query<{
    thread_id: string;
    kind: string;
    statement: string;
    attention_state: string;
    problem: Record<string, unknown> | null;
  }>(`SELECT t.object_id AS thread_id,t.kind,left(t.statement,500) AS statement,length(t.statement)>500 AS statement_truncated,t.attention_state,
 CASE WHEN ${threadReadableSql("so", "$3", "read_content")} THEN ${PROBLEM_SUMMARY_SQL} ELSE NULL END AS problem
 FROM inquiry_threads t JOIN space_objects so ON so.id=t.object_id AND so.space_id=t.space_id ${PROBLEM_SUMMARY_JOINS}
 WHERE t.space_id=$1 AND t.project_id=$2 AND t.lifecycle_status='active' AND ${threadReadableSql("so", "$3", "read")}
 AND ($4::text IS NULL OR t.kind=$4) AND ($5::varchar IS NULL OR t.object_id>$5) ORDER BY t.object_id LIMIT $6`, [identity.spaceId, projectId, identity.userId, options.kind ?? null, options.after_thread_id ?? null, limit + 1]);
  const items = rows.rows.slice(0, limit);
  return {
    threads: items,
    next_cursor: rows.rows.length > limit ? items[items.length - 1]!.thread_id : null
  };
}
