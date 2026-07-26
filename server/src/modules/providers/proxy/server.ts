import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { ServerConfig } from "../../../config";
import {
  ProviderCommandValidationError,
  resolveProviderCommandStore,
  type ProviderCommandStore,
} from "../commands/store";
import {
  providerProxyLeases,
  setProviderProxyBaseUrlForProcess,
  type ResolvedProviderProxyLease,
  type ProviderProxyLeaseRegistry,
  type ProviderProxyRoute,
} from "./lease";
import {
  fetchWithNetworkProfile,
  resolveNetworkProfileRepository,
} from "../../networkProfiles";
import {
  recordAttributedUsageObservation as recordUsage,
  resolveUsageObservationAttribution as resolveUsageAttribution,
  type UsageAttribution,
  type UsageObservation,
} from "../../usage";

const MAX_PROXY_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PROXY_USAGE_PARSE_BYTES = 2 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
// The fetch implementation used for the upstream request transparently
// decodes content-encoding. These headers describe the encoded representation,
// not the decoded body that this proxy sends to the client.
const DECODED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
]);

export interface ProviderProxyServerHandle {
  baseUrl: string;
  close(): Promise<void>;
}

export interface ProviderProxyServerDeps {
  leaseRegistry?: ProviderProxyLeaseRegistry;
  commandStore?: Pick<ProviderCommandStore, "resolveProviderApiKey">;
  resolveUsageAttribution?: (observation: UsageObservation) => Promise<UsageAttribution>;
  recordUsageObservation?: (
    observation: UsageObservation,
    attribution: UsageAttribution,
  ) => Promise<void>;
  fetch?: typeof fetch;
}

export async function startProviderProxyServer(
  config: ServerConfig,
  deps: ProviderProxyServerDeps = {},
): Promise<ProviderProxyServerHandle> {
  const leaseRegistry = deps.leaseRegistry ?? providerProxyLeases;
  const server = createServer((request, response) => {
    void handleProviderProxyRequest(config, request, response, {
      leaseRegistry,
      commandStore: deps.commandStore,
      resolveUsageAttribution: deps.resolveUsageAttribution,
      recordUsageObservation: deps.recordUsageObservation,
      fetch: deps.fetch,
    }).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 502, { error: "provider_proxy_failed" });
      } else {
        response.destroy();
      }
    });
  });

  const host = "127.0.0.1";
  await listen(server, host, 0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://${host}:${address.port}`;
  setProviderProxyBaseUrlForProcess(baseUrl);
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          setProviderProxyBaseUrlForProcess(null);
          return err ? reject(err) : resolve();
        }),
      ),
  };
}

async function handleProviderProxyRequest(
  config: ServerConfig,
  request: IncomingMessage,
  response: ServerResponse,
  deps: {
    leaseRegistry: ProviderProxyLeaseRegistry;
    commandStore?: Pick<ProviderCommandStore, "resolveProviderApiKey">;
    resolveUsageAttribution?: (observation: UsageObservation) => Promise<UsageAttribution>;
    recordUsageObservation?: (
      observation: UsageObservation,
      attribution: UsageAttribution,
    ) => Promise<void>;
    fetch?: typeof fetch;
  },
): Promise<void> {
  const parsed = new URL(request.url ?? "/", "http://provider-proxy.local");
  const parts = parsed.pathname.split("/").filter(Boolean);
  const route = providerProxyRoute(parts[0]);
  if (!route || !parts[1]) {
    sendJson(response, 404, { error: "provider_proxy_route_not_found" });
    return;
  }

  const token = requestLeaseToken(request);
  if (!token) {
    sendJson(response, 401, { error: "provider_proxy_token_required" });
    return;
  }

  const lease = deps.leaseRegistry.resolve(decodeURIComponent(parts[1]), token);
  if (!lease || lease.route !== route) {
    sendJson(response, 401, { error: "provider_proxy_token_invalid" });
    return;
  }

  let apiKey: string;
  try {
    const commandStore = deps.commandStore ?? resolveProviderCommandStore(config);
    apiKey = await commandStore.resolveProviderApiKey(lease.space_id, lease.provider_id);
  } catch (error) {
    const status = error instanceof ProviderCommandValidationError ? 400 : 404;
    sendJson(response, status, { error: "provider_proxy_credential_unavailable" });
    return;
  }

  const body = await readBody(request);
  const attributionObservation = providerProxyUsageObservation(lease, null);
  const attribution = deps.resolveUsageAttribution
    ? await deps.resolveUsageAttribution(attributionObservation)
    : await resolveUsageAttribution(config, attributionObservation);
  const upstreamUrl = upstreamRequestUrl(
    lease.upstream_base_url,
    `/${parts.slice(2).join("/")}`,
    parsed.search,
  );
  const fetchImpl = await fetchForLease(config, lease, deps.fetch);
  const upstream = await fetchImpl(upstreamUrl, {
    method: request.method ?? "GET",
    headers: upstreamHeaders(route, request, apiKey),
    body: methodMayHaveBody(request.method) ? body : undefined,
  });

  await forwardUpstreamResponse(
    config,
    response,
    upstream,
    lease,
    attribution,
    deps.recordUsageObservation,
  );
}

async function fetchForLease(
  config: ServerConfig,
  lease: { space_id: string; network_profile_id: string | null },
  override?: typeof fetch,
): Promise<typeof fetch> {
  if (override) return override;
  // A lease without a network profile is intentionally a direct egress route.
  // Do not ask the network-profile repository to resolve a null profile: that
  // turns local provider proxy tests (and local development) into a database
  // dependency and can hang before the upstream request is made.
  if (!lease.network_profile_id) return globalThis.fetch;
  const profile = await resolveNetworkProfileRepository(config).resolve(
    lease.space_id,
    lease.network_profile_id,
  );
  return fetchWithNetworkProfile(profile);
}

function providerProxyRoute(value: string | undefined): ProviderProxyRoute | null {
  return value === "anthropic" || value === "openai" ? value : null;
}

async function forwardUpstreamResponse(
  config: ServerConfig,
  response: ServerResponse,
  upstream: Response,
  lease: ResolvedProviderProxyLease,
  attribution: UsageAttribution,
  recordUsageObservation?: (
    observation: UsageObservation,
    attribution: UsageAttribution,
  ) => Promise<void>,
): Promise<void> {
  response.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(normalized) && !DECODED_RESPONSE_HEADERS.has(normalized)) {
      response.setHeader(key, value);
    }
  });

  if (!upstream.body) {
    await recordProviderProxyUsage(config, lease, upstream, null, attribution, recordUsageObservation);
    response.end();
    return;
  }

  if (shouldInspectJsonUsage(upstream)) {
    const inspected = await readResponseBodyForUsage(upstream.body, MAX_PROXY_USAGE_PARSE_BYTES);
    if (inspected.complete) {
      await recordProviderProxyUsage(
        config,
        lease,
        upstream,
        proxyUsageMetadata(inspected.body),
        attribution,
        recordUsageObservation,
      );
      response.end(inspected.body);
      return;
    }

    await recordProviderProxyUsage(config, lease, upstream, null, attribution, recordUsageObservation);
    for (const chunk of inspected.chunks) await writeResponseChunk(response, chunk);
    await pipeReaderToResponse(inspected.reader, response);
    return;
  }

  await recordProviderProxyUsage(config, lease, upstream, null, attribution, recordUsageObservation);
  Readable.fromWeb(upstream.body).pipe(response);
}

function shouldInspectJsonUsage(upstream: Response): boolean {
  if (!upstream.ok) return false;
  if (upstream.headers.has("content-encoding")) return false;
  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) return false;
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MAX_PROXY_USAGE_PARSE_BYTES) return false;
  }
  return true;
}

async function readResponseBodyForUsage(
  body: ReadableStream<Uint8Array>,
  limitBytes: number,
): Promise<
  | { complete: true; body: Buffer }
  | { complete: false; chunks: Buffer[]; reader: ReadableStreamDefaultReader<Uint8Array> }
> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { complete: true, body: Buffer.concat(chunks, total) };
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    total += chunk.length;
    if (total > limitBytes) return { complete: false, chunks, reader };
  }
}

async function pipeReaderToResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  response: ServerResponse,
): Promise<void> {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      response.end();
      return;
    }
    await writeResponseChunk(response, Buffer.from(value));
  }
}

async function writeResponseChunk(response: ServerResponse, chunk: Buffer): Promise<void> {
  if (response.write(chunk)) return;
  await once(response, "drain");
}

interface ProxyUsageMetadata {
  model: string | null;
  providerUsage: Record<string, unknown>;
}

function proxyUsageMetadata(body: Buffer): ProxyUsageMetadata | null {
  const parsed = parseJsonObject(body);
  if (!parsed) return null;
  const usage = recordValue(parsed.usage);
  return {
    model: stringValue(parsed.model),
    providerUsage: usage,
  };
}

async function recordProviderProxyUsage(
  config: ServerConfig,
  lease: ResolvedProviderProxyLease,
  upstream: Response,
  metadata: ProxyUsageMetadata | null,
  attribution: UsageAttribution,
  recordUsageObservation?: (
    observation: UsageObservation,
    attribution: UsageAttribution,
  ) => Promise<void>,
): Promise<void> {
  if (!upstream.ok) return;
  const observation = providerProxyUsageObservation(lease, metadata);
  if (recordUsageObservation) await recordUsageObservation(observation, attribution);
  else await recordUsage(config, observation, attribution);
}

function providerProxyUsageObservation(
  lease: ResolvedProviderProxyLease,
  metadata: ProxyUsageMetadata | null,
): UsageObservation {
  const providerUsage = metadata?.providerUsage ?? {};
  return {
    space_id: lease.space_id,
    event_type: "llm.generation",
    source_type: "provider_proxy",
    execution_channel: "provider_proxy",
    meter_subject_type: "run",
    meter_subject_id: lease.run_id,
    run_id: lease.run_id,
    source_resource_type: "run",
    source_resource_id: lease.run_id,
    space_system_task: true,
    root_run_id: lease.root_run_id,
    parent_run_id: lease.parent_run_id,
    run_group_id: lease.run_group_id,
    session_id: lease.session_id,
    agent_id: lease.agent_id,
    project_id: lease.project_id,
    project_folder_id: lease.project_folder_id,
    trigger_origin: lease.trigger_origin,
    adapter_type: lease.adapter_type,
    provider_id: lease.provider_id,
    provider_type: lease.provider_type ?? lease.route,
    provider_name_snapshot: lease.provider_name_snapshot,
    vendor: lease.route === "anthropic" ? "anthropic" : "openai",
    model: metadata?.model ?? lease.model,
    provider_usage: providerUsage,
    usage_accuracy: hasUsage(providerUsage) ? "proxy_observed" : "unknown",
    dimensions: {
      provider_proxy_route: lease.route,
    },
  };
}

function parseJsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return recordValue(parsed);
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function hasUsage(value: Record<string, unknown>): boolean {
  return Object.values(value).some(hasUsageValue);
}

function hasUsageValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasUsageValue);
  if (typeof value === "object") return Object.values(value).some(hasUsageValue);
  return false;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function requestLeaseToken(request: IncomingMessage): string | null {
  const auth = firstHeader(request.headers.authorization);
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  return (
    firstHeader(request.headers["anthropic-auth-token"]) ??
    firstHeader(request.headers["x-api-key"]) ??
    null
  );
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  if (!methodMayHaveBody(request.method)) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_PROXY_REQUEST_BYTES) {
      throw new Error("provider proxy request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function methodMayHaveBody(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function upstreamHeaders(
  route: ProviderProxyRoute,
  request: IncomingMessage,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const normalized = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      normalized === "host" ||
      normalized === "content-length" ||
      normalized === "authorization" ||
      normalized === "x-api-key" ||
      normalized === "anthropic-auth-token"
    ) {
      continue;
    }
    const first = firstHeader(value);
    if (first !== null) headers[key] = first;
  }
  headers.authorization = `Bearer ${apiKey}`;
  // Do not ask the upstream for a compressed representation. The proxy uses
  // fetch, which may transparently decode compressed responses; requesting the
  // identity representation also avoids forwarding representation metadata
  // that cannot describe the body sent to the CLI client.
  headers["accept-encoding"] = "identity";
  if (route === "anthropic") headers["x-api-key"] = apiKey;
  return headers;
}

function upstreamRequestUrl(baseUrl: string, path: string, search: string): string {
  const suffix = path === "/" ? "" : path;
  return `${baseUrl.replace(/\/+$/, "")}${suffix}${search}`;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
