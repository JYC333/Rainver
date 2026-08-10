import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { getDbPool } from "../src/db/pool";
import type { QueryResult, Queryable } from "../src/modules/routeUtils/common";
import {
  executeManagedApiNoToolAdapter,
  type RuntimeHostExecutor,
} from "../src/modules/runs/managedApiAdapter";
import type { RetrievalToolService } from "../src/modules/retrieval/tool/service";
import type { RunRecord } from "../src/modules/runs/repository";
import type { InvocationDelivery } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { RunInvocationAttemptLifecycle } from "../src/modules/runs/runtimeContextAttempts";
import {
  __setProviderCommandStoreForTests,
  __setProviderHttpClientForTests,
  type ProviderCommandStore,
  type ProviderHttpClient,
} from "../src/modules/providers";
import { resolveTestUsageAttribution } from "./support/usageAttribution";
import { executeRuntimeHost } from "../src/modules/runtimeHost";

vi.mock("../src/db/pool", () => ({
  getDbPool: vi.fn(),
}));

afterEach(() => {
  __setProviderCommandStoreForTests(null);
  __setProviderHttpClientForTests(null);
  vi.mocked(getDbPool).mockReset();
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    status: "running",
    mode: "live",
    prompt: "Say hello",
    instruction: "Be concise.",
    project_folder_id: null,
    session_id: null,
    project_id: null,
    adapter_type: "model_api",
    model_provider_id: "provider-1",
    permission_snapshot_json: {
      tool_grants: [
        "retrieval.search",
        "retrieval.brief",
        "memory.retrieval.search",
        "memory.retrieval.brief",
        "project.summary.search",
        "project.summary.brief",
        "source.retrieval.search",
        "source.retrieval.brief",
        "agent.delegate",
        "agent.wait_for_results",
      ].map((action_id) => ({
        action_id,
        capability_id: null,
        approval_behavior: "none",
        side_effecting: action_id === "agent.delegate",
      })),
    },
    required_sandbox_level: "none",
    trigger_origin: "manual",
    started_at: null,
    ended_at: null,
    ...overrides,
  };
}

function retrievalSettingsRow(overrides: Record<string, unknown> = {}) {
  return {
    settings_json: {
      default_search_mode: "hybrid",
      rerank_enabled: false,
      query_rewrite_enabled: false,
      query_rewrite_default: false,
      use_query_cache: true,
      include_trace: false,
      external_egress_enabled: true,
      retrieval_tool_mode: "off",
      embedding_dimensions: 2560,
      max_results_default: 10,
      ...overrides,
    },
    created_at: "2026-06-12T10:00:00.000Z",
    updated_at: "2026-06-12T10:00:00.000Z",
  };
}

function mockRetrievalSettingsPool(overrides: Record<string, unknown> = {}) {
  vi.mocked(getDbPool).mockReturnValue({
    query: vi.fn(async () => ({ rows: [retrievalSettingsRow(overrides)] })),
  } as never);
}

function mockDomainRetrievalToolPool(overrides: Record<string, unknown> = {}) {
  const pool = new DomainRetrievalToolFakePool(overrides);
  vi.mocked(getDbPool).mockReturnValue(pool as never);
  return pool;
}

function fakeProviderStore(): ProviderCommandStore {
  return {
    async getTaskChain() {
      return null;
    },
    async getInvocationTarget() {
      throw new Error("provider invocation should not be needed in this test");
    },
  } as unknown as ProviderCommandStore;
}

function invocationDelivery(id: string, prompt: string): InvocationDelivery {
  const itemId = `item-${id}`;
  const controlId = `control-${id}`;
  const snapshotId = `snapshot-${id}`;
  return {
    id,
    invocation_id: "run-1",
    delivery_kind: "agent_task",
    adapter_type: "model_api",
    provider_id: "provider-1",
    model: "gpt-4o-mini",
    renderer_version: "managed.v1",
    mode: "full",
    planned_items: [{ item_id: itemId, semantic_role: "user_input", required: true }],
    message_blocks: [{ semantic_role: "user_input", content: prompt, source_item_ids: [itemId] }],
    control_ref: { type: "execution_control_snapshot", id: controlId },
    sandbox_ref: null,
    tool_grant_refs: [],
    output_contract_ref: null,
    expected_prompt_tokens: 4,
    max_output_tokens: null,
    snapshot_draft_ref: { type: "invocation_snapshot", id: snapshotId },
    audit_refs: {
      delivery_id: id,
      invocation_snapshot_id: snapshotId,
      execution_control_snapshot_id: controlId,
      usage_source_id: `usage-${id}`,
    },
  };
}

describe("executeManagedApiNoToolAdapter", () => {
  it("builds an explicit no-tool runtime-host request and maps success", async () => {
    const calls: Array<Parameters<RuntimeHostExecutor>[1]> = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "host output",
        stderr: "",
        output_text: "host output",
        output_json: { adapter_type: "ts_agent_host", stdout: "raw" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        model: "gpt-4o-mini",
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };

    const result = await executeManagedApiNoToolAdapter(
      config(),
      { run: run(), model: "gpt-4o-mini", max_tokens: 64 },
      { executeRuntimeHost: executor },
    );

    expect(calls).toMatchObject([
      {
        run_id: "run-1",
        space_id: "space-1",
        model_provider_id: "provider-1",
        model: "gpt-4o-mini",
        system_prompt: "Be concise.",
        prompt: "Say hello",
        mode: "live",
        instruction: "Be concise.",
        session_id: null,
        parent_run_id: null,
        root_run_id: null,
        run_group_id: null,
        agent_id: "agent-1",
        project_id: null,
        project_folder_id: null,
        trigger_origin: "manual",
        capability_id: null,
        max_tokens: 64,
        tool_mode: "disabled",
        tool_bindings: [],
      },
    ]);
    expect(calls[0]?.run_input).toMatchObject({
      schema_version: "run_input.v1",
      run_id: "run-1",
      task_goal: "Say hello",
      execution: { shape: "conversational" },
    });
    expect(result).toMatchObject({
      adapter_type: "model_api",
      adapter_kind: "managed_api",
      success: true,
      output_text: "host output",
      exit_code: 0,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      metadata_json: {
        adapter_type: "model_api",
        runtime_host_adapter_type: "ts_agent_host",
        model_provider_id: "provider-1",
      },
    });
    expect(result.output_json).toEqual({
      adapter_type: "model_api",
      stdout: "[REDACTED_EVIDENCE_FIELD]",
      model: "gpt-4o-mini",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
  });

  it("uses the accepted Delivery output reserve as the provider limit", async () => {
    const calls: Array<Parameters<RuntimeHostExecutor>[1]> = [];
    const delivery = {
      ...invocationDelivery("delivery-budget", "Say hello"),
      max_output_tokens: 23,
    };
    await executeManagedApiNoToolAdapter(
      config(),
      { run: run(), model: "gpt-4o-mini", max_tokens: 64, invocation_delivery: delivery },
      {
        executeRuntimeHost: async (_config, request) => {
          calls.push(request);
          return runtimeHostSuccess({ output_text: "done" });
        },
      },
    );

    expect(calls).toEqual([expect.objectContaining({ max_tokens: 23 })]);
  });

  it("honors the model persisted by routing when the worker request omits it", async () => {
    const calls: Array<{ model?: string | null }> = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "ok",
        stderr: "",
        output_text: "ok",
        output_json: {},
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        model: "routed-model",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };

    const result = await executeManagedApiNoToolAdapter(
      config(),
      { run: run({ model_override_json: { model: "routed-model" } }) },
      { executeRuntimeHost: executor },
    );

    expect(calls).toEqual([expect.objectContaining({ model: "routed-model" })]);
    expect(result.metadata_json).toMatchObject({
      model_provider_id: "provider-1",
      requested_model_provider_id: "provider-1",
      model: "routed-model",
    });
  });

  it("preserves actual and requested provider evidence from the runtime host", async () => {
    const executor: RuntimeHostExecutor = async () => ({
      success: true,
      stdout: "fallback output",
      stderr: "",
      output_text: "fallback output",
      output_json: {},
      exit_code: 0,
      error_text: null,
      error_code: null,
      started_at: "2026-06-12T10:00:00.000Z",
      completed_at: "2026-06-12T10:00:01.000Z",
      model: "fallback-model",
      usage: null,
      events: [],
      adapter_metadata: {
        adapter_type: "ts_agent_host",
        model_provider_id: "provider-2",
        requested_model_provider_id: "provider-1",
        model: "fallback-model",
      },
      adapter_log_json: null,
    });

    const result = await executeManagedApiNoToolAdapter(
      config(),
      { run: run({ model_provider_id: "provider-1" }) },
      { executeRuntimeHost: executor },
    );

    expect(result.metadata_json).toMatchObject({
      model_provider_id: "provider-2",
      requested_model_provider_id: "provider-1",
      model: "fallback-model",
    });
    expect(result.runtime_events).toContainEqual({
      schema_version: "runtime_event.v1",
      type: "warning",
      occurred_at: "2026-06-12T10:00:01.000Z",
      call_id: null,
      summary: "Managed model invocation used a fallback Provider.",
      metadata_json: {
        event_code: "model_provider_mismatch",
        model_provider_id: "provider-2",
        requested_model_provider_id: "provider-1",
      },
    });
  });

  it("passes native chat messages to runtime-host for managed API runs", async () => {
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "ok",
        stderr: "",
        output_text: "ok",
        output_json: { adapter_type: "ts_agent_host" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        model: "gpt-4o-mini",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };

    await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          model_override_json: {
            chat_context_preamble: "Relevant memory.",
            messages: [
              { role: "user", content: "Earlier question" },
              { role: "assistant", content: "Earlier answer" },
              { role: "user", content: "Continue" },
            ],
          },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor },
    );

    expect(calls).toEqual([
      expect.objectContaining({
        system_prompt: "",
        prompt: "Say hello",
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          {
            role: "user",
            content: "Continue\n\n[Retrieved context for this turn]\nBe concise.\n\nRelevant memory.",
          },
        ],
      }),
    ]);
  });

  it("passes chat context preamble even when native messages are absent", async () => {
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "ok",
        stderr: "",
        output_text: "ok",
        output_json: { adapter_type: "ts_agent_host" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        model: "gpt-4o-mini",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };

    await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          model_override_json: {
            chat_context_preamble: "Room turn routing context.",
          },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor },
    );

    expect(calls).toEqual([
      expect.objectContaining({
        system_prompt: "Be concise.\n\nRoom turn routing context.",
        prompt: "Say hello",
      }),
    ]);
    expect(calls[0]).not.toHaveProperty("messages");
  });

  it("adds the current room agent identity to grouped managed API runs", async () => {
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "ok",
        stderr: "",
        output_text: "ok",
        output_json: { adapter_type: "ts_agent_host" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        model: "gpt-4o-mini",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };

    await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          agent_id: "agent-reviewer",
          agent_name: "Coding Reviewer",
          run_group_id: "group-1",
          root_run_id: "run-root",
          prompt: "@Coding Reviewer 56456*56456=?",
          system_prompt: "Answer as the coding reviewer.",
        }),
        model: "gpt-4o-mini",
      },
      {
        executeRuntimeHost: executor,
        agentDelegationTools: { targets: [] },
      },
    );

    expect(calls).toEqual([
      expect.objectContaining({
        prompt: "@Coding Reviewer 56456*56456=?",
        system_prompt: expect.stringContaining("You are Coding Reviewer for this run."),
      }),
    ]);
    const systemPrompt = (calls[0] as { system_prompt?: string }).system_prompt ?? "";
    expect(systemPrompt).toContain("Answer as the coding reviewer.");
    expect(systemPrompt).toContain("Do not claim to be the room manager");
    expect(systemPrompt).toContain("Do not include them in user-facing replies");
    expect(systemPrompt).not.toContain("agent_id: agent-reviewer");
  });

  it("executes governed retrieval brief tool calls under the instructing user and emits a brief artifact", async () => {
    const calls: unknown[] = [];
    const toolActors: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          success: true,
          stdout: "",
          stderr: "",
          output_text: "",
          output_json: {
            adapter_type: "ts_agent_host",
            tool_calls: [
              {
                id: "tool-call-1",
                name: "retrieval.brief",
                arguments_json: JSON.stringify({
                  query: "widget plan",
                  mode: "lexical",
                  max_results: 2,
                }),
              },
            ],
          },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        };
      }
      return {
        success: true,
        stdout: "final with brief",
        stderr: "",
        output_text: "final with brief",
        output_json: { adapter_type: "ts_agent_host" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:02.000Z",
        completed_at: "2026-06-12T10:00:03.000Z",
        model: "gpt-4o-mini",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };
    const retrievalToolService = {
      async toolBrief(actor: unknown) {
        toolActors.push(actor);
        return {
          brief: {
            answer: "Use the staged widget plan.",
            synthesized: true,
            citations: [{ object_type: "knowledge_item", object_id: "k1", title: "Widget Plan" }],
            gap_analysis: {
              stale: [],
              thin: [],
              low_coverage: false,
              uncited_claims: [],
              contradictions: [],
              missing_topics: [],
            },
          },
          items: [
            {
              object_type: "knowledge_item",
              object_id: "k1",
              title: "Widget Plan",
              snippet: "staged rollout",
              score: 1,
              evidence: { kind: "lexical_match" },
              matched_fields: ["title"],
            },
          ],
          total: 1,
        };
      },
    } as unknown as RetrievalToolService;

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: { retrieval_tool_mode: "manual_tool_only" },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor, retrievalToolService },
    );

    expect(toolActors).toEqual([
      {
        spaceId: "space-1",
        instructedByUserId: "user-1",
        agentId: "agent-1",
        runId: "run-1",
      },
    ]);
    expect(calls[0]).toMatchObject({
      tool_mode: "authorized_bindings",
      tools: [
        { name: "retrieval.search" },
        { name: "retrieval.brief" },
      ],
      messages: [{ role: "user", content: "Say hello" }],
    });
    expect(calls[1]).toMatchObject({
      messages: [
        { role: "user", content: "Say hello" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool-call-1",
              name: "retrieval.brief",
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "tool-call-1",
          name: "retrieval.brief",
        },
      ],
    });
    expect(result).toMatchObject({
      success: true,
      output_text: "final with brief",
      output_json: {
        retrieval_tool_calls: [
          {
            tool_name: "retrieval.brief",
            ok: true,
            result_count: 1,
            synthesized: true,
          },
        ],
        artifacts: [
          {
            artifact_type: "retrieval_brief",
            visibility: "private",
            title: "Context Brief: widget plan",
            mime_type: "application/json; charset=utf-8",
          },
        ],
      },
    });
  });

  it("runs a governed retrieval brief preflight before the model turn", async () => {
    const calls: unknown[] = [];
    const toolActors: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "final after preflight",
        stderr: "",
        output_text: "final after preflight",
        output_json: { adapter_type: "ts_agent_host" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:02.000Z",
        completed_at: "2026-06-12T10:00:03.000Z",
        model: "gpt-4o-mini",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };
    const retrievalToolService = {
      async toolBrief(actor: unknown, params: unknown) {
        toolActors.push({ actor, params });
        return {
          brief: {
            answer: "Preflight says use the staged widget plan.",
            synthesized: true,
            citations: [{ object_type: "knowledge_item", object_id: "k1", title: "Widget Plan" }],
            gap_analysis: {
              stale: [],
              thin: [],
              low_coverage: false,
              uncited_claims: [],
              contradictions: [],
              missing_topics: [],
            },
          },
          items: [
            {
              object_type: "knowledge_item",
              object_id: "k1",
              title: "Widget Plan",
              snippet: "staged rollout",
              score: 1,
              evidence: { kind: "lexical_match" },
              matched_fields: ["title"],
            },
          ],
          total: 1,
        };
      },
    } as unknown as RetrievalToolService;

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          prompt: "What should we do with the widget plan?",
          instructed_by_user_id: "user-1",
          runtime_config_json: { retrieval_tool_mode: "preflight_brief" },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor, retrievalToolService },
    );

    expect(toolActors).toEqual([
      {
        actor: {
          spaceId: "space-1",
          instructedByUserId: "user-1",
          agentId: "agent-1",
          runId: "run-1",
        },
        params: {
          query: "What should we do with the widget plan?",
          mode: "hybrid",
          maxResults: 10,
          includeTrace: false,
        },
      },
    ]);
    expect(calls).toEqual([
      expect.objectContaining({
        tool_mode: "disabled",
        tool_bindings: [],
        messages: [
          { role: "user", content: "What should we do with the widget plan?" },
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Retrieval preflight (retrieval.brief) result:"),
          }),
        ],
      }),
    ]);
    expect(calls[0]).not.toHaveProperty("tools");
    expect(result).toMatchObject({
      success: true,
      output_text: "final after preflight",
      output_json: {
        retrieval_tool_calls: [
          {
            tool_name: "retrieval.brief",
            ok: true,
            result_count: 1,
            synthesized: true,
            preflight: true,
          },
        ],
        artifacts: [
          {
            artifact_type: "retrieval_brief",
            visibility: "private",
            title: "Context Brief: What should we do with the widget plan?",
            metadata_json: expect.objectContaining({
              surface: "managed_run_retrieval_tool",
              owner_user_id: "user-1",
              run_id: "run-1",
              query: "What should we do with the widget plan?",
              item_refs: [
                expect.objectContaining({
                  object_type: "knowledge_item",
                  object_id: "k1",
                  title: "Widget Plan",
                }),
              ],
            }),
          },
        ],
      },
    });
  });

  it("does not inject adapter-side retrieval preflight into a Delivery-backed call", async () => {
    mockRetrievalSettingsPool({ retrieval_tool_mode: "preflight_brief" });
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: Array<Parameters<RuntimeHostExecutor>[1]> = [];
    const toolBrief = vi.fn();

    await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: { retrieval_tool_mode: "preflight_brief" },
        }),
        invocation_delivery: invocationDelivery("delivery-preflight", "Planned Gateway context"),
      },
      {
        executeRuntimeHost: async (_config, request) => {
          calls.push(request);
          return runtimeHostSuccess({ output_text: "planned answer" });
        },
        retrievalToolService: { toolBrief } as unknown as RetrievalToolService,
      },
    );

    expect(toolBrief).not.toHaveBeenCalled();
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "Planned Gateway context" }]);
  });

  it("runs a governed retrieval search preflight without exposing manual tool bindings", async () => {
    const calls: unknown[] = [];
    const toolActors: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "final after search preflight",
        stderr: "",
        output_text: "final after search preflight",
        output_json: { adapter_type: "ts_agent_host" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:02.000Z",
        completed_at: "2026-06-12T10:00:03.000Z",
        model: "gpt-4o-mini",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };
    const retrievalToolService = {
      async toolSearch(actor: unknown, params: unknown) {
        toolActors.push({ actor, params });
        return {
          items: [
            {
              object_type: "knowledge_item",
              object_id: "k1",
              title: "Widget Plan",
              snippet: "staged rollout",
              score: 1,
              evidence: { kind: "lexical_match" },
              matched_fields: ["title"],
            },
          ],
          total: 1,
        };
      },
    } as unknown as RetrievalToolService;

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          prompt: "Find the widget plan",
          instructed_by_user_id: "user-1",
          runtime_config_json: { retrieval_tool_mode: "preflight_search" },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor, retrievalToolService },
    );

    expect(toolActors).toEqual([
      {
        actor: {
          spaceId: "space-1",
          instructedByUserId: "user-1",
          agentId: "agent-1",
          runId: "run-1",
        },
        params: {
          query: "Find the widget plan",
          mode: "hybrid",
          maxResults: 10,
          includeTrace: false,
        },
      },
    ]);
    expect(calls).toEqual([
      expect.objectContaining({
        tool_mode: "disabled",
        tool_bindings: [],
        messages: [
          { role: "user", content: "Find the widget plan" },
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Retrieval preflight (retrieval.search) result:"),
          }),
        ],
      }),
    ]);
    expect(calls[0]).not.toHaveProperty("tools");
    expect(result).toMatchObject({
      success: true,
      output_text: "final after search preflight",
      output_json: {
        retrieval_tool_calls: [
          {
            tool_name: "retrieval.search",
            ok: true,
            result_count: 1,
            preflight: true,
          },
        ],
      },
    });
  });

  it("uses the space-level retrieval_tool_mode when a run has no run-level opt-in", async () => {
    mockRetrievalSettingsPool({ retrieval_tool_mode: "manual_tool_only" });
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "space mode answer",
        stderr: "",
        output_text: "space mode answer",
        output_json: { adapter_type: "ts_agent_host" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:02.000Z",
        completed_at: "2026-06-12T10:00:03.000Z",
        model: "gpt-4o-mini",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: {},
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor },
    );

    expect(calls).toEqual([
      expect.objectContaining({
        tool_mode: "authorized_bindings",
        tool_bindings: [
          expect.objectContaining({ id: "retrieval.search" }),
          expect.objectContaining({ id: "retrieval.brief" }),
        ],
        tools: [
          expect.objectContaining({ name: "retrieval.search" }),
          expect.objectContaining({ name: "retrieval.brief" }),
        ],
      }),
    ]);
    expect(result).toMatchObject({
      success: true,
      output_text: "space mode answer",
    });
  });

  it("exposes Memory and Project retrieval tools only with explicit domain opt-in", async () => {
    mockRetrievalSettingsPool({ retrieval_tool_mode: "manual_tool_only" });
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "domain tools available",
        stderr: "",
        output_text: "domain tools available",
        output_json: { adapter_type: "ts_agent_host" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:02.000Z",
        completed_at: "2026-06-12T10:00:03.000Z",
        model: "gpt-4o-mini",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };

    await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: {
            retrieval_tools: {
              domains: ["memory", "project_public_summary"],
            },
          },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor },
    );

    const first = calls[0] as { tool_bindings?: Array<{ id: string }>; tools?: Array<{ name: string }> };
    expect(first.tool_bindings?.map((tool) => tool.id)).toEqual([
      "retrieval.search",
      "retrieval.brief",
      "memory.retrieval.search",
      "memory.retrieval.brief",
      "project.summary.search",
      "project.summary.brief",
    ]);
    expect(first.tools?.map((tool) => tool.name)).toEqual([
      "retrieval.search",
      "retrieval.brief",
      "memory.retrieval.search",
      "memory.retrieval.brief",
      "project.summary.search",
      "project.summary.brief",
    ]);
  });

  it("executes explicitly opted-in Memory retrieval search tool calls", async () => {
    const pool = mockDomainRetrievalToolPool({ retrieval_tool_mode: "manual_tool_only" });
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: unknown[] = [];
    const firstDelivery = invocationDelivery("delivery-1", "First accepted context");
    const secondDelivery = invocationDelivery("delivery-2", "Second accepted context");
    const invocationAttempts: RunInvocationAttemptLifecycle = {
      prepare: vi.fn(async () => secondDelivery),
      acknowledge: vi.fn(async () => ({} as never)),
      finalize: vi.fn(async () => ({} as never)),
    };
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      if (calls.length === 1) {
        return runtimeHostSuccess({
          output_text: "",
          output_json: {
            adapter_type: "ts_agent_host",
            tool_calls: [
              {
                id: "memory-call-1",
                name: "memory.retrieval.search",
                arguments_json: JSON.stringify({
                  query: "Coffee preferences",
                  mode: "exact",
                  max_results: 3,
                }),
              },
            ],
          },
        });
      }
      return runtimeHostSuccess({ output_text: "final memory answer" });
    };

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: {
            retrieval_tool_mode: "manual_tool_only",
            retrieval_tools: { domains: ["memory"] },
          },
        }),
        model: "gpt-4o-mini",
        invocation_delivery: firstDelivery,
        invocation_attempts: invocationAttempts,
      },
      { executeRuntimeHost: executor },
    );

    const toolPayload = toolPayloadFromRequest(calls[1], "memory.retrieval.search");
    expect(toolPayload).toMatchObject({
      ok: true,
      tool: "memory.retrieval.search",
      total: 1,
      items: [
        {
          object_type: "memory_entry",
          object_id: "memory-1",
          title: "Coffee preferences",
          snippet: "Prefers oat milk for coffee.",
        },
      ],
    });
    expect(pool.auditWrites).toHaveLength(1);
    expect(pool.auditWrites[0]?.[4]).toBe("memory.retrieval.search");
    expect(pool.auditWrites[0]?.[7]).toBe("allow");
    expect(invocationAttempts.prepare).toHaveBeenCalledTimes(1);
    expect(invocationAttempts.acknowledge).toHaveBeenCalledTimes(2);
    expect(invocationAttempts.finalize).toHaveBeenCalledTimes(2);
    expect((calls[0] as { invocation_audit_refs?: { delivery_id: string } }).invocation_audit_refs?.delivery_id)
      .toBe("delivery-1");
    expect((calls[1] as { invocation_audit_refs?: { delivery_id: string } }).invocation_audit_refs?.delivery_id)
      .toBe("delivery-2");
    expect((calls[1] as { messages?: Array<{ role: string; content?: string | null }> }).messages)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Second accepted context" }),
        expect.objectContaining({ role: "tool" }),
      ]));
    expect(result).toMatchObject({
      success: true,
      output_text: "final memory answer",
      output_json: {
        retrieval_tool_calls: [
          {
            tool_name: "memory.retrieval.search",
            domain: "memory",
            ok: true,
            result_count: 1,
          },
        ],
      },
    });
  });

  it("does not relabel lifecycle persistence failures as transport failures", async () => {
    const delivery = invocationDelivery("delivery-lifecycle", "Accepted context");
    const attempts: RunInvocationAttemptLifecycle = {
      prepare: vi.fn(async () => delivery),
      acknowledge: vi.fn(async () => { throw new Error("ack persistence failed"); }),
      finalize: vi.fn(async () => ({} as never)),
    };

    await expect(executeManagedApiNoToolAdapter(
      config(),
      { run: run(), invocation_delivery: delivery, invocation_attempts: attempts },
      { executeRuntimeHost: async () => runtimeHostSuccess({ output_text: "done" }) },
    )).rejects.toThrow("ack persistence failed");

    expect(attempts.acknowledge).toHaveBeenCalledTimes(1);
    expect(attempts.finalize).not.toHaveBeenCalled();
  });

  it("returns an audited requestable denial for an unapproved grantable action", async () => {
    const pool = mockDomainRetrievalToolPool({});
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      if (calls.length === 1) {
        return runtimeHostSuccess({
          output_text: "",
          output_json: {
            adapter_type: "ts_agent_host",
            tool_calls: [{
              id: "bind-call-1",
              name: "project.source.propose_bind",
              arguments_json: JSON.stringify({ source_channel_id: "channel-1" }),
            }],
          },
        });
      }
      return runtimeHostSuccess({ output_text: "I need owner authorization." });
    };

    const grants = ["authorization.request", "project.source.propose_bind"].map(
      (action_id) => ({
        action_id,
        capability_id: null,
        approval_behavior: "none" as const,
        side_effecting: true,
      }),
    );
    await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          project_id: "project-1",
          permission_snapshot_json: { tool_grants: grants },
        }),
      },
      { executeRuntimeHost: executor },
    );

    expect(toolPayloadFromRequest(calls[1], "project.source.propose_bind")).toMatchObject({
      ok: false,
      tool: "project.source.propose_bind",
      error_code: "system_action_policy_denied",
      policy_decision_record_id: "policy-1",
    });
    expect(pool.auditWrites).toHaveLength(1);
    expect(pool.auditWrites[0]?.[4]).toBe("project.source.bind");
    expect(pool.auditWrites[0]?.[7]).toBe("deny");
    expect(pool.auditWrites[0]?.[14]).toBe("managed_system_action_grant_required");
  });

  it("rejects a model-emitted action outside the immutable Run grants", async () => {
    const pool = mockDomainRetrievalToolPool({ retrieval_tool_mode: "manual_tool_only" });
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      if (calls.length === 1) {
        return runtimeHostSuccess({
          output_text: "",
          output_json: {
            adapter_type: "ts_agent_host",
            tool_calls: [{
              id: "ungranted-call-1",
              name: "project.source.propose_bind",
              arguments_json: JSON.stringify({ source_channel_id: "channel-1" }),
            }],
          },
        });
      }
      return runtimeHostSuccess({ output_text: "Action unavailable." });
    };

    await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: {
            retrieval_tool_mode: "manual_tool_only",
            retrieval_tools: { domains: ["memory"] },
          },
        }),
      },
      { executeRuntimeHost: executor },
    );

    expect(toolPayloadFromRequest(calls[1], "project.source.propose_bind")).toMatchObject({
      ok: false,
      tool: "project.source.propose_bind",
      error_code: "system_action_not_granted",
    });
    expect(pool.auditWrites).toHaveLength(0);
  });

  it("returns a domain-not-enabled tool result when Memory is not opted in", async () => {
    const pool = mockDomainRetrievalToolPool({ retrieval_tool_mode: "manual_tool_only" });
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      if (calls.length === 1) {
        return runtimeHostSuccess({
          output_text: "",
          output_json: {
            adapter_type: "ts_agent_host",
            tool_calls: [
              {
                id: "memory-call-1",
                name: "memory.retrieval.search",
                arguments_json: JSON.stringify({
                  query: "Coffee preferences",
                  mode: "exact",
                }),
              },
            ],
          },
        });
      }
      return runtimeHostSuccess({ output_text: "final without memory" });
    };

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: { retrieval_tool_mode: "manual_tool_only" },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor },
    );

    const first = calls[0] as { tool_bindings?: Array<{ id: string }> };
    expect(first.tool_bindings?.map((tool) => tool.id)).toEqual([
      "retrieval.search",
      "retrieval.brief",
    ]);
    expect(toolPayloadFromRequest(calls[1], "memory.retrieval.search")).toMatchObject({
      ok: false,
      tool: "memory.retrieval.search",
      error: "Retrieval tool domain is not enabled for this run.",
    });
    expect(pool.auditWrites).toHaveLength(1);
    expect(pool.auditWrites[0]?.[4]).toBe("memory.retrieval.search");
    expect(pool.auditWrites[0]?.[7]).toBe("deny");
    expect(pool.auditWrites[0]?.[14]).toBe("retrieval_tool_domain_not_enabled");
    expect(result).toMatchObject({
      output_json: {
        retrieval_tool_calls: [
          {
            tool_name: "memory.retrieval.search",
            domain: "memory",
            ok: false,
            error_code: "retrieval_tool_domain_not_enabled",
          },
        ],
      },
    });
  });

  it("rejects wrong-domain object types before executing a retrieval tool", async () => {
    const pool = mockDomainRetrievalToolPool({ retrieval_tool_mode: "manual_tool_only" });
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      if (calls.length === 1) {
        return runtimeHostSuccess({
          output_text: "",
          output_json: {
            adapter_type: "ts_agent_host",
            tool_calls: [
              {
                id: "memory-call-wrong-domain",
                name: "memory.retrieval.search",
                arguments_json: JSON.stringify({
                  query: "Widget plan",
                  object_types: ["knowledge_item"],
                }),
              },
            ],
          },
        });
      }
      return runtimeHostSuccess({ output_text: "final wrong-domain answer" });
    };

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: {
            retrieval_tool_mode: "manual_tool_only",
            retrieval_tools: { domains: ["memory"] },
          },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor },
    );

    expect(toolPayloadFromRequest(calls[1], "memory.retrieval.search")).toMatchObject({
      ok: false,
      tool: "memory.retrieval.search",
      error: "object_types may only include memory_entry.",
    });
    expect(pool.auditWrites).toHaveLength(0);
    expect(result).toMatchObject({
      output_json: {
        retrieval_tool_calls: [
          {
            tool_name: "memory.retrieval.search",
            ok: false,
            error_code: "retrieval_tool_call_failed",
          },
        ],
      },
    });
  });

  it("executes explicitly opted-in Project public-summary brief tool calls", async () => {
    const pool = mockDomainRetrievalToolPool({ retrieval_tool_mode: "manual_tool_only" });
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      if (calls.length === 1) {
        return runtimeHostSuccess({
          output_text: "",
          output_json: {
            adapter_type: "ts_agent_host",
            tool_calls: [
              {
                id: "project-call-1",
                name: "project.summary.brief",
                arguments_json: JSON.stringify({
                  query: "Cross Project Discovery",
                  mode: "exact",
                  max_results: 2,
                  include_trace: true,
                }),
              },
            ],
          },
        });
      }
      return runtimeHostSuccess({ output_text: "final project answer" });
    };

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: {
            retrieval_tool_mode: "manual_tool_only",
            retrieval_tools: { domains: ["project_public_summary"] },
          },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor },
    );

    const toolPayload = toolPayloadFromRequest(calls[1], "project.summary.brief");
    expect(toolPayload).toMatchObject({
      ok: true,
      tool: "project.summary.brief",
      total: 1,
      items: [
        {
          object_type: "project_public_summary",
          object_id: "project-1",
          title: "Cross Project Discovery",
        },
      ],
    });
    expect(pool.auditWrites).toHaveLength(1);
    expect(pool.auditWrites[0]?.[4]).toBe("project.summary.brief");
    expect(pool.auditWrites[0]?.[7]).toBe("allow");
    const artifact = artifactFromResult(result);
    expect(artifact.metadata_json).toMatchObject({
      surface: "managed_run_project_public_summary_retrieval_tool",
      trace: null,
      item_refs: [
        expect.objectContaining({
          object_type: "project_public_summary",
          object_id: "project-1",
          title: "Cross Project Discovery",
        }),
      ],
    });
    expect(artifact.content).not.toContain("Project public summary text");
    expect(artifact.content).not.toContain('"snippet"');
    expect(result).toMatchObject({
      output_json: {
        retrieval_tool_calls: [
          {
            tool_name: "project.summary.brief",
            domain: "project_public_summary",
            ok: true,
            result_count: 1,
          },
        ],
      },
    });
  });

  it("omits Memory brief snippets and trace from managed-run artifacts", async () => {
    mockDomainRetrievalToolPool({ retrieval_tool_mode: "manual_tool_only" });
    __setProviderCommandStoreForTests(fakeProviderStore());
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      if (calls.length === 1) {
        return runtimeHostSuccess({
          output_text: "",
          output_json: {
            adapter_type: "ts_agent_host",
            tool_calls: [
              {
                id: "memory-call-1",
                name: "memory.retrieval.brief",
                arguments_json: JSON.stringify({
                  query: "Coffee preferences",
                  mode: "exact",
                  max_results: 2,
                  include_trace: true,
                }),
              },
            ],
          },
        });
      }
      return runtimeHostSuccess({ output_text: "final memory brief" });
    };

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: {
            retrieval_tool_mode: "manual_tool_only",
            retrieval_tools: { domains: ["memory"] },
          },
        }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor },
    );

    const artifact = artifactFromResult(result);
    expect(artifact.metadata_json).toMatchObject({
      surface: "managed_run_memory_retrieval_tool",
      trace: null,
      item_refs: [
        expect.objectContaining({
          object_type: "memory_entry",
          object_id: "memory-1",
          title: "Coffee preferences",
        }),
      ],
    });
    expect(artifact.content).not.toContain("Prefers oat milk for coffee");
    expect(artifact.content).not.toContain('"snippet"');
    expect(result).toMatchObject({
      output_json: {
        retrieval_tool_calls: [
          {
            tool_name: "memory.retrieval.brief",
            domain: "memory",
            ok: true,
            result_count: 1,
          },
        ],
      },
    });
  });

  it("does not bind retrieval tools for instructed runs without explicit opt-in", async () => {
    const calls: unknown[] = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request);
      return {
        success: true,
        stdout: "no tool output",
        stderr: "",
        output_text: "no tool output",
        output_json: { adapter_type: "ts_agent_host" },
        exit_code: 0,
        error_text: null,
        error_code: null,
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        model: "gpt-4o-mini",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
    };
    const retrievalToolService = {
      async toolBrief() {
        throw new Error("retrieval tool should not run");
      },
    } as unknown as RetrievalToolService;

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({ instructed_by_user_id: "user-1" }),
        model: "gpt-4o-mini",
      },
      { executeRuntimeHost: executor, retrievalToolService },
    );

    expect(calls).toEqual([
      expect.objectContaining({
        tool_mode: "disabled",
        tool_bindings: [],
      }),
    ]);
    expect(result).toMatchObject({
      success: true,
      output_text: "no tool output",
    });
  });

  it("degrades to a no-tool turn when the provider cannot perform tool calls", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const executor: RuntimeHostExecutor = async (_config, request) => {
      calls.push(request as unknown as Record<string, unknown>);
      const base = {
        stderr: "",
        output_json: { adapter_type: "ts_agent_host" },
        started_at: "2026-06-12T10:00:00.000Z",
        completed_at: "2026-06-12T10:00:01.000Z",
        model: "ollama-llama",
        usage: null,
        events: [],
        adapter_metadata: { adapter_type: "ts_agent_host" },
        adapter_log_json: null,
      };
      // First call carries tools; the provider rejects them. Second call is the
      // degraded no-tool turn.
      if ((request as { tool_mode?: string }).tool_mode === "authorized_bindings") {
        return {
          ...base,
          success: false,
          stdout: "",
          output_text: "",
          exit_code: 1,
          error_text: "provider_type 'ollama' does not support runtime-host tools yet",
          error_code: "runtime_tool_provider_unsupported",
        };
      }
      return {
        ...base,
        success: true,
        stdout: "plain answer",
        output_text: "plain answer",
        exit_code: 0,
        error_text: null,
        error_code: null,
      };
    };
    const retrievalToolService = {
      async toolSearch() {
        throw new Error("tool should not run when the provider rejects tools");
      },
      async toolBrief() {
        throw new Error("tool should not run when the provider rejects tools");
      },
    } as unknown as RetrievalToolService;

    const result = await executeManagedApiNoToolAdapter(
      config(),
      {
        run: run({
          instructed_by_user_id: "user-1",
          runtime_config_json: { retrieval_tool_mode: "manual_tool_only" },
        }),
        model: "ollama-llama",
      },
      { executeRuntimeHost: executor, retrievalToolService },
    );

    // Two turns: tool-enabled (rejected) then degraded no-tool.
    expect(calls.map((c) => c.tool_mode)).toEqual(["authorized_bindings", "disabled"]);
    expect(result).toMatchObject({
      success: true,
      output_text: "plain answer",
      output_json: {
        retrieval_tool_calls: [
          { tool_name: "retrieval", ok: false, error_code: "retrieval_tool_provider_unsupported" },
        ],
      },
    });
  });

  // Policy enforcement (runtime.execute / runtime.use_credential) lives upstream
  // in RunOrchestrationService.enforceRuntimePolicy — see
  // runOrchestrationService.test.ts "fails closed before adapter invocation when
  // policy denies". The adapter no longer carries its own policy seam.

  it("fails before runtime-host invocation without an explicit provider grant", async () => {
    const calls: unknown[] = [];

    const result = await executeManagedApiNoToolAdapter(
      config(),
      { run: run({ model_provider_id: null }) },
      {
        executeRuntimeHost: async (_config, request) => {
          calls.push(request);
          throw new Error("runtime host should not run");
        },
      },
    );

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      error_code: "model_provider_required",
      adapter_type: "model_api",
    });
  });

  it("maps runtime-host failures into managed adapter failures", async () => {
    const result = await executeManagedApiNoToolAdapter(
      config(),
      { run: run({ adapter_type: "ts_agent_host" }) },
      {
        executeRuntimeHost: async () => ({
          success: false,
          stdout: "",
          stderr: "bad",
          output_text: "",
          output_json: { adapter_type: "ts_agent_host" },
          exit_code: 1,
          error_text: "provider token=secret failed",
          error_code: "provider_invocation_failed",
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: null,
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
    );

    expect(result).toMatchObject({
      adapter_type: "ts_agent_host",
      success: false,
      error_code: "provider_invocation_failed",
      error_message: "provider [REDACTED_SECRET] failed",
    });
  });

  it("does not send provider HTTP requests when credentials are unavailable", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(emptyCredentialStore(calls));
    __setProviderHttpClientForTests(fakeHttpClient(calls));

    const result = await executeManagedApiNoToolAdapter(
      config(),
      { run: run(), model: "gpt-4o-mini" },
      { executeRuntimeHost: (runtimeConfig, request) => executeRuntimeHost(runtimeConfig, request) },
    );

    expect(result).toMatchObject({
      success: false,
      error_code: "provider_invocation_failed",
      exit_code: 1,
    });
    expect(calls).toEqual(["task:runtime_host", "target:provider-1"]);
  });

});

function emptyCredentialStore(calls: string[]): ProviderCommandStore {
  return {
    resolveUsageAttribution: resolveTestUsageAttribution,
    async getInvocationTarget(_spaceId: string, providerId?: string | null) {
      calls.push(`target:${providerId}`);
      return {
        provider: {
          id: providerId ?? "provider-1",
          space_id: "space-1",
          name: "Main",
          provider_type: "openai",
          base_url: "https://api.example.test/v1",
          default_model: "gpt-4o-mini",
          available_models: ["gpt-4o-mini"],
          enabled: true,
          is_default: true,
        },
        rotation_strategy: "fill_first",
        fallback_provider_ids: [],
        candidates: [],
      };
    },
    async recordPoolOutcome() {
      calls.push("outcome");
    },
    async getTaskChain(_spaceId: string, task: string) {
      calls.push(`task:${task}`);
      return null;
    },
  } as unknown as ProviderCommandStore;
}

function fakeHttpClient(calls: string[]): ProviderHttpClient {
  return {
    async fetch() {
      calls.push("fetch");
      return new Response("{}", { status: 200 });
    },
  };
}

function runtimeHostSuccess(overrides: Partial<Awaited<ReturnType<RuntimeHostExecutor>>> = {}) {
  return {
    success: true,
    stdout: overrides.output_text ?? "ok",
    stderr: "",
    output_text: "ok",
    output_json: { adapter_type: "ts_agent_host" },
    exit_code: 0,
    error_text: null,
    error_code: null,
    started_at: "2026-06-12T10:00:00.000Z",
    completed_at: "2026-06-12T10:00:01.000Z",
    model: "gpt-4o-mini",
    usage: null,
    events: [],
    adapter_metadata: { adapter_type: "ts_agent_host" },
    adapter_log_json: null,
    ...overrides,
  };
}

function toolPayloadFromRequest(request: unknown, toolName: string): Record<string, unknown> {
  const messages = (request as { messages?: Array<{ role: string; name?: string; content?: string }> }).messages ?? [];
  const toolMessage = messages.find((message) => message.role === "tool" && message.name === toolName);
  expect(toolMessage).toBeTruthy();
  return JSON.parse(toolMessage!.content ?? "{}") as Record<string, unknown>;
}

function artifactFromResult(result: Awaited<ReturnType<typeof executeManagedApiNoToolAdapter>>): {
  content: string;
  metadata_json: Record<string, unknown>;
} {
  const artifacts = (result.output_json as { artifacts?: unknown[] }).artifacts ?? [];
  expect(artifacts).toHaveLength(1);
  return artifacts[0] as { content: string; metadata_json: Record<string, unknown> };
}

class DomainRetrievalToolFakePool implements Queryable {
  readonly auditWrites: readonly unknown[][] = [];
  private readonly settings: Record<string, unknown>;

  constructor(settingsOverrides: Record<string, unknown>) {
    this.settings = retrievalSettingsRow(settingsOverrides);
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    if (sql.includes("FROM settings")) {
      return rows([this.settings] as Row[]);
    }
    if (sql.includes("INSERT INTO policy_decision_records")) {
      (this.auditWrites as unknown[][]).push([...params]);
      return rows([{ id: `policy-${this.auditWrites.length}` }] as Row[]);
    }
    if (sql.includes("UPDATE memory_entries") && sql.includes("access_count")) {
      return rows([]);
    }
    if (sql.includes("INSERT INTO content_access_logs")) {
      return rows([]);
    }
    if (sql.includes("FROM action_approval_grants")) {
      return rows([]);
    }
    if (sql.includes("FROM retrieval_aliases ra")) {
      return rows(this.exactAliasRows(params) as Row[]);
    }
    if (sql.includes("FROM retrieval_chunks rc")) {
      return rows([]);
    }
    if (sql.includes("FROM retrieval_edges")) {
      return rows([]);
    }
    if (sql.includes("FROM memory_entries")) {
      return rows(this.memoryRows(params) as Row[]);
    }
    if (sql.includes("FROM project_public_summaries ps")) {
      return rows(this.projectRows(params) as Row[]);
    }
    if (sql.includes("FROM projects")) {
      return rows([]);
    }
    if (sql.includes("FROM spaces")) {
      return rows([{ type: "personal" }] as Row[]);
    }
    if (sql.includes("FROM project_members")) {
      return rows([]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  private exactAliasRows(params: readonly unknown[]) {
    const objectTypes = new Set(Array.isArray(params[1]) ? params[1] : []);
    const aliases = new Set(Array.isArray(params[2]) ? params[2] : []);
    const matches: Array<Record<string, unknown>> = [];
    if (objectTypes.has("memory_entry") && aliases.has("coffee preferences")) {
      matches.push({
        object_type: "memory_entry",
        object_id: "memory-1",
        title: "Coffee preferences",
        snippet: "indexed memory snippet should not be authoritative",
        matched_text: "coffee preferences",
        matched_field: "title",
        updated_at: "2026-06-12T10:00:00.000Z",
        rank: 1,
      });
    }
    if (objectTypes.has("project_public_summary") && aliases.has("cross project discovery")) {
      matches.push({
        object_type: "project_public_summary",
        object_id: "project-1",
        title: "Cross Project Discovery",
        snippet: "indexed project snippet should not be authoritative",
        matched_text: "cross project discovery",
        matched_field: "title",
        updated_at: "2026-06-12T10:00:00.000Z",
        rank: 1,
      });
    }
    return matches;
  }

  private memoryRows(params: readonly unknown[]) {
    const ids = new Set(Array.isArray(params[1]) ? params[1] : []);
    if (!ids.has("memory-1")) return [];
    return [
      {
        id: "memory-1",
        space_id: "space-1",
        deleted_at: null,
        sensitivity_level: "normal",
        visibility: "private",
        owner_user_id: "user-1",
        scope_type: "personal",
        project_folder_id: null,
        access_level: "full",
        project_id: null,
        title: "Coffee preferences",
        content: "Prefers oat milk for coffee.",
      },
    ];
  }

  private projectRows(params: readonly unknown[]) {
    const ids = new Set(Array.isArray(params[1]) ? params[1] : []);
    if (!ids.has("project-1")) return [];
    return [
      {
        project_id: "project-1",
        name: "Cross Project Discovery",
        description: "Approved public summary description.",
        current_focus: "Find shared work across projects.",
        owner_user_id: "user-1",
        status: "active",
        summary_text: "Project public summary text that must not be persisted as a snippet.",
        topics_json: ["discovery"],
        highlights_json: ["shared planning"],
        review_status: "approved",
        updated_at: "2026-06-12T10:00:00.000Z",
      },
    ];
  }
}

function rows<Row>(entries: Row[]): QueryResult<Row> {
  return { rowCount: entries.length, rows: entries };
}
