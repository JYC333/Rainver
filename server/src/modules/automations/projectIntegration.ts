import { contentReadSql } from "../access/contentAccessSql";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry";
import {
  projectModeProjectionRegistry,
  type ModeOverviewProjection,
  type ProjectModeAreaAdapter,
  type ProjectAreaSummary,
} from "../projects/overviewRegistry";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";

interface OperationsSnapshot {
  active_automations: number;
  paused_automations: number;
  active_runs: number;
  failed_runs: number;
  alerts: Array<{ id: string; title: string | null; content: string | null; occurred_at: string }>;
}

async function snapshot(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<OperationsSnapshot> {
  const [automations, runs, alerts] = await Promise.all([
    db.query<{ active: number; paused: number }>(
      `SELECT count(*) FILTER (WHERE status='active')::int AS active,
              count(*) FILTER (WHERE status='paused')::int AS paused
         FROM automations WHERE space_id=$1 AND project_id=$2`,
      [identity.spaceId, projectId],
    ),
    db.query<{ active: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('queued','waiting_for_dependency','running'))::int AS active,
              count(*) FILTER (WHERE status='failed')::int AS failed
         FROM runs r WHERE r.space_id=$1 AND r.project_id=$2
          AND ${contentReadSql("run", "r", "$3")}`,
      [identity.spaceId, projectId, identity.userId],
    ),
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
  return {
    active_automations: automations.rows[0]?.active ?? 0,
    paused_automations: automations.rows[0]?.paused ?? 0,
    active_runs: runs.rows[0]?.active ?? 0,
    failed_runs: runs.rows[0]?.failed ?? 0,
    alerts: alerts.rows,
  };
}

const operationsModeAdapter: ProjectModeAreaAdapter = {
  mode: "operations",
  async getOverviewProjection(db, identity, projectId): Promise<ModeOverviewProjection> {
    const state = await snapshot(db, identity, projectId);
    return {
      mode: "operations",
      current_state_summary: `${state.active_automations} active Automation${state.active_automations === 1 ? "" : "s"}; ${state.active_runs} active Run${state.active_runs === 1 ? "" : "s"}; ${state.alerts.length} alert${state.alerts.length === 1 ? "" : "s"}`,
      progress_indicators: [
        { metric: "active_automations", value: state.active_automations },
        { metric: "active_runs", value: state.active_runs },
        { metric: "failed_runs", value: state.failed_runs },
        { metric: "alerts", value: state.alerts.length },
      ],
      focus_set: state.alerts.slice(0, 10).map((alert) => ({
        id: alert.id,
        label: alert.title ?? "Operational alert",
        href: `/projects/${projectId}/operations`,
      })),
      next_actions: [{
        id: "open-operations",
        label: state.alerts.length > 0 ? "Review operations" : "Open operations",
        href: `/projects/${projectId}/operations`,
        kind: state.alerts.length > 0 ? "review" : "monitor",
      }],
    };
  },
  async getAreaSummary(db, identity, projectId): Promise<ProjectAreaSummary> {
    const state = await snapshot(db, identity, projectId);
    return {
      count: state.active_automations + state.active_runs,
      status: state.alerts.length > 0 || state.failed_runs > 0 ? "attention" : "ok",
    };
  },
};

const operationsAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "operations",
  async listAttentionItems(db, identity, projectId): Promise<ProjectAttentionItem[]> {
    const state = await snapshot(db, identity, projectId);
    return state.alerts.map((alert) => ({
      id: `operational_alert:${alert.id}`,
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
      action_descriptors: [{ label: "Review", href: `/projects/${projectId}/operations?alert=${alert.id}` }],
      href: `/projects/${projectId}/operations?alert=${alert.id}`,
    }));
  },
};

export function registerAutomationsProjectIntegration(): void {
  projectModeProjectionRegistry.register(operationsModeAdapter);
  projectAttentionRegistry.register(operationsAttentionAdapter);
}
