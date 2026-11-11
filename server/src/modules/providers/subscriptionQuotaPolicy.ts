import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError, resolveIdentity, sendRouteError, type Queryable } from "../routeUtils/common.js";
import { defineScopedSetting, ScopedSettingsStore, settingsRecord } from "../settings/scopedSettings.js";

/**
 * Where a Space draws its two subscription lines (`modules/rooms.md`,
 * "Subscription quota gate"): `warn_pct`, from which the composer and a discussion's header
 * show the account's utilization, and `reserve_pct`, from which
 * Agent-triggered turns wait for the window to reset (`rooms/quotaGate.ts`).
 * Person-origin turns are never held; they proceed until the CLI itself
 * refuses.
 */
interface SubscriptionQuotaPolicyValue {
  warn_pct: number;
  reserve_pct: number;
}

function pct(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : fallback;
}

const SUBSCRIPTION_QUOTA_POLICY = defineScopedSetting<SubscriptionQuotaPolicyValue>({
  key: "subscription_quota",
  scopeType: "space",
  defaults: { ...protocol.SUBSCRIPTION_QUOTA_POLICY_DEFAULTS },
  parse(value) {
    const record = settingsRecord(value);
    const reserve = pct(record.reserve_pct, protocol.SUBSCRIPTION_QUOTA_POLICY_DEFAULTS.reserve_pct);
    const warn = pct(record.warn_pct, protocol.SUBSCRIPTION_QUOTA_POLICY_DEFAULTS.warn_pct);
    return { warn_pct: Math.min(warn, reserve), reserve_pct: reserve };
  },
});

/** `provider.subscription_quota_policy.set`, in the caller's transaction; authority is the operation's. */
export async function writeSubscriptionQuotaPolicyIn(db: Queryable, spaceId: string, userId: string, value: SubscriptionQuotaPolicyValue): Promise<SubscriptionQuotaPolicyValue> {
  const stored = await new ScopedSettingsStore(db).upsert(SUBSCRIPTION_QUOTA_POLICY, spaceId, value, { updatedByUserId: userId });
  return protocol.SubscriptionQuotaPolicySchema.parse(stored.value);
}

export async function readSubscriptionQuotaPolicy(db: Queryable, spaceId: string): Promise<SubscriptionQuotaPolicyValue> {
  return (await new ScopedSettingsStore(db).get(SUBSCRIPTION_QUOTA_POLICY, spaceId)).value;
}

/**
 * `GET /api/v1/providers/subscription-quota-policy`. Any member reads the
 * lines (the composer needs them); a Space owner or admin moves them through
 * `provider.subscription_quota_policy.set` (`PUT` on the same URL). Claimed
 * explicitly because `GET /api/v1/providers/:configId` would otherwise read
 * it as a provider id.
 */
export function registerSubscriptionQuotaPolicyRoutes(app: FastifyInstance, config: ServerConfig): void {
  const path = "/api/v1/providers/subscription-quota-policy";
  app.get(path, async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(protocol.SubscriptionQuotaPolicySchema.parse(
        await readSubscriptionQuotaPolicy(pool(config), identity.spaceId),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function pool(config: ServerConfig) {
  if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
  return getDbPool(config.databaseUrl);
}
