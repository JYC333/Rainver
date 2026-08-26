import { describe, expect, it } from "vitest";
import type {
  CanonicalToolCall,
  RunAdapterResultEnvelope,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@agent-space/protocol";
import { loadConfig } from "../src/config.js";
import {
  DEFAULT_MAX_MODEL_TURNS,
  executeManagedToolLoop,
  mergeManagedToolContributions,
  type ManagedToolContribution,
} from "../src/modules/runs/managedToolLoop.js";
import { managedToolDegradation } from "../src/modules/runs/orchestrationResults.js";

const config = loadConfig({});

function request(): RuntimeHostExecuteRequest {
  return {
    run_id: "run-1",
    space_id: "space-1",
    model_provider_id: "provider-1",
    model: "model-1",
    prompt: "Do the thing.",
    messages: [{ role: "user", content: "Do the thing." }],
    mode: "live",
    tool_mode: "disabled",
    tool_bindings: [],
  } as unknown as RuntimeHostExecuteRequest;
}

function response(overrides: Partial<RuntimeHostExecuteResponse> = {}): RuntimeHostExecuteResponse {
  return {
    success: true,
    stdout: "",
    stderr: "",
    output_text: "done",
    output_json: {},
    exit_code: 0,
    events: [],
    ...overrides,
  } as unknown as RuntimeHostExecuteResponse;
}

function toolCallResponse(name: string, id: string): RuntimeHostExecuteResponse {
  return response({
    output_json: { tool_calls: [{ id, name, arguments_json: "{}" }] },
    output_text: "",
  });
}

function toolContribution(name: string): ManagedToolContribution {
  return {
    definitions: [{ name, description: name, input_schema: { type: "object" } }],
    bindings: [{
      id: name,
      external_type: "internal",
      external_ref: name,
      display_name: name,
      required_scopes: [],
      credential_ref: null,
      data_exposure_level: "model_provider",
      observability_level: "structured_events",
      side_effect_level: "none",
      approval_required: false,
    }],
  } as unknown as ManagedToolContribution;
}

/** A contribution that produced model-visible content but offers no tool — the shape a retrieval preflight takes. */
function prefaceOnlyContribution(): ManagedToolContribution {
  return {
    definitions: [],
    bindings: [],
    prefaceMessages: [{ role: "user", content: "Retrieval preflight (retrieval.brief) result:\n{}" }],
    prefaceSummaries: [{ tool_name: "retrieval.brief", ok: true, preflight: true }],
    prefaceArtifacts: [{ kind: "brief" }],
  } as unknown as ManagedToolContribution;
}

describe("generic managed tool loop", () => {
  it("defaults the turn budget to four model turns", () => {
    expect(DEFAULT_MAX_MODEL_TURNS).toBe(4);
    expect(mergeManagedToolContributions([], async () => ({ modelResult: {}, summary: {} })).maxModelTurns).toBe(4);
  });

  it("offers a preface-only contribution's content alongside another family's tools", async () => {
    // A run in a retrieval preflight mode that also holds a delegation grant
    // used to lose the delegation tool entirely: the preflight short-circuited
    // the whole run before the loop, and nothing recorded the loss.
    const seenTools: string[][] = [];
    const seenMessages: unknown[][] = [];
    let turn = 0;
    const execute = async (_config: typeof config, sent: RuntimeHostExecuteRequest) => {
      seenTools.push((sent.tools ?? []).map((tool) => tool.name));
      seenMessages.push(sent.messages ?? []);
      turn += 1;
      return turn === 1 ? toolCallResponse("agent.delegate", "call-1") : response({ output_text: "final" });
    };
    const dispatched: string[] = [];
    const result = await executeManagedToolLoop(
      config,
      request(),
      execute,
      mergeManagedToolContributions(
        [prefaceOnlyContribution(), toolContribution("agent.delegate"), null],
        async (call: CanonicalToolCall) => {
          dispatched.push(call.name);
          return { modelResult: { ok: true }, summary: { tool_name: call.name, ok: true } };
        },
      ),
    );

    expect(seenTools[0]).toEqual(["agent.delegate"]);
    expect(JSON.stringify(seenMessages[0])).toContain("Retrieval preflight");
    expect(dispatched).toEqual(["agent.delegate"]);
    const output = result.output_json as { managed_tool_calls?: Array<Record<string, unknown>>; artifacts?: unknown[] };
    expect(output.managed_tool_calls?.map((summary) => summary.tool_name)).toEqual(["retrieval.brief", "agent.delegate"]);
    expect(output.artifacts).toEqual([{ kind: "brief" }]);
  });

  it("performs exactly one disabled-tool turn when only a preface was contributed", async () => {
    const sentRequests: RuntimeHostExecuteRequest[] = [];
    const execute = async (_config: typeof config, sent: RuntimeHostExecuteRequest) => {
      sentRequests.push(sent);
      return response({ output_text: "grounded answer" });
    };
    const result = await executeManagedToolLoop(
      config,
      request(),
      execute,
      mergeManagedToolContributions([prefaceOnlyContribution(), null, null], async () => ({ modelResult: {}, summary: {} })),
    );

    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0].tool_mode).toBe("disabled");
    expect(sentRequests[0].tool_bindings).toEqual([]);
    expect(JSON.stringify(sentRequests[0].messages)).toContain("Retrieval preflight");
    expect(result.output_text).toBe("grounded answer");
  });

  it("states the absence of tools on the request when no family contributed anything", async () => {
    const sentRequests: RuntimeHostExecuteRequest[] = [];
    const original = request();
    const execute = async (_config: typeof config, sent: RuntimeHostExecuteRequest) => {
      sentRequests.push(sent);
      return response();
    };
    await executeManagedToolLoop(
      config,
      original,
      execute,
      mergeManagedToolContributions([null, null, null], async () => ({ modelResult: {}, summary: {} })),
    );
    expect(sentRequests).toHaveLength(1);
    // Offering no tools is the loop's statement, not something inherited from
    // whatever the caller happened to set.
    expect(sentRequests[0].tool_mode).toBe("disabled");
    expect(sentRequests[0].tool_bindings).toEqual([]);
    expect(sentRequests[0].messages).toEqual(original.messages);
    expect(sentRequests[0].prompt).toBe(original.prompt);
  });

  it("attributes an unclaimable budget to no tool family", async () => {
    // The budget is spent by calls whose summaries carry no tool name, so no
    // tool can be credited with exhausting it. Naming the first *offered*
    // definition would invent an attribution, and would name a family — the
    // misattribution this loop move exists to remove.
    const execute = async () => toolCallResponse("unlisted.tool", "call-x");
    const result = await executeManagedToolLoop(
      config,
      request(),
      execute,
      mergeManagedToolContributions(
        [toolContribution("retrieval.search"), null, null],
        async () => ({ modelResult: {}, summary: {} }),
      ),
    );
    const summaries = (result.output_json as { managed_tool_calls: Array<Record<string, unknown>> }).managed_tool_calls;
    expect(summaries.at(-1)).toEqual({
      tool_name: "managed_tools",
      ok: false,
      error_code: "managed_tool_turn_limit",
    });
  });

  it("names the tool that spent the budget when the turn limit is reached", async () => {
    // A delegation-only run that runs out of turns used to report a retrieval
    // failure, because the loop belonged to Retrieval.
    let turn = 0;
    const execute = async () => {
      turn += 1;
      return toolCallResponse("agent.delegate", `call-${turn}`);
    };
    const result = await executeManagedToolLoop(
      config,
      request(),
      execute,
      mergeManagedToolContributions(
        [null, toolContribution("agent.delegate"), null],
        async (call: CanonicalToolCall) => ({ modelResult: { ok: true }, summary: { tool_name: call.name, ok: true } }),
      ),
    );

    expect(turn).toBe(DEFAULT_MAX_MODEL_TURNS);
    const summaries = (result.output_json as { managed_tool_calls: Array<Record<string, unknown>> }).managed_tool_calls;
    expect(summaries.at(-1)).toEqual({
      tool_name: "agent.delegate",
      ok: false,
      error_code: "managed_tool_turn_limit",
    });
    expect((result.output_json as { tool_calls?: unknown }).tool_calls).toBeUndefined();
  });

  it("writes its summaries where the degradation reader looks for them", async () => {
    // The two halves of the Always-on evidence path are written in different
    // modules: the loop fills `adapter_metadata`, and `managedToolDegradation`
    // reads `metadata_json`. Asserting each against a literal leaves the join
    // untested, so renaming the key on one side would silently stop every
    // managed run from ever reporting degradation. Drive the real producer into
    // the real consumer.
    let turn = 0;
    const execute = async () => {
      turn += 1;
      return turn === 1 ? toolCallResponse("agent.delegate", "call-1") : response({ output_text: "answered anyway" });
    };
    const result = await executeManagedToolLoop(
      config,
      request(),
      execute,
      mergeManagedToolContributions(
        [null, toolContribution("agent.delegate"), null],
        async (call: CanonicalToolCall) => ({
          modelResult: { ok: false },
          summary: { tool_name: call.name, ok: false, error_code: "agent_delegate_tool_call_failed" },
        }),
      ),
    );

    expect(
      managedToolDegradation({ metadata_json: result.adapter_metadata } as unknown as RunAdapterResultEnvelope),
    ).toEqual({
      tool_names: ["agent.delegate"],
      error_codes: ["agent_delegate_tool_call_failed"],
    });
  });

  it("reports a failed delegation tool as run degradation", () => {
    // The Always-on gate treats `managed_tool_degraded` as its evidence that an
    // unattended Run did not silently answer without a tool it was granted.
    // That evidence must not be limited to the retrieval family.
    expect(
      managedToolDegradation({
        metadata_json: {
          managed_tool_calls: [
            { tool_name: "retrieval.search", ok: true },
            { tool_name: "agent.delegate", ok: false, error_code: "agent_delegate_tool_call_failed" },
          ],
        },
      } as never),
    ).toEqual({
      tool_names: ["agent.delegate"],
      error_codes: ["agent_delegate_tool_call_failed"],
    });
  });
});
