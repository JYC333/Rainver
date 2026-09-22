import { describe, it, expect } from "vitest";
import {
  CanonicalRunOutputSchema,
  RunAdapterResultEnvelopeSchema,
  RunCancelRequestSchema,
  RunEventAppendRequestSchema,
  RunExecuteRequestSchema,
  RunExecutionKnownErrorCodeSchema,
  RunInputEnvelopeSchema,
  RunJobResultSchema,
  RuntimeSemanticEventSchema,
  RunTerminalResultSchema,
  SecretFreeJsonRecordSchema,
  stripSecretFields,
} from "../src/index";

describe("run orchestration contract", () => {
  it("rejects nested credential identifiers and strips them recursively without mutating input", () => {
    const config = {
      effort: "medium",
      max_tokens: 1024,
      nested: [{ apiKey: "secret", credentialProfileId: "credential-1", keep: true }],
    };

    expect(SecretFreeJsonRecordSchema.safeParse(config).success).toBe(false);
    expect(stripSecretFields(config)).toEqual({
      effort: "medium",
      max_tokens: 1024,
      nested: [{ keep: true }],
    });
    expect(config.nested[0]).toMatchObject({ apiKey: "secret", credentialProfileId: "credential-1" });
  });

  it("parses run_input.v1 and rejects secrets or escaping output paths", () => {
    const input = {
      schema_version: "run_input.v1",
      run_id: "run-1",
      space_id: "space-1",
      instruction: "Summarize the evidence",
      task_goal: "Produce a bounded report",
      messages: [{ role: "user", content: "What changed?" }],
      inputs: {
        direct: { topic: "runtime convergence" },
        workflow: null,
        upstream: { items: [{ source_run_id: "run-0", value: { count: 2 } }] },
      },
      attachments: [
        {
          kind: "artifact",
          ref_id: "artifact-1",
          purpose: "supporting evidence",
          locator: "artifact:artifact-1",
          media_type: "text/markdown",
        },
      ],
      project_folder_access: {
        project_folder_id: "folder-1",
        access: "read_write",
        mount_point: "working",
      },
      output_contract: {
        schema_version: "run_output_contract.v1",
        structured_output: { type: "json_schema", schema_id: "report.v1" },
        required_outputs: [
          { name: "report", path: "report.json", required: true, max_bytes: 4096 },
        ],
      },
      tool_grants: [
        {
          action_id: "artifact.create",
          capability_id: "reporting",
          approval_behavior: "none",
          side_effecting: true,
        },
      ],
      execution: {
        shape: "structured_generation",
        risk_level: "low",
        required_sandbox_level: "none",
        policy_ref: "run_permission_snapshot:run-1",
        budget_ref: "run_contract:run-1",
      },
    } as const;

    expect(RunInputEnvelopeSchema.parse(input).schema_version).toBe("run_input.v1");
    expect(
      RunInputEnvelopeSchema.safeParse({
        ...input,
        inputs: { ...input.inputs, direct: { api_key: "secret" } },
      }).success,
    ).toBe(false);
    expect(
      RunInputEnvelopeSchema.safeParse({
        ...input,
        output_contract: {
          ...input.output_contract,
          required_outputs: [{ name: "escape", path: "../result.json" }],
        },
      }).success,
    ).toBe(false);
  });

  it("parses canonical semantic events and final run output", () => {
    const event = RuntimeSemanticEventSchema.parse({
      schema_version: "runtime_event.v1",
      type: "tool_call_completed",
      occurred_at: "2026-06-12T10:00:01.000Z",
      call_id: "call-1",
      summary: "Artifact created",
      metadata_json: { action_id: "artifact.create", ok: true },
    });
    const output = CanonicalRunOutputSchema.parse({
      schema_version: "run_output.v1",
      status: "succeeded",
      summary: "Report produced",
      result: { report_artifact_id: "artifact-1" },
      output_manifest: [
        {
          name: "report",
          status: "valid",
          artifact_id: "artifact-1",
          media_type: "application/json",
          size_bytes: 512,
        },
      ],
    });

    expect(event.type).toBe("tool_call_completed");
    expect(output.output_manifest[0]?.status).toBe("valid");
    expect(
      RuntimeSemanticEventSchema.safeParse({
        ...event,
        metadata_json: { stderr: "unbounded raw log" },
      }).success,
    ).toBe(false);
    expect(
      CanonicalRunOutputSchema.safeParse({
        ...output,
        result: { access_token: "secret" },
      }).success,
    ).toBe(false);
  });

  it("parses snake_case run execute and cancel requests", () => {
    const execute = RunExecuteRequestSchema.parse({
      run_id: "run-1",
      space_id: "space-1",
      runtime: null,
      worker_id: "worker-1",
      job_id: "job-1",
      command_source: "job",
    });

    const cancel = RunCancelRequestSchema.parse({
      run_id: "run-1",
      space_id: "space-1",
      requested_by_user_id: "user-1",
      reason: "user_requested",
    });

    expect(execute.command_source).toBe("job");
    expect(cancel.terminate_process).toBe(true);
  });

  it("parses terminal result and adapter result envelopes without secret fields", () => {
    const adapter = RunAdapterResultEnvelopeSchema.parse({
      runtime_key: "opencode",
      adapter_kind: "local_cli",
      success: true,
      output_text: "done",
      output_json: { artifacts: [{ title: "summary" }] },
      exit_code: 0,
      started_at: "2026-06-12T10:00:00.000Z",
      completed_at: "2026-06-12T10:00:01.000Z",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      metadata_json: { selected_model: "gpt-4o-mini" },
    });

    const terminal = RunTerminalResultSchema.parse({
      run_id: "run-1",
      space_id: "space-1",
      status: "succeeded",
      output_text: "done",
      output_json: { activities: [] },
      error_json: null,
      exit_code: 0,
      started_at: "2026-06-12T10:00:00.000Z",
      completed_at: "2026-06-12T10:00:01.000Z",
      adapter_result: adapter,
      materialization: [
        {
          kind: "artifact",
          status: "succeeded",
          artifact_id: "artifact-1",
          metadata_json: { title: "summary" },
        },
      ],
    });

    expect(terminal.status).toBe("succeeded");
    expect(
      RunAdapterResultEnvelopeSchema.safeParse({
        ...adapter,
        output_json: { nested: { api_key: "sk-secret" } },
      }).success,
    ).toBe(false);
    expect(
      RunTerminalResultSchema.safeParse({
        ...terminal,
        secret_ref: "model_provider_api_key:v1:secret",
      }).success,
    ).toBe(false);
  });

  it("parses event append requests and rejects raw trace evidence", () => {
    const event = RunEventAppendRequestSchema.parse({
      run_id: "run-1",
      space_id: "space-1",
      event_type: "adapter_invoked",
      status: "running",
      summary: "Adapter started",
      metadata_json: {
        runtime_key: "codex_cli",
        argv_summary: ["codex", "exec"],
      },
    });

    expect(event.metadata_json).toEqual({
      runtime_key: "codex_cli",
      argv_summary: ["codex", "exec"],
    });
    expect(
      RunEventAppendRequestSchema.safeParse({
        ...event,
        metadata_json: { rendered_context: "full prompt text" },
      }).success,
    ).toBe(false);
    expect(
      RunEventAppendRequestSchema.safeParse({
        ...event,
        metadata_json: { nested: { stderr: "raw adapter log" } },
      }).success,
    ).toBe(false);
  });

  it("parses job result and stable known error codes", () => {
    expect(RunExecutionKnownErrorCodeSchema.parse("duplicate_execution")).toBe(
      "duplicate_execution",
    );
    // A code that used to be known and no longer is. The known list is
    // descriptive, so the DTO still round-trips it — persisted rows keep
    // whatever they were written with — but it is no longer in the enum.
    expect(RunExecutionKnownErrorCodeSchema.safeParse("missing_runtime_credential").success).toBe(false);
    const result = RunJobResultSchema.parse({
      run_id: "run-1",
      status: "failed",
      error_code: "runtime_stall_timeout",
      error_text: "No output for the stall budget",
      metadata_json: { retryable: false },
    });

    expect(result.error_code).toBe("runtime_stall_timeout");
    expect(
      RunJobResultSchema.safeParse({
        ...result,
        metadata_json: { private_memory_text: "raw private memory" },
      }).success,
    ).toBe(false);
  });
});
