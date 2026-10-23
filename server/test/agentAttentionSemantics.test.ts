import { describe, expect, it } from "vitest";
import type { AgentAttentionReason } from "@rainver/protocol";
import {
  attentionGroup, createAgentWorkResolver, initiallyUnread, isMine, supersededAgentRuns, type WorkRunFacts,
} from "../src/modules/agentAttention/semantics.js";

// Questions, retention, result revisions and the projected retry members are
// protected on their real paths in agentAttentionDb/LineageDb/SnapshotDb tests.
const run = (id: string, facts: Partial<WorkRunFacts> = {}): WorkRunFacts => ({ id, space_id: "space", execution_kind: "agent", ...facts });
const resolveAgentWork = (id: string, rows: readonly WorkRunFacts[]) => createAgentWorkResolver(rows)(id);
const reason: AgentAttentionReason = { kind: "awaiting_answer", message_id: "question", session_id: "session", agent_id: "agent", responsible: { kind: "user", id: "me", display_name: "Me" } };

describe("Agent work source ownership", () => {
  it("keeps Task attempts and their delegated work together, independently of creation provenance or execution Session", () => {
    const rows = [run("creation", { session_id: "conversation" }), run("task", { task_ids: ["task-a"], contract_task_id: "task-a", session_id: "direct" }), run("retry", { task_ids: ["task-a"] }), run("delegate", { parent_run_id: "task", delegation_id: "delegation", session_id: "direct" })];
    expect(resolveAgentWork("creation", rows)).toEqual({ kind: "session", source_id: "conversation" });
    for (const id of ["task", "retry", "delegate"]) expect(resolveAgentWork(id, rows)).toEqual({ kind: "task", source_id: "task-a" });
  });
  it("uses a Plan's source Task without pretending the node is a task_runs row", () => {
    const rows = [run("node", { plan_task_id: "source-task", root_run_id: "coordinator" })];
    expect(resolveAgentWork("node", rows)).toEqual({ kind: "task", source_id: "source-task" });
  });
  it("folds Room waves, serialized recipients and delegates into their exact Conversation, not Agent or Room", () => {
    const rows = [run("first", { group: { id: "wave-1", session_id: "conversation-a" } }), run("second", { group: { id: "wave-1", session_id: "conversation-a" }, parent_run_id: "first" }), run("later", { group: { id: "wave-2", session_id: "conversation-a" } }), run("other", { group: { id: "wave-3", session_id: "conversation-b" } }), run("child", { parent_run_id: "second", delegation_id: "d" })];
    for (const id of ["first", "second", "later", "child"]) expect(resolveAgentWork(id, rows)).toEqual({ kind: "session", source_id: "conversation-a" });
    expect(resolveAgentWork("other", rows)).toEqual({ kind: "session", source_id: "conversation-b" });
  });
  it("represents non-Room groups, standalone Runs, direct sessions and causal continuations", () => {
    const rows = [run("group", { group: { id: "g", session_id: null } }), run("single"), run("direct", { session_id: "s" }), run("continue", { trigger_origin: "continuation", cause_run_id: "single" })];
    expect(rows.map((row) => resolveAgentWork(row.id, rows))).toEqual([{ kind: "agent_group", source_id: "g" }, { kind: "run", source_id: "single" }, { kind: "session", source_id: "s" }, { kind: "run", source_id: "single" }]);
  });
  it("anchors autonomous/workflow siblings at their actual Agent coordinator and excludes ProviderTask-only work", () => {
    const rows = [run("coordinator"), run("provider", { execution_kind: "provider_task" }), run("candidate-a", { parent_run_id: "coordinator", trigger_origin: "autonomous" }), run("candidate-b", { root_run_id: "coordinator", trigger_origin: "job" })];
    expect(resolveAgentWork("provider", rows)).toBeNull();
    for (const id of ["coordinator", "candidate-a", "candidate-b"]) expect(resolveAgentWork(id, rows)).toEqual({ kind: "run", source_id: "coordinator" });
  });
  it("keeps the Run's own identity for ambiguous links, missing ancestry, cycles and cross-Space chains", () => {
    const own = { kind: "run", source_id: "a" };
    expect(resolveAgentWork("a", [run("a", { task_ids: ["one", "two"] })])).toEqual(own);
    expect(resolveAgentWork("a", [run("a", { task_ids: ["one", "two"], contract_task_id: "two" })])).toEqual({ kind: "task", source_id: "two" });
    expect(resolveAgentWork("a", [run("a", { contract_task_id: "missing" })])).toEqual(own);
    expect(resolveAgentWork("a", [run("a", { parent_run_id: "missing" })])).toEqual(own);
    expect(resolveAgentWork("b", [run("a", { parent_run_id: "b" }), run("b", { parent_run_id: "a" })])).toEqual(own);
    expect(resolveAgentWork("a", [run("a", { parent_run_id: "b" }), run("b", { space_id: "other" })])).toEqual(own);
  });
});

describe("Grouping and personal responsibility", () => {
  it("keeps terminal questions needs_you and another person's decision waiting", () => {
    const facts = { viewer_user_id: "me", reasons: [reason], active: false, queued: false, terminal: true, unread: false, resource_wait: false };
    expect(attentionGroup(facts)).toBe("needs_you");
    expect(attentionGroup({ ...facts, viewer_user_id: "other", unread: true })).toBe("waiting");
    expect(attentionGroup({ ...facts, reasons: [], resource_wait: true })).toBe("waiting");
    expect(attentionGroup({ ...facts, reasons: [], unread: true })).toBe("recently_finished");
    expect(attentionGroup({ ...facts, reasons: [], active: true })).toBe("working");
    // One queued sibling must not conceal another member still executing.
    expect(attentionGroup({ ...facts, reasons: [], active: true, resource_wait: true })).toBe("working");
    expect(attentionGroup({ ...facts, reasons: [] })).toBe("idle");
  });
  it("keeps queued work waiting without a detailed reason, while an executing sibling keeps the work working", () => {
    const facts = { viewer_user_id: "me", reasons: [], active: false, queued: true, terminal: false, unread: false, resource_wait: false };
    expect(attentionGroup(facts)).toBe("waiting");
    expect(attentionGroup({ ...facts, active: true })).toBe("working");
  });
  it("never makes a resource wait a personal decision for any viewer", () => {
    const resource: AgentAttentionReason = { kind: "resource", run_id: "run", code: "workspace", dependency_run_ids: [] };
    for (const viewer_user_id of ["me", "other", "administrator"]) {
      expect(attentionGroup({ viewer_user_id, reasons: [resource], active: false, queued: false, terminal: false, unread: false, resource_wait: true })).toBe("waiting");
      expect(isMine({ viewer_user_id, reasons: [resource], owner_user_ids: [], instructed_by_user_ids: [], responsible: { kind: null, id: null } })).toBe(false);
    }
  });
  it("requires personal facts, rather than general visibility or approval capability, for mine", () => {
    const facts = { viewer_user_id: "me", owner_user_ids: [], instructed_by_user_ids: [], responsible: { kind: null, id: null }, reasons: [] };
    expect(isMine(facts)).toBe(false);
    expect(isMine({ ...facts, owner_user_ids: ["me"] })).toBe(true);
    expect(isMine({ ...facts, instructed_by_user_ids: ["me"] })).toBe(true);
    expect(isMine({ ...facts, reasons: [reason] })).toBe(true);
    expect(isMine({ ...facts, responsible: { kind: "agent", id: "my-agent" } })).toBe(false);
  });
});

describe("Initial reading baseline", () => {
  const now = "2026-10-21T12:00:00Z";
  it("suppresses old history, includes recent results and preserves old active/open work", () => {
    const facts = { result_at: "2026-10-20T11:59:59Z", baseline_at: now, active: false, open_reason: false };
    expect(initiallyUnread(facts)).toBe(false);
    expect(initiallyUnread({ ...facts, active: true })).toBe(true);
    expect(initiallyUnread({ ...facts, open_reason: true })).toBe(true);
    expect(initiallyUnread({ ...facts, result_at: "2026-10-20T12:00:00Z" })).toBe(true);
    expect(initiallyUnread({ ...facts, result_at: "2026-10-22T12:00:00Z" })).toBe(true);
  });
  it("includes exactly baseline minus 24 hours, but not the preceding millisecond", () => {
    const facts = { baseline_at: now, active: false, open_reason: false };
    expect(initiallyUnread({ ...facts, result_at: "2026-10-20T12:00:00.000Z" })).toBe(true);
    expect(initiallyUnread({ ...facts, result_at: "2026-10-20T11:59:59.999Z" })).toBe(false);
  });
});

describe("Retry supersession", () => {
  const retryRun = (id: string, changes: Partial<WorkRunFacts> & { retry_superseded?: boolean } = {}) => ({ ...run(id, { session_id: "session" }), retry_superseded: false, ...changes });
  const superseded = (rows: ReturnType<typeof retryRun>[]) => [...supersededAgentRuns(rows, createAgentWorkResolver(rows))].sort();
  it("keeps an explicit Room supersession and replaces each predecessor of a direct-chat retry chain", () => {
    expect(superseded([retryRun("old", { retry_superseded: true }), retryRun("new")])).toEqual(["old"]);
    expect(superseded([retryRun("old"), retryRun("retry", { retry_of_run_id: "old" }), retryRun("latest", { retry_of_run_id: "retry" })])).toEqual(["old", "retry"]);
  });
  it("replaces nothing through missing, cyclic, cross-Space or differently owned chains", () => {
    expect(superseded([retryRun("new", { retry_of_run_id: "missing" })])).toEqual([]);
    expect(superseded([retryRun("a", { retry_of_run_id: "b" }), retryRun("b", { retry_of_run_id: "a" })])).toEqual([]);
    expect(superseded([retryRun("old"), retryRun("new", { retry_of_run_id: "old", space_id: "other" })])).toEqual([]);
    expect(superseded([retryRun("old"), retryRun("new", { retry_of_run_id: "old", session_id: "other" })])).toEqual([]);
  });
});
