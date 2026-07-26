import { describe, expect, it } from "vitest";
import { assembleRunInputEnvelope, logicalRunInput } from "../src/modules/runs/runInputEnvelope";
import type { RunRecord } from "../src/modules/runs/repository";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    status: "queued",
    mode: "live",
    prompt: "Produce the report",
    instruction: "Use the supplied evidence",
    project_folder_id: "folder-1",
    project_id: "project-1",
    session_id: null,
    adapter_type: "opencode",
    model_provider_id: null,
    required_sandbox_level: "worktree",
    trigger_origin: "workflow",
    started_at: null,
    ended_at: null,
    contract_snapshot_json: {
      contract_version: "run_contract.v1",
      workflow_input_json: { question: "What changed?" },
      upstream_inputs_json: {
        evidence: [{ source_run_id: "run-0", value: { count: 2 } }],
      },
      attachment_manifest_json: [
        {
          kind: "artifact",
          ref_id: "artifact-1",
          purpose: "evidence",
          locator: "artifact:artifact-1",
        },
      ],
      required_outputs_json: [
        {
          name: "report",
          path: "report.json",
          required: true,
          max_bytes: 4096,
          schema: { type: "object" },
        },
      ],
      structured_output_json: {
        type: "json_schema",
        schema_id: "report.v1",
        schema: { type: "object" },
      },
      risk_level: "medium",
      route_hints_json: { execution_shape: "agentic_files" },
    },
    model_override_json: {
      messages: [{ role: "user", content: "Continue from the prior turn" }],
    },
    permission_snapshot_json: {
      tool_grants: [
        {
          action_id: "artifact.create",
          capability_id: "reporting",
          approval_behavior: "none",
          side_effecting: true,
        },
      ],
    },
    context_snapshot_id: "snapshot-1",
    ...overrides,
  };
}

describe("run_input.v1 assembly", () => {
  it("projects immutable Run authorities without physical Folder paths", () => {
    const input = assembleRunInputEnvelope(run());

    expect(input).toMatchObject({
      schema_version: "run_input.v1",
      run_id: "run-1",
      messages: [{ role: "user", content: "Continue from the prior turn" }],
      context: {
        context_snapshot_id: "snapshot-1",
        context_package_ref: "context_snapshot:snapshot-1",
      },
      project_folder_access: {
        project_folder_id: "folder-1",
        access: "read_write",
        mount_point: "working",
      },
      execution: {
        shape: "agentic_files",
        risk_level: "medium",
      },
    });
    expect(input.attachments).toHaveLength(1);
    expect(input.output_contract.required_outputs[0]?.path).toBe("report.json");
    expect(JSON.stringify(input)).not.toContain("/home/");
  });

  it("fails closed when a contract attempts to carry secret-shaped input", () => {
    expect(() =>
      assembleRunInputEnvelope(run({
        contract_snapshot_json: {
          workflow_input_json: { nested: { access_token: "secret" } },
        },
      })),
    ).toThrow(/forbids secret/i);
  });

  it("coerces null-content messages instead of silently dropping them, matching the Managed API adapter's own message parsing", () => {
    const input = assembleRunInputEnvelope(run({
      model_override_json: {
        messages: [
          { role: "user", content: "Continue from the prior turn" },
          { role: "assistant", content: null, tool_calls: [{ id: "call-1", name: "search" }] },
        ],
      },
    }));
    expect(input.messages).toEqual([
      { role: "user", content: "Continue from the prior turn" },
      { role: "assistant", content: "" },
    ]);
  });

  it("drops the whole message list when any entry has a non-string, non-null content shape", () => {
    const input = assembleRunInputEnvelope(run({
      model_override_json: { messages: [{ role: "user", content: { weird: true } }] },
    }));
    expect(input.messages).toEqual([]);
  });
});

describe("logicalRunInput", () => {
  it("strips the raw attachment locator from the Run Detail display projection without changing the rest of the envelope", () => {
    const input = assembleRunInputEnvelope(run());
    const logical = logicalRunInput(input);

    expect(logical.attachments).toHaveLength(1);
    expect(logical.attachments[0]).not.toHaveProperty("locator");
    expect(logical.attachments[0]).toMatchObject({ kind: "artifact", ref_id: "artifact-1", purpose: "evidence" });
    expect(logical.messages).toEqual(input.messages);
    expect(logical.instruction).toBe(input.instruction);
  });
});
