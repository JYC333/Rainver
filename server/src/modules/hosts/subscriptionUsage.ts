import { createHash } from "node:crypto";
import { HostUsageQuotaSchema, type HostUsageQuota, type SubscriptionAccountIdentity, type SubscriptionQuotaPool } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { normalizeHostCapabilities, hasSubscriptionQuota } from "./capabilities.js";
import { isStale } from "./liveness.js";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/specs.js";

/** Unknown logins remain connection-scoped, even on the same Rainver user. */
export function subscriptionPoolId(hostId: string, runtimeKey: string, installation: string, account?: SubscriptionAccountIdentity | null): string {
  const scope = account
    ? [account.provider, account.product, account.identity_kind ?? "vendor_id", account.account_id, account.organization_id]
    : [hostId, runtimeKey, installation];
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

export function quotaWindows(quota: HostUsageQuota): NonNullable<HostUsageQuota["windows"]> {
  const named = quota.windows ?? [];
  const includeAccount = !named.length || quota.account?.product === "claude" || named.some(w => /^(five_hour|seven_day)(_|$)/.test(w.id));
  return [
    ...(includeAccount && quota.session_pct !== null && !named.some(w => w.id === "five_hour" || w.id === "session")
      ? [{ id: "session", label: "Session", used_pct: quota.session_pct, resets: quota.session_resets }] : []),
    ...(includeAccount && quota.week_pct !== null && !named.some(w => w.id === "seven_day" || w.id === "week")
      ? [{ id: "week", label: "Weekly", used_pct: quota.week_pct, resets: quota.week_resets }] : []),
    ...named,
  ];
}

interface SourceRow {
  host_id: string; host_name: string; kind: string; status: string; last_heartbeat_at: string | null;
  capabilities_json: unknown; runtime_key: string | null; installation: string | null;
  quota_json: unknown; checked_at: string | null;
}

/** Apply the existing Host quota read gate BEFORE any account grouping. */
export async function readSubscriptionQuotaPools(db: Queryable, userId: string, instanceAdmin: boolean, now = new Date()): Promise<SubscriptionQuotaPool[]> {
  const result = await db.query<SourceRow>(
    `SELECT host.id AS host_id, host.name AS host_name, host.kind, host.status, host.last_heartbeat_at,
            host.capabilities_json, usage.runtime_key, usage.installation, usage.quota_json, usage.checked_at
       FROM hosts host LEFT JOIN host_runtime_usage usage ON usage.host_id = host.id
      WHERE host.status <> 'revoked'
        AND ((host.kind = 'remote' AND host.owner_user_id = $1) OR (host.kind = 'server' AND $2))
      ORDER BY host.id, usage.runtime_key, usage.installation`, [userId, instanceAdmin],
  );
  const pools = new Map<string, SubscriptionQuotaPool>();
  const hosts = new Map<string, SourceRow[]>();
  for (const row of result.rows) hosts.set(row.host_id, [...(hosts.get(row.host_id) ?? []), row]);
  for (const rows of hosts.values()) {
    const host = rows[0]!;
    const capabilities = normalizeHostCapabilities(host.capabilities_json);
    for (const [runtimeKey, copies] of Object.entries(capabilities.installations)) {
      if (!hasSubscriptionQuota(runtimeKey)) continue;
      for (const copy of copies) {
        const row = rows.find(item => item.runtime_key === runtimeKey && item.installation === copy.id);
        const parsed = HostUsageQuotaSchema.safeParse(row?.quota_json);
        const quota = copy.logged_in === false ? null : parsed.success ? parsed.data : null;
        const account = quota?.account ?? null;
        const id = subscriptionPoolId(host.host_id, runtimeKey, copy.id, account);
        const runtimeName = getRuntimeAdapterSpec(runtimeKey)?.display_name ?? runtimeKey;
        const productName = account?.product === "claude" ? "Claude" : account?.product === "codex" ? "Codex" : account?.product === "antigravity" ? "Antigravity" : runtimeName;
        const pool: SubscriptionQuotaPool = pools.get(id) ?? { id, account, label: account ? `${productName} · ${account.account_id.slice(0, 8)}${account.organization_id ? ` / ${account.organization_id.slice(0, 6)}` : ''}` : `${runtimeName} · ${host.host_name} · ${copy.id}`, windows: [], connections: [] };
        if (quota?.account_display && (!pool.account_display || !pool.connections.length ||
          Date.parse(row?.checked_at ?? "") > Math.max(...pool.connections.map(c => Date.parse(c.checked_at ?? "") || 0)))) {
          pool.account_display = quota.account_display;
        }
        const checkedAt = row?.checked_at ? new Date(row.checked_at).toISOString() : null;
        pool.connections.push({ host_id: host.host_id, host_name: host.host_name, runtime_key: runtimeKey, runtime_name: runtimeName,
          installation: copy.id, online: host.status === "online" && !isStale(host.last_heartbeat_at), can_refresh: true,
          checked_at: checkedAt, error: copy.logged_in === false ? "not_logged_in" : quota?.error ?? null });
        if (quota?.available && checkedAt) for (const window of quotaWindows(quota)) {
          const resetsAt = window.resets ? Date.parse(window.resets.replace(/^Resets\s+/i, "")) : NaN;
          if (Number.isFinite(resetsAt) && resetsAt <= now.getTime()) continue;
          const measuredAt = quota.window_checked_at?.[window.id] ?? checkedAt;
          const previous = pool.windows.findIndex(item => item.id === window.id);
          const snapshot = { ...window, checked_at: measuredAt };
          if (previous < 0) pool.windows.push(snapshot);
          else if (Date.parse(measuredAt) > Date.parse(pool.windows[previous]!.checked_at)) pool.windows[previous] = snapshot;
        }
        pools.set(id, pool);
      }
    }
  }
  return [...pools.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
