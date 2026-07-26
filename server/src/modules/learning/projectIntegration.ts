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
import { LearningService } from "./service";

// Registers Learning into the Project Kernel's registries (ADR 0011 decision
// 5), mirroring modules/inquiry and modules/decisions project integration.
// Mastery/scheduling is per-user (plan section 13.5), so the Overview and
// Attention projections below are scoped to the requesting identity's own
// mastery state, not a Project-wide aggregate across all members.

const learningModeAdapter: ProjectModeAreaAdapter = {
  mode: "learning",

  async getOverviewProjection(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ModeOverviewProjection> {
    const learning = new LearningService(db);
    const summary = await learning.getMasterySummary(identity, { projectId });
    const objectives = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM learning_objectives WHERE space_id = $1 AND project_id = $2 AND status = 'active' ORDER BY updated_at DESC LIMIT 10`,
      [identity.spaceId, projectId],
    );

    return {
      mode: "learning",
      current_state_summary: `${summary.mastered_count} mastered, ${summary.learning_count} in progress, ${summary.due_count} due for review`,
      progress_indicators: [
        { metric: "mastered_count", value: summary.mastered_count },
        { metric: "due_count", value: summary.due_count },
      ],
      focus_set: objectives.rows.map((o) => ({ id: o.id, label: o.title, href: `/projects/${projectId}/learning` })),
      next_actions: summary.due_count > 0
        ? [{ id: "review-due", label: `Review ${summary.due_count} due card${summary.due_count === 1 ? "" : "s"}`, href: `/projects/${projectId}/learning`, kind: "review" }]
        : [],
    };
  },

  async getAreaSummary(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectAreaSummary> {
    const items = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM learning_items WHERE space_id = $1 AND project_id = $2`,
      [identity.spaceId, projectId],
    );
    const summary = await new LearningService(db).getMasterySummary(identity, { projectId });
    return { count: items.rows[0]?.total ?? 0, status: summary.due_count > 0 ? "attention" : "ok" };
  },
};

const learningAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "learning",
  async listAttentionItems(db: Queryable, identity: SpaceUserIdentity, projectId: string): Promise<ProjectAttentionItem[]> {
    const summary = await new LearningService(db).getMasterySummary(identity, { projectId });
    if (summary.due_count === 0) return [];
    return [{
      id: `learning_due:${projectId}`,
      project_id: projectId,
      area_kind: "learning",
      source_type: "learning_review_queue",
      source_id: projectId,
      severity: "low",
      title: `${summary.due_count} card${summary.due_count === 1 ? "" : "s"} due for review`,
      summary: null,
      reason: "scheduled review",
      due_at: null,
      blocking_refs: [],
      action_descriptors: [{ label: "Review", href: `/projects/${projectId}/learning` }],
      href: `/projects/${projectId}/learning`,
    }];
  },
};

export function registerLearningProjectIntegration(): void {
  projectModeProjectionRegistry.register(learningModeAdapter);
  projectAttentionRegistry.register(learningAttentionAdapter);
}
