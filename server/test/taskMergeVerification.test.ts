import { describe, expect, it } from "vitest";
import { verifyTaskWorkspace, type VerificationCommandExecutor } from "../src/modules/runs/verification/engine.js";
import type { VerificationPlanReader } from "../src/modules/runs/verification/repository.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

/**
 * A merge's gate (ADR 0016 §11): the Task's declared checks, asked again of
 * its rebased worktree. Only what a workspace can answer is asked — a Run's
 * outputs are not part of the tree being merged — and a check that could not
 * run did not say yes.
 */
const emptyPlan: VerificationPlanReader = {
  async getPlan() {
    return {
      recipe_id: null, commands: null, required_checks: null, artifact_expectations: null,
      timeout_seconds: null, profile_test_commands: null, profile_build_commands: null, forbidden_paths: null,
    };
  },
};
const target = { host_id: "host-1", workspace_location_id: "loc-1", workspace: { kind: "location" as const, workspace_location_id: "loc-1", worktree: { task_id: "task-1" } } };

function runWith(acceptance: unknown): RunRecord {
  return {
    id: "run-1", space_id: "space-1", project_folder_id: null,
    contract_snapshot_json: { source: { kind: "task", id: "task-1" }, acceptance_criteria_json: acceptance },
  } as unknown as RunRecord;
}

function executor(returncode: number, seen: string[][] = []): VerificationCommandExecutor {
  return {
    async run(input) {
      seen.push(input.command);
      return { returncode, stdout: "", stderr: "", timed_out: false };
    },
  };
}

describe("a merge's verification", () => {
  it("asks the workspace checks in the Task worktree and skips a Run's output checks", async () => {
    const seen: string[][] = [];
    const outcome = await verifyTaskWorkspace(emptyPlan, executor(0, seen), {
      run: runWith([{ type: "test", command: ["npm", "test"] }, { type: "artifact_exists", artifact_type: "report" }]),
      target,
      base_commit_sha: "a".repeat(40),
    });
    expect(outcome.status).toBe("passed");
    expect(outcome.checks.map((check) => check.verifier_type)).toEqual(["test"]);
    expect(seen).toEqual([["npm", "test"]]);
  });

  it("fails the gate on a failing check", async () => {
    const outcome = await verifyTaskWorkspace(emptyPlan, executor(1), {
      run: runWith([{ type: "test", command: ["npm", "test"] }]),
      target,
      base_commit_sha: "a".repeat(40),
    });
    expect(outcome.status).toBe("failed");
  });

  it("is not required when the Task declares nothing a workspace can answer", async () => {
    const outcome = await verifyTaskWorkspace(emptyPlan, executor(0), {
      run: runWith([{ type: "artifact_exists", artifact_type: "report" }]),
      target,
      base_commit_sha: "a".repeat(40),
    });
    expect(outcome).toEqual({ status: "not_required", checks: [] });
  });
});
