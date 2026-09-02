import { describe, expect, it } from "vitest";
import {
  ProjectBriefVersionWriteRequestSchema,
  ProjectOverviewResponseSchema,
} from "../src/projects.js";
import { ProjectWorkUpdateSchema } from "../src/projectWork.js";

const overview = {
  project: {
    id: "project-1",
    name: "Project One",
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
  has_project_folder: false,
  mode_projection: {
    mode: "research",
    current_state_summary: "No research under way.",
    progress_indicators: [],
    focus_set: [],
    next_actions: [],
  },
  attention: [],
  in_progress: [{
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "project-1",
    kind: "research",
    title: "Start initial material intake",
    status: "active",
    progress_json: { current_stage: "screening", screening_progress: { total_items: 873, classified_items: 848 } },
    created_at: "2026-08-27T16:00:00.000Z",
    updated_at: "2026-08-27T20:00:00.000Z",
  }],
};

describe("ProjectOverviewResponseSchema", () => {
  it("parses the overview contract the shell reads", () => {
    expect(ProjectOverviewResponseSchema.safeParse(overview).success).toBe(true);
  });

  it("accepts partial typed Brief drafts and rejects malformed or unknown fields", () => {
    expect(ProjectBriefVersionWriteRequestSchema.safeParse({ goal: "Understand X" }).success).toBe(true);
    expect(ProjectBriefVersionWriteRequestSchema.safeParse({ goal: 123 }).success).toBe(false);
    expect(ProjectBriefVersionWriteRequestSchema.safeParse({ goal: "Understand X", embedded_context: "no" }).success).toBe(false);
  });

});

describe("ProjectWorkUpdateSchema", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    event_kind: "thread.created" as const,
    occurred_at: "2026-08-28T09:00:00.000Z",
    actor: { kind: "agent" as const, id: "22222222-2222-4222-8222-222222222222", display_name: "Assistant" },
    summary: "Question opened",
    outcome: null,
    subject: { type: "inquiry_thread" as const, id: "33333333-3333-4333-8333-333333333333", title: "A question" },
    undo: { action: "archive_thread" as const, target_id: "33333333-3333-4333-8333-333333333333" },
    undone_by_event_id: null,
  };

  it("carries a fold whose members keep their own undo", () => {
    // The client contract for review-after (ADR 0017 §4). Without a test the
    // fold, the undo and the generalised subject are validated by nothing.
    const parsed = ProjectWorkUpdateSchema.parse({
      ...base,
      id: "fold:run-1:thread.created",
      summary: "Opened 3 questions",
      subject: null,
      undo: null,
      members: [base, { ...base, id: "44444444-4444-4444-8444-444444444444" }],
    });
    expect(parsed.members).toHaveLength(2);
    expect(parsed.members![0]!.undo).toEqual({ action: "archive_thread", target_id: base.subject.id });
  });

  it("requires every field the read model derives, and rejects an unknown one", () => {
    expect(ProjectWorkUpdateSchema.safeParse({ ...base, members: null }).success).toBe(true);
    // A Task subject is the other kind the stream names.
    expect(ProjectWorkUpdateSchema.safeParse({
      ...base, subject: { type: "task", id: base.subject.id, title: "A task" }, members: null,
    }).success).toBe(true);
    for (const missing of ["undo", "undone_by_event_id", "members", "subject"]) {
      const { [missing]: _dropped, ...rest } = { ...base, members: null } as Record<string, unknown>;
      expect(ProjectWorkUpdateSchema.safeParse(rest).success).toBe(false);
    }
    expect(ProjectWorkUpdateSchema.safeParse({ ...base, members: null, task: { id: "x", title: "y" } }).success).toBe(false);
    expect(ProjectWorkUpdateSchema.safeParse({
      ...base, members: null, undo: { action: "delete_thread", target_id: base.subject.id },
    }).success).toBe(false);
  });
});
