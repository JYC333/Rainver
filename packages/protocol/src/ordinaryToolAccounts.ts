import { z } from "zod";
import { IdSchema } from "./common.js";

/**
 * Personal accounts for ordinary CLI tools (`ordinaryTools.ts`), currently the
 * official Feishu/Lark CLI. The binary is shared on a Host; its configuration
 * and credentials belong to one Rainver user on that Host.
 *
 * The control plane derives `account_key` from the signed-in user and never
 * accepts a user, path, environment or argv from a client. The daemon maps the
 * key to directories it creates and runs only the fixed official commands
 * named here. Only the fields below ever leave the Host: no token, master key,
 * app secret, credential path or raw command output.
 */
export const ORDINARY_TOOL_ACCOUNTS_PROTOCOL = "ordinary-tool-accounts-v1";

/** Tools with a personal account flow. */
export const ORDINARY_ACCOUNT_TOOL_IDS = ["lark_cli"] as const;
export const OrdinaryAccountToolIdSchema = z.enum(ORDINARY_ACCOUNT_TOOL_IDS);
export type OrdinaryAccountToolId = z.infer<typeof OrdinaryAccountToolIdSchema>;

/** Opaque per Host × user key the control plane derives; never a user id or path. */
export const OrdinaryAccountKeySchema = z.string().regex(/^[a-f0-9]{40}$/);

/**
 * Daemon capability (`capabilities_json.ordinary_tool_accounts`). `supported`
 * is false where the daemon cannot keep one user's credentials apart from
 * another's (macOS: lark-cli keeps its master key in the system Keychain,
 * outside the per-user data directory).
 */
export const OrdinaryToolAccountsCapabilitySchema = z.object({
  protocol: z.literal(ORDINARY_TOOL_ACCOUNTS_PROTOCOL),
  supported: z.boolean(),
  reason: z.string().max(300).nullable(),
}).strict();
export type OrdinaryToolAccountsCapability = z.infer<typeof OrdinaryToolAccountsCapabilitySchema>;

/** The display-safe account summary read from the CLI's own status output. */
export const OrdinaryAccountSummarySchema = z.object({
  user_name: z.string().max(200).nullable(),
  app_id: z.string().max(100).nullable(),
  brand: z.enum(["feishu", "lark"]).nullable(),
  /** The access token is due for refresh; the CLI refreshes it on the next user call. */
  refresh_pending: z.boolean(),
  expires_at: z.string().max(64).nullable(),
  refresh_expires_at: z.string().max(64).nullable(),
  /** Null unless the status was verified against the server. */
  verified: z.boolean().nullable(),
}).strict();
export type OrdinaryAccountSummary = z.infer<typeof OrdinaryAccountSummarySchema>;

/**
 * What the Host's own copy of the CLI says about this user's personal
 * identity. Never a bot/tenant identity: a ready bot with no user is
 * `not_logged_in`.
 */
export const OrdinaryAccountStateSchema = z.enum([
  "not_configured", // no app configuration yet: run initialization
  "not_logged_in",
  "signed_in",
  "expired",
  "verify_failed",
  "error",
]);
export type OrdinaryAccountState = z.infer<typeof OrdinaryAccountStateSchema>;

export const OrdinaryAccountStatusSchema = z.object({
  state: OrdinaryAccountStateSchema,
  account: OrdinaryAccountSummarySchema.nullable(),
  /** A short, fixed explanation; never vendor output. */
  reason: z.string().max(300).nullable(),
}).strict();
export type OrdinaryAccountStatus = z.infer<typeof OrdinaryAccountStatusSchema>;

export const OrdinaryAccountLogoutSchema = z.object({
  /** The CLI removed this user's local credential. */
  local_cleared: z.boolean(),
  /**
   * The official logout also asks the server to revoke the token, but ignores
   * that call's outcome; Rainver cannot say it was revoked.
   */
  remote_revocation: z.enum(["attempted_unconfirmed", "not_applicable"]),
}).strict();

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

export const HostOrdinaryAccountRequestFrameSchema = z.object({
  type: z.literal("ordinary_account_request"),
  request_id: IdSchema,
  tool_id: OrdinaryAccountToolIdSchema,
  account_key: OrdinaryAccountKeySchema,
  action: z.enum(["status", "verify", "logout"]),
}).strict();

/** `init`: the official app setup (`config init --new`); `login`: the personal device-flow login. */
export const OrdinaryAccountFlowSchema = z.enum(["init", "login"]);
export type OrdinaryAccountFlow = z.infer<typeof OrdinaryAccountFlowSchema>;

export const HostOrdinaryAccountSessionOpenFrameSchema = z.object({
  type: z.literal("ordinary_account_session_open"),
  session_id: IdSchema,
  tool_id: OrdinaryAccountToolIdSchema,
  account_key: OrdinaryAccountKeySchema,
  flow: OrdinaryAccountFlowSchema,
}).strict();

export const HostOrdinaryAccountSessionCloseFrameSchema = z.object({
  type: z.literal("ordinary_account_session_close"),
  session_id: IdSchema,
}).strict();

export const OrdinaryAccountResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(300).nullable(),
  status: OrdinaryAccountStatusSchema.nullable(),
  logout: OrdinaryAccountLogoutSchema.nullable().optional(),
});
export type OrdinaryAccountResult = z.infer<typeof OrdinaryAccountResultSchema>;

/**
 * The only things a session forwards: the official authorization link (and
 * device user code) for the person who started it, and its end.
 */
export const OrdinaryAccountSessionEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("authorization"),
    url: z.string().url().max(2048),
    user_code: z.string().max(64).nullable(),
    expires_in: z.number().int().positive().max(86_400).nullable(),
  }).strict(),
  z.object({
    kind: z.literal("exit"),
    outcome: z.enum(["completed", "failed", "cancelled", "timed_out"]),
    error: z.string().max(300).nullable(),
    status: OrdinaryAccountStatusSchema.nullable(),
  }).strict(),
]);
export type OrdinaryAccountSessionEvent = z.infer<typeof OrdinaryAccountSessionEventSchema>;

// ---------------------------------------------------------------------------
// Runs (`launch.ordinary_tools`)
// ---------------------------------------------------------------------------

/**
 * Daemon capability (`capabilities_json.ordinary_tools_runs`): it provides
 * ordinary tools, and the person's account named in a launch, to a Run.
 * Absent from older daemons, which are then sent no `ordinary_tools` field.
 */
export const ORDINARY_TOOLS_RUN_PROTOCOL = "ordinary-tools-runs-v1";
export const OrdinaryToolsRunCapabilitySchema = z.object({
  protocol: z.literal(ORDINARY_TOOLS_RUN_PROTOCOL),
}).strict();

/**
 * Which personal accounts one Run may use: only ever the account of the
 * person who instructed it (the Run's `instructed_by_user_id`), as a key the
 * control plane derived. Empty when the Run has no such person; the daemon
 * never chooses another account.
 */
export const HostLaunchOrdinaryToolsSchema = z.object({
  accounts: z.array(z.object({
    tool_id: OrdinaryAccountToolIdSchema,
    account_key: OrdinaryAccountKeySchema,
  }).strict()).max(ORDINARY_ACCOUNT_TOOL_IDS.length),
}).strict();
export type HostLaunchOrdinaryTools = z.infer<typeof HostLaunchOrdinaryToolsSchema>;

// ---------------------------------------------------------------------------
// HTTP DTO (`GET /api/v1/hosts/:hostId/ordinary-tools/:toolId/account`)
// ---------------------------------------------------------------------------

export const HostOrdinaryAccountResponseSchema = z.object({
  host_id: IdSchema,
  tool_id: OrdinaryAccountToolIdSchema,
  /**
   * `live`: read now from the Host. Otherwise why nothing could be read:
   * the Host is offline, its daemon predates accounts, it cannot isolate
   * personal credentials, the tool is not available there, another account
   * operation is running, or the Host answered with an error.
   */
  availability: z.enum(["live", "offline", "update_required", "unsupported", "tool_unavailable", "busy", "error"]),
  status: OrdinaryAccountStatusSchema.nullable(),
  reason: z.string().max(300).nullable(),
  session_active: z.boolean(),
  /** Sandbox use by Runs is a later phase. */
  sandbox_status: z.literal("not_verified"),
});
export type HostOrdinaryAccountResponse = z.infer<typeof HostOrdinaryAccountResponseSchema>;
