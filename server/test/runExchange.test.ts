import { mkdtemp, chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunInputEnvelope } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { RunExchangeManager, type RunExchangeHandle } from "../src/modules/runs/runExchange";

const roots: string[] = [];
const exchanges: Array<{ manager: RunExchangeManager; handle: RunExchangeHandle }> = [];

afterEach(async () => {
  await Promise.all(exchanges.splice(0).map(({ manager, handle }) => manager.cleanup(handle).catch(() => {})));
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function input(): RunInputEnvelope {
  return {
    schema_version: "run_input.v1",
    run_id: "run-1",
    space_id: "space-1",
    instruction: null,
    task_goal: "Produce outputs",
    messages: [],
    inputs: { direct: null, workflow: null, upstream: null },
    context: { context_snapshot_id: null, context_package_ref: null },
    attachments: [],
    project_folder_access: null,
    output_contract: {
      schema_version: "run_output_contract.v1",
      structured_output: null,
      required_outputs: [
        {
          name: "report",
          path: "nested/report.json",
          required: true,
          max_bytes: 1024,
          json_schema: {
            type: "object",
            required: ["answer"],
            properties: { answer: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    },
    tool_grants: [],
    execution: {
      shape: "agentic_files",
      risk_level: "low",
      required_sandbox_level: "worktree",
      policy_ref: "run_permission_snapshot:run-1",
      budget_ref: "run_contract:run-1",
    },
  };
}

async function fixture(): Promise<{ root: string; manager: RunExchangeManager; handle: RunExchangeHandle }> {
  const root = await mkdtemp(join(tmpdir(), "run-exchange-test-"));
  roots.push(root);
  const manager = new RunExchangeManager(root);
  const handle = await manager.prepare("space-1", "run-1", input());
  exchanges.push({ manager, handle });
  return { root, manager, handle };
}

describe("Run Exchange lifecycle", () => {
  it("keeps the Exchange outside working trees and collects declared and candidate outputs", async () => {
    const { root, manager, handle } = await fixture();
    expect(handle.root).toBe(join(root, "exchange", "space-1", "run-1"));
    expect(await readFile(handle.input_manifest_path, "utf8")).toContain('"schema_version": "run_input.v1"');

    await mkdir(join(handle.output_dir, "nested"), { recursive: true });
    await writeFile(join(handle.output_dir, "nested", "report.json"), JSON.stringify({ answer: "ok" }));
    await writeFile(join(handle.output_dir, "notes.md"), "# Candidate\n");
    const collection = await manager.collect(handle, input().output_contract.required_outputs);

    expect(collection.errors).toEqual([]);
    expect(collection.manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "report", status: "valid" }),
      expect.objectContaining({ name: "notes.md", status: "undeclared" }),
    ]));
    expect(collection.artifact_paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "nested/report.json", declared: true }),
      expect.objectContaining({ path: "notes.md", declared: false }),
    ]));
  });

  it("fails required missing, invalid, oversized, and modified-input cases", async () => {
    const missing = await fixture();
    expect((await missing.manager.collect(
      missing.handle,
      input().output_contract.required_outputs,
    )).errors[0]).toMatch(/missing/);

    const invalid = await fixture();
    await mkdir(join(invalid.handle.output_dir, "nested"), { recursive: true });
    await writeFile(join(invalid.handle.output_dir, "nested", "report.json"), JSON.stringify({ wrong: true }));
    expect((await invalid.manager.collect(
      invalid.handle,
      input().output_contract.required_outputs,
    )).manifest[0]?.status).toBe("invalid");

    const oversized = await fixture();
    await mkdir(join(oversized.handle.output_dir, "nested"), { recursive: true });
    await writeFile(join(oversized.handle.output_dir, "nested", "report.json"), "x".repeat(1025));
    expect((await oversized.manager.collect(
      oversized.handle,
      input().output_contract.required_outputs,
    )).manifest[0]?.status).toBe("oversized");

    const modified = await fixture();
    await chmod(modified.handle.input_manifest_path, 0o600);
    await writeFile(modified.handle.input_manifest_path, "{}\n");
    expect((await modified.manager.collect(modified.handle, [])).errors[0]).toMatch(/modified/);
  });

  it("does not follow output symlinks and removes raw Exchange state", async () => {
    const { manager, handle } = await fixture();
    await mkdir(join(handle.output_dir, "nested"), { recursive: true });
    await symlink("/etc/passwd", join(handle.output_dir, "nested", "report.json"));
    const collection = await manager.collect(handle, input().output_contract.required_outputs);
    expect(collection.manifest[0]?.status).toBe("invalid");
    expect(collection.artifact_paths).toEqual([]);

    await manager.cleanup(handle);
    await expect(readFile(handle.input_manifest_path, "utf8")).rejects.toThrow();
  });

  it("collects an explicit semantic outcome from a validated Room capture", async () => {
    const { manager, handle } = await fixture();
    const declaration = {
      name: "conversation_capture",
      path: "conversation_capture.json",
      required: true,
      json_schema: {
        type: "object",
        required: ["status", "proposed_changes"],
        properties: {
          status: { type: "string", enum: ["succeeded", "rejected"] },
          proposed_changes: { type: "array", items: { type: "object" } },
          rejection_reason: { type: "string" },
        },
        additionalProperties: false,
      },
    };
    await writeFile(
      join(handle.output_dir, declaration.path),
      JSON.stringify({
        status: "rejected",
        proposed_changes: [],
        rejection_reason: "The requested evidence is unavailable.",
      }),
    );

    const collection = await manager.collect(handle, [declaration]);

    expect(collection.errors).toEqual([]);
    expect(collection.reported_status).toBe("rejected");
    expect(collection.manifest[0]).toMatchObject({
      name: "conversation_capture",
      status: "valid",
    });
  });
});
