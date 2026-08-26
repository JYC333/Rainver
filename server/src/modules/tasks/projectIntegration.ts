import { contentReadSql } from "../access/contentAccessSql.js";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry.js";
import {
  projectEntitySummaryRegistry,
  projectModeProjectionRegistry,
  type ModeOverviewProjection,
  type ProjectEntitySummary,
  type ProjectEntitySummaryAdapter,
  type ProjectModeProjectionAdapter,
} from "../projects/overviewRegistry.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";

interface DeliveryTask {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  blocked_reason: string | null;
}

async function deliveryTasks(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
): Promise<DeliveryTask[]> {
  const result = await db.query<DeliveryTask>(
    `SELECT t.id,t.title,t.status,t.due_at,t.blocked_reason
       FROM tasks t
      WHERE t.space_id=$1 AND t.project_id=$2 AND t.deleted_at IS NULL
        AND ${contentReadSql("task", "t", "$3")}
      ORDER BY
        CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 ELSE 3 END,
        t.due_at NULLS LAST,t.updated_at DESC`,
    [identity.spaceId, projectId, identity.userId],
  );
  return result.rows;
}

const deliveryModeAdapter: ProjectModeProjectionAdapter = {
  mode: "delivery",
  async getOverviewProjection(db, identity, projectId): Promise<ModeOverviewProjection> {
    const tasks = await deliveryTasks(db, identity, projectId);
    const open = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
    const blocked = open.filter((task) => task.status === "blocked");
    const done = tasks.filter((task) => task.status === "done");
    return {
      mode: "delivery",
      current_state_summary: `${open.length} open Task${open.length === 1 ? "" : "s"}; ${blocked.length} blocked; ${done.length} done`,
      progress_indicators: [
        { metric: "open_tasks", value: open.length },
        { metric: "blocked_tasks", value: blocked.length },
        { metric: "completed_tasks", value: done.length },
      ],
      focus_set: open.slice(0, 10).map((task) => ({
        id: task.id,
        label: task.title,
        href: `/projects/${projectId}/delivery`,
      })),
      next_actions: [{
        id: "open-delivery",
        label: open.length > 0 ? "Continue delivery" : "Plan delivery",
        href: `/projects/${projectId}/delivery`,
        kind: open.length > 0 ? "execute" : "plan",
      }],
    };
  },
};

const deliveryAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "delivery",
  async listAttentionItems(db, identity, projectId): Promise<ProjectAttentionItem[]> {
    const now = Date.now();
    return (await deliveryTasks(db, identity, projectId))
      .filter((task) => task.status === "blocked"
        || (!["done", "cancelled"].includes(task.status)
          && task.due_at !== null
          && Date.parse(task.due_at) < now))
      .map((task) => ({
        id: `task:${task.id}`,
        project_id: projectId,
        area_kind: "delivery",
        source_type: "task",
        source_id: task.id,
        severity: task.status === "blocked" ? "high" : "normal",
        title: task.title,
        summary: task.blocked_reason,
        reason: task.status === "blocked" ? "blocked" : "overdue",
        due_at: task.due_at,
        blocking_refs: [],
        action_descriptors: [{ label: "Open task", href: `/tasks/${task.id}` }],
        href: `/tasks/${task.id}`,
      }));
  },
};

/** Tasks are Delivery's entity. The Mode projection above says what to do
 *  next; this row says how much of it there is. */
const deliveryTaskSummaryAdapter: ProjectEntitySummaryAdapter = {
  entityType: "task",
  label: "Tasks",
  detail: "Work items assigned and tracked",
  href: (projectId) => `/projects/${projectId}/delivery`,

  async getSummary(db, identity, projectId): Promise<ProjectEntitySummary> {
    const tasks = await deliveryTasks(db, identity, projectId);
    const open = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
    return {
      count: open.length,
      status: open.some((task) => task.status === "blocked") ? "blocked" : "ok",
    };
  },
};

export function registerTasksProjectIntegration(): void {
  projectModeProjectionRegistry.register(deliveryModeAdapter, "tasks");
  projectEntitySummaryRegistry.register(deliveryTaskSummaryAdapter, "tasks");
  projectAttentionRegistry.replace(deliveryAttentionAdapter);
}
