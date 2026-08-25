import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { InvocationAuditRefs } from "@agent-space/protocol" with { "resolution-mode": "import" };

export interface ProviderProxyLeaseInput {
  run_id: string;
  space_id: string;
  provider_id: string;
  provider_type?: string | null;
  provider_name_snapshot?: string | null;
  network_profile_id?: string | null;
  route?: ProviderProxyRoute;
  upstream_base_url: string;
  model?: string | null;
  adapter_type?: string | null;
  session_id?: string | null;
  parent_run_id?: string | null;
  root_run_id?: string | null;
  run_group_id?: string | null;
  agent_id?: string | null;
  project_id?: string | null;
  project_folder_id?: string | null;
  trigger_origin?: string | null;
  /**
   * The execution host this lease was issued for, when it is not the server.
   * Recorded so revoking a host also revokes its live leases — otherwise a
   * machine that was just cut off keeps spending the space's provider
   * credential until every in-flight lease expires on its own.
   */
  host_id?: string | null;
  invocation_audit_refs?: InvocationAuditRefs | null;
  ttl_ms: number;
}

export type ProviderProxyRoute = "anthropic" | "openai";

export interface ProviderProxyLease {
  id: string;
  token: string;
  run_id: string;
  space_id: string;
  provider_id: string;
  provider_type: string | null;
  provider_name_snapshot: string | null;
  network_profile_id: string | null;
  host_id: string | null;
  route: ProviderProxyRoute;
  upstream_base_url: string;
  model: string | null;
  adapter_type: string | null;
  session_id: string | null;
  parent_run_id: string | null;
  root_run_id: string | null;
  run_group_id: string | null;
  agent_id: string | null;
  project_id: string | null;
  project_folder_id: string | null;
  trigger_origin: string | null;
  invocation_audit_refs: InvocationAuditRefs | null;
  expires_at: string;
}

export interface ResolvedProviderProxyLease {
  id: string;
  token_hash: Buffer;
  run_id: string;
  space_id: string;
  provider_id: string;
  provider_type: string | null;
  provider_name_snapshot: string | null;
  network_profile_id: string | null;
  host_id: string | null;
  route: ProviderProxyRoute;
  upstream_base_url: string;
  model: string | null;
  adapter_type: string | null;
  session_id: string | null;
  parent_run_id: string | null;
  root_run_id: string | null;
  run_group_id: string | null;
  agent_id: string | null;
  project_id: string | null;
  project_folder_id: string | null;
  trigger_origin: string | null;
  invocation_audit_refs: InvocationAuditRefs | null;
  usage_sequence: number;
  expires_at_ms: number;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

let processProviderProxyBaseUrl: string | null = null;
/**
 * How a *remote* execution host reaches the same proxy. Separate from the
 * in-network URL above because that one names a Compose service, which a
 * paired machine cannot resolve. Null means remote provider binding is not
 * configured, and callers say so rather than handing out an unusable URL.
 */
let processProviderProxyExternalBaseUrl: string | null = null;

export function setProviderProxyBaseUrlForProcess(
  baseUrl: string | null,
  externalBaseUrl: string | null = null,
): void {
  processProviderProxyBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : null;
  processProviderProxyExternalBaseUrl = externalBaseUrl ? externalBaseUrl.replace(/\/+$/, "") : null;
}

/**
 * Where one lease lives under a proxy base URL. The shape is the proxy's own
 * routing contract (`server.ts` splits the path back into route and lease id),
 * so every caller that builds such a URL goes through here rather than
 * repeating it — there were four copies, and a wire format spread across four
 * expressions is one edit away from disagreeing.
 */
export function providerProxyLeaseUrl(baseUrl: string, route: ProviderProxyRoute, leaseId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${route}/${encodeURIComponent(leaseId)}`;
}

export function providerProxyLeaseBaseUrl(route: ProviderProxyRoute, leaseId: string): string {
  if (!processProviderProxyBaseUrl) {
    throw new Error("Provider proxy listener is not started.");
  }
  return providerProxyLeaseUrl(processProviderProxyBaseUrl, route, leaseId);
}

/** Null when this deployment has not published the proxy for remote hosts. */
export function providerProxyExternalLeaseUrl(route: ProviderProxyRoute, leaseId: string): string | null {
  if (!processProviderProxyExternalBaseUrl) return null;
  return providerProxyLeaseUrl(processProviderProxyExternalBaseUrl, route, leaseId);
}

export class ProviderProxyLeaseRegistry {
  private readonly leases = new Map<string, ResolvedProviderProxyLease>();

  create(input: ProviderProxyLeaseInput): ProviderProxyLease {
    this.pruneExpired();
    const token = randomBytes(32).toString("base64url");
    const record: ResolvedProviderProxyLease = {
      id: randomUUID(),
      token_hash: hashToken(token),
      run_id: input.run_id,
      space_id: input.space_id,
      provider_id: input.provider_id,
      provider_type: input.provider_type ?? null,
      host_id: input.host_id ?? null,
      provider_name_snapshot: input.provider_name_snapshot ?? null,
      network_profile_id: input.network_profile_id ?? null,
      route: input.route ?? "anthropic",
      upstream_base_url: normalizeBaseUrl(input.upstream_base_url),
      model: input.model ?? null,
      adapter_type: input.adapter_type ?? null,
      session_id: input.session_id ?? null,
      parent_run_id: input.parent_run_id ?? null,
      root_run_id: input.root_run_id ?? null,
      run_group_id: input.run_group_id ?? null,
      agent_id: input.agent_id ?? null,
      project_id: input.project_id ?? null,
      project_folder_id: input.project_folder_id ?? null,
      trigger_origin: input.trigger_origin ?? null,
      invocation_audit_refs: input.invocation_audit_refs ?? null,
      usage_sequence: 0,
      expires_at_ms: Date.now() + Math.max(input.ttl_ms, 1_000),
    };
    this.leases.set(record.id, record);
    return {
      id: record.id,
      token,
      run_id: record.run_id,
      space_id: record.space_id,
      provider_id: record.provider_id,
      provider_type: record.provider_type,
      host_id: record.host_id,
      provider_name_snapshot: record.provider_name_snapshot,
      network_profile_id: record.network_profile_id,
      route: record.route,
      upstream_base_url: record.upstream_base_url,
      model: record.model,
      adapter_type: record.adapter_type,
      session_id: record.session_id,
      parent_run_id: record.parent_run_id,
      root_run_id: record.root_run_id,
      run_group_id: record.run_group_id,
      agent_id: record.agent_id,
      project_id: record.project_id,
      project_folder_id: record.project_folder_id,
      trigger_origin: record.trigger_origin,
      invocation_audit_refs: record.invocation_audit_refs,
      expires_at: new Date(record.expires_at_ms).toISOString(),
    };
  }

  resolve(id: string, token: string): ResolvedProviderProxyLease | null {
    const lease = this.leases.get(id);
    if (!lease) return null;
    if (lease.expires_at_ms <= Date.now()) {
      this.leases.delete(id);
      return null;
    }
    const presented = hashToken(token);
    if (
      presented.length !== lease.token_hash.length ||
      !timingSafeEqual(presented, lease.token_hash)
    ) {
      return null;
    }
    return lease;
  }

  revoke(id: string): void {
    this.leases.delete(id);
  }

  revokeRun(runId: string): void {
    for (const [id, lease] of this.leases) {
      if (lease.run_id === runId) this.leases.delete(id);
    }
  }

  /** Cuts off a revoked execution host's in-flight leases immediately. */
  revokeHost(hostId: string): number {
    let revoked = 0;
    for (const [id, lease] of this.leases) {
      if (lease.host_id === hostId) {
        this.leases.delete(id);
        revoked += 1;
      }
    }
    return revoked;
  }

  size(): number {
    this.pruneExpired();
    return this.leases.size;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, lease] of this.leases) {
      if (lease.expires_at_ms <= now) this.leases.delete(id);
    }
  }
}

export const providerProxyLeases = new ProviderProxyLeaseRegistry();
