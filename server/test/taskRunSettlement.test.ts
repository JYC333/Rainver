import { describe, expect, it } from "vitest";
import type { HostServerFrame } from "@rainver/protocol";
import { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { agentGitIdentity } from "../src/modules/runs/agentGitIdentity.js";
import { taskRunCommitMessage } from "../src/modules/runs/taskRunSettlement.js";

/**
 * A Task Run ends as one commit on its Task branch (ADR 0016 §11). `git log`
 * on that branch is read without Rainver open, so the commit has to say which
 * Task and Run it is and who asked, and must name no address anyone owns.
 */
describe("a Task Run's commit", () => {
  it("is the Task's title, the head of what the Agent said, and trailers naming the Task, Run and requester", () => {
    const message = taskRunCommitMessage({
      taskTitle: "Fix the  parser\n",
      taskId: "task-1",
      runId: "run-1",
      outcome: "succeeded",
      requester: "Jin",
      summary: "Fixed the tokenizer.\r\nAdded a test.",
    });
    expect(message).toBe([
      "Fix the parser",
      "",
      "Fixed the tokenizer.\nAdded a test.",
      "",
      "Rainver-Task: task-1",
      "Rainver-Run: run-1",
      "Requested-by: Jin",
    ].join("\n"));
  });

  it("says when the Run did not succeed, and keeps only the head of a long summary", () => {
    const message = taskRunCommitMessage({
      taskTitle: null,
      taskId: "task-1",
      runId: "run-1",
      outcome: "failed",
      requester: null,
      summary: Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"),
    });
    expect(message.split("\n")[0]).toBe("Task task-1 (failed Run)");
    expect(message).toContain("line 19");
    expect(message).not.toContain("line 20");
    expect(message).not.toContain("Requested-by:");
  });

  it("is authored by the Agent at an address that reaches nobody", () => {
    expect(agentGitIdentity("agent-1", "Builder")).toEqual({ name: "Builder", email: "agent-1@agents.rainver.invalid" });
    expect(agentGitIdentity(null, null)).toEqual({ name: "Rainver Agent", email: "agent@agents.rainver.invalid" });
  });
});

describe("Task branch requests to a host", () => {
  const workspace = { kind: "location" as const, workspace_location_id: "loc-1", worktree: { task_id: "task-1" } };

  it("routes the reply to the request that asked", async () => {
    const registry = new HostConnectionRegistry();
    const sent: HostServerFrame[] = [];
    registry.registerConnection("host-1", { send: (frame) => sent.push(frame), close() {} });
    const pending = registry.requestTaskBranch("host-1", "task_run_settle", {
      workspace, run_id: "run-1", author: { name: "A", email: "a@b" }, message: "m",
    });
    const frame = sent[0] as Extract<HostServerFrame, { type: "task_run_settle" }>;
    expect(frame).toMatchObject({ type: "task_run_settle", run_id: "run-1", workspace });
    // Another host, or the other request type, cannot answer it.
    registry.receiveTaskBranchResult("host-2", "task_run_settle_result", frame.request_id, { ok: false, branch: null, commit: null, error: "x" });
    registry.receiveTaskBranchResult("host-1", "task_branch_delete_result", frame.request_id, { ok: true, deleted: true, error: null });
    registry.receiveTaskBranchResult("host-1", "task_run_settle_result", frame.request_id, {
      ok: true, branch: "rainver/task-task-1", commit: "c".repeat(40), error: null,
    });
    await expect(pending).resolves.toEqual({ ok: true, branch: "rainver/task-task-1", commit: "c".repeat(40), error: null });
  });

  it("answers offline in the reply's own shape, and fails a pending request when the host goes", async () => {
    const registry = new HostConnectionRegistry();
    await expect(registry.requestTaskBranch("host-1", "task_branch_delete", { workspace }))
      .resolves.toEqual({ ok: false, deleted: false, error: "host_offline" });
    const sink = { send() {}, close() {} };
    registry.registerConnection("host-1", sink);
    const pending = registry.requestTaskBranch("host-1", "task_run_settle", {
      workspace, run_id: "run-1", author: { name: "A", email: "a@b" }, message: "m",
    });
    registry.unregisterConnection("host-1", sink);
    await expect(pending).resolves.toEqual({ ok: false, branch: null, commit: null, error: "host_offline" });
  });
});
