import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

/**
 * Subscription quota as the conversation surface sees it (server
 * `modules/rooms.md`, "Cost lines, by funding source" and "Subscription quota gate").
 *
 * A subscription is an account-level window — Claude's five-hour and weekly
 * limits, Codex's equivalents — read per CLI login on the host that holds it
 * (`HostUsageQuota`). Its percentage belongs to the account, never to one
 * discussion; what a discussion spent on it is counted in tokens.
 */

/** Space policy: where the warning line and the reserve line sit, in percent of the window. */
export const SubscriptionQuotaPolicySchema = z.object({
  /** At or above this the composer and the discussion header show the utilization line. */
  warn_pct: z.number().int().min(1).max(100),
  /** At or above this Agent-triggered turns are held until the window resets or a person continues anyway. */
  reserve_pct: z.number().int().min(1).max(100),
  ...SecretResponseGuards,
}).strict().refine((policy) => policy.warn_pct <= policy.reserve_pct, {
  message: "warn_pct must not be above reserve_pct",
  path: ["warn_pct"],
});
export type SubscriptionQuotaPolicy = z.infer<typeof SubscriptionQuotaPolicySchema>;

export const SUBSCRIPTION_QUOTA_POLICY_DEFAULTS = { warn_pct: 70, reserve_pct: 85 } as const;

export const SubscriptionQuotaPolicyUpdateSchema = z.object({
  warn_pct: z.number().int().min(1).max(100),
  reserve_pct: z.number().int().min(1).max(100),
}).strict().refine((policy) => policy.warn_pct <= policy.reserve_pct, {
  message: "warn_pct must not be above reserve_pct",
  path: ["warn_pct"],
});
export type SubscriptionQuotaPolicyUpdate = z.infer<typeof SubscriptionQuotaPolicyUpdateSchema>;

/**
 * The fuller of a login's windows: the one that decides whether an
 * Agent-triggered turn may start. `resets_at` is null when the vendor gave a
 * reset time that is not a date.
 */
export const SubscriptionQuotaWindowSchema = z.object({
  kind: z.enum(["session", "week"]),
  utilization: z.number().min(0).max(100),
  resets_at: ISODateTimeSchema.nullable(),
}).strict();
export type SubscriptionQuotaWindow = z.infer<typeof SubscriptionQuotaWindowSchema>;

/** One subscription a discussion ran on: its tokens there, and the account's window. */
export const SubscriptionUsageLineSchema = z.object({
  account_label: z.string(),
  tokens: z.number().int().nonnegative(),
  window: SubscriptionQuotaWindowSchema.nullable(),
}).strict();
export type SubscriptionUsageLine = z.infer<typeof SubscriptionUsageLineSchema>;

/** Agent-triggered turns waiting for a subscription window, and until when. */
export const SubscriptionQuotaHoldSchema = z.object({
  account_label: z.string(),
  window: z.enum(["session", "week"]),
  resets_at: ISODateTimeSchema.nullable(),
  run_ids: z.array(IdSchema),
  /**
   * Whether the viewer may continue these Runs anyway: only whoever may spend
   * the login — its host's owner, or for the built-in host a Space owner or
   * admin — is offered to spend its reserve.
   */
  can_continue: z.boolean(),
}).strict();
export type SubscriptionQuotaHold = z.infer<typeof SubscriptionQuotaHoldSchema>;

/** A CLI login a conversation's Agents run on, with its latest reading. */
export const ConversationSubscriptionLoginSchema = z.object({
  account_label: z.string(),
  window: SubscriptionQuotaWindowSchema.nullable(),
  checked_at: ISODateTimeSchema.nullable(),
}).strict();
export type ConversationSubscriptionLogin = z.infer<typeof ConversationSubscriptionLoginSchema>;

/**
 * `GET /api/v1/rooms/:roomId/conversations/:sessionId/quota`: the Space's
 * lines, the logins the conversation's Agents use, and what is held.
 */
export const RoomConversationQuotaSchema = z.object({
  warn_pct: z.number().int(),
  reserve_pct: z.number().int(),
  logins: z.array(ConversationSubscriptionLoginSchema),
  holds: z.array(SubscriptionQuotaHoldSchema),
  ...SecretResponseGuards,
}).strict();
export type RoomConversationQuota = z.infer<typeof RoomConversationQuotaSchema>;
