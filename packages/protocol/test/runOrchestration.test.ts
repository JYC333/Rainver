import { describe, it, expect } from "vitest";
import {
  CanonicalRunOutputSchema,
  RunAdapterResultEnvelopeSchema,
  RunCancelRequestSchema,
  RunEventAppendRequestSchema,
  RunExecuteRequestSchema,
  RunExecutionKnownErrorCodeSchema,
  RunInputEnvelopeSchema,
  RunJobEnvelopeSchema,
  RunJobPayloadSchema,
  RunJobResultSchema,
  RuntimeSemanticEventSchema,
  RunTerminalResultSchema,
  RunTraceSafeSummarySchema,
} from "../src/index";

describe("run orchestration contract", () => {
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
      adapter_type: "ts_agent_host",
      adapter_kind: "managed_api",
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
        adapter_type: "codex_cli",
        argv_summary: ["codex", "exec"],
      },
    });

    expect(event.metadata_json).toEqual({
      adapter_type: "codex_cli",
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

  it("covers existing agent_run job payload forms", () => {
    expect(
      RunJobPayloadSchema.parse({
        space_id: "space-1",
        user_id: "user-1",
        run_id: "run-1",
        root_run_id: "run-root",
        run_group_id: "group-1",
        delegation_id: "delegation-1",
        instructed_by_agent_id: "agent-manager",
        simulate_failure: false,
      }).run_id,
    ).toBe("run-1");

    expect(
      RunJobPayloadSchema.parse({
        space_id: "space-1",
        user_id: "user-1",
        task_id: "task-1",
        agent_id: "agent-1",
        set_task_in_progress: true,
      }).task_id,
    ).toBe("task-1");

    const envelope = RunJobEnvelopeSchema.parse({
      job_id: "job-1",
      space_id: "space-1",
      user_id: "user-1",
      attempts: 1,
      max_attempts: 3,
      worker_id: "worker-1",
      payload: {
        agent_id: "agent-1",
        prompt: "Do the work",
        adapter_type: "model_api",
      },
    });

    expect(envelope.payload.agent_id).toBe("agent-1");
    expect(RunJobPayloadSchema.safeParse({ space_id: "space-1" }).success).toBe(
      false,
    );
  });

  it("parses job result and stable known error codes", () => {
    expect(RunExecutionKnownErrorCodeSchema.parse("duplicate_execution")).toBe(
      "duplicate_execution",
    );
    const result = RunJobResultSchema.parse({
      run_id: "run-1",
      status: "failed",
      error_code: "missing_runtime_credential",
      error_text: "Credential profile is required",
      metadata_json: { retryable: false },
    });

    expect(result.error_code).toBe("missing_runtime_credential");
    expect(
      RunJobResultSchema.safeParse({
        ...result,
        metadata_json: { private_memory_text: "raw private memory" },
      }).success,
    ).toBe(false);
  });

  it("parses trace-safe summaries and rejects raw file or patch content", () => {
    const summary = RunTraceSafeSummarySchema.parse({
      run_id: "run-1",
      space_id: "space-1",
      status: "failed",
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      parent_run_id: "run-parent",
      root_run_id: "run-root",
      run_group_id: "group-1",
      delegation_id: "delegation-1",
      instructed_by_agent_id: "agent-manager",
      started_at: "2026-06-12T10:00:00.000Z",
      completed_at: "2026-06-12T10:00:03.000Z",
      error_code: "adapter_nonzero_exit",
      event_summaries: [
        {
          event_type: "adapter_completed",
          status: "failed",
          summary: "Adapter exited nonzero",
          error_code: "adapter_nonzero_exit",
          metadata_json: { exit_code: 1 },
        },
      ],
      artifact_summaries: [
        { artifact_id: "artifact-1", artifact_type: "runtime_output", title: "Output" },
      ],
      proposal_summaries: [
        { proposal_id: "proposal-1", proposal_type: "code_patch", status: "pending" },
      ],
    });

    expect(summary.event_summaries).toHaveLength(1);
    expect(
      RunTraceSafeSummarySchema.safeParse({
        ...summary,
        event_summaries: [
          {
            event_type: "patch_collected",
            status: "succeeded",
            metadata_json: { full_patch: "diff --git ..." },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RunTraceSafeSummarySchema.safeParse({
        ...summary,
        event_summaries: [
          {
            event_type: "artifact_ingested",
            status: "succeeded",
            metadata_json: { file_content: "raw file body" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
