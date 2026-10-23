import { describe, expect, it } from "vitest";
import { AgentAttentionOperationSchema, AgentAttentionPageSchema, AgentAttentionQuerySchema, AgentAttentionReadRequestSchema, AgentAttentionReasonSchema, AgentAttentionRunSchema, AgentAttentionViewResultSchema, AgentWorkIdentitySchema, AgentWorkItemSchema } from "../src/agentAttention.js";
import { RUN_STATUS_VALUES, RunContractSourceKindSchema } from "../src/runOrchestration.js";
import { AgentRunGroupMemberRoleSchema } from "../src/agentGroupRuns.js";
import { RunDTOSchema } from "../src/schemas.js";
import { TASK_STATUSES, TaskMergeBlockedOutcomeSchema, TaskMergeOutcomeSchema } from "../src/projectWork.js";
import { RunResourceWaitCodeSchema } from "../src/turnParts.js";

const run = {
  run_id: "run", agent_id: "agent", status: "succeeded", turn_state: "done", blocked_on: null,
  trigger_origin: "autonomous", parent_run_id: "coordinator", root_run_id: "coordinator", cause_run_id: null,
  run_group_id: null, delegation_id: null, session_id: null, room_id: null, task_role: null, task_run_role: null,
  run_role: "execution", plan_id: null, plan_node_id: null, workflow_execution_id: null,
  contract_source: { kind: "automation", id: "automation" }, automation_id: "automation", autonomy_tick_id: "tick", autonomy_candidate_id: "candidate",
  owner_user_id: "user", instructed_by_user_id: "user", ended_at: "2026-10-21T12:00:00Z",
  retry_of_run_id: null, retry_superseded: false,
};
const subject = { kind: "run_result", schema_version: 1, run_id: "run", attempt_id: "attempt", revision: "terminal-1" };
const item = {
  identity: { kind: "run", source_id: "coordinator" }, work_key: "opaque-work", space_id: "space", project_id: null,
  title: "Autonomous work", access_level: "full", group: "recently_finished", mine: true,
  source_run_id: null,
  responsible: { kind: "user", id: "user", display_name: "User" },
  task_status: null, loop_stage: null, task_completed_at: null, runs: [run], reasons: [],
  read_states: [{ subject, unread: true, manual_unread: false, read_at: null, state_version: 0 }],
  unread: true, last_activity_at: "2026-10-21T12:00:00Z", visible_run_count: 1, runs_next_cursor: null, operations: [],
};

describe("Agent attention contracts", () => {
  it("represents every stable source without requiring a Project or a replyable Session", () => {
    for (const kind of ["task", "session", "agent_group", "run"]) {
      expect(AgentWorkItemSchema.parse({ ...item, identity: { kind, source_id: "source" } }).identity.kind).toBe(kind);
    }
    expect(AgentWorkIdentitySchema.safeParse({ kind: "agent", source_id: "agent" }).success).toBe(false);
  });
  it("reuses the complete Run vocabulary while keeping Turn and Task axes independent", () => {
    for (const status of RUN_STATUS_VALUES) expect(AgentAttentionRunSchema.parse({ ...run, status }).status).toBe(status);
    const reason = { kind: "awaiting_answer", message_id: "question", session_id: "session", agent_id: "agent", responsible: { kind: "user", id: "user", display_name: "User" } };
    expect(AgentWorkItemSchema.parse({ ...item, group: "needs_you", reasons: [reason], task_status: "waiting_for_review", loop_stage: "verify" }).runs[0]?.status).toBe("succeeded");
  });
  it("rejects body/credential leakage and unbounded summaries", () => {
    for (const extra of [{ prompt: "private" }, { output_json: {} }, { api_key: "secret" }]) {
      expect(AgentAttentionRunSchema.safeParse({ ...run, ...extra }).success).toBe(false);
    }
    expect(AgentWorkItemSchema.safeParse({ ...item, runs: Array(101).fill(run) }).success).toBe(false);
    expect(AgentWorkItemSchema.safeParse({ ...item, title: "x".repeat(501) }).success).toBe(false);
  });
  it("accepts bounded display metadata without requiring it from older snapshots", () => {
    expect(AgentAttentionRunSchema.parse(run)).not.toHaveProperty('agent_name');
    const metadata = { agent_name: 'Builder', runtime_key: 'codex', started_at: '2026-10-21T11:00:00Z' };
    expect(AgentAttentionRunSchema.parse({ ...run, ...metadata })).toMatchObject(metadata);
    for (const invalid of [{ agent_name: 'x'.repeat(501) }, { runtime_key: 'x'.repeat(65) }, { started_at: 42 }]) {
      expect(AgentAttentionRunSchema.safeParse({ ...run, ...invalid }).success).toBe(false);
    }
  });
  it("uses bounded server cursors and permits history without an optional time window", () => {
    expect(AgentAttentionQuerySchema.parse({})).toEqual({ scope: "mine", view: "current", limit: 50 });
    expect(AgentAttentionQuerySchema.parse({ view: "history" })).toEqual({ scope: "mine", view: "history", limit: 50 });
    expect(AgentAttentionQuerySchema.parse({ scope: "all_visible", limit: "100", view: "history", since: "2026-10-20T00:00:00Z", until: "2026-10-21T00:00:00Z" }).limit).toBe(100);
    for (const query of [{ limit: 101 }, { limit: 0 }, { cursor: "" }, { user_id: "other" }, { since: "2026-10-20T00:00:00Z" }, { view: "history", since: "bad" }, { view: "history", since: "2026-10-21T00:00:00Z", until: "2026-10-20T00:00:00Z" }]) expect(AgentAttentionQuerySchema.safeParse(query).success).toBe(false);
  });
  it("reuses authoritative Run, group-member and contract-source vocabularies", () => {
    for (const run_role of RunDTOSchema.shape.run_role.options) expect(AgentAttentionRunSchema.parse({ ...run, run_role }).run_role).toBe(run_role);
    for (const task_role of AgentRunGroupMemberRoleSchema.options) expect(AgentAttentionRunSchema.parse({ ...run, task_role }).task_role).toBe(task_role);
    for (const kind of RunContractSourceKindSchema.options) expect(AgentAttentionRunSchema.parse({ ...run, contract_source: { kind, id: null } }).contract_source?.kind).toBe(kind);
    for (const changes of [{ run_role: "worker" }, { task_role: "primary" }, { contract_source: { kind: "invented", id: "source" } }]) expect(AgentAttentionRunSchema.safeParse({ ...run, ...changes }).success).toBe(false);
    expect(AgentAttentionRunSchema.parse({ ...run, task_role: "worker", task_run_role: "planning" }).task_run_role).toBe("planning");
  });
  it("accepts only owning resource wait codes and Task statuses", () => {
    for (const code of RunResourceWaitCodeSchema.options) expect(AgentAttentionReasonSchema.parse({ kind: "resource", run_id: "run", code, dependency_run_ids: [] }).kind).toBe("resource");
    expect(AgentAttentionReasonSchema.safeParse({ kind: "resource", run_id: "run", code: "please approve", dependency_run_ids: [] }).success).toBe(false);
    const task = { kind: "task", task_id: "task", responsible: item.responsible };
    for (const status of TASK_STATUSES) expect(AgentAttentionReasonSchema.parse({ ...task, status }).kind).toBe("task");
    expect(AgentAttentionReasonSchema.safeParse({ ...task, status: "pending" }).success).toBe(false);
  });
  it("accepts exactly the four blocked Task merge outcomes, never success or a deduplication key", () => {
    const reason = { kind: "task_merge", task_id: "task", merge_id: "merge", responsible: item.responsible };
    const blocked = ["waiting_local_changes", "conflict", "verification_failed", "failed"];
    expect(TaskMergeBlockedOutcomeSchema.options).toEqual(blocked);
    expect(TaskMergeOutcomeSchema.parse("merged")).toBe("merged");
    for (const code of blocked) {
      expect(AgentAttentionReasonSchema.parse({ ...reason, code })).toEqual({ ...reason, code });
    }
    for (const code of ["merged", "arbitrary", "conflict:0123456789abcdef"]) {
      expect(AgentAttentionReasonSchema.safeParse({ ...reason, code }).success).toBe(false);
    }
  });
  it.each([
    { kind: "open_session", space_id: "space", session_id: "session", room_id: null, agent_id: "agent" },
    { kind: "open_task", space_id: "space", task_id: "task" },
    { kind: "stop_run", space_id: "space", run_id: "run" },
    { kind: "resume_run", space_id: "space", run_id: "run" },
    { kind: "authorization", space_id: "space", authorization_request_id: "request" },
    { kind: "run_decision", space_id: "space", run_id: "run" },
    { kind: "proposal", space_id: "space", proposal_id: "proposal" },
  ])("accepts $kind locators and rejects additional operation fields", (operation) => {
    expect(AgentAttentionOperationSchema.parse(operation)).toEqual(operation);
    expect(AgentAttentionOperationSchema.safeParse({ ...operation, command: "arbitrary" }).success).toBe(false);
  });
  it("keeps counts independent of the current page and validates nonnegative counts", () => {
    const page = { items: [item], next_cursor: "server-cursor", as_of: "2026-10-21T12:00:00Z", counts: { needs_you: 200, recently_finished: 20, working: 100, waiting: 3, idle: 1 } };
    expect(AgentAttentionPageSchema.parse(page).counts.needs_you).toBe(200);
    expect(AgentAttentionPageSchema.safeParse({ ...page, counts: { ...page.counts, idle: -1 } }).success).toBe(false);
  });
  it("acknowledges one displayed subject with concurrency control, never arbitrary user identity or event ordering", () => {
    const request = { identity: item.identity, space_id: "space", subject, state_version: 3, action: "read" };
    expect(AgentAttentionReadRequestSchema.parse(request).state_version).toBe(3);
    for (const change of [{ user_id: "other" }, { state_version: -1 }, { subject: { ...subject, event_index: 999 } }, { subject: { ...subject, schema_version: 2 } }]) expect(AgentAttentionReadRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  });
  it("returns bounded content-free versions from a view report for a subsequent explicit reading decision", () => {
    const state = { subject: { kind: "message", schema_version: 1, message_id: "message", revision: "message-rev" },
      unread: false, manual_unread: false, read_at: "2026-10-21T12:00:00Z", state_version: 3 };
    expect(AgentAttentionViewResultSchema.parse({ read_count: 1, read_states: [state] }).read_states).toEqual([state]);
    for (const read_states of [[{ ...state, content: "private" }], [{ ...state, state_version: -1 }], Array(201).fill(state)]) {
      expect(AgentAttentionViewResultSchema.safeParse({ read_count: read_states.length, read_states }).success).toBe(false);
    }
  });
});

// Stream transport sequence is deliberately unrelated to source revisions.
it('bounds attention delivery frames and rejects content-bearing notice metadata', async () => {
  const { AgentAttentionStreamFrameSchema } = await import('../src/agentAttention.js');
  const frame = { type: 'attention.denied', seq: 1, version: '', page: null, unread_count: 0, notices: [] };
  expect(AgentAttentionStreamFrameSchema.safeParse(frame).success).toBe(true);
  const counts = { needs_you: 1, recently_finished: 2, working: 3, waiting: 4, idle: 5 };
  expect(AgentAttentionStreamFrameSchema.parse({ ...frame, type: 'attention.invalidation', counts }).counts).toEqual(counts);
  expect(AgentAttentionStreamFrameSchema.safeParse({ ...frame, counts: { ...counts, working: -1 } }).success).toBe(false);
  expect(AgentAttentionStreamFrameSchema.safeParse({ ...frame, seq: 0 }).success).toBe(false);
  expect(AgentAttentionStreamFrameSchema.safeParse({ ...frame, notices: [{ key: 'revision', work_key: 'work', kind: 'failed', prompt: 'private' }] }).success).toBe(false);
});
