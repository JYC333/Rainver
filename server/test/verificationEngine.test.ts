import { describe, expect, it } from "vitest";
import type { RunMaterializationItemSummary } from "@rainver/protocol";
import type { Queryable, RunRecord } from "../src/modules/runs/repository.js";
import {
  PgVerificationEngine,
  buildVerificationDeclarations,
  hasDeclaredVerificationChecks,
  summarizeVerificationResults,
} from "../src/modules/runs/verification/index.js";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "version-1",
    status: "succeeded",
    mode: "live",
    prompt: null,
    instruction: null,
    project_folder_id: null,
    session_id: null,
    project_id: null,
    adapter_type: "model_api",
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "manual",
    started_at: null,
    ended_at: new Date().toISOString(),
    contract_snapshot_json: {},
    output_json: {},
    ...overrides,
  };
}

class VerificationDb implements Queryable {
  readonly inserts: unknown[][] = [];

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    if (sql.includes("FROM project_folders")) return { rows: [], rowCount: 0 } as { rows: Row[]; rowCount: number };
    if (sql.includes("INSERT INTO verification_results")) {
      this.inserts.push([...params]);
      return {
        rows: [{
          id: "verification-1",
          space_id: params[1],
          run_id: params[2],
          verifier_type: params[3],
          verifier_version: params[4],
          status: params[5],
          summary: params[6],
          evidence_refs_json: params[7],
          details_json: params[8],
          started_at: params[9],
          completed_at: params[10],
          created_at: params[11],
        }] as Row[],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

describe("verification engine", () => {
  it("normalizes contract checks and required outputs into deterministic declarations", () => {
    const current = run({
      contract_snapshot_json: {
        acceptance_criteria_json: {
          checks: [{ type: "output_schema", schema: { type: "object" } }],
        },
        required_outputs_json: ["file:report.json", { type: "proposal_created", proposal_type: "follow_up_task" }],
      },
    });
    const declarations = buildVerificationDeclarations(current, {
      recipe_id: null,
      commands: null,
      required_checks: null,
      artifact_expectations: null,
      timeout_seconds: null,
      profile_test_commands: null,
      profile_build_commands: null,
      forbidden_paths: null,
    }, []);

    expect(declarations.map((item) => item.verifier_type)).toEqual([
      "output_schema",
      "file_exists",
      "proposal_created",
    ]);
    expect(hasDeclaredVerificationChecks(current)).toBe(true);
  });

  it("treats plan verification recipe references as executable checks", () => {
    const current = run({
      contract_snapshot_json: {
        route_hints_json: { verification_recipe_refs: ["recipe-1"] },
      },
    });
    const declarations = buildVerificationDeclarations(current, {
      recipe_id: null,
      commands: null,
      required_checks: null,
      artifact_expectations: null,
      timeout_seconds: null,
      profile_test_commands: null,
      profile_build_commands: null,
      forbidden_paths: null,
      missing_recipe_refs: ["recipe-1"],
    }, []);

    expect(declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ verifier_type: "recipe_ref", key: "recipe_ref:recipe-1" }),
    ]));
    expect(hasDeclaredVerificationChecks(current)).toBe(true);
  });

  it("persists a passed output schema verification", async () => {
    const db = new VerificationDb();
    const engine = new PgVerificationEngine(db);
    const results = await engine.verify({
      run: run({
        contract_snapshot_json: {
          acceptance_criteria_json: {
            checks: [{ type: "output_schema", schema: { type: "object", required: ["answer"] } }],
          },
        },
      }),
      execution_target: null,
      base_commit_sha: null,
      output_json: { answer: "verified" },
      materialization_items: [] as RunMaterializationItemSummary[],
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ verifier_type: "output_schema", status: "passed" });
    expect(db.inserts).toHaveLength(1);
  });

  it("fails a declared schema instead of treating adapter success as completion", async () => {
    const db = new VerificationDb();
    const engine = new PgVerificationEngine(db);
    const results = await engine.verify({
      run: run({
        contract_snapshot_json: {
          acceptance_criteria_json: {
            checks: [{ type: "output_schema", schema: { type: "object", required: ["answer"] } }],
          },
        },
      }),
      execution_target: null,
      base_commit_sha: null,
      output_json: { other: true },
      materialization_items: [] as RunMaterializationItemSummary[],
    });

    expect(results[0]?.status).toBe("failed");
    expect(summarizeVerificationResults(results).status).toBe("failed");
  });

  it("sends a validation command to the host that holds the workspace, not to a path here", async () => {
    const db = new VerificationDb();
    const calls: Array<{ command: string[]; target: unknown }> = [];
    const engine = new PgVerificationEngine(db, undefined, {
      async run(input) {
        calls.push({ command: input.command, target: input.target });
        return { returncode: 0, stdout: "", stderr: "", timed_out: false };
      },
    });
    const results = await engine.verify({
      run: run({
        contract_snapshot_json: {
          acceptance_criteria_json: {
            checks: [{ type: "command", command: ["pnpm", "test"] }],
          },
        },
      }),
      execution_target: { host_id: "host-1", workspace_location_id: "loc-1" },
      base_commit_sha: null,
      output_json: {},
      materialization_items: [] as RunMaterializationItemSummary[],
    });

    expect(results[0]).toMatchObject({ verifier_type: "command", status: "passed" });
    // The workspace is named, never resolved here: the engine used to hand the
    // executor a server path, which is why verification only ever worked for a
    // Run the server itself had provisioned.
    expect(calls).toContainEqual({ command: ["pnpm", "test"], target: { host_id: "host-1", workspace_location_id: "loc-1" } });
    // And nothing else. Changed-file detection asks the same host the same way
    // when a verifier needs it — but a recipe that declares no git-backed
    // verifier must not send `git diff` and `git status` to that host anyway,
    // twice per Run, which on a paired machine is spawns on someone's laptop.
    expect(calls.map((call) => call.command)).toEqual([["pnpm", "test"]]);
  });

  it("asks the host for changed files when a git-backed verifier declares it", async () => {
    const db = new VerificationDb();
    const calls: string[][] = [];
    const engine = new PgVerificationEngine(db, undefined, {
      async run(input) {
        calls.push(input.command);
        return { returncode: 0, stdout: "src/app.ts\n", stderr: "", timed_out: false };
      },
    });
    await engine.verify({
      run: run({
        contract_snapshot_json: {
          acceptance_criteria_json: { checks: [{ type: "file_changed", path: "*" }] },
        },
      }),
      execution_target: { host_id: "host-1", workspace_location_id: "loc-1" },
      base_commit_sha: "HEAD",
      output_json: {},
      materialization_items: [] as RunMaterializationItemSummary[],
    });
    expect(calls).toContainEqual(["git", "diff", "--name-only", "HEAD"]);
    expect(calls).toContainEqual(["git", "status", "--porcelain"]);
  });

  it("reports a command verifier unavailable when the run has no host workspace", async () => {
    const db = new VerificationDb();
    const engine = new PgVerificationEngine(db, undefined, {
      async run() {
        throw new Error("must not be asked");
      },
    });
    const results = await engine.verify({
      run: run({
        contract_snapshot_json: {
          acceptance_criteria_json: { checks: [{ type: "command", command: ["pnpm", "test"] }] },
        },
      }),
      execution_target: null,
      base_commit_sha: null,
      output_json: {},
      materialization_items: [] as RunMaterializationItemSummary[],
    });
    expect(results[0]).toMatchObject({ verifier_type: "command", status: "error" });
  });

  it("asks the host whether a required file exists, on either host kind", async () => {
    const db = new VerificationDb();
    const calls: string[][] = [];
    const engine = new PgVerificationEngine(db, undefined, {
      async run(input) {
        calls.push(input.command);
        // `test -e` says no.
        return { returncode: 1, stdout: "", stderr: "", timed_out: false };
      },
    });
    const results = await engine.verify({
      run: run({ contract_snapshot_json: { required_outputs_json: ["file:report.json"] } }),
      execution_target: { host_id: "host-1", workspace_location_id: "loc-1" },
      base_commit_sha: null,
      output_json: {},
      materialization_items: [] as RunMaterializationItemSummary[],
    });

    // It used to `stat` a server path, which meant a paired host's Run could
    // not be checked at all and a Run on the built-in host will not have one
    // either. One question, asked where the workspace actually is.
    expect(calls).toContainEqual(["test", "-e", "report.json"]);
    expect(results[0]).toMatchObject({ verifier_type: "file_exists", status: "failed" });
  });

  it("does not report a missing file when the host never answered", async () => {
    const db = new VerificationDb();
    const engine = new PgVerificationEngine(db, undefined, {
      async run() {
        // An offline host, as `HostCommandVerificationExecutor` reports it.
        return { returncode: 1, stdout: "", stderr: "host_offline", timed_out: false, failure_code: "sandbox_runner_unavailable" as const };
      },
    });
    const results = await engine.verify({
      run: run({ contract_snapshot_json: { required_outputs_json: ["file:report.json"] } }),
      execution_target: { host_id: "host-1", workspace_location_id: "loc-1" },
      base_commit_sha: null,
      output_json: {},
      materialization_items: [] as RunMaterializationItemSummary[],
    });
    // A host that could not be reached learned nothing; calling that a missing
    // file would turn an offline machine into a failing build.
    expect(results[0]).toMatchObject({ verifier_type: "file_exists", status: "error" });
  });
});
