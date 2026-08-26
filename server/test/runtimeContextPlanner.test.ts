import { describe, expect, it } from "vitest";
import { ContextWindowPlanner, RuntimeContextPlanningError } from "../src/modules/runtimeContext/windowPlanner.js";
import { RetrievalCoordinator } from "../src/modules/runtimeContext/retrievalCoordinator.js";
import { RuntimeContextPlanner } from "../src/modules/runtimeContext/planner.js";
import { RuntimeContextPlanningService } from "../src/modules/runtimeContext/planningService.js";
import { contextItemText, normalizeContextItem } from "../src/modules/runtimeContext/itemNormalizer.js";
import { runtimeContextProviderDestination } from "../src/modules/runtimeContext/productionAcquisition.js";

const SPACE_ID = "00000000-0000-4000-8000-000000000001";
const CONTROL_ID = "00000000-0000-4000-8000-000000000002";
const SCOPE_ID = "00000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000004";

function item(options: {
  id: string;
  text: string;
  selection?: "required" | "pinned" | "ranked";
  acquisition?: "direct" | "explicit" | "retrieval" | "continuity";
  role?: "delegated_instruction" | "user_input" | "reference_data";
  rank?: number;
}) {
  return normalizeContextItem({
    sourceRef: { type: options.id === MESSAGE_ID ? "message" : "test", id: options.id },
    acquisition: options.acquisition ?? "direct",
    selection: options.selection ?? "ranked",
    semanticRole: options.role ?? "reference_data",
    trust: "domain_approved",
    sensitivity: "normal",
    visibility: "private",
    ownerUserId: null,
    egressEligible: true,
    spaceId: SPACE_ID,
    text: options.text,
    revalidation: { status: "live", checked_at: "2026-08-09T00:00:00.000Z" },
    rank: options.rank,
  });
}

function currentMessage(text = "do the work") {
  return item({ id: MESSAGE_ID, text, selection: "required", role: "user_input" });
}

describe("Runtime Context common planner", () => {
  it("classifies provider-bound CLI egress from the adapter-specific upstream", () => {
    expect(runtimeContextProviderDestination("claude_code", {
      provider_type: "ollama",
      base_url: "http://127.0.0.1:11434",
      config_json: { claude_compatible_base_url: "https://api.example.test/anthropic" },
    })).toBe("external_provider");
    expect(runtimeContextProviderDestination("codex_cli", {
      provider_type: "custom",
      base_url: "https://generic.example.test",
      config_json: { openai_compatible_base_url: "http://localhost:8080/v1" },
    })).toBe("local_provider");
    expect(runtimeContextProviderDestination("opencode", {
      provider_type: "ollama",
      base_url: "http://localhost:11434",
      config_json: {},
    })).toBe("external_provider");
  });

  it("uses the same deterministic window decisions for preview and execution", () => {
    const planner = new RuntimeContextPlanner();
    const input = {
      executionControlSnapshotId: CONTROL_ID,
      setupRef: null,
      turn: {
        work_context_scope_id: SCOPE_ID,
        expected_setup_version: 1,
        current_message_ref: { type: "message", id: MESSAGE_ID },
        one_off_refs: [],
        invocation_purpose: "agent_task",
      },
      model: "gpt-4o",
      directItems: [currentMessage(), item({
        id: "00000000-0000-4000-8000-000000000005",
        text: "approved instruction",
        selection: "required" as const,
        role: "delegated_instruction" as const,
      })],
      retrievalItems: [item({
        id: "00000000-0000-4000-8000-000000000006",
        text: "retrieved reference",
        acquisition: "retrieval" as const,
        rank: 1,
      })],
    };
    const preview = planner.plan(input);
    const execution = planner.plan(input);
    expect(execution.window_plan).toEqual(preview.window_plan);
    expect(execution.items).toEqual(preview.items);
  });

  it("never exceeds the model window across arbitrary ranked item sizes", () => {
    const planner = new ContextWindowPlanner();
    for (let seed = 1; seed <= 100; seed += 1) {
      const current = currentMessage("x".repeat((seed * 97) % 8_000 + 1));
      const ranked = Array.from({ length: 24 }, (_, index) => item({
        id: `ranked-${seed}-${index}`,
        text: "r".repeat(((seed * (index + 11) * 7919) % 80_000) + 1),
        acquisition: "retrieval",
        rank: index + 1,
      }));
      const { windowPlan } = planner.plan({
        model: "unknown-model",
        modelWindowOverride: {
          contextWindowTokens: 128_000,
          defaultOutputReserveTokens: 8_192,
          providerOverheadTokens: 512,
          catalogVersion: "test-catalog.v1",
        },
        items: [current, ...ranked],
        currentMessageItemId: current.id,
      });
      expect(windowPlan.planned_prompt_tokens
        + windowPlan.reserved_output_tokens
        + windowPlan.provider_overhead_tokens).toBeLessThanOrEqual(windowPlan.total_window_tokens);
      expect(windowPlan.decisions.find((decision) => decision.item_id === current.id)?.decision).toBe("included");
    }
  });

  it("blocks visible required-item overflow instead of truncating it", () => {
    const current = currentMessage("x".repeat(600_000));
    expect(() => new ContextWindowPlanner().plan({
      model: "unknown-model",
      modelWindowOverride: {
        contextWindowTokens: 128_000,
        defaultOutputReserveTokens: 8_192,
        providerOverheadTokens: 512,
        catalogVersion: "test-catalog.v1",
      },
      items: [current],
      currentMessageItemId: current.id,
    })).toThrowError(expect.objectContaining<Partial<RuntimeContextPlanningError>>({
      code: "required_context_overflow",
    }));
  });

  it("rejects renderer-empty mandatory context", () => {
    const current = currentMessage("   \n\t");
    expect(() => new ContextWindowPlanner().plan({
      model: "gpt-4o",
      items: [current],
      currentMessageItemId: current.id,
    })).toThrowError(expect.objectContaining<Partial<RuntimeContextPlanningError>>({
      code: "invalid_context_item",
    }));
  });

  it("delegates relevance selection to Retrieval and normalizes results as ranked reference data", async () => {
    const calls: unknown[] = [];
    const audited: unknown[] = [];
    const coordinator = new RetrievalCoordinator({
      async search(input) {
        calls.push(input);
        return {
          items: [{
            object_type: "memory_entry",
            object_id: "00000000-0000-4000-8000-000000000007",
            title: "Episode",
            snippet: "Relevant prior event",
            score: 0.9,
            evidence: { kind: "lexical_match", source: "projection" },
            matched_fields: ["text"],
          }],
          total: 1,
          trace: { arms: { lexical: 1 } },
        };
      },
      async recordReads(input) { audited.push(input); },
    }, {
      async authorize() {
        return {
          sensitivity: "normal",
          visibility: "private",
          ownerUserId: null,
          egressEligible: true,
          revalidation: { status: "live", checked_at: "2026-08-09T00:00:00.000Z" },
        };
      },
    });
    const result = await coordinator.retrieve({
      spaceId: SPACE_ID,
      userId: "00000000-0000-4000-8000-000000000008",
      agentId: "00000000-0000-4000-8000-000000000010",
      executionControlSnapshotId: CONTROL_ID,
      query: "prior event",
      objectTypes: ["memory_entry"],
      maxResults: 5,
      mode: "hybrid",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agentId: "00000000-0000-4000-8000-000000000010" });
    expect(result.items[0]).toMatchObject({
      acquisition: "retrieval",
      selection: "ranked",
      semantic_role: "reference_data",
      rank: 1,
    });
    expect(audited).toHaveLength(1);
    const skipped = await coordinator.retrieve({
      spaceId: SPACE_ID,
      userId: "00000000-0000-4000-8000-000000000008",
      agentId: "00000000-0000-4000-8000-000000000010",
      executionControlSnapshotId: CONTROL_ID,
      query: "nothing",
      objectTypes: [],
      maxResults: 0,
      mode: "exact",
    });
    expect(skipped.items).toEqual([]);
    expect(calls).toHaveLength(1);

    const excluded = await coordinator.retrieve({
      spaceId: SPACE_ID,
      userId: "00000000-0000-4000-8000-000000000008",
      agentId: "00000000-0000-4000-8000-000000000010",
      executionControlSnapshotId: CONTROL_ID,
      query: "prior event",
      objectTypes: ["memory_entry"],
      maxResults: 5,
      mode: "hybrid",
      excludedRefs: [{ type: "memory", id: "00000000-0000-4000-8000-000000000007" }],
    });
    expect(excluded.items).toEqual([]);
    const notAllowlisted = await coordinator.retrieve({
      spaceId: SPACE_ID,
      userId: "00000000-0000-4000-8000-000000000008",
      agentId: "00000000-0000-4000-8000-000000000010",
      executionControlSnapshotId: CONTROL_ID,
      query: "prior event",
      objectTypes: ["memory_entry"],
      maxResults: 5,
      mode: "hybrid",
      allowedRefs: [{ type: "memory_entry", id: "00000000-0000-4000-8000-000000000099" }],
    });
    expect(notAllowlisted.items).toEqual([]);
    expect(audited).toHaveLength(1);
  });

  it("reacquires execution context and records only optional Retrieval drift", async () => {
    let execution = false;
    const message = currentMessage();
    const stable = item({
      id: "00000000-0000-4000-8000-000000000009",
      text: "stable pinned object",
      selection: "pinned",
      acquisition: "explicit",
    });
    const recorded: unknown[] = [];
    const service = new RuntimeContextPlanningService({
      async acquire(_request, mode) {
        execution = mode === "execution";
        return {
          executionControlSnapshotId: CONTROL_ID,
          setupRef: { type: "work_context_setup", id: SCOPE_ID, version: "1" },
          model: "gpt-4o",
          directItems: [{
            ...message,
            revalidation: {
              ...message.revalidation,
              checked_at: execution ? "2026-08-09T00:01:00.000Z" : "2026-08-09T00:00:00.000Z",
            },
          }],
          explicitItems: [stable],
          retrievalItems: [item({
            id: execution ? "retrieval-new" : "retrieval-old",
            text: execution ? "new live result" : "old live result",
            acquisition: "retrieval",
            rank: 1,
          })],
        };
      },
    }, {
      async recordPlan(input) { recorded.push(input); },
      async reconcile() {},
    });
    const request = {
      invocationId: "00000000-0000-4000-8000-000000000011",
      deliveryId: "00000000-0000-4000-8000-000000000012",
      identity: { userId: "00000000-0000-4000-8000-000000000008", spaceId: SPACE_ID },
      turn: {
        work_context_scope_id: SCOPE_ID,
        expected_setup_version: 1,
        current_message_ref: { type: "message", id: MESSAGE_ID },
        one_off_refs: [],
        invocation_purpose: "agent_task",
      },
    };
    const preview = await service.preview(request);
    const prepared = await service.prepareExecution(request, preview);
    expect(execution).toBe(true);
    expect(prepared.optionalRetrievalDrift).toEqual({
      addedSourceRefs: ["test:retrieval-new:"],
      removedSourceRefs: ["test:retrieval-old:"],
      changedSourceRefs: [],
    });
    expect(recorded).toHaveLength(1);
  });

  it("materializes deterministic ranked trimming and preserves mandatory conflict winners", () => {
    const current = currentMessage("required");
    const mandatory = item({ id: "mandatory", text: "must stay", selection: "pinned", role: "reference_data" });
    const ranked = item({ id: "ranked", text: "z".repeat(300), acquisition: "retrieval", rank: 1 });
    mandatory.conflict_key = "same-setting";
    ranked.conflict_key = "same-setting";
    const oversized = item({ id: "oversized", text: "界".repeat(100), acquisition: "retrieval", rank: 2 });
    const result = new ContextWindowPlanner().plan({
      model: "custom-small",
      modelWindowOverride: {
        contextWindowTokens: 90,
        defaultOutputReserveTokens: 8,
        providerOverheadTokens: 8,
        catalogVersion: "test-catalog.v1",
      },
      items: [current, mandatory, ranked, oversized],
      currentMessageItemId: current.id,
    });
    expect(result.windowPlan.decisions.find((decision) => decision.item_id === mandatory.id)?.decision).toBe("included");
    expect(result.windowPlan.decisions.find((decision) => decision.item_id === ranked.id)?.decision).toBe("blocked");
    const trimmed = result.items.find((candidate) => candidate.id === oversized.id)!;
    expect(contextItemText(trimmed)).not.toBe("界".repeat(100));
    expect(trimmed.token_estimate).toBeLessThanOrEqual(90);
  });

  it("uses a conservative catalog fallback for unknown models and CJK token estimates", () => {
    const current = currentMessage("界".repeat(20));
    expect(current.token_estimate).toBe(60);
    const result = new ContextWindowPlanner().plan({
      model: "unknown-model",
      items: [current],
      currentMessageItemId: current.id,
    });
    expect(result.windowPlan).toMatchObject({
      total_window_tokens: 16_384,
      reserved_output_tokens: 4_096,
      provider_overhead_tokens: 512,
    });
  });

  it("blocks a ranked trim when the remaining budget cannot hold one character", () => {
    const current = currentMessage("x".repeat(9));
    const ranked = item({ id: "multibyte", text: "界", acquisition: "retrieval", rank: 1 });
    const result = new ContextWindowPlanner().plan({
      model: "tiny",
      modelWindowOverride: {
        contextWindowTokens: 20,
        defaultOutputReserveTokens: 5,
        providerOverheadTokens: 4,
        catalogVersion: "test-catalog.v1",
      },
      items: [current, ranked],
      currentMessageItemId: current.id,
    });
    expect(result.windowPlan.decisions.find((decision) => decision.item_id === ranked.id)).toMatchObject({
      decision: "blocked",
      planned_tokens: 0,
    });
  });
});
