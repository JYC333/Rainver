import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import {
  projectModeProjectionRegistry,
  type ModeOverviewProjection,
  type ProjectModeAreaAdapter,
  type ProjectAreaSummary,
} from "../projects/overviewRegistry";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry";

// Registers Decision into the Project Kernel's registries (ADR 0011 decision
// 5), mirroring modules/inquiry/projectIntegration.ts: modules/projects
// aggregates through these contracts and never queries decision_cases
// directly.

const decisionModeAdapter: ProjectModeAreaAdapter = {
  mode: "decision",

  async getOverviewProjection(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ModeOverviewProjection> {
    const counts = await db.query<{ open_cases: number; decided_cases: number }>(
      `SELECT
         count(*) FILTER (WHERE status = 'open')::int AS open_cases,
         count(*) FILTER (WHERE status = 'decided')::int AS decided_cases
       FROM decision_cases WHERE space_id = $1 AND project_id = $2`,
      [identity.spaceId, projectId],
    );
    const row = counts.rows[0] ?? { open_cases: 0, decided_cases: 0 };

    const readyToDecide = await readyToDecideCases(db, identity.spaceId, projectId);

    const focusSet = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM decision_cases
        WHERE space_id = $1 AND project_id = $2 AND status = 'open'
        ORDER BY updated_at DESC LIMIT 10`,
      [identity.spaceId, projectId],
    );

    return {
      mode: "decision",
      current_state_summary: `${row.open_cases} open Decision Case${row.open_cases === 1 ? "" : "s"} (${row.decided_cases} decided)`,
      progress_indicators: [
        { metric: "open_cases", value: row.open_cases },
        { metric: "ready_to_decide", value: readyToDecide.length },
      ],
      focus_set: focusSet.rows.map((c) => ({ id: c.id, label: c.title, href: `/projects/${projectId}/decisions` })),
      next_actions: readyToDecide.length > 0
        ? [{ id: "decide-cases", label: `Decide ${readyToDecide.length} ready Case${readyToDecide.length === 1 ? "" : "s"}`, href: `/projects/${projectId}/decisions`, kind: "decide" }]
        : [],
    };
  },

  async getAreaSummary(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectAreaSummary> {
    const open = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM decision_cases WHERE space_id = $1 AND project_id = $2 AND status = 'open'`,
      [identity.spaceId, projectId],
    );
    const readyToDecide = await readyToDecideCases(db, identity.spaceId, projectId);
    const status: ProjectAreaSummary["status"] = readyToDecide.length > 0 ? "attention" : "ok";
    return { count: open.rows[0]?.total ?? 0, status };
  },
};

// A Case is ready once it has at least two Options, at least one Criterion,
// and every active Option has a score for every Criterion.
async function readyToDecideCases(db: Queryable, spaceId: string, projectId: string): Promise<Array<{ id: string; title: string }>> {
  const rows = await db.query<{ id: string; title: string }>(
    `SELECT c.id, c.title FROM decision_cases c
      WHERE c.space_id = $1 AND c.project_id = $2 AND c.status = 'open'
        AND (SELECT count(*) FROM decision_options o WHERE o.decision_case_id = c.id AND o.status = 'active') >= 2
        AND (SELECT count(*) FROM decision_criteria cr WHERE cr.decision_case_id = c.id) >= 1
        AND NOT EXISTS (
          SELECT 1
            FROM decision_options o
            CROSS JOIN decision_criteria cr
            LEFT JOIN decision_option_scores s
              ON s.option_id=o.id AND s.criterion_id=cr.id AND s.decision_case_id=c.id
           WHERE o.decision_case_id=c.id AND o.status='active' AND cr.decision_case_id=c.id
             AND s.id IS NULL
        )`,
    [spaceId, projectId],
  );
  return rows.rows;
}

const decisionAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "decision",
  async listAttentionItems(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectAttentionItem[]> {
    const cases = await readyToDecideCases(db, identity.spaceId, projectId);
    return cases.map((c): ProjectAttentionItem => ({
      id: `decision_case:${c.id}`,
      project_id: projectId,
      area_kind: "decision",
      source_type: "decision_case",
      source_id: c.id,
      severity: "normal",
      title: c.title,
      summary: null,
      reason: "ready to decide between scored Options",
      due_at: null,
      blocking_refs: [],
      action_descriptors: [{ label: "Decide", href: `/projects/${projectId}/decisions?open=${c.id}` }],
      href: `/projects/${projectId}/decisions?open=${c.id}`,
    }));
  },
};

export function registerDecisionsProjectIntegration(): void {
  projectModeProjectionRegistry.register(decisionModeAdapter);
  projectAttentionRegistry.register(decisionAttentionAdapter);
}
