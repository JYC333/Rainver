/**
 * The ACP agent registry — the protocol's own list of agents and how each is
 * distributed (https://agentclientprotocol.com/registry). It answers "how is
 * this agent launched", and nothing more: no credentials, no models, no
 * provider endpoints. That is exactly the half of a runtime adapter spec a
 * person should not have to type, and only that half.
 */

import type { RuntimeBinaryTarget, RuntimeDistribution } from "../runtimeAdapters/specs.js";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/** One way of obtaining an agent, as the registry describes it. */
export type AcpBinaryTarget = RuntimeBinaryTarget;
/** Keyed by the registry's platform names: `linux-x86_64`, `darwin-aarch64`, `windows-x86_64`, ... */
export type AcpDistribution = RuntimeDistribution;

export interface AcpRegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string | null;
  repository: string | null;
  license: string | null;
  icon: string | null;
  distribution: AcpDistribution;
}

const REGISTRY_TTL_MS = 60 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 15_000;

export class AcpRegistryError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 502) {
    super(message);
    this.name = "AcpRegistryError";
  }
}

let cache: { at: number; entries: AcpRegistryEntry[] } | null = null;
/** Test seam: a list stands in for the registry; "unavailable" makes every fetch fail. */
let override: AcpRegistryEntry[] | "unavailable" | null = null;

/**
 * The registry entries builtin adapters install their managed copies from,
 * by registry id — what `hello_ack` reads. Filled by the acpAgents refresh
 * loop (from the network when it can, from the persisted copy at startup),
 * never on the hello path itself: a daemon connecting must not wait on a
 * CDN, and an offline server must still be able to say how to install.
 */
const resolvedEntries = new Map<string, AcpRegistryEntry>();

export function setResolvedRegistryEntries(entries: readonly AcpRegistryEntry[]): void {
  resolvedEntries.clear();
  for (const entry of entries) resolvedEntries.set(entry.id, entry);
}

export function resolvedRegistryEntry(registryId: string): AcpRegistryEntry | null {
  return resolvedEntries.get(registryId) ?? null;
}

/** Tests never reach the network: they say what the registry holds (and the hello path sees it at once), or that it is down. */
export function __setAcpRegistryForTests(entries: AcpRegistryEntry[] | "unavailable" | null): void {
  override = entries;
  cache = null;
  setResolvedRegistryEntries(Array.isArray(entries) ? entries : []);
}

export async function fetchAcpRegistry(): Promise<AcpRegistryEntry[]> {
  if (override === "unavailable") throw new AcpRegistryError("acp_registry_unavailable", "ACP registry could not be fetched (test).");
  if (override) return override;
  if (cache && Date.now() - cache.at < REGISTRY_TTL_MS) return cache.entries;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  let body: unknown;
  try {
    const response = await fetch(ACP_REGISTRY_URL, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new AcpRegistryError("acp_registry_unavailable", `ACP registry returned ${response.status}.`);
    body = await response.json();
  } catch (error) {
    if (error instanceof AcpRegistryError) throw error;
    throw new AcpRegistryError("acp_registry_unavailable", `ACP registry could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  const entries = parseRegistry(body);
  cache = { at: Date.now(), entries };
  return entries;
}

function parseRegistry(body: unknown): AcpRegistryEntry[] {
  const root = record(body);
  const agents = Array.isArray(root.agents) ? root.agents : Array.isArray(body) ? body : [];
  return agents.flatMap((raw) => {
    const entry = parseEntry(raw);
    return entry ? [entry] : [];
  });
}

export function parseEntry(raw: unknown): AcpRegistryEntry | null {
  const entry = record(raw);
  const id = str(entry.id);
  const name = str(entry.name);
  const version = str(entry.version);
  const distribution = parseDistribution(entry.distribution);
  if (!id || !name || !version || !distribution || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return null;
  return {
    id,
    name,
    version,
    description: str(entry.description),
    repository: str(entry.repository),
    license: str(entry.license),
    icon: str(entry.icon),
    distribution,
  };
}

/**
 * Accepts both the registry's shape (`{ npx: { package } }`) and this
 * module's own (`{ kind: "npx", package }`), because an enabled agent is
 * stored as the latter and read back through the same parser.
 */
function parseDistribution(raw: unknown): AcpDistribution | null {
  const distribution = record(raw);
  const kind = str(distribution.kind);
  if (kind === "npx" || kind === "uvx") {
    const pkg = str(distribution.package);
    return pkg ? { kind, package: pkg, args: strArray(distribution.args), env: strRecord(distribution.env) } : null;
  }
  if (kind === "binary") return parseBinary(distribution.platforms);
  for (const kind of ["npx", "uvx"] as const) {
    const spec = record(distribution[kind]);
    const pkg = str(spec.package);
    if (pkg) return { kind, package: pkg, args: strArray(spec.args), env: strRecord(spec.env) };
  }
  return parseBinary(distribution.binary);
}

function parseBinary(raw: unknown): AcpDistribution | null {
  const platforms: Record<string, AcpBinaryTarget> = {};
  for (const [platform, value] of Object.entries(record(raw))) {
    const target = record(value);
    const archive = str(target.archive);
    const cmd = str(target.cmd);
    if (!archive || !cmd) continue;
    platforms[platform] = { archive, cmd, args: strArray(target.args), sha256: str(target.sha256), env: strRecord(target.env) };
  }
  return Object.keys(platforms).length > 0 ? { kind: "binary", platforms } : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function strRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
}
