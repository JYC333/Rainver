import { describe, expect, it } from "vitest";
import {
  ProjectBriefVersionWriteRequestSchema,
  ProjectOverviewResponseSchema,
} from "../src/projects.js";

const overview = {
  project: {
    id: "project-1",
    name: "Project One",
    primary_mode: "research",
    status: "active",
  },
  brief: {
    id: "brief-1",
    space_id: "space-1",
    project_id: "project-1",
    version: "v1",
    goal: "Trace the evidence",
    scope_included: null,
    scope_excluded: null,
    success_definition: null,
    constraints: null,
    assumptions: null,
    project_status: "active",
    current_focus: "Trace the evidence",
    confirmed_decisions: [],
    primary_mode: "research",
    workspace_identity: {},
    workspace_boundary: {},
    source_refs: [],
    status: "published",
    reviewed_by_user_id: "user-1",
    reviewed_at: "2026-08-08T00:00:00.000Z",
    published_by_user_id: "user-1",
    published_at: "2026-08-08T00:00:00.000Z",
    created_by_user_id: "user-1",
    created_at: "2026-08-08T00:00:00.000Z",
  },
  definition_status: {
    status: "initialized",
    basis: "published_brief_goal",
    goal_or_problem: "Trace the evidence",
  },
  mode_projection: {
    mode: "research",
    current_state_summary: "No research under way.",
    progress_indicators: [],
    focus_set: [],
    next_actions: [],
  },
  available_modes: ["research", "delivery", "operations", "learning"],
  attention: [],
  setup_checklist: [{
    id: "brief",
    label: "Project Brief goal",
    status: "ready",
    required: true,
    href: "/projects/project-1/inquiry?setup=goal",
    detail: "Goal recorded",
  }],
  entity_summaries: [],
};

describe("ProjectOverviewResponseSchema", () => {
  it("accepts partial typed Brief drafts and rejects malformed or unknown fields", () => {
    expect(ProjectBriefVersionWriteRequestSchema.safeParse({ goal: "Understand X" }).success).toBe(true);
    expect(ProjectBriefVersionWriteRequestSchema.safeParse({ goal: 123 }).success).toBe(false);
    expect(ProjectBriefVersionWriteRequestSchema.safeParse({ goal: "Understand X", embedded_context: "no" }).success).toBe(false);
  });

  it("keeps the persistent shell setup checklist in the public contract", () => {
    expect(ProjectOverviewResponseSchema.parse(overview).setup_checklist).toEqual(
      overview.setup_checklist,
    );
    const { setup_checklist: _omitted, ...withoutChecklist } = overview;
    expect(ProjectOverviewResponseSchema.safeParse(withoutChecklist).success).toBe(false);
  });
});
