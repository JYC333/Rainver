/**
 * Ambient session import contracts.
 *
 * An *ambient* session is one a person had with their own coding CLI in a
 * folder, outside Rainver, on a paired execution host. The daemon reaches
 * them through the runtime's own Agent Client Protocol surface
 * (`session/list` + `session/load`) — never by parsing a vendor's session
 * files — and hands back trimmed, redacted records.
 *
 * The record shape here is the wire contract the server validates a daemon's
 * report against, and the shape the web renders. The daemon does not import
 * this package — it must stay dependency-free (REUSE_AND_DEPENDENCY_POLICY),
 * so it produces this shape structurally and the server is what checks it.
 * Identity and hashing live on the server, which is the only side that
 * reconciles.
 */

import { z } from "zod";

/**
 * Retained kinds. `unknown` is not a failure: an ACP update this version does
 * not model is stored raw so a later parser version can re-derive it, rather
 * than being dropped at the one moment the source still exists.
 */
export const AMBIENT_RECORD_KINDS = [
  "user_message",
  "agent_message",
  "tool_call",
  "plan",
  "unknown",
] as const;
export type AmbientRecordKind = (typeof AMBIENT_RECORD_KINDS)[number];

/**
 * Trim limits, applied on the daemon before anything leaves the machine.
 *
 * Measured on a real machine: conversation text is 2.6–4.5 % of a session's
 * bytes and tool output is 13–41 %, so trimming output is what makes import
 * viable at all. It is also the usual home of a leaked key, which is why the
 * cap is small enough to be a label rather than a copy of the result.
 */
export const AMBIENT_TEXT_MAX_BYTES = 64_000;
export const AMBIENT_TOOL_INPUT_MAX_BYTES = 512;
export const AMBIENT_TOOL_OUTPUT_MAX_BYTES = 512;
export const AMBIENT_RAW_MAX_BYTES = 2_048;

/** The parser version stamped on derived fields, bumped when trimming or field derivation changes. */
export const AMBIENT_PARSER_VERSION = "ambient-record.v1";

/** Rainver's own window over a host's history; no adapter applies one of its own. */
export const AMBIENT_DEFAULT_WINDOW_DAYS = 30;
export const AMBIENT_DEFAULT_MAX_SESSIONS = 50;

export const AmbientSessionSummarySchema = z.object({
  /** The runtime's own opaque id, in its own format. */
  session_id: z.string().min(1).max(256),
  cwd: z.string().min(1).max(1024),
  title: z.string().max(512).nullable(),
  updated_at: z.string().max(64).nullable(),
});
export type AmbientSessionSummary = z.infer<typeof AmbientSessionSummarySchema>;

/**
 * One trimmed record: a whole message, or a whole tool call with its result.
 *
 * `record_key` is the runtime's message or tool-call id. It is unique only
 * *within a session* — Codex replays `item-1`, `item-2`, … per session — so
 * identity everywhere else is the pair (session, key), never the key alone.
 */
export const AmbientRecordSchema = z.object({
  record_key: z.string().min(1).max(256),
  kind: z.enum(AMBIENT_RECORD_KINDS),
  /** Replay order within the session; the only ordering a vendor guarantees. */
  sequence: z.number().int().min(0),
  occurred_at: z.string().max(64).nullable(),
  /** Joined message text for message kinds. */
  text: z.string().max(AMBIENT_TEXT_MAX_BYTES * 2).nullable(),
  tool_name: z.string().max(256).nullable(),
  tool_status: z.string().max(64).nullable(),
  /** Truncated JSON of the call's arguments — what files, what commands. */
  tool_input: z.string().max(AMBIENT_TOOL_INPUT_MAX_BYTES * 2).nullable(),
  /** A label for the result, not the result. */
  tool_output: z.string().max(AMBIENT_TOOL_OUTPUT_MAX_BYTES * 2).nullable(),
  /** Set only for `unknown`: the update as received, truncated. */
  raw_json: z.string().max(AMBIENT_RAW_MAX_BYTES * 2).nullable(),
  /** Whether any field above lost bytes to a limit. */
  truncated: z.boolean(),
});
export type AmbientRecord = z.infer<typeof AmbientRecordSchema>;

/** Token usage a replay reported, forwarded to the ledger rather than stored as a record. */
export const AmbientUsageSchema = z.object({
  record_key: z.string().min(1).max(256),
  model: z.string().max(256).nullable(),
  occurred_at: z.string().max(64).nullable(),
  input_tokens: z.number().int().min(0).nullable(),
  output_tokens: z.number().int().min(0).nullable(),
  cache_read_input_tokens: z.number().int().min(0).nullable(),
  cache_creation_input_tokens: z.number().int().min(0).nullable(),
  reasoning_tokens: z.number().int().min(0).nullable(),
});
export type AmbientUsage = z.infer<typeof AmbientUsageSchema>;

/**
 * One session's replay outcome.
 *
 * `load_state` is `partial` when the replay failed part way. Those records are
 * still worth keeping — the alternative is discarding evidence because the
 * last page of it is missing — and the next sync retries the session.
 */
export const AmbientSessionImportSchema = z.object({
  session: AmbientSessionSummarySchema,
  load_state: z.enum(["complete", "partial"]),
  records: z.array(AmbientRecordSchema),
  usage: z.array(AmbientUsageSchema),
  error: z.string().max(1024).nullable(),
});
export type AmbientSessionImport = z.infer<typeof AmbientSessionImportSchema>;

/** Trim limits the server sends with a request; the daemon keeps no policy of its own. */
export const AmbientTrimLimitsSchema = z.object({
  text_max_bytes: z.number().int().positive(),
  tool_input_max_bytes: z.number().int().positive(),
  tool_output_max_bytes: z.number().int().positive(),
  raw_max_bytes: z.number().int().positive(),
});
export type AmbientTrimLimits = z.infer<typeof AmbientTrimLimitsSchema>;

export const AMBIENT_TRIM_LIMITS: AmbientTrimLimits = {
  text_max_bytes: AMBIENT_TEXT_MAX_BYTES,
  tool_input_max_bytes: AMBIENT_TOOL_INPUT_MAX_BYTES,
  tool_output_max_bytes: AMBIENT_TOOL_OUTPUT_MAX_BYTES,
  raw_max_bytes: AMBIENT_RAW_MAX_BYTES,
};

/** Per (Location, adapter, installation) counts, refreshed on a slow interval and reported in heartbeats. */
export const AmbientSessionCountSchema = z.object({
  location_id: z.string().min(1).max(36),
  adapter_type: z.string().min(1).max(64),
  installation: z.string().min(1).max(64),
  session_count: z.number().int().min(0),
  oldest_updated_at: z.string().max(64).nullable(),
  newest_updated_at: z.string().max(64).nullable(),
  /** Set when the runtime could not be asked; the count is then unknown, not zero. */
  error: z.string().max(512).nullable(),
});
export type AmbientSessionCount = z.infer<typeof AmbientSessionCountSchema>;

/**
 * Per-runtime import policy on a Location.
 *
 * Absent means never offered and never synced. `sync` is the standing consent
 * the banner asks for; without it an import happens once and stops.
 */
export const AmbientImportPolicyEntrySchema = z.object({
  adapter_type: z.string().min(1).max(64),
  installation: z.string().min(1).max(64),
  sync: z.boolean(),
  /** Visibility new sessions land with; inherited by their records. */
  default_visibility: z.enum(["private", "space_shared"]),
  /**
   * Whether a sync that brings in enough new records should extract from them
   * without being asked. Default off, and deliberately so: extraction spends
   * model budget, and where that budget is a managed subscription, unattended
   * spending is not assumed to be permitted merely because attended spending
   * is (ADR 0010).
   */
  auto_extract: z.boolean().default(false),
  updated_at: z.string().max(64),
  updated_by_user_id: z.string().max(36).nullable(),
});
export type AmbientImportPolicyEntry = z.infer<typeof AmbientImportPolicyEntrySchema>;

export const AmbientImportPolicySchema = z.object({
  entries: z.array(AmbientImportPolicyEntrySchema).default([]),
  /** Set once the banner has been answered, so it is not shown again. */
  offered_at: z.string().max(64).nullable().default(null),
});
export type AmbientImportPolicy = z.infer<typeof AmbientImportPolicySchema>;

/**
 * What the product reads back: one imported session and one of its records.
 *
 * Here rather than only in the web's own types because these are wire shapes
 * with rows behind them, and a second declaration drifts — as it already had:
 * the location and host columns are nullable by design (a folder can be
 * unbound and a host unpaired without destroying the history), and a client
 * copy that typed them non-null would have been wrong the first time either
 * happened.
 */
export const ImportedSessionSchema = z.object({
  id: z.string(),
  space_id: z.string(),
  project_id: z.string(),
  project_folder_id: z.string().nullable(),
  workspace_location_id: z.string().nullable(),
  execution_host_id: z.string().nullable(),
  owner_user_id: z.string(),
  adapter_type: z.string(),
  installation: z.string(),
  vendor_session_id: z.string(),
  cwd: z.string().nullable(),
  title: z.string().nullable(),
  visibility: z.enum(["private", "space_shared", "selected_users"]),
  access_level: z.enum(["full", "summary"]),
  /** `gone` means the host no longer has it; the import is kept regardless. */
  source_state: z.enum(["present", "gone"]),
  load_state: z.enum(["complete", "partial"]),
  last_error: z.string().nullable(),
  record_count: z.number().int().nonnegative(),
  first_record_at: z.string().nullable(),
  last_record_at: z.string().nullable(),
  vendor_updated_at: z.string().nullable(),
  last_synced_at: z.string().nullable(),
  last_seen_on_host_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();
export type ImportedSession = z.infer<typeof ImportedSessionSchema>;

export const ImportedSessionRecordSchema = z.object({
  id: z.string(),
  imported_session_id: z.string(),
  record_key: z.string(),
  content_hash: z.string(),
  /** Set when a later replay disagreed; the first import stays authoritative. */
  conflict_hash: z.string().nullable(),
  kind: z.enum(AMBIENT_RECORD_KINDS),
  sequence: z.number().int(),
  occurred_at: z.string().nullable(),
  text: z.string().nullable(),
  tool_name: z.string().nullable(),
  tool_status: z.string().nullable(),
  tool_input: z.string().nullable(),
  tool_output: z.string().nullable(),
  raw_json: z.unknown().nullable(),
  truncated: z.boolean(),
  parser_version: z.string(),
  extracted_in: z.string().nullable(),
  created_at: z.string(),
}).strict();
export type ImportedSessionRecord = z.infer<typeof ImportedSessionRecordSchema>;

/**
 * What one sync did. The three failure counters are part of the contract
 * because a total that is short for a reason must not read as a total that is
 * short because nothing happened.
 */
export const AmbientSyncReportSchema = z.object({
  location_id: z.string(),
  adapter_type: z.string(),
  installation: z.string(),
  sessions_seen: z.number().int().nonnegative(),
  sessions_written: z.number().int().nonnegative(),
  records_inserted: z.number().int().nonnegative(),
  records_unchanged: z.number().int().nonnegative(),
  records_conflicted: z.number().int().nonnegative(),
  marked_gone: z.number().int().nonnegative(),
  usage_events: z.number().int().nonnegative(),
  /** Ledger writes rejected. */
  usage_failures: z.number().int().nonnegative(),
  /** Sessions a daemon reported in a shape this server does not accept. */
  malformed_sessions: z.number().int().nonnegative(),
  /** Sessions that could not be written; the rest of the sync still stands. */
  failed_sessions: z.number().int().nonnegative(),
  error: z.string().nullable(),
}).strict();
export type AmbientSyncReport = z.infer<typeof AmbientSyncReportSchema>;

/** What one extraction read and proposed; nothing is written until a proposal is accepted. */
export const ExtractionOutcomeSchema = z.object({
  brief_proposal_id: z.string().nullable(),
  memory_packet_proposal_id: z.string().nullable(),
  records_covered: z.number().int().nonnegative(),
  sessions_covered: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
  facts: z.number().int().nonnegative(),
  records_remaining: z.number().int().nonnegative(),
}).strict();
export type ExtractionOutcome = z.infer<typeof ExtractionOutcomeSchema>;

/**
 * Files touched and commands run, computed from a session's records.
 *
 * Deterministic on purpose: it needs no model, it is right the moment an
 * import lands, and it can invent nothing. Two callers need exactly this — the
 * session page's header and the summarizer's input, which is why it lives with
 * the contract rather than being written out twice.
 *
 * Structurally typed on the fields it reads, so both the server's row shape
 * and the wire record satisfy it without either importing the other's.
 */
export function deriveAmbientActivity(records: readonly {
  kind: string;
  tool_name?: string | null;
  tool_status?: string | null;
  tool_input?: string | null;
}[]): {
  files: string[];
  commands: Array<{ tool: string; status: string | null }>;
} {
  const files = new Set<string>();
  const commands: Array<{ tool: string; status: string | null }> = [];
  for (const record of records) {
    if (record.kind !== "tool_call") continue;
    commands.push({ tool: record.tool_name ?? "tool", status: record.tool_status ?? null });
    if (!record.tool_input) continue;
    for (const match of record.tool_input.matchAll(/["']((?:\/|\.\/|[\w.-]+\/)[\w./-]+\.[\w]{1,8})["']/g)) {
      const path = match[1];
      if (path) files.add(path);
    }
  }
  return { files: [...files], commands };
}
