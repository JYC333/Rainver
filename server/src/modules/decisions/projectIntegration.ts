import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import {
  projectEntitySummaryRegistry,
  type ProjectEntitySummary,
  type ProjectEntitySummaryAdapter,
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

/**
 * A Decision Case is an entity every Project can hold, not a way of advancing
 * work.
 *
 * It used to register a Primary Mode projection. Deciding is where research
 * ends, so `research` absorbed that Mode — and a Project that advances by
 * delivery makes decisions too, which is exactly why it was never a Mode of
 * its own. Cases ready to decide still reach the shell through the attention
 * adapter below.
 */
const decisionEntitySummaryAdapter: ProjectEntitySummaryAdapter = {
  entityType: "decision_case",
  label: "Decision Cases",
  detail: "Open choices with scored Options",
  href: (projectId) => `/projects/${projectId}/decisions`,

  async getSummary(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectEntitySummary> {
    const open = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM decision_cases WHERE space_id = $1 AND project_id = $2 AND status = 'open'`,
      [identity.spaceId, projectId],
    );
    const readyToDecide = await readyToDecideCases(db, identity.spaceId, projectId);
    const status: ProjectEntitySummary["status"] = readyToDecide.length > 0 ? "attention" : "ok";
    return { count: open.rows[0]?.total ?? 0, status };
  },
};

// A Case is ready once it has at least two Options, at least one Criterion,
// and every active Option has a score for every Criterion.
async function readyToDecideCases(db: Queryable, spaceId: string, projectId: string): Promise<Array<{ id: string; title: string }>> {
  const rows = await db.query<{ id: string; title: string }>(
    `SELECT c.object_id AS id, so.title FROM decision_cases c
      JOIN space_objects so ON so.id = c.object_id AND so.space_id = c.space_id
      WHERE c.space_id = $1 AND c.project_id = $2 AND c.status = 'open'
        AND (SELECT count(*) FROM decision_options o WHERE o.decision_case_id = c.object_id AND o.status = 'active') >= 2
        AND (SELECT count(*) FROM decision_criteria cr WHERE cr.decision_case_id = c.object_id) >= 1
        AND NOT EXISTS (
          SELECT 1
            FROM decision_options o
            CROSS JOIN decision_criteria cr
            LEFT JOIN decision_option_scores s
              ON s.option_id=o.id AND s.criterion_id=cr.id AND s.decision_case_id=c.object_id
           WHERE o.decision_case_id=c.object_id AND o.status='active' AND cr.decision_case_id=c.object_id
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
  projectEntitySummaryRegistry.register(decisionEntitySummaryAdapter);
  projectAttentionRegistry.register(decisionAttentionAdapter);
}
