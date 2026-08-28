import { contentReadSql } from "../access/contentAccessSql.js";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";

interface OperationsSnapshot {
  alerts: Array<{ id: string; title: string | null; content: string | null; occurred_at: string }>;
}

async function snapshot(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<OperationsSnapshot> {
  const [alerts] = await Promise.all([
    db.query<{ id: string; title: string | null; content: string | null; occurred_at: string }>(
      `SELECT ar.id,ar.title,ar.content,ar.occurred_at
         FROM activity_records ar
        WHERE ar.space_id=$1 AND ar.project_id=$2
          AND ar.activity_type='operational_alert'
          AND ar.discarded_at IS NULL
          AND ${contentReadSql("activity", "ar", "$3")}
        ORDER BY ar.occurred_at DESC LIMIT 20`,
      [identity.spaceId, projectId, identity.userId],
    ),
  ]);
  return { alerts: alerts.rows };
}

const operationsAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "operations",
  async listAttentionItems(db, identity, projectId): Promise<ProjectAttentionItem[]> {
    const state = await snapshot(db, identity, projectId);
    return state.alerts.map((alert) => ({
      id: `operational_alert:${alert.id}`,
      attention_class: "gate",
      project_id: projectId,
      area_kind: "operations",
      source_type: "operational_alert",
      source_id: alert.id,
      severity: "high",
      title: alert.title ?? "Operational alert",
      summary: alert.content,
      reason: "operational alert",
      due_at: null,
      blocking_refs: [],
      // An alert is an activity record; the Space Inbox filtered to this
      // Project is where it is read and cleared. The Project's own Operations
      // Area, which used to render a copy, is retired.
      action_descriptors: [{ label: "Review", href: `/activity?project_id=${projectId}` }],
      href: `/activity?project_id=${projectId}`,
    }));
  },
};

export function registerAutomationsProjectIntegration(): void {
  projectAttentionRegistry.replace(operationsAttentionAdapter);
}
