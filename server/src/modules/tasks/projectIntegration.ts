import { contentReadSql } from "../access/contentAccessSql.js";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { responsibleUserSql } from "../projectWork/responsibility.js";
import { mergeFailureText } from "../hosts/taskMerges.js";

interface DeliveryTask {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  blocked_reason: string | null;
  claimed_by_user_id: string | null;
  claimed_by_agent_id: string | null;
  assigned_user_id: string | null;
  assigned_agent_id: string | null;
  created_by_user_id: string | null;
  responsible_user_id: string | null;
  loop_stage: string | null;
}

async function deliveryTasks(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
): Promise<DeliveryTask[]> {
  const result = await db.query<DeliveryTask>(
    `SELECT t.id,t.title,t.status,t.due_at,t.blocked_reason,
            t.claimed_by_user_id,t.claimed_by_agent_id,
            t.assigned_user_id,t.assigned_agent_id,t.created_by_user_id,
            ${responsibleUserSql("t", "p")} AS responsible_user_id,
            ls.current_stage_key AS loop_stage
       FROM tasks t
       JOIN projects p ON p.id=t.project_id AND p.space_id=t.space_id
       LEFT JOIN task_loop_states ls ON ls.task_id=t.id AND ls.space_id=t.space_id
      WHERE t.space_id=$1 AND t.project_id=$2 AND t.deleted_at IS NULL
        AND ${contentReadSql("task", "t", "$3")}
      ORDER BY
        CASE t.status
          WHEN 'waiting_for_review' THEN 0 WHEN 'blocked' THEN 1
          WHEN 'in_progress' THEN 2 WHEN 'ready' THEN 3 ELSE 4 END,
        t.due_at NULLS LAST,t.updated_at DESC`,
    [identity.spaceId, projectId, identity.userId],
  );
  return result.rows;
}

interface BlockedMerge {
  id: string;
  task_id: string;
  title: string;
  status: string;
  main_branch: string | null;
  detail_json: Record<string, unknown> | null;
}

/**
 * Merges of this Project's done Tasks that stopped on something a person has
 * to see (ADR 0016 §11), for the Task's responsible person. Their own
 * `source_type`, so snoozing one does not snooze the Task's other items.
 */
async function blockedMerges(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<BlockedMerge[]> {
  const result = await db.query<BlockedMerge>(
    `SELECT m.id, m.task_id, t.title, m.status, m.main_branch, m.detail_json
       FROM task_merges m
       JOIN tasks t ON t.id = m.task_id AND t.space_id = m.space_id
       JOIN projects p ON p.id = t.project_id AND p.space_id = t.space_id
      WHERE m.space_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL AND t.status = 'done'
        AND m.status IN ('waiting_local_changes', 'conflict', 'verification_failed', 'failed')
        AND ${responsibleUserSql("t", "p")} = $3
        AND ${contentReadSql("task", "t", "$3")}
      ORDER BY m.updated_at DESC`,
    [identity.spaceId, projectId, identity.userId],
  );
  return result.rows;
}

const MERGE_REASON_TEXT: Record<string, string> = {
  waiting_local_changes: "Ready to merge, waiting for uncommitted changes in the checkout that touch the same files",
  conflict: "Conflicts with the main branch; its branch is kept to merge by hand",
  verification_failed: "Its checks failed on top of the latest main branch",
  failed: "The merge failed",
};

function mergeAttentionItem(projectId: string, merge: BlockedMerge): ProjectAttentionItem {
  const detail = merge.detail_json ?? {};
  const files = Array.isArray(detail.conflicted_files) ? detail.conflicted_files
    : Array.isArray(detail.overlapping_files) ? detail.overlapping_files : [];
  const named = files.filter((file): file is string => typeof file === "string").slice(0, 5);
  // Waiting with no files: someone is rebasing, merging or bisecting the main
  // branch, not editing the same files.
  const reasonText = merge.status === "waiting_local_changes" && named.length === 0
    ? "Ready to merge, waiting for a rebase, merge or bisect of the main branch to finish"
    : MERGE_REASON_TEXT[merge.status] ?? merge.status;
  const error = typeof detail.error === "string" ? detail.error : null;
  return {
    id: `task_merge:${merge.id}`,
    attention_class: "gate",
    project_id: projectId,
    area_kind: "delivery",
    source_type: "task_merge",
    source_id: merge.id,
    // Waiting on the person's own edits resolves itself once they commit;
    // the others need a decision.
    severity: merge.status === "waiting_local_changes" ? "normal" : "high",
    title: merge.title,
    summary: [
      reasonText,
      named.length > 0 ? `: ${named.join(", ")}` : "",
      merge.status === "failed" ? `: ${mergeFailureText(error)}` : "",
    ].join(""),
    reason: `merge_${merge.status}`,
    due_at: null,
    blocking_refs: [],
    action_descriptors: [{ label: "Open task", href: `/tasks/${merge.task_id}` }],
    href: `/tasks/${merge.task_id}`,
  };
}

const deliveryAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "delivery",
  async listAttentionItems(db, identity, projectId): Promise<ProjectAttentionItem[]> {
    const merges = (await blockedMerges(db, identity, projectId)).map((merge) => mergeAttentionItem(projectId, merge));
    return [...merges, ...await taskAttentionItems(db, identity, projectId)];
  },
};

async function taskAttentionItems(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectAttentionItem[]> {
  const now = Date.now();
  const open = (task: DeliveryTask): boolean => !["done", "cancelled"].includes(task.status);
  return (await deliveryTasks(db, identity, projectId))
    // `waiting_for_review` is the state that means a person has to decide,
    // so it is the reason this surface exists. `blocked` is now only ever
    // set deliberately — Run failure stopped writing it, because a Run
    // ending badly is not the same fact as work being held up by something
    // else, and merging them lost which one had happened.
    .filter((task) => (open(task) && task.status === "waiting_for_review")
      || task.status === "blocked"
      || (open(task) && task.due_at !== null && Date.parse(task.due_at) < now))
    // Only the responsible person is interrupted. Everyone else still sees
    // the Task on the Board and can take it over; they just are not told to.
    .filter((task) => task.responsible_user_id === identity.userId)
    .map((task) => ({
      id: `task:${task.id}`,
      attention_class: "gate",
      project_id: projectId,
      area_kind: "delivery",
      source_type: "task",
      source_id: task.id,
      severity: task.status === "waiting_for_review" || task.status === "blocked" ? "high" : "normal",
      title: task.title,
      summary: task.blocked_reason,
      reason: task.status === "waiting_for_review"
        ? "waiting_for_review"
        : task.status === "blocked" ? "blocked" : "overdue",
      due_at: task.due_at,
      blocking_refs: [],
      action_descriptors: [{ label: "Open task", href: `/tasks/${task.id}` }],
      href: `/tasks/${task.id}`,
    } satisfies ProjectAttentionItem));
}

export function registerTasksProjectIntegration(): void {
  projectAttentionRegistry.replace(deliveryAttentionAdapter);
}
