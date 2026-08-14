import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { loadConfig } from "../src/config";
import { runManagedAgentLoop } from "../src/modules/runs/managedAgentLoop";
import { validToolLoopSuffix } from "../src/modules/runtimeHost/deliveryAuthorizer";

const config = loadConfig({});

function request(): RuntimeHostExecuteRequest {
  return {
    run_input: {
      schema_version: "run_input.v1",
      run_id: "run-1",
      space_id: "space-1",
      instruction: "Use tools when needed.",
      task_goal: "Complete the request.",
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
        policy_ref: "policy-1",
        budget_ref: "budget-1",
      },
    },
    run_id: "run-1",
    space_id: "space-1",
    model_provider_id: "provider-1",
    model: "model-1",
    system_prompt: "Be useful.",
    prompt: "Start.",
    messages: [{ role: "user", content: "Start." }],
    mode: "live",
    instruction: "Use tools when needed.",
    project_id: null,
    project_folder_id: null,
    capability_id: null,
    tool_mode: "authorized_bindings",
    tool_bindings: [{
      id: "sample.tool",
      external_type: "internal",
      external_ref: "sample.tool",
      display_name: "sample.tool",
      required_scopes: [],
      credential_ref: null,
      data_exposure_level: "model_provider",
      observability_level: "structured_events",
      side_effect_level: "none",
      approval_required: false,
    }],
    tools: [{
      name: "sample.tool",
      description: "A test tool.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    }],
  };
}

function response(overrides: Partial<RuntimeHostExecuteResponse> = {}): RuntimeHostExecuteResponse {
  return {
    success: true,
    stdout: overrides.output_text ?? "",
    stderr: "",
    output_text: "",
    output_json: {},
    exit_code: 0,
    error_code: null,
    error_text: null,
    started_at: "2026-08-14T00:00:00.000Z",
    completed_at: "2026-08-14T00:00:01.000Z",
    model: "model-1",
    usage: null,
    events: [],
    adapter_metadata: {},
    adapter_log_json: null,
    ...overrides,
  };
}

function toolResponse(turn: number, finishReason: "toolUse" | "length" | "max_tokens" = "toolUse") {
  return response({
    output_json: {
      tool_calls: [{
        id: `call-${turn}`,
        name: "sample.tool",
        arguments_json: JSON.stringify({ value: turn }),
      }],
    },
    events: [{ type: "model.message_stop", finish_reason: finishReason }],
  });
}

describe("managed pi agent loop port", () => {
  it("keeps raw model arguments at the canonical dispatch boundary", async () => {
    const calls: RuntimeHostExecuteRequest[] = [];
    const dispatch = vi.fn(async (call) => ({
      modelResult: { ok: true, raw: JSON.parse(call.arguments_json) },
      summary: { tool_name: call.name, ok: true },
    }));
    const result = await runManagedAgentLoop({
      config,
      request: request(),
      tools: request().tools ?? [],
      toolBindings: request().tool_bindings,
      maxTurns: 4,
      dispatch,
      executeModel: async (_config, next) => {
        calls.push(next);
        return calls.length === 1 ? toolResponse(1) : response({ output_text: "done" });
      },
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      id: "call-1",
      arguments_json: JSON.stringify({ value: 1 }),
    }));
    expect(calls[1]?.messages?.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      name: "sample.tool",
    });
    expect(validToolLoopSuffix((calls[1]?.messages ?? []).slice(1))).toBe(true);
    expect(result.response.output_text).toBe("done");
  });

  it("preserves malformed model arguments for gateway validation", async () => {
    const dispatch = vi.fn(async (call) => ({
      modelResult: { ok: false },
      summary: { tool_name: call.name, ok: false },
    }));
    let turn = 0;
    await runManagedAgentLoop({
      config,
      request: request(),
      tools: request().tools ?? [],
      toolBindings: request().tool_bindings,
      maxTurns: 4,
      dispatch,
      executeModel: async () => {
        turn += 1;
        return turn === 1
          ? response({
              output_json: {
                tool_calls: [{ id: "malformed", name: "sample.tool", arguments_json: "not-json" }],
              },
            })
          : response({ output_text: "done" });
      },
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      id: "malformed",
      arguments_json: "not-json",
    }));
  });

  it("fails an entire length-truncated tool batch without dispatching it", async () => {
    const calls: RuntimeHostExecuteRequest[] = [];
    const dispatch = vi.fn();
    const result = await runManagedAgentLoop({
      config,
      request: request(),
      tools: request().tools ?? [],
      toolBindings: request().tool_bindings,
      maxTurns: 4,
      dispatch,
      executeModel: async (_config, next) => {
        calls.push(next);
        return calls.length === 1 ? toolResponse(1, "length") : response({ output_text: "recovered" });
      },
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(validToolLoopSuffix((calls[1]?.messages ?? []).slice(1))).toBe(true);
    expect(result.response.output_text).toBe("recovered");
  });

  it("treats Anthropic max_tokens as a truncated tool batch", async () => {
    const dispatch = vi.fn();
    let turn = 0;
    await runManagedAgentLoop({
      config,
      request: request(),
      tools: request().tools ?? [],
      toolBindings: request().tool_bindings,
      maxTurns: 4,
      dispatch,
      executeModel: async () => {
        turn += 1;
        return turn === 1 ? toolResponse(1, "max_tokens") : response({ output_text: "recovered" });
      },
    });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stops a cancelled batch before requesting another Delivery", async () => {
    const controller = new AbortController();
    const twoCalls = toolResponse(1);
    twoCalls.output_json = {
      tool_calls: [
        { id: "call-1", name: "sample.tool", arguments_json: "{}" },
        { id: "call-2", name: "sample.tool", arguments_json: "{}" },
      ],
    };
    const executeModel = vi.fn(async () => twoCalls);
    const dispatch = vi.fn(async () => {
      controller.abort();
      return { modelResult: { ok: true }, summary: { tool_name: "sample.tool", ok: true } };
    });

    const result = await runManagedAgentLoop({
      config,
      request: request(),
      tools: request().tools ?? [],
      toolBindings: request().tool_bindings,
      maxTurns: 4,
      signal: controller.signal,
      dispatch,
      executeModel,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(executeModel).toHaveBeenCalledTimes(1);
    expect(result.response).toMatchObject({
      success: false,
      error_code: "provider_request_aborted",
    });
  });

  it("returns a suspend envelope and blocks the rest of its sequential batch", async () => {
    const suspend = response({
      output_json: { waiting_for_results: { status: "waiting" } },
      output_text: "",
    });
    const dispatch = vi.fn(async () => ({
      modelResult: { ok: true, status: "waiting" },
      summary: { tool_name: "sample.tool", ok: true },
      suspend,
    }));
    const twoCalls = toolResponse(1);
    twoCalls.output_json = {
      tool_calls: [
        { id: "call-1", name: "sample.tool", arguments_json: "{}" },
        { id: "call-2", name: "sample.tool", arguments_json: "{}" },
      ],
    };
    const executeModel = vi.fn(async () => twoCalls);

    const result = await runManagedAgentLoop({
      config,
      request: request(),
      tools: request().tools ?? [],
      toolBindings: request().tool_bindings,
      maxTurns: 4,
      dispatch,
      executeModel,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(executeModel).toHaveBeenCalledTimes(1);
    expect(result.response).toBe(suspend);
  });

  it("stops after four completed model turns and reports exhaustion", async () => {
    const executeModel = vi.fn(async () => toolResponse(executeModel.mock.calls.length));
    const dispatch = vi.fn(async (call) => ({
      modelResult: { ok: true },
      summary: { tool_name: call.name, ok: true },
    }));

    const result = await runManagedAgentLoop({
      config,
      request: request(),
      tools: request().tools ?? [],
      toolBindings: request().tool_bindings,
      maxTurns: 4,
      dispatch,
      executeModel,
    });

    expect(executeModel).toHaveBeenCalledTimes(4);
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(result.turnLimitReached).toBe(true);
  });
});
