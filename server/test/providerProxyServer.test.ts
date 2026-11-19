import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialSpendAuthorization } from "../src/modules/policy/credentialSpend.js";
import { loadConfig } from "../src/config.js";
import { ProviderProxyLeaseRegistry } from "../src/modules/providers/proxy/lease.js";
import { pipeReaderToResponse, startProviderProxyServer, type ProviderProxyServerHandle } from "../src/modules/providers/proxy/server.js";
import type { UsageAttribution, UsageObservation } from "../src/modules/usage/index.js";
import { startMockUpstream, type MockUpstream } from "./support/mockUpstream.js";

/** A decided spend, as `authorizeCredentialSpend` returns one. */
function authorizedFor(spaceId: string, runId: string, providerId: string): CredentialSpendAuthorization {
  return {
    space_id: spaceId,
    run_id: runId,
    provider_id: providerId,
    trigger_origin: "manual",
    policy_decision_record_id: null,
  } as unknown as CredentialSpendAuthorization;
}

const handles: ProviderProxyServerHandle[] = [];
const upstreams: MockUpstream[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) {
    await handle.close();
  }
  for (const upstream of upstreams.splice(0).reverse()) {
    await upstream.close();
  }
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
  });
}

async function testUsageAttribution(input: UsageObservation): Promise<UsageAttribution> {
  return {
    owner_user_id: "user-1",
    visibility: "private",
    access_level: "full",
    source_resource_type: input.source_resource_type ?? null,
    source_resource_id: input.source_resource_id ?? null,
    project_folder_id: null,
    project_id: null,
    grant_snapshots: [],
  };
}

describe("provider proxy server", () => {
  it("mints no lease from a spend decided for another Run or provider", () => {
    const leases = new ProviderProxyLeaseRegistry();
    const input = {
      run_id: "run-1",
      space_id: "space-1",
      provider_id: "provider-1",
      upstream_base_url: "https://upstream.example.test/anthropic",
      ttl_ms: 60_000,
    };
    expect(() => leases.create(authorizedFor("space-1", "run-2", "provider-1"), input)).toThrow();
    expect(() => leases.create(authorizedFor("space-1", "run-1", "provider-2"), input)).toThrow();
    expect(() => leases.create(authorizedFor("space-2", "run-1", "provider-1"), input)).toThrow();
    expect(leases.size()).toBe(0);
    leases.create(authorizedFor("space-1", "run-1", "provider-1"), input);
    expect(leases.size()).toBe(1);
  });

  it("renews live leases without reviving revoked or expired leases", () => {
    vi.useFakeTimers();
    try {
      const leases = new ProviderProxyLeaseRegistry();
      const lease = leases.create(authorizedFor("space-1", "run-1", "provider-1"), {
        run_id: "run-1", space_id: "space-1", provider_id: "provider-1",
        upstream_base_url: "https://upstream.example.test", ttl_ms: 1_000,
      });
      vi.advanceTimersByTime(500);
      leases.renew(lease.id, 2_000);
      vi.advanceTimersByTime(600);
      expect(leases.resolve(lease.id, lease.token)).not.toBeNull();
      vi.advanceTimersByTime(2_000);
      leases.renew(lease.id, 2_000);
      expect(leases.resolve(lease.id, lease.token)).toBeNull();
      leases.revoke(lease.id);
      leases.renew(lease.id, 2_000);
      expect(leases.resolve(lease.id, lease.token)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("forwards a Claude-compatible request with provider credentials instead of the lease token", async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const leases = new ProviderProxyLeaseRegistry();
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: {
        async resolveProviderApiKey(spaceId, providerId) {
          expect(spaceId).toBe("space-1");
          expect(providerId).toBe("provider-1");
          return "provider-secret";
        },
      },
      resolveUsageAttribution: testUsageAttribution,
      async recordUsageObservation() {},
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "run-1", "provider-1"), {
      run_id: "run-1",
      space_id: "space-1",
      provider_id: "provider-1",
      upstream_base_url: `${upstream.baseUrl}/anthropic`,
      model: "MiniMax-M2.7",
      ttl_ms: 60_000,
    });

    const response = await fetch(`${proxy.baseUrl}/anthropic/${lease.id}/v1/messages?trace=1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.token}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "lease-token-must-not-pass",
      },
      body: JSON.stringify({ model: "MiniMax-M2.7", messages: [] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      seen_path: "/anthropic/v1/messages?trace=1",
    });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: "POST",
      url: "/anthropic/v1/messages?trace=1",
      body: JSON.stringify({ model: "MiniMax-M2.7", messages: [] }),
    });
    expect(upstream.requests[0].headers.authorization).toBe("Bearer provider-secret");
    expect(upstream.requests[0].headers["x-api-key"]).toBe("provider-secret");
    expect(upstream.requests[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(upstream.requests[0].headers["accept-encoding"]).toBe("identity");
  });

  it("holds a lease judged local to its model, so a request cannot switch to one the server forwards to the cloud", async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const leases = new ProviderProxyLeaseRegistry();
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: { async resolveProviderApiKey() { return "provider-secret"; } },
      resolveUsageAttribution: testUsageAttribution,
      async recordUsageObservation() {},
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "run-local", "provider-local"), {
      run_id: "run-local",
      space_id: "space-1",
      provider_id: "provider-local",
      route: "openai",
      upstream_base_url: `${upstream.baseUrl}/v1`,
      model: "llama3.1",
      pinned_model: "llama3.1",
      ttl_ms: 60_000,
    });
    const send = (model: string) => fetch(`${proxy.baseUrl}/openai/${lease.id}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [] }),
    });

    const refused = await send("gpt-oss:120b-cloud");
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({ error: "provider_proxy_model_not_leased" });
    expect(upstream.requests).toHaveLength(0);
    expect((await send("llama3.1")).status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });

  it("holds a pinned lease to its model when a request names none: the local server must not pick one", async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const leases = new ProviderProxyLeaseRegistry();
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: { async resolveProviderApiKey() { return "provider-secret"; } },
      resolveUsageAttribution: testUsageAttribution,
      async recordUsageObservation() {},
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "run-local", "provider-local"), {
      run_id: "run-local", space_id: "space-1", provider_id: "provider-local", route: "openai",
      upstream_base_url: `${upstream.baseUrl}/v1`, model: "llama3.1", pinned_model: "llama3.1", ttl_ms: 60_000,
    });
    for (const body of [JSON.stringify({ messages: [] }), JSON.stringify({ model: "", messages: [] }), "not json"]) {
      const refused = await fetch(`${proxy.baseUrl}/openai/${lease.id}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" }, body,
      });
      expect(refused.status).toBe(403);
    }
    expect(upstream.requests).toHaveLength(0);
  });

  describe("a model-only lease (the model channel of a network-isolated Run)", () => {
    async function setup(route: "anthropic" | "openai", requestPolicy: "model_only" | null = "model_only") {
      const upstream = await startMockUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: ping\ndata: {\"part\":1}\n\n");
        setTimeout(() => res.end("event: done\ndata: {\"part\":2}\n\n"), 20);
      });
      upstreams.push(upstream);
      const leases = new ProviderProxyLeaseRegistry();
      const proxy = await startProviderProxyServer(config(), {
        leaseRegistry: leases,
        commandStore: { async resolveProviderApiKey() { return "provider-secret"; } },
        resolveUsageAttribution: testUsageAttribution,
        async recordUsageObservation() {},
      });
      handles.push(proxy);
      const lease = leases.create(authorizedFor("space-1", "run-iso", "provider-1"), {
        run_id: "run-iso", space_id: "space-1", provider_id: "provider-1", route,
        upstream_base_url: route === "openai" ? `${upstream.baseUrl}/v1` : upstream.baseUrl,
        model: "leased-model", request_policy: requestPolicy, ttl_ms: 60_000,
      });
      // Each response is read to its end, as a CLI does, and returned with its body.
      const send = async (path: string, body: unknown, init: { method?: string; contentType?: string } = {}) => {
        const response = await fetch(`${proxy.baseUrl}/${route}/${lease.id}${path}`, {
          method: init.method ?? "POST",
          headers: { authorization: `Bearer ${lease.token}`, "content-type": init.contentType ?? "application/json" },
          body: init.method === "GET" || init.method === "HEAD" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        });
        return { status: response.status, body: await response.text() };
      };
      return { upstream, leases, send };
    }
    // The shapes the installed Claude Code (2.1.318) and Codex (0.167.1) sent to a synthetic provider.
    const claudeTurn = {
      model: "leased-model", max_tokens: 32000, stream: true, metadata: { user_id: "{}" },
      thinking: { type: "adaptive", display: "omitted" }, context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      output_config: { effort: "high" },
      system: [{ type: "text", text: "sys" }, { type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Bash", description: "run", input_schema: { type: "object" } }, { name: "DeferredToolPlaceholder", description: "x", input_schema: { type: "object", properties: {} }, defer_loading: true }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: "note" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi", url: "https://example.invalid/" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi", is_error: false, cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
      ],
    };
    const codexTurn = {
      model: "leased-model", stream: true, store: false, tool_choice: "auto", parallel_tool_calls: true, reasoning: { summary: "auto" },
      include: ["reasoning.encrypted_content"], prompt_cache_key: "k", client_metadata: { turn_id: "t" }, instructions: "be codex",
      tools: [
        { type: "function", name: "exec_command", description: "run", parameters: { type: "object" }, strict: false },
        { type: "namespace", name: "multi_agent_v1", description: "agents", tools: [{ type: "function", name: "spawn", description: "s", parameters: {}, strict: false }] },
      ],
      input: [
        { type: "message", id: "m1", role: "developer", content: [{ type: "input_text", text: "dev" }] },
        { type: "message", id: "m2", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: "{}", status: "completed" },
        { type: "function_call_output", id: "fo_1", call_id: "call_1", output: "ok" },
      ],
    };

    it("forwards exactly the CLIs' inference requests, streamed, and nothing a lease of the same token would add", async () => {
      const claude = await setup("anthropic");
      const forwarded = await claude.send("/v1/messages?beta=true", claudeTurn);
      expect(forwarded.status).toBe(200);
      expect(forwarded.body).toContain('"part":2');
      expect((await claude.send("/v1/messages/count_tokens?beta=true", { model: "leased-model", messages: claudeTurn.messages, tools: claudeTurn.tools })).status).toBe(200);
      expect(claude.upstream.requests.map((r) => r.url)).toEqual(["/v1/messages?beta=true", "/v1/messages/count_tokens?beta=true"]);
      const codex = await setup("openai");
      expect((await codex.send("/responses", codexTurn)).status).toBe(200);
      expect((await codex.send("/chat/completions", { model: "leased-model", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "read", parameters: {} } }] })).status).toBe(200);
      expect(codex.upstream.requests.map((r) => r.url)).toEqual(["/v1/responses", "/v1/chat/completions"]);
    });

    it("refuses resource endpoints, other methods, hosted tools, provider-side fetches, unknown fields and another or missing model", async () => {
      const claude = await setup("anthropic");
      const anthropicRefusals: Array<[string, unknown, { method?: string; contentType?: string }?]> = [
        ["/v1/models", null, { method: "GET" }],
        ["/api/hello", null, { method: "HEAD" }],
        ["/v1/files", { model: "leased-model" }],
        ["/v1/messages/batches", { requests: [] }],
        ["/v1/messages/batches/b1/results", null, { method: "GET" }],
        ["/v1/messages", claudeTurn, { method: "PUT" }],
        ["/v1/messages?beta=false", claudeTurn],
        ["/v1/messages?beta=true&x=1", claudeTurn],
        ["/v1/messages", "not json"],
        ["/v1/messages", JSON.stringify(claudeTurn), { contentType: "text/plain" }],
        ["/v1/messages", { ...claudeTurn, model: undefined }],
        ["/v1/messages", { ...claudeTurn, model: "other-model" }],
        ["/v1/messages", { ...claudeTurn, mcp_servers: [{ type: "url", url: "https://mcp.example.invalid", name: "x" }] }],
        ["/v1/messages", { ...claudeTurn, container: "c1" }],
        ["/v1/messages", { ...claudeTurn, unknown_feature: true }],
        ["/v1/messages", { ...claudeTurn, tools: [{ type: "web_search_20250305", name: "web_search" }] }],
        ["/v1/messages", { ...claudeTurn, tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }],
        ["/v1/messages", { ...claudeTurn, tools: [{ type: "code_execution_20250825", name: "code_execution" }] }],
        ["/v1/messages", { ...claudeTurn, tools: [{ type: "tool_search_tool_regex_20251119", name: "tool_search" }] }],
        ["/v1/messages", { ...claudeTurn, tools: [{ name: "Bash", input_schema: {}, allowed_callers: ["code_execution_20250825"] }] }],
        ["/v1/messages", { ...claudeTurn, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.invalid/a.png" } }] }] }],
        ["/v1/messages", { ...claudeTurn, messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "file_1" } }] }] }],
        ["/v1/messages", { ...claudeTurn, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "url", url: "https://example.invalid/b.png" } }] }] }] }],
        ["/v1/messages", { ...claudeTurn, messages: [{ role: "user", content: [{ type: "container_upload", file_id: "file_1" }] }] }],
        ["/v1/messages", { ...claudeTurn, messages: [{ role: "assistant", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }] }] }],
        ["/v1/messages", { ...claudeTurn, messages: [{ role: "user", content: [{ type: "text", text: "x", extra: 1 }] }] }],
        ["/v1/messages", { ...claudeTurn, context_management: { edits: [{ type: "fetch_everything_20990101" }] } }],
      ];
      for (const [path, body, init] of anthropicRefusals) {
        const response = await claude.send(path, body, init);
        expect(response.status, `${path} ${JSON.stringify(body)?.slice(0, 120)}`).toBe(403);
        if (init?.method !== "HEAD") expect(JSON.parse(response.body)).toMatchObject({ error: "provider_proxy_request_not_leased" });
      }
      const codex = await setup("openai");
      const openaiRefusals: Array<[string, unknown, { method?: string }?]> = [
        ["/files", { purpose: "batch" }],
        ["/batches", { input_file_id: "f", endpoint: "/v1/responses" }],
        ["/responses/resp_1", null, { method: "GET" }],
        ["/responses/resp_1", null, { method: "DELETE" }],
        ["/responses/resp_1/input_items", null, { method: "GET" }],
        ["/models", null, { method: "GET" }],
        ["/vector_stores", { name: "x" }],
        ["/responses", { ...codexTurn, model: undefined }],
        ["/responses", { ...codexTurn, model: "gpt-other" }],
        ["/responses", { ...codexTurn, tools: [...codexTurn.tools, { type: "web_search", external_web_access: true }] }],
        ["/responses", { ...codexTurn, tools: [{ type: "web_search_preview" }] }],
        ["/responses", { ...codexTurn, tools: [{ type: "file_search", vector_store_ids: ["v"] }] }],
        ["/responses", { ...codexTurn, tools: [{ type: "code_interpreter", container: { type: "auto" } }] }],
        ["/responses", { ...codexTurn, tools: [{ type: "mcp", server_url: "https://mcp.example.invalid", server_label: "x" }] }],
        ["/responses", { ...codexTurn, tools: [{ type: "image_generation" }] }],
        ["/responses", { ...codexTurn, tools: [{ type: "namespace", name: "n", tools: [{ type: "web_search" }] }] }],
        ["/responses", { ...codexTurn, tool_choice: { type: "web_search_preview" } }],
        ["/responses", { ...codexTurn, include: ["web_search_call.action.sources"] }],
        ["/responses", { ...codexTurn, store: true }],
        ["/responses", { ...codexTurn, background: true }],
        ["/responses", { ...codexTurn, previous_response_id: "resp_0" }],
        ["/responses", { ...codexTurn, conversation: "conv_1" }],
        ["/responses", { ...codexTurn, unknown_feature: 1 }],
        ["/responses", { ...codexTurn, input: [{ type: "item_reference", id: "msg_0" }] }],
        ["/responses", { ...codexTurn, input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/a.png" }] }] }],
        ["/responses", { ...codexTurn, input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] }],
        ["/responses", { ...codexTurn, input: [{ type: "web_search_call", id: "ws", status: "completed" }] }],
        ["/chat/completions", { model: "leased-model", messages: [], web_search_options: {} }],
        ["/chat/completions", { model: "leased-model", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/a.png" } }] }] }],
        ["/chat/completions", { model: "leased-model", messages: [{ role: "user", content: [{ type: "file", file: { file_id: "f" } }] }] }],
      ];
      for (const [path, body, init] of openaiRefusals) {
        const response = await codex.send(path, body, init);
        expect(response.status, `${path} ${JSON.stringify(body)?.slice(0, 120)}`).toBe(403);
      }
      // Nothing refused ever reached the provider.
      expect(claude.upstream.requests).toHaveLength(0);
      expect(codex.upstream.requests).toHaveLength(0);
      // Inline images stay usable.
      expect((await codex.send("/responses", { ...codexTurn, input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }] }] })).status).toBe(200);
    });

    it("judges a tool's output as model input: no URL, file id or unknown block, and Responses must say store: false", async () => {
      const codex = await setup("openai");
      const call = { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{}" };
      const withOutput = (item: Record<string, unknown>) => ({ ...codexTurn, input: [call, item] });
      const fetches = [
        [{ type: "input_image", image_url: "https://attacker.example.invalid/beacon.png" }],
        [{ type: "input_image", image_url: { url: "https://attacker.example.invalid/beacon.png" } }],
        [{ type: "input_image", file_id: "file_1" }],
        [{ type: "input_file", file_url: "https://attacker.example.invalid/doc.pdf" }],
        [{ type: "input_file", file_id: "file_1" }],
        [{ type: "input_file", file_data: "data:application/pdf;base64,JVBERi0=", file_url: "https://attacker.example.invalid/doc.pdf" }],
        [{ type: "input_text", text: "ok" }, { type: "web_fetch_result", url: "https://attacker.example.invalid/" }],
        [{ type: "input_text", text: "ok", extra: 1 }],
        { url: "https://attacker.example.invalid/" },
        7,
      ];
      const refusals: unknown[] = [];
      for (const output of fetches) {
        refusals.push(withOutput({ type: "function_call_output", call_id: "call_1", output }));
        refusals.push(withOutput({ type: "custom_tool_call_output", call_id: "call_1", output }));
      }
      refusals.push(
        withOutput({ type: "local_shell_call_output", call_id: "call_1", output: [{ type: "input_image", image_url: "https://attacker.example.invalid/x.png" }] }),
        withOutput({ type: "local_shell_call", call_id: "call_1", action: { type: "exec", command: ["ls"], url: "https://attacker.example.invalid/" } }),
        withOutput({ type: "reasoning", summary: [{ type: "input_image", image_url: "https://attacker.example.invalid/x.png" }] }),
        withOutput({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "t", file_id: "f" }] }),
        withOutput({ type: "message", role: "assistant", content: [{ type: "output_text", text: "t", annotations: [{ type: "file_citation", file_id: "file_1", index: 0 }] }] }),
        { ...codexTurn, store: undefined },
        { ...codexTurn, store: true },
        { ...codexTurn, store: "false" },
        { ...codexTurn, store: 0 },
        { ...codexTurn, store: null },
      );
      for (const body of refusals) {
        const response = await codex.send("/responses", body);
        expect(response.status, JSON.stringify(body).slice(-200)).toBe(403);
        expect(JSON.parse(response.body)).toMatchObject({ error: "provider_proxy_request_not_leased" });
      }
      for (const store of ["yes", true, 1, null]) {
        expect((await codex.send("/chat/completions", { model: "leased-model", store, messages: [{ role: "user", content: "hi" }] })).status).toBe(403);
      }
      // Nothing refused reached the provider: no attacker URL, file id or stored response.
      expect(codex.upstream.requests).toHaveLength(0);

      // Text and inline content a local tool returns still round-trip, and the provider receives store: false.
      const inline = [
        { type: "input_text", text: "LOCAL-TOOL-RAN" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=", detail: "auto" },
        { type: "input_file", filename: "out.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
      ];
      const allowed = [
        withOutput({ type: "function_call_output", call_id: "call_1", output: "LOCAL-TOOL-RAN" }),
        withOutput({ type: "function_call_output", call_id: "call_1", output: inline }),
        withOutput({ type: "custom_tool_call_output", call_id: "call_1", output: inline }),
        withOutput({ type: "local_shell_call_output", call_id: "call_1", output: "LOCAL-TOOL-RAN" }),
        withOutput({ type: "reasoning", summary: [{ type: "summary_text", text: "s" }], encrypted_content: "e" }),
        withOutput({ type: "message", role: "assistant", content: [{ type: "output_text", text: "t", annotations: [] }] }),
      ];
      for (const body of allowed) expect((await codex.send("/responses", body)).status, JSON.stringify(body).slice(-200)).toBe(200);
      expect((await codex.send("/chat/completions", { model: "leased-model", store: false, messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
      expect((await codex.send("/chat/completions", { model: "leased-model", messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
      const received = codex.upstream.requests.map((r) => JSON.parse(r.body) as Record<string, unknown>);
      expect(received).toHaveLength(allowed.length + 2);
      for (const body of received.slice(0, allowed.length)) expect(body.store).toBe(false);
      expect(codex.upstream.requests.some((r) => r.body.includes("attacker.example.invalid") || r.body.includes("file_1"))).toBe(false);
    });

    it("leaves an ordinary lease's requests as they were", async () => {
      const ordinary = await setup("openai", null);
      expect((await ordinary.send("/responses", { ...codexTurn, tools: [{ type: "web_search", external_web_access: true }] })).status).toBe(200);
      expect((await ordinary.send("/models", null, { method: "GET" })).status).toBe(200);
      expect(ordinary.upstream.requests.map((r) => r.url)).toEqual(["/v1/responses", "/v1/models"]);
    });

    it("is issued only for a named model", () => {
      const leases = new ProviderProxyLeaseRegistry();
      expect(() => leases.create(authorizedFor("space-1", "run-iso", "provider-1"), {
        run_id: "run-iso", space_id: "space-1", provider_id: "provider-1", route: "anthropic",
        upstream_base_url: "http://upstream.invalid", model: null, request_policy: "model_only", ttl_ms: 60_000,
      })).toThrow(/one named model/);
      expect(leases.size()).toBe(0);
    });
  });

  it("does not forward upstream encoding metadata after fetch decodes the body", async () => {
    const leases = new ProviderProxyLeaseRegistry();
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: {
        async resolveProviderApiKey() {
          return "provider-secret";
        },
      },
      resolveUsageAttribution: testUsageAttribution,
      async recordUsageObservation() {},
      fetch: async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "br",
          "content-length": "999",
        },
      }),
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "run-encoding", "provider-encoding"), {
      run_id: "run-encoding",
      space_id: "space-1",
      provider_id: "provider-encoding",
      route: "openai",
      upstream_base_url: "https://provider.example",
      ttl_ms: 60_000,
    });

    const response = await fetch(`${proxy.baseUrl}/openai/${lease.id}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("999");
  });

  it("ends a stream the provider breaks without taking the proxy down", async () => {
    const leases = new ProviderProxyLeaseRegistry();
    let calls = 0;
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: { async resolveProviderApiKey() { return "provider-secret"; } },
      resolveUsageAttribution: testUsageAttribution,
      async recordUsageObservation() {},
      fetch: async () => {
        calls += 1;
        const broken = calls === 1;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(broken ? "data: one\n\n" : "data: two\n\n"));
            if (!broken) controller.close();
          },
          pull(controller) {
            if (broken) controller.error(new Error("terminated"));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "run-stream", "provider-stream"), {
      run_id: "run-stream",
      space_id: "space-1",
      provider_id: "provider-stream",
      route: "openai",
      upstream_base_url: "https://provider.example",
      ttl_ms: 60_000,
    });
    const request = () => fetch(`${proxy.baseUrl}/openai/${lease.id}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: "{}",
    });

    // The broken request fails, at the headers or mid-body; the proxy lives on.
    await expect(request().then((response) => response.text())).rejects.toThrow();
    await expect((await request()).text()).resolves.toContain("data: two");
  });

  it("stops streaming and releases the upstream body when the client goes away under backpressure", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    // A response whose socket buffer is full: write() says wait for 'drain'.
    // The client then hangs up, which is 'close', never 'drain'.
    class StalledResponse extends EventEmitter {
      destroyed = false;
      writableEnded = false;
      writes = 0;
      write(): boolean { this.writes += 1; return false; }
      end(): void { this.writableEnded = true; }
    }
    const response = new StalledResponse();

    const piping = pipeReaderToResponse(upstream.getReader(), response as unknown as ServerResponse, []);
    await vi.waitUntil(() => response.writes === 1);
    response.destroyed = true;
    response.emit("close");

    await piping;
    expect(cancelled).toBe(true);
    expect(response.writes).toBe(1);
  });

  it("rejects invalid lease tokens before reaching the upstream provider", async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const leases = new ProviderProxyLeaseRegistry();
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: {
        async resolveProviderApiKey() {
          return "provider-secret";
        },
      },
      resolveUsageAttribution: testUsageAttribution,
      async recordUsageObservation() {},
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "run-1", "provider-1"), {
      run_id: "run-1",
      space_id: "space-1",
      provider_id: "provider-1",
      upstream_base_url: upstream.baseUrl,
      ttl_ms: 60_000,
    });

    const response = await fetch(`${proxy.baseUrl}/anthropic/${lease.id}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects unavailable Run attribution before reaching the upstream provider", async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const leases = new ProviderProxyLeaseRegistry();
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: {
        async resolveProviderApiKey() {
          return "provider-secret";
        },
      },
      async resolveUsageAttribution() {
        throw new Error("Run attribution unavailable");
      },
      async recordUsageObservation() {
        throw new Error("usage must not be recorded");
      },
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "missing-run", "provider-1"), {
      run_id: "missing-run",
      space_id: "space-1",
      provider_id: "provider-1",
      upstream_base_url: upstream.baseUrl,
      ttl_ms: 60_000,
    });

    const response = await fetch(`${proxy.baseUrl}/anthropic/${lease.id}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(502);
    expect(upstream.requests).toHaveLength(0);
  });

  it("forwards an OpenAI-compatible request with bearer provider credentials", async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const leases = new ProviderProxyLeaseRegistry();
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: {
        async resolveProviderApiKey(spaceId, providerId) {
          expect(spaceId).toBe("space-1");
          expect(providerId).toBe("provider-openai");
          return "provider-secret";
        },
      },
      resolveUsageAttribution: testUsageAttribution,
      async recordUsageObservation() {},
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "run-1", "provider-openai"), {
      run_id: "run-1",
      space_id: "space-1",
      provider_id: "provider-openai",
      route: "openai",
      upstream_base_url: `${upstream.baseUrl}/v1`,
      model: "MiniMax-M3",
      ttl_ms: 60_000,
    });

    const response = await fetch(`${proxy.baseUrl}/openai/${lease.id}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.token}`,
        "content-type": "application/json",
        "x-api-key": "lease-token-must-not-pass",
      },
      body: JSON.stringify({ model: "MiniMax-M3", input: "hello" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      seen_path: "/v1/responses",
    });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/responses",
      body: JSON.stringify({ model: "MiniMax-M3", input: "hello" }),
    });
    expect(upstream.requests[0].headers.authorization).toBe("Bearer provider-secret");
    expect(upstream.requests[0].headers["x-api-key"]).toBeUndefined();
  });

  it("records bounded Anthropic-compatible proxy usage without storing response content", async () => {
    const usageObservations: UsageObservation[] = [];
    let recordedAttribution: UsageAttribution | null = null;
    const upstream = await startMockUpstream((_req, res) => {
      const payload = {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "MiniMax-M2.7",
        content: [{ type: "text", text: "response content must not be metered" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
        },
      };
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
      });
      res.end(body);
    });
    upstreams.push(upstream);
    const leases = new ProviderProxyLeaseRegistry();
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: {
        async resolveProviderApiKey() {
          return "provider-secret";
        },
      },
      resolveUsageAttribution: testUsageAttribution,
      async recordUsageObservation(input, attribution) {
        usageObservations.push(input);
        recordedAttribution = attribution;
      },
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "run-1", "provider-1"), {
      run_id: "run-1",
      space_id: "space-1",
      provider_id: "provider-1",
      provider_type: "anthropic",
      provider_name_snapshot: "MiniMax",
      upstream_base_url: upstream.baseUrl,
      model: "MiniMax-M2.7",
      runtime_key: "claude_code",
      session_id: "session-1",
      parent_run_id: "parent-1",
      root_run_id: "root-1",
      run_group_id: "group-1",
      agent_id: "agent-1",
      project_id: "project-1",
      project_folder_id: "workspace-1",
      trigger_origin: "manual",
      invocation_audit_refs: {
        delivery_id: "delivery-1",
        invocation_snapshot_id: "snapshot-1",
        execution_control_snapshot_id: "control-1",
        usage_source_id: "usage-source-1",
      },
      ttl_ms: 60_000,
    });

    const response = await fetch(`${proxy.baseUrl}/anthropic/${lease.id}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "MiniMax-M2.7", messages: [] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ model: "MiniMax-M2.7" });
    expect(usageObservations).toEqual([
      expect.objectContaining({
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "provider_proxy",
        execution_channel: "provider_proxy",
        meter_subject_type: "run",
        meter_subject_id: "run-1",
        run_id: "run-1",
        source_resource_type: "run",
        source_resource_id: "run-1",
        root_run_id: "root-1",
        parent_run_id: "parent-1",
        run_group_id: "group-1",
        session_id: "session-1",
        agent_id: "agent-1",
        project_id: "project-1",
        project_folder_id: "workspace-1",
        trigger_origin: "manual",
        runtime_key: "claude_code",
        provider_id: "provider-1",
        provider_type: "anthropic",
        provider_name_snapshot: "MiniMax",
        vendor: "anthropic",
        model: "MiniMax-M2.7",
        provider_usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
        },
        usage_accuracy: "proxy_observed",
        idempotency_key: "usage-source-1:proxy:1",
        metadata: {
          runtime_context_audit_refs: {
            delivery_id: "delivery-1",
            invocation_snapshot_id: "snapshot-1",
            execution_control_snapshot_id: "control-1",
            usage_source_id: "usage-source-1",
          },
        },
        dimensions: {
          provider_proxy_route: "anthropic",
          delivery_id: "delivery-1",
          invocation_snapshot_id: "snapshot-1",
          execution_control_snapshot_id: "control-1",
          usage_source_id: "usage-source-1",
        },
      }),
    ]);
    expect(JSON.stringify(usageObservations[0])).not.toContain("response content");
    expect(recordedAttribution).toMatchObject({
      owner_user_id: "user-1",
      visibility: "private",
      source_resource_type: "run",
      source_resource_id: "run-1",
    });

    const secondResponse = await fetch(`${proxy.baseUrl}/anthropic/${lease.id}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "MiniMax-M2.7", messages: [] }),
    });
    expect(secondResponse.status).toBe(200);
    await secondResponse.json();
    expect(usageObservations.map((observation) => observation.idempotency_key)).toEqual([
      "usage-source-1:proxy:1",
      "usage-source-1:proxy:2",
    ]);
  });

  it("records bounded OpenAI-compatible proxy usage", async () => {
    const usageObservations: UsageObservation[] = [];
    const upstream = await startMockUpstream((_req, res) => {
      const payload = {
        id: "resp-1",
        model: "MiniMax-M3",
        output: [{ type: "message", content: [{ type: "output_text", text: "drop me" }] }],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      };
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
      });
      res.end(body);
    });
    upstreams.push(upstream);
    const leases = new ProviderProxyLeaseRegistry();
    const proxy = await startProviderProxyServer(config(), {
      leaseRegistry: leases,
      commandStore: {
        async resolveProviderApiKey() {
          return "provider-secret";
        },
      },
      resolveUsageAttribution: testUsageAttribution,
      async recordUsageObservation(input) {
        usageObservations.push(input);
      },
    });
    handles.push(proxy);
    const lease = leases.create(authorizedFor("space-1", "run-openai", "provider-openai"), {
      run_id: "run-openai",
      space_id: "space-1",
      provider_id: "provider-openai",
      provider_type: "openai",
      provider_name_snapshot: "OpenAI Compatible",
      route: "openai",
      upstream_base_url: `${upstream.baseUrl}/v1`,
      model: "MiniMax-M3",
      runtime_key: "codex_cli",
      ttl_ms: 60_000,
    });

    const response = await fetch(`${proxy.baseUrl}/openai/${lease.id}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "MiniMax-M3", input: "hello" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ model: "MiniMax-M3" });
    expect(usageObservations).toEqual([
      expect.objectContaining({
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "provider_proxy",
        execution_channel: "provider_proxy",
        meter_subject_type: "run",
        meter_subject_id: "run-openai",
        run_id: "run-openai",
        source_resource_type: "run",
        source_resource_id: "run-openai",
        runtime_key: "codex_cli",
        provider_id: "provider-openai",
        provider_type: "openai",
        provider_name_snapshot: "OpenAI Compatible",
        vendor: "openai",
        model: "MiniMax-M3",
        provider_usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          output_tokens_details: { reasoning_tokens: 2 },
        },
        usage_accuracy: "proxy_observed",
        dimensions: { provider_proxy_route: "openai" },
      }),
    ]);
    expect(JSON.stringify(usageObservations[0])).not.toContain("drop me");
  });
});
