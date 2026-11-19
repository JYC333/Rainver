import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setProvidersDbPortForTests } from "../src/modules/providers/dbReader.js";
import { ProviderProxyLeaseRegistry, setProviderProxyBaseUrlForProcess } from "../src/modules/providers/proxy/lease.js";
import { startProviderProxyServer, type ProviderProxyServerHandle } from "../src/modules/providers/proxy/server.js";
import { buildRemoteProviderBinding } from "../src/modules/runs/remoteProviderBinding.js";
import type { AgentRunRecord } from "../src/modules/runs/repository.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { MODEL_CHANNEL_FORWARDER_SOURCE, startModelChannel } from "../../packages/host-daemon/src/modelChannel.js";
import { materializeProviderBinding } from "../../packages/host-daemon/src/providerBinding.js";

/**
 * Explicit smoke (`MODEL_ONLY_CLI_SMOKE=1`, Linux with unprivileged user and
 * network namespaces): the vendor CLIs installed on this machine, configured
 * by the real binding (`buildRemoteProviderBinding` with a model channel, then
 * the daemon's own `materializeProviderBinding`), run in an unshared network
 * namespace whose only path is the daemon's model-channel relay → the real
 * provider proxy holding a `model_only` lease → a synthetic provider on this
 * machine. No live provider, credential or outside network is used.
 *
 * The CLIs are started through their print/exec entry points, which read the
 * same environment (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`) and `config.toml`
 * (`CODEX_HOME`) as the ACP adapters the product launches; the ACP adapter
 * processes themselves are not part of this smoke. A CLI that is not installed
 * fails the smoke rather than being simulated.
 */
const SMOKE = process.env.MODEL_ONLY_CLI_SMOKE === "1";
const MODEL = "synthetic-model";
const UPSTREAM_KEY = "UPSTREAM-SECRET-not-in-the-run";

interface Seen { url: string; authorization: string | undefined; body: Record<string, any> }
const seen: Seen[] = [];
let upstream: Server;
let upstreamUrl = "";
let proxy: ProviderProxyServerHandle;
const leases = new ProviderProxyLeaseRegistry();
let root = "";

function sse(res: ServerResponse, events: Array<[string, unknown]>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

/** A synthetic provider: first turn asks for one local tool call, the next answers. */
function answer(req: IncomingMessage, res: ServerResponse, raw: string): void {
  const body = JSON.parse(raw || "{}") as Record<string, any>;
  seen.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
  const text = (value: string) => value;
  if (req.url?.startsWith("/v1/messages")) {
    const history = JSON.stringify(body.messages ?? []);
    const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } };
    const end = (reason: string): Array<[string, unknown]> => [["message_delta", { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 1 } }], ["message_stop", { type: "message_stop" }]];
    const want = process.env.MODEL_ONLY_CLI_SMOKE_CLAUDE_TOOL ?? "Bash";
    if (!history.includes("tool_result")) {
      const input = want === "WebSearch" ? { query: "rainver" } : { command: "echo LOCAL-TOOL-RAN", description: "echo" };
      sse(res, [["message_start", start], ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: want, input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }], ...end("tool_use")]);
      return;
    }
    sse(res, [["message_start", start], ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text(history.includes("LOCAL-TOOL-RAN") ? "SYNTHETIC-OK after LOCAL-TOOL-RAN" : "SYNTHETIC-OK") } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }], ...end("end_turn")]);
    return;
  }
  if (req.url === "/v1/responses") {
    const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    const history = JSON.stringify(body.input ?? []);
    const item = !history.includes("function_call_output")
      ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: "echo LOCAL-TOOL-RAN" }), status: "completed" }
      : { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: history.includes("LOCAL-TOOL-RAN") ? "SYNTHETIC-OK after LOCAL-TOOL-RAN" : "SYNTHETIC-OK", annotations: [] }] };
    sse(res, [["response.created", { type: "response.created", response: { id: "resp_1", model: body.model, status: "in_progress", output: [] } }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
      ["response.completed", { type: "response.completed", response: { id: "resp_1", model: body.model, status: "completed", output: [item], usage } }]]);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" }).end("{}");
}

const run = { id: "run-smoke", space_id: "space-1", agent_id: "agent-1", session_id: null, project_id: null, project_folder_id: null, trigger_origin: "manual", instructed_by_user_id: "user-1", owner_user_id: "user-1" } as unknown as AgentRunRecord;

async function launch(runtimeKey: "claude_code" | "codex_cli", argv: string[], tweak?: (files: { relative_path: string; contents: string }[]) => void) {
  const routeIsAnthropic = runtimeKey === "claude_code";
  __setProvidersDbPortForTests({ async getProvider() {
    return { id: "prov-1", name: "Synthetic", provider_type: routeIsAnthropic ? "anthropic" : "openai", default_model: MODEL, available_models: [MODEL],
      claude_compatible_base_url: upstreamUrl, openai_compatible_base_url: `${upstreamUrl}/v1` };
  } } as never);
  const hostRow = { query: async () => ({ rows: [{ provider_proxy_base_url: proxy.baseUrl, kind: "server" }], rowCount: 1 }) } as unknown as Queryable;
  const binding = await buildRemoteProviderBinding({
    config: loadConfig({}), run, hostId: "host-server", runtimeKey, binding: { provider_id: "prov-1", model: MODEL },
    scope: { agent_id: "agent-1", container_kind: "agent", container_id: "agent-1" }, ttlSeconds: 120, leaseRegistry: leases, db: hostRow,
    enforcer: async () => ({ status: "allow" as const, policy_decision_record_id: null }), modelChannel: { loopback_port: 18790 },
  });
  const runDir = await mkdtemp(join(root, `${runtimeKey}-`));
  const channel = await startModelChannel(runDir, binding.model_channel!);
  try {
    if (tweak) tweak(binding.frame.files as { relative_path: string; contents: string }[]);
    const env = await materializeProviderBinding(binding.frame, join(runDir, "profile"), null);
    const ready = join(runDir, "forwarder.ready");
    // Inside: loopback up, the namespace forwarder (the daemon's own source), then the CLI.
    const script = `ip link set lo up && node -e "$FORWARDER" "$SOCK" 18790 "$READY" & i=0; while [ ! -e "$READY" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; exec "$@"`;
    const child = spawn("unshare", ["-rn", "sh", "-c", script, "sh", ...argv], {
      cwd: runDir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "dumb", ...env, FORWARDER: MODEL_CHANNEL_FORWARDER_SOURCE, SOCK: channel.socketPath, READY: ready },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("exit", (exit) => { clearTimeout(timer); resolve(exit); });
    });
    return { code, stdout, stderr, stats: channel.stats(), frame: binding.frame };
  } finally {
    await channel.close();
    binding.revoke();
  }
}

const installed = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

describe.skipIf(!SMOKE)("model-only lease with the installed vendor CLIs (smoke)", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rv-model-only-"));
    upstream = createServer((req, res) => { let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => answer(req, res, raw)); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    proxy = await startProviderProxyServer(loadConfig({}), {
      leaseRegistry: leases,
      commandStore: { async resolveProviderApiKey() { return UPSTREAM_KEY; } },
      resolveUsageAttribution: async () => ({ owner_user_id: "user-1", visibility: "private", access_level: "full", source_resource_type: null, source_resource_id: null, project_folder_id: null, project_id: null, grant_snapshots: [] }),
      async recordUsageObservation() {},
    });
    setProviderProxyBaseUrlForProcess(proxy.baseUrl, null);
  });
  afterAll(async () => {
    __setProvidersDbPortForTests(null);
    await proxy?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("Claude Code: its bound env is consumed, a local tool round-trip completes, and only leased requests reach the provider", async () => {
    expect(installed("claude"), "claude must be installed for this smoke").toBe(true);
    seen.length = 0;
    const result = await launch("claude_code", ["claude", "-p", "Run the echo command, then reply.", "--output-format", "json", "--allowedTools", "Bash(echo:*)"]);
    expect(result.code, result.stderr.slice(-2000)).toBe(0);
    expect(JSON.parse(result.stdout).result).toBe("SYNTHETIC-OK after LOCAL-TOOL-RAN");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const request of seen) {
      expect(request.url).toBe("/v1/messages?beta=true");
      expect(request.body.model).toBe(MODEL);
      expect(request.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    }
    // At most Claude Code's connectivity probe (`HEAD /api/hello`) is stopped, at the POST-only relay;
    // every request the relay forwarded reached the provider.
    expect(result.stats.refused).toBeLessThanOrEqual(1);
    expect(result.stats.forwarded).toBe(seen.length);
    console.info(`claude: relay forwarded ${result.stats.forwarded}, provider received ${seen.length}`);
  });

  it("Claude Code: a hosted web search the model asks for is refused at the lease; the provider never sees it", async () => {
    expect(installed("claude")).toBe(true);
    seen.length = 0;
    process.env.MODEL_ONLY_CLI_SMOKE_CLAUDE_TOOL = "WebSearch";
    try {
      const result = await launch("claude_code", ["claude", "-p", "Search the web for rainver, then reply.", "--output-format", "json", "--allowedTools", "WebSearch"]);
      expect(result.code, result.stderr.slice(-2000)).toBe(0);
      expect(seen.some((r) => JSON.stringify(r.body.tools ?? []).includes("web_search_"))).toBe(false);
      // Claude Code's WebSearch tool is a second request carrying the hosted `web_search_*` tool: it reached the
      // proxy through the relay and stopped there, while the turn itself still completed.
      expect(result.stats.forwarded - seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.length).toBeGreaterThanOrEqual(2);
      console.info(`claude WebSearch: relay forwarded ${result.stats.forwarded}, provider received ${seen.length}, refused at the proxy ${result.stats.forwarded - seen.length}; result ${JSON.stringify(JSON.parse(result.stdout).result).slice(0, 200)}`);
    } finally {
      delete process.env.MODEL_ONLY_CLI_SMOKE_CLAUDE_TOOL;
    }
  });

  it("Codex: its bound config.toml (hosted web search off) is consumed and a local function call round-trips", async () => {
    expect(installed("codex"), "codex must be installed for this smoke").toBe(true);
    seen.length = 0;
    const result = await launch("codex_cli", ["codex", "exec", "--skip-git-repo-check", "-s", "read-only", "Run the echo command, then reply."]);
    expect(result.code, result.stderr.slice(-2000)).toBe(0);
    expect(result.stdout).toContain("SYNTHETIC-OK after LOCAL-TOOL-RAN");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const request of seen) {
      expect(request.url).toBe("/v1/responses");
      expect(request.body.model).toBe(MODEL);
      expect(JSON.stringify(request.body.tools)).not.toContain("web_search");
      // The provider is told not to store: Responses would otherwise store by default.
      expect(request.body.store).toBe(false);
      expect(request.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    }
    console.info(`codex: relay forwarded ${result.stats.forwarded}, provider received ${seen.length}`);
  });

  it("Codex: the same lease refuses the CLI's default hosted web search when the config does not switch it off", async () => {
    expect(installed("codex")).toBe(true);
    seen.length = 0;
    const result = await launch("codex_cli", ["codex", "exec", "--skip-git-repo-check", "-s", "read-only", "Reply."], (files) => {
      const toml = files.find((file) => file.relative_path === ".codex/config.toml")!;
      toml.contents = toml.contents.replace('web_search = "disabled"\n', "");
    });
    expect(result.code).not.toBe(0);
    expect(result.stats.forwarded).toBeGreaterThan(0);
    expect(seen).toHaveLength(0);
  });
});
