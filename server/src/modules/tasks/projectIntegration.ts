import { contentReadSql } from "../access/contentAccessSql.js";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { responsibleUserSql } from "../projectWork/responsibility.js";

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

const deliveryAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "delivery",
  async listAttentionItems(db, identity, projectId): Promise<ProjectAttentionItem[]> {
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
      }));
  },
};

export function registerTasksProjectIntegration(): void {
  projectAttentionRegistry.replace(deliveryAttentionAdapter);
}
