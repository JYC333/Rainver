import { describe, it, expect } from "vitest";
import {
  RuntimeHostExecuteRequestSchema,
  RuntimeHostExecuteResponseSchema,
  RuntimeHostToolModeSchema,
} from "../src/index";

describe("runtime host contract", () => {
  it("parses an explicit provider-backed host execution request", () => {
    const value = RuntimeHostExecuteRequestSchema.parse({
      run_input: runInput(),
      run_id: "run-1",
      space_id: "space-1",
      model_provider_id: "provider-1",
      model: "gpt-4o-mini",
      system_prompt: "Be concise.",
      prompt: "Summarize this",
      mode: "live",
    });

    expect(value.tool_mode).toBe("disabled");
    expect(value.tool_bindings).toEqual([]);
    expect(
      RuntimeHostExecuteRequestSchema.parse({
        ...value,
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Continue" },
        ],
      }).messages?.map((message) => message.role),
    ).toEqual(["user", "assistant", "user"]);
    expect(RuntimeHostToolModeSchema.parse("authorized_bindings")).toBe(
      "authorized_bindings",
    );
  });

  it("allows authorized tool binding metadata without secret material", () => {
    const value = RuntimeHostExecuteRequestSchema.parse({
      run_input: runInput(),
      run_id: "run-1",
      space_id: "space-1",
      model_provider_id: "provider-1",
      prompt: "Use a tool",
      mode: "live",
      tool_mode: "authorized_bindings",
      tool_bindings: [
        {
          id: "binding-1",
          external_type: "mcp_server",
          external_ref: "filesystem",
          display_name: "Filesystem",
          required_scopes: ["read"],
          credential_ref: null,
          data_exposure_level: "local_only",
          observability_level: "structured_events",
          side_effect_level: "external_read",
          approval_required: true,
        },
      ],
    });

    expect(value.tool_bindings[0].external_type).toBe("mcp_server");
    expect(
      RuntimeHostExecuteRequestSchema.safeParse({
        ...value,
        tool_bindings: [{ ...value.tool_bindings[0], api_key: "sk-secret" }],
      }).success,
    ).toBe(false);
  });

  it("parses normalized adapter output and rejects secret-bearing responses", () => {
    const response = RuntimeHostExecuteResponseSchema.parse({
      success: true,
      stdout: "done",
      stderr: "",
      output_text: "done",
      output_json: { adapter_type: "ts_agent_host" },
      exit_code: 0,
      started_at: "2026-06-12T10:00:00.000Z",
      completed_at: "2026-06-12T10:00:01.000Z",
      model: "gpt-4o-mini",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      events: [
        { type: "model.message_start", model: "gpt-4o-mini" },
        { type: "model.text_delta", delta: "done" },
        { type: "model.usage", usage: { total_tokens: 12 } },
        { type: "model.message_stop", finish_reason: "stop" },
      ],
      adapter_metadata: { adapter_type: "ts_agent_host" },
    });

    expect(response.success).toBe(true);
    expect(
      RuntimeHostExecuteResponseSchema.safeParse({
        ...response,
        api_key: "sk-secret",
      }).success,
    ).toBe(false);
  });
});

function runInput() {
  return {
    schema_version: "run_input.v1",
    run_id: "run-1",
    space_id: "space-1",
    instruction: null,
    task_goal: "Use the managed runtime",
    messages: [],
    inputs: { direct: null, workflow: null, upstream: null },
    attachments: [],
    project_folder_access: null,
    output_contract: {
      schema_version: "run_output_contract.v1",
      structured_output: null,
      required_outputs: [],
    },
    tool_grants: [],
    execution: {
      shape: "conversational",
      risk_level: "low",
      required_sandbox_level: "none",
      policy_ref: "run_permission_snapshot:run-1",
      budget_ref: "run_contract:run-1",
    },
  };
}
