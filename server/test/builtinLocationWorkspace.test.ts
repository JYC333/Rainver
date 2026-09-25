import { describe, expect, it } from "vitest";
import { executionTaskId, launchWorkspaceForTest, withTaskWorktree } from "../src/modules/runs/remoteHostCliAdapter.js";
import { verificationTargetForTest } from "../src/modules/runs/orchestrationService.js";

/**
 * The built-in host's daemon never ran `workspace add`, so a Location id alone
 * resolves to nothing on it and the Run dies with "no local path registered".
 * The path under the shared workspace root is what lets it resolve one
 * (ADR 0016 section 4) — and a Conversation bound to a server Location always
 * arrives with a snapshot workspace, which is the case that used to skip it.
 */
describe("the workspace a Location-bound launch carries", () => {
  const LOC = "loc-1";

  it("fills the relative path into a snapshot workspace that has none", () => {
    expect(launchWorkspaceForTest({ kind: "location", workspace_location_id: LOC }, LOC, "space/ttt"))
      .toEqual({ kind: "location", workspace_location_id: LOC, workspace_relative_path: "space/ttt" });
  });

  it("leaves a snapshot workspace that already names one alone", () => {
    const named = { kind: "location" as const, workspace_location_id: LOC, workspace_relative_path: "kept" };
    expect(launchWorkspaceForTest(named, LOC, "other")).toEqual(named);
  });

  it("does not touch a managed workspace, which resolves without a path", () => {
    const managed = { kind: "managed" as const, agent_id: "a", container: { kind: "conversation" as const, conversation_id: "c" } };
    expect(launchWorkspaceForTest(managed, LOC, "space/ttt")).toEqual(managed);
  });

  it("still builds one when the snapshot named no workspace", () => {
    expect(launchWorkspaceForTest(undefined, LOC, "space/ttt"))
      .toEqual({ kind: "location", workspace_location_id: LOC, workspace_relative_path: "space/ttt" });
  });

  it("carries nothing for a paired host, which resolves the Location from its own registration", () => {
    expect(launchWorkspaceForTest(undefined, LOC, null)).toBeUndefined();
  });
});

/**
 * The same gap, in the other place that names a workspace. A launch carries the
 * built-in host's path because `builtinLocationRelativePath` computes it; the
 * verifier reached for `port.workspace` first and took the snapshot's
 * path-less Location as-is, so every verification on that host came back "no
 * local path registered" — reported, after two relabellings, as a Run that had
 * failed its acceptance checks.
 */
describe("the workspace a verifier runs in", () => {
  const LOC = "loc-1";
  const port = (over: Record<string, unknown>) => ({
    hostKind: "server" as const, hostId: "host-1", workspaceLocationId: LOC,
    workspaceRelativePath: null, ...over,
  } as never);

  it("folds the built-in host's path into a snapshot Location that has none", () => {
    const target = verificationTargetForTest(port({
      workspace: { kind: "location", workspace_location_id: LOC },
      workspaceRelativePath: "space/ttt",
    }));
    expect(target?.workspace).toEqual({
      kind: "location", workspace_location_id: LOC, workspace_relative_path: "space/ttt",
    });
  });

  it("leaves a managed workspace alone, which resolves without a path", () => {
    const managed = { kind: "managed" as const, agent_id: "a", container: { kind: "conversation" as const, conversation_id: "c" } }
    expect(verificationTargetForTest(port({ workspace: managed, workspaceRelativePath: "x" }))?.workspace).toEqual(managed)
  });

  it("carries no workspace for a paired host, which resolves the Location itself", () => {
    expect(verificationTargetForTest(port({ hostKind: "remote" }))?.workspace).toBeUndefined();
  });

  it("carries the Run's managed runtime identity to Host verification", () => {
    expect(verificationTargetForTest(port({}), {
      runtime_key: "codex_cli",
      model_override_json: { installation: "managed:1.11.0" },
      runtime_profile_snapshot_json: { runtime_installation: "own" },
    })).toMatchObject({ runtime_key: "codex_cli", installation: "managed:1.11.0" });
  });
})

/**
 * A write-capable execution Task Run works in its Task's worktree, on the
 * Task's branch (ADR 0016 §11), so it never waits for the Location's writers;
 * every other Run — a turn, a Task's planning Run, a read-only Run — works in
 * the checkout the person is looking at. The verifier asks about the Task Run
 * where its change is.
 */
describe("a Task Run's worktree", () => {
  const LOC = "loc-1";
  const task = {
    contract_snapshot_json: { source: { kind: "task", id: "task-1" } },
    run_type: "agent",
    required_sandbox_level: "worktree",
  };

  it("names the Task on an execution Run's Location launch, even one the snapshot named no workspace for", () => {
    expect(withTaskWorktree({ kind: "location", workspace_location_id: LOC }, LOC, task))
      .toEqual({ kind: "location", workspace_location_id: LOC, worktree: { task_id: "task-1" } });
    expect(withTaskWorktree(undefined, LOC, task))
      .toEqual({ kind: "location", workspace_location_id: LOC, worktree: { task_id: "task-1" } });
  });

  it("leaves Conversation turns, managed workspaces and Location-less Runs alone", () => {
    const location = { kind: "location" as const, workspace_location_id: LOC };
    expect(withTaskWorktree(location, LOC, { ...task, contract_snapshot_json: {} })).toEqual(location);
    const managed = { kind: "managed" as const, agent_id: "a", container: { kind: "conversation" as const, conversation_id: "c" } };
    expect(withTaskWorktree(managed, LOC, task)).toEqual(managed);
    expect(withTaskWorktree(undefined, null, task)).toBeUndefined();
  });

  it("gives a Task's planning Run and a read-only Run the checkout, not a worktree", () => {
    const location = { kind: "location" as const, workspace_location_id: LOC };
    expect(withTaskWorktree(location, LOC, { ...task, run_type: "planning" })).toEqual(location);
    expect(withTaskWorktree(location, LOC, { ...task, required_sandbox_level: "read_only" })).toEqual(location);
    expect(executionTaskId({ ...task, run_type: "planning" })).toBeNull();
    expect(executionTaskId(task)).toBe("task-1");
  });

  it("points the verifier of a Task Run at its worktree", () => {
    const target = verificationTargetForTest({
      hostKind: "remote", hostId: "host-1", workspaceLocationId: LOC, workspaceRelativePath: null,
      workspace: { kind: "location", workspace_location_id: LOC },
    } as never, { runtime_key: null, model_override_json: null, runtime_profile_snapshot_json: null, ...task } as never);
    expect(target?.workspace).toEqual({ kind: "location", workspace_location_id: LOC, worktree: { task_id: "task-1" } });
  });
});
