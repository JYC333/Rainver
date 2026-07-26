import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { ProviderProxyLeaseRegistry } from "../src/modules/providers/proxy/lease";
import { startProviderProxyServer, type ProviderProxyServerHandle } from "../src/modules/providers/proxy/server";
import type { UsageAttribution, UsageObservation } from "../src/modules/usage";
import { startMockUpstream, type MockUpstream } from "./support/mockUpstream";

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
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
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
    const lease = leases.create({
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
    const lease = leases.create({
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
    const lease = leases.create({
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
    const lease = leases.create({
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
    const lease = leases.create({
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
    const lease = leases.create({
      run_id: "run-1",
      space_id: "space-1",
      provider_id: "provider-1",
      provider_type: "anthropic",
      provider_name_snapshot: "MiniMax",
      upstream_base_url: upstream.baseUrl,
      model: "MiniMax-M2.7",
      adapter_type: "claude_code",
      session_id: "session-1",
      parent_run_id: "parent-1",
      root_run_id: "root-1",
      run_group_id: "group-1",
      agent_id: "agent-1",
      project_id: "project-1",
      project_folder_id: "workspace-1",
      trigger_origin: "manual",
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
        adapter_type: "claude_code",
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
        dimensions: { provider_proxy_route: "anthropic" },
      }),
    ]);
    expect(JSON.stringify(usageObservations[0])).not.toContain("response content");
    expect(recordedAttribution).toMatchObject({
      owner_user_id: "user-1",
      visibility: "private",
      source_resource_type: "run",
      source_resource_id: "run-1",
    });
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
    const lease = leases.create({
      run_id: "run-openai",
      space_id: "space-1",
      provider_id: "provider-openai",
      provider_type: "openai",
      provider_name_snapshot: "OpenAI Compatible",
      route: "openai",
      upstream_base_url: `${upstream.baseUrl}/v1`,
      model: "MiniMax-M3",
      adapter_type: "codex_cli",
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
        adapter_type: "codex_cli",
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
