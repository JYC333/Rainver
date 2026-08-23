import { describe, expect, it } from "vitest";
import type { RunMaterializationItemSummary } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { Queryable, RunRecord } from "../src/modules/runs/repository";
import {
  PgVerificationEngine,
  buildVerificationDeclarations,
  hasDeclaredVerificationChecks,
  summarizeVerificationResults,
} from "../src/modules/runs/verification";

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
      sandbox_cwd: null,
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
      sandbox_cwd: null,
      base_commit_sha: null,
      output_json: { other: true },
      materialization_items: [] as RunMaterializationItemSummary[],
    });

    expect(results[0]?.status).toBe("failed");
    expect(summarizeVerificationResults(results).status).toBe("failed");
  });

  it("gives validation commands a temporary HOME inside the sandbox", async () => {
    const db = new VerificationDb();
    const calls: string[][] = [];
    const engine = new PgVerificationEngine(db, undefined, {
      async run(input) {
        calls.push(input.command);
        return { returncode: 0, stdout: "", stderr: "", timed_out: false };
      },
    });
    const results = await engine.verify({
      run: run({
        contract_snapshot_json: {
          acceptance_criteria_json: {
            checks: [{
              type: "command",
              command: [
                process.execPath,
                "-e",
                "process.exit(process.env.HOME.includes('.verification-home-') ? 0 : 1)",
              ],
            }],
          },
        },
      }),
      sandbox_cwd: process.cwd(),
      base_commit_sha: null,
      output_json: {},
      materialization_items: [] as RunMaterializationItemSummary[],
    });

    expect(results[0]).toMatchObject({ verifier_type: "command", status: "passed" });
    expect(calls).toContainEqual(expect.arrayContaining([process.execPath, "-e"]));
  });

  it("short-circuits file_exists for a remote-host run instead of stat-ing a path that has no meaning on this machine (ADR 0016 P2)", async () => {
    const db = new VerificationDb();
    const engine = new PgVerificationEngine(db);
    const current = run({
      contract_snapshot_json: {
        required_outputs_json: ["file:report.json"],
      },
    });

    const remote = await engine.verify({
      run: current,
      sandbox_cwd: "/this/path/does/not/exist/on/the/server",
      base_commit_sha: null,
      output_json: {},
      materialization_items: [] as RunMaterializationItemSummary[],
      host_kind: "remote",
    });
    expect(remote[0]).toMatchObject({ verifier_type: "file_exists", status: "error" });
    expect(remote[0]?.summary).toMatch(/not available for a remote execution host/);

    // Omitting host_kind (or "server") preserves today's behavior exactly —
    // it still actually checks the filesystem, so a genuinely-missing file
    // fails rather than reporting unavailable.
    const server = await engine.verify({
      run: current,
      sandbox_cwd: "/this/path/does/not/exist/on/the/server",
      base_commit_sha: null,
      output_json: {},
      materialization_items: [] as RunMaterializationItemSummary[],
    });
    expect(server[0]).toMatchObject({ verifier_type: "file_exists", status: "failed" });
  });
});
