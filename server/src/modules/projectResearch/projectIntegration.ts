import type { Queryable } from "../routeUtils/common.js";
import {
  projectEntitySummaryRegistry,
  projectModeProjectionRegistry,
  type ModeOverviewProjection,
  type ProjectEntitySummary,
  type ProjectEntitySummaryAdapter,
  type ProjectModeProjectionAdapter,
} from "../projects/overviewRegistry.js";

interface ResearchState {
  active_workflows: number;
  total_workflows: number;
  pending_checkpoints: number;
  paused_workflows: number;
}

async function researchState(db: Queryable, spaceId: string, projectId: string): Promise<ResearchState> {
  const [workflows, checkpoints] = await Promise.all([
    db.query<{ active: number; total: number; paused: number }>(
      `SELECT
         count(*) FILTER (WHERE status = 'active')::int AS active,
         count(*) FILTER (WHERE status <> 'archived')::int AS total,
         count(*) FILTER (WHERE status = 'paused')::int AS paused
       FROM project_research_workflows WHERE space_id = $1 AND project_id = $2`,
      [spaceId, projectId],
    ),
    db.query<{ pending: number }>(
      `SELECT count(*)::int AS pending
         FROM project_research_checkpoints
        WHERE space_id = $1 AND project_id = $2 AND status = 'pending'`,
      [spaceId, projectId],
    ),
  ]);
  const workflow = workflows.rows[0] ?? { active: 0, total: 0, paused: 0 };
  return {
    active_workflows: workflow.active,
    total_workflows: workflow.total,
    pending_checkpoints: checkpoints.rows[0]?.pending ?? 0,
    paused_workflows: workflow.paused,
  };
}

/**
 * Research is a way of advancing work: an open question, material gathered
 * against it, evidence screened out of that material, and a conclusion.
 *
 * It absorbed `inquiry` and `decision` as Modes — asking is how research
 * starts and deciding is where it ends, so neither is a separate way of
 * advancing. Both remain entities with their own Areas, and Inquiry's pending
 * Candidates still reach the shell through its attention adapter, so nothing
 * this projection leaves out becomes unreachable.
 */
const researchModeAdapter: ProjectModeProjectionAdapter = {
  mode: "research",

  async getOverviewProjection(db, identity, projectId): Promise<ModeOverviewProjection> {
    const state = await researchState(db, identity.spaceId, projectId);
    const focusSet = await db.query<{ id: string; question: string | null; stage: string | null }>(
      `SELECT w.object_id AS id,
              w.state_json ->> 'research_question' AS question,
              w.current_stage AS stage
         FROM project_research_workflows w
         JOIN space_objects so ON so.id = w.object_id AND so.space_id = w.space_id
        WHERE w.space_id = $1 AND w.project_id = $2 AND w.status = 'active'
        ORDER BY so.updated_at DESC LIMIT 10`,
      [identity.spaceId, projectId],
    );

    const nextActions: ModeOverviewProjection["next_actions"] = [];
    if (state.pending_checkpoints > 0) {
      nextActions.push({
        id: "review-checkpoints",
        label: `Review ${state.pending_checkpoints} paused research step${state.pending_checkpoints === 1 ? "" : "s"}`,
        href: `/projects/${projectId}/operations`,
        kind: "review",
      });
    }
    if (state.total_workflows === 0) {
      nextActions.push({
        id: "start-research",
        label: "Define a question to research",
        href: `/projects/${projectId}/inquiry`,
        kind: "create",
      });
    }

    return {
      mode: "research",
      current_state_summary: state.total_workflows === 0
        ? "No research under way."
        : `${state.active_workflows} running search${state.active_workflows === 1 ? "" : "es"} of ${state.total_workflows}`,
      progress_indicators: [
        { metric: "active_workflows", value: state.active_workflows },
        { metric: "pending_checkpoints", value: state.pending_checkpoints },
      ],
      focus_set: focusSet.rows.map((row) => ({
        id: row.id,
        label: row.question ?? row.stage ?? "Research workflow",
        href: `/projects/${projectId}/research`,
      })),
      next_actions: nextActions,
    };
  },
};

const researchWorkflowSummaryAdapter: ProjectEntitySummaryAdapter = {
  entityType: "research_workflow",
  label: "Research workflows",
  detail: "Questions being searched and screened",
  href: (projectId) => `/projects/${projectId}/research`,
  async getSummary(db, identity, projectId): Promise<ProjectEntitySummary> {
    const state = await researchState(db, identity.spaceId, projectId);
    return {
      count: state.total_workflows,
      // A paused Workflow is stopped until someone acts, which is what
      // `blocked` means here; a pending checkpoint is a decision waiting.
      status: state.pending_checkpoints > 0
        ? "attention"
        : state.paused_workflows > 0
          ? "blocked"
          : "ok",
    };
  },
};

// Both registries upsert by key, so calling this repeatedly (module init, or a
// test resetting a registry between cases) is always safe.
export function registerProjectResearchProjectIntegration(): void {
  projectModeProjectionRegistry.register(researchModeAdapter, "project_research");
  projectEntitySummaryRegistry.register(researchWorkflowSummaryAdapter, "project_research");
}
