import type { HostLaunchIsolation, LaunchWorkspace } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { launchRecordResetSql } from "../hosts/agentHostResetGeneration.js";
import { coreDataTool, coreDataTools, projectBoundConsentIds, projectBoundPin } from "../plugins/coreDataTools.js";
import { inheritedReads, sensitiveConversationReads } from "./contextTaint.js";
import { runInSensitiveConversation } from "./modelChannelLaunch.js";
import type { RuntimeProfileScope } from "./remoteProviderBinding.js";
import { gmailPrivateCheckRunContext } from "../sources/gmail/gmailPrivateCheckContext.js";

/**
 * Host state of a conversation that may read sensitive data (ADR 0032 Gmail,
 * ADR 0030 sensitive tools) belongs to that Session alone.
 *
 * A non-Project direct chat otherwise uses the person's direct container
 * (`host_threads` keyed by Agent × person): one vendor session pointer, one
 * managed cwd and one CLI profile shared by every direct chat with that Agent,
 * while the sensitive-read taint follows the Session. So the container is
 * decided when the turn is admitted, before its Run exists and before Runtime
 * Context is assembled: a Session that may read uses its own Conversation
 * container (`directChatMayReadSensitive`), whose thread, cwd and profile are
 * keyed by the Session. Whether the turn resumes a vendor session is then the
 * ordinary thread rule of that container — a thread with no vendor session
 * (a first turn, or one whose first launch failed before the runtime started
 * a session) replays as fresh — narrowed by `sensitiveThreadResumable`, which
 * trusts only the launch bound to the current pointer.
 *
 * The launch re-checks all of it (`sensitiveLaunchRefusal`), because the
 * snapshot is frozen after admission: a Run that may read is refused unless its
 * profile, cwd and mounts are its own Session's, nothing shared is writable,
 * and it is network-isolated on the built-in strict Host with the model-only
 * channel.
 *
 * A Project-bound core tool (ADR 0033 §6, Gmail) is not
 * such a tool: a Project conversation already has its own container
 * (`directContainer`), the read goes through the server's broker with the
 * credential kept server-side, and the Run keeps the conversation's own
 * selected runtime (CLI, Host, native login, model). Its boundary is the
 * Project, enforced at consent and release. A Run of the withdrawn private
 * Gmail check never launches.
 */

const SENSITIVE_PIN_SQL = `(r.permission_snapshot_json->>'sensitive_conversation' = 'true'
  OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(r.permission_snapshot_json->'plugin_tool_pins') = 'object'
                                           THEN r.permission_snapshot_json->'plugin_tool_pins' ELSE '{}'::jsonb END) pin
              WHERE pin.value->>'data_class' = 'sensitive'))`;

/**
 * Whether a person's direct chat may read sensitive data from this turn on: a
 * core data tool is offered here now (Gmail: in an ordinary conversation of a
 * Project, once the person turned Agent reads on for an active connection,
 * ADR 0033 §6), or a Run of the Session already pinned a sensitive tool. A
 * non-Project chat that may read gets its Session's own container; a Project
 * chat that may read gets an owner-only Run (`directTurnVisibility`). Over-approximates the snapshot on purpose:
 * a Session moved to its own container when nothing was pinned loses only
 * continuity with the person's other direct chats.
 */
export async function directChatMayReadSensitive(
  db: Queryable,
  input: { spaceId: string; userId: string; sessionId: string },
): Promise<boolean> {
  const pinned = (await db.query(
    `SELECT 1 FROM runs r WHERE r.space_id = $1 AND r.session_id = $2 AND ${SENSITIVE_PIN_SQL} LIMIT 1`,
    [input.spaceId, input.sessionId],
  )).rows.length > 0;
  if (pinned) return true;
  for (const tool of coreDataTools()) {
    if (await tool.available(db, input)) return true;
  }
  return false;
}

/**
 * The frozen snapshot pins a core sensitive data tool that reads only on an isolated launch. None does
 * today: Gmail's tools are Project-bound (ADR 0033 §6) and run on the conversation's own runtime.
 */
export function runPinsCoreDataTool(run: { permission_snapshot_json?: unknown }): boolean {
  const snapshot = run.permission_snapshot_json;
  const pins = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as { plugin_tool_pins?: unknown }).plugin_tool_pins
    : null;
  if (!pins || typeof pins !== "object" || Array.isArray(pins)) return false;
  return Object.entries(pins as Record<string, unknown>).some(([actionId, pin]) =>
    coreDataTool(actionId) !== undefined && !projectBoundPin(actionId, pin) && Boolean(pin) && typeof pin === "object"
    && (pin as { data_class?: unknown }).data_class === "sensitive");
}

/**
 * The Run launches isolated or not at all: it pins a core sensitive tool that requires it, or continues a
 * conversation an earlier Run read sensitive plugin data in. A Run of the withdrawn private Gmail check
 * (ADR 0033 §6, from its immutable contract) is refused at launch (`sensitiveLaunchRefusal`) and before
 * dispatch.
 */
export function runRequiresIsolatedLaunch(run: { permission_snapshot_json?: unknown; contract_snapshot_json?: unknown }): boolean {
  return runInSensitiveConversation(run) || runPinsCoreDataTool(run) || gmailPrivateCheckRunContext(run) !== null;
}

/**
 * Whether `vendorSessionId` — the session the caller is about to resume — may
 * be resumed by a Run that may read sensitive data. It must be exactly the
 * session this thread currently points at, and the proof is that pointer's own
 * binding (`host_threads.vendor_session_launch_id`): the launch that reported
 * this session, a launch of a Run on this thread, was isolated (strict Host,
 * egress `none`, model-only channel) and, when `profileKey` is given, in
 * exactly that profile (Agent, container, runtime and backend) — without
 * `profileKey` (admission), in an isolated launch's own directory
 * (`runtimeProfileKey`, ADR 0036 §11), never the earlier one both channels
 * shared. A session id
 * read before the pointer moved on (a stale snapshot) is not resumed, even
 * when the newer pointer would be. Earlier launches of the thread do not count
 * either way: a reset clears pointer and binding together, so a session a
 * later isolated launch started resumes even though older unisolated history
 * remains. A pointer with no binding (no recorded launch, or one from before
 * the binding existed) is not resumed, nor one on an archived (closed) thread,
 * nor one whose launch predates a reset of its Agent's state on that Host
 * (`launchRecordResetSql`, ADR 0036 §15): a late report after the reset.
 */
export async function sensitiveThreadResumable(
  db: Queryable,
  threadId: string,
  input: { vendorSessionId: string; profileKey?: string },
): Promise<boolean> {
  const row = (await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM host_threads t
         JOIN run_attempts a ON a.launch_id = t.vendor_session_launch_id
         JOIN runs r ON r.id = a.run_id AND r.space_id = a.space_id AND r.host_task_thread_id = t.id
        WHERE t.id = $1 AND t.vendor_session_id = $3::text AND t.status <> 'closed'
          AND NOT ${launchRecordResetSql("a.launch_isolation_json", "r.agent_id", "a.created_at")}
          AND COALESCE(a.launch_isolation_json->>'egress_profile', '') = 'none'
          AND COALESCE(a.launch_isolation_json->>'host_kind', '') = 'server'
          AND COALESCE(a.launch_isolation_json->>'model_channel', '') = 'provider_lease'
          AND CASE WHEN $2::text IS NULL THEN COALESCE(a.launch_isolation_json->>'profile_key', '') LIKE '%.isolated'
                   ELSE COALESCE(a.launch_isolation_json->>'profile_key', '') = $2::text END
     ) AS ok`,
    [threadId, input.profileKey ?? null, input.vendorSessionId],
  )).rows[0];
  return row?.ok === true;
}

/**
 * Whether the vendor session `vendorSessionId` this thread points at was ever held by a launch isolated to the model-only
 * channel (ADR 0030 §4a, 0036 §9) — one whose own record states `model_channel`. Such a session may hold what only an
 * isolated launch was given (a provider-bound Gmail automation's mail, a sensitive plugin read), so a launch with network
 * never resumes it (ADR 0036 §11): the turn's admission resets it when the turn will not launch isolated, and the
 * launch refuses it otherwise.
 *
 * Judged from what each launched Run of the thread records, never a guess: the session it resumed
 * (`model_override_json.host_thread.runtime_session_id`, frozen at admission) and its launch's isolation. The session's
 * origin is the latest launched Run, up to the one the pointer is bound to, that did not resume it (it started it fresh,
 * or resumed another one and was handed this one); every launched Run from that origin to the pointer's held it, and any
 * launched Run that resumed it held it too. A pointer whose launch is unknown (no recorded binding) is judged against
 * every launched Run of the thread. So an isolated session that an ordinary launch already continued — before this
 * check existed — still counts as held.
 */
export async function vendorSessionHeldIsolated(db: Queryable, threadId: string, vendorSessionId: string): Promise<boolean> {
  const row = (await db.query<{ held: boolean }>(`SELECT ${heldIsolatedSql("$1", "$2")} AS held`, [threadId, vendorSessionId])).rows[0];
  return row?.held === true;
}

/** `vendorSessionHeldIsolated` as one boolean expression over the thread and session parameters named, so a caller can
 * judge it in the same statement (one snapshot) as the rest of what it reads. */
function heldIsolatedSql(thread: string, session: string): string {
  return `(WITH launched AS (
       SELECT r.id, r.created_at, r.model_override_json #>> '{host_thread,runtime_session_id}' AS resumed,
              bool_or(a.launch_isolation_json->>'model_channel' IS NOT NULL) AS isolated
         FROM runs r JOIN run_attempts a ON a.run_id = r.id AND a.space_id = r.space_id AND a.launch_id IS NOT NULL
        WHERE r.host_task_thread_id = ${thread}
        GROUP BY r.id, r.created_at, r.model_override_json
     ), pointer AS (
       SELECT COALESCE((SELECT r.created_at FROM run_attempts a JOIN runs r ON r.id = a.run_id AND r.space_id = a.space_id
                         WHERE a.launch_id = t.vendor_session_launch_id), 'infinity'::timestamptz) AS at
         FROM host_threads t WHERE t.id = ${thread} AND t.vendor_session_id = ${session}::text
     ), origin AS (
       SELECT max(l.created_at) AS at FROM launched l, pointer p
        WHERE l.created_at <= p.at AND l.resumed IS DISTINCT FROM ${session}::text
     )
     SELECT EXISTS (SELECT 1 FROM launched l, pointer p, origin o
                     WHERE l.isolated AND l.created_at <= p.at AND (o.at IS NULL OR l.created_at >= o.at))
         OR EXISTS (SELECT 1 FROM launched l WHERE l.isolated AND l.resumed = ${session}::text))`;
}

/**
 * Whether the session this thread points at was recorded in a ModelProvider profile directory from before isolated and
 * networked launches were kept apart (a backend segment naming no channel, `runtimeProfileKey`, ADR 0036 §11): no
 * launch uses that directory now, so the session cannot be resumed and the turn replays fresh instead. A pointer whose
 * launch recorded no directory is left to the launch, as before.
 */
export async function pointerInSharedProfile(db: Queryable, threadId: string, vendorSessionId: string): Promise<boolean> {
  const row = (await db.query<{ shared: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM host_threads t JOIN run_attempts a ON a.launch_id = t.vendor_session_launch_id
                     WHERE t.id = $1 AND t.vendor_session_id = $2::text
                       AND a.launch_isolation_json->>'profile_key' !~ '/(ambient|[^/]+[.](isolated|network))$') AS shared`,
    [threadId, vendorSessionId],
  )).rows[0];
  return row?.shared === true;
}

/** What a launch with network may do with the vendor session frozen on its Run (`networkedResumeVerdict`). */
export type NetworkedResumeVerdict = "resumable" | "unconfirmed" | "held_isolated";

/** A launch record as `run_attempts.launch_isolation_json` states it (or a Run's frozen copy of one). */
type LaunchRecordFacts = { launch_id?: unknown; model_channel?: unknown; profile_key?: unknown } | null;

/**
 * Whether a launch with network, in CLI directory `profileKey`, may resume `vendorSessionId`, the session frozen on Run
 * `runId` (ADR 0036 §11–§13). Everything is read in one statement, so the thread's state, its pointer, the isolation
 * history and the launch records are one snapshot, never two reads a concurrent reset or report could fall between —
 * and only from what is recorded, never because evidence is missing:
 * - `unconfirmed`: the thread is gone or closed (archived), the session is retired (reset, excluded), or the session is
 *   not proven to be in this launch's own directory as either the thread's current pointer (its bound launch's record
 *   names `profileKey`) or this Run's own parked session (the reporting launch's record frozen at parking,
 *   `recordParkedHostThreadSession`: it names `profileKey`, states no model channel, and no launch of this Run now states
 *   one). That record is the Run's own copy, so a relaunch of the same attempt — which rewrites `run_attempts` with a
 *   new nonce — keeps the evidence, and a parked Run's legitimate resume or retry still continues. A pointer cleared or
 *   replaced after admission, a session in another directory (the earlier channel-less `<provider>` one a Run queued
 *   before the split still names, another backend's) and a session parked before its launch was recorded with it are
 *   refused. An `ambient` directory never changed: a pointer there that no launch was ever bound to (imported CLI
 *   history, a pointer from before bindings) still resumes, but only on a thread whose every launch was the machine's
 *   own login (none that started ModelProvider-bound — on the Run or its frozen profile, with or without a launch nonce
 *   — isolated, or in a directory other than this one, §14–§15). A bound pointer whose launch record is gone (its nonce
 *   replaced) or names no directory is not assumed to be ambient; any other directory needs the record. A record from a
 *   launch before a later reset of its Agent's state on its Host (`launchRecordResetSql`, §15) vouches for nothing,
 *   whether it is the pointer's or this Run's parked one: the reset archived that profile, and a report that arrives
 *   after the reset — a park of a Run waiting for review, which the reset admits — must not bring the session back.
 * - `held_isolated`: an isolated launch held it (`vendorSessionHeldIsolated`), including one that started it fresh and
 *   then parked or set the pointer.
 */
export async function networkedResumeVerdict(
  db: Queryable,
  input: { threadId: string; runId: string; vendorSessionId: string; profileKey: string | null },
): Promise<NetworkedResumeVerdict> {
  const row = (await db.query<{
    open: boolean; retired: boolean; current: boolean; pointer_unbound: boolean; native_history: boolean; held: boolean;
    pointer_launch: LaunchRecordFacts; parked_launch: LaunchRecordFacts; run_isolated: boolean;
    pointer_reset: boolean; parked_reset: boolean;
  }>(
    `SELECT t.status <> 'closed' AS open, t.retired_vendor_session_ids ? $3::text AS retired,
            t.vendor_session_id IS NOT DISTINCT FROM $3::text AS current,
            t.vendor_session_launch_id IS NULL AS pointer_unbound,
            -- Every Run of the thread that started was the machine's own login in this very directory: none was
            -- ModelProvider-bound (on the Run or its frozen profile), stated a model channel or recorded another
            -- directory — a Run from before launch nonces, whose attempts carry none, included. Only then is an
            -- unbound pointer native history (ADR 0036 §14, §15).
            NOT EXISTS (SELECT 1 FROM runs r
                         WHERE r.host_task_thread_id = t.id
                           AND (r.started_at IS NOT NULL OR EXISTS (SELECT 1 FROM run_attempts a
                                 WHERE a.run_id = r.id AND a.space_id = r.space_id AND (a.started_at IS NOT NULL OR a.launch_id IS NOT NULL)))
                           AND (r.model_provider_id IS NOT NULL
                                OR COALESCE(r.runtime_profile_snapshot_json->>'backend_mode', '') = 'model_provider'
                                OR EXISTS (SELECT 1 FROM run_attempts a WHERE a.run_id = r.id AND a.space_id = r.space_id
                                             AND (a.launch_isolation_json->>'model_channel' IS NOT NULL
                                                  OR COALESCE(a.launch_isolation_json->>'profile_key' <> $4::text, false))))) AS native_history,
            ${heldIsolatedSql("$1", "$3")} AS held,
            (SELECT a.launch_isolation_json FROM run_attempts a
               JOIN runs reporting ON reporting.id = a.run_id AND reporting.space_id = a.space_id
              WHERE a.launch_id = t.vendor_session_launch_id AND reporting.host_task_thread_id = t.id
                AND t.vendor_session_id = $3::text) AS pointer_launch,
            -- The pointer's launch predates a reset of its Agent on its Host (ADR 0036 §15): a late report of it.
            EXISTS (SELECT 1 FROM run_attempts a
               JOIN runs reporting ON reporting.id = a.run_id AND reporting.space_id = a.space_id
              WHERE a.launch_id = t.vendor_session_launch_id AND reporting.host_task_thread_id = t.id
                AND ${launchRecordResetSql("a.launch_isolation_json", "reporting.agent_id", "a.created_at")}) AS pointer_reset,
            (SELECT r.model_override_json #> '{host_thread,runtime_session_launch}' FROM runs r
              WHERE r.id = $2 AND r.host_task_thread_id = t.id
                AND r.model_override_json #>> '{host_thread,runtime_session_id}' = $3::text
                AND jsonb_typeof(r.model_override_json #> '{host_thread,runtime_session_launch}') = 'object') AS parked_launch,
            -- This Run's parked launch predates a reset of its Agent on that launch's Host: a park reported after the
            -- reset (the Run waited for review, which the reset admits) or before it.
            EXISTS (SELECT 1 FROM runs r WHERE r.id = $2 AND r.host_task_thread_id = t.id
                AND ${launchRecordResetSql("(r.model_override_json #> '{host_thread,runtime_session_launch}')", "r.agent_id",
                  "(SELECT la.created_at FROM run_attempts la WHERE la.id = r.model_override_json #>> '{host_thread,runtime_session_launch,attempt_id}')")}) AS parked_reset,
            EXISTS (SELECT 1 FROM run_attempts a WHERE a.run_id = $2
                      AND a.launch_isolation_json->>'model_channel' IS NOT NULL) AS run_isolated
       FROM host_threads t WHERE t.id = $1`,
    [input.threadId, input.runId, input.vendorSessionId, input.profileKey],
  )).rows[0];
  if (!row || !row.open || row.retired) return "unconfirmed";
  if (row.held) return "held_isolated";
  const inThisDirectory = (record: LaunchRecordFacts): boolean =>
    record !== null && typeof record.profile_key === "string" && record.profile_key === input.profileKey;
  const parked = row.parked_launch;
  const ownParked = parked !== null && !row.parked_reset && !row.run_isolated && parked.model_channel == null
    && typeof parked.launch_id === "string" && inThisDirectory(parked);
  // Native history no launch was ever bound to (imported CLI history, a pointer from before bindings), in the
  // `ambient` directory whose key never changed. A bound pointer whose record is gone or names no directory, and a
  // pointer on a thread that ran ModelProvider-bound or in another directory, are not assumed to be ambient.
  const nativeAmbient = row.pointer_unbound && row.native_history
    && input.profileKey !== null && input.profileKey.endsWith("/ambient");
  return ownParked || (row.current && ((!row.pointer_reset && inThisDirectory(row.pointer_launch)) || nativeAmbient))
    ? "resumable" : "unconfirmed";
}

/**
 * Whether a later Run of this conversation launches isolated or not at all because of what it already holds — the
 * rule `PgRunRepository.createRun` freezes as `sensitive_conversation`: an earlier Run was frozen so, or read a plugin's
 * sensitive data (not a Project-bound core read such as Gmail, ADR 0033 §6), or its reads cannot all be determined.
 */
export async function conversationCarriesIsolatingReads(db: Queryable, spaceId: string, sessionId: string): Promise<boolean> {
  const frozen = (await db.query(
    `SELECT 1 FROM runs r WHERE r.space_id = $1 AND r.session_id = $2 AND r.permission_snapshot_json->>'sensitive_conversation' = 'true' LIMIT 1`,
    [spaceId, sessionId],
  )).rows.length > 0;
  return frozen || isolatingSensitiveReads(inheritedReads(await sensitiveConversationReads(db, spaceId, sessionId))).length > 0;
}

/** The inherited reads that make a Run `sensitive_conversation`: all but the Project-bound core reads (ADR 0033 §6). */
export function isolatingSensitiveReads<T extends { pluginId: string }>(reads: readonly T[]): T[] {
  const projectBound = new Set(projectBoundConsentIds());
  return reads.filter((read) => !projectBound.has(read.pluginId));
}

export type SensitiveLaunchRefusal = { code: string; message: string };

/**
 * The pre-launch check for a Run that may hold sensitive data — one that must
 * launch isolated, or one the dispatcher selected the isolated launch for — on
 * what the frame will actually state. Null when it may launch (or is not such
 * a Run).
 */
export function sensitiveLaunchRefusal(input: {
  run: { id?: string; session_id?: string | null; permission_snapshot_json?: unknown; contract_snapshot_json?: unknown };
  scope: RuntimeProfileScope;
  workspace: LaunchWorkspace | undefined;
  workspaceLocationId: string | null;
  workspaceAccess: ReadonlyArray<{ access_mode: "read" | "write" }>;
  isolation: HostLaunchIsolation;
  strictHost: boolean;
  modelChannel: boolean;
}): SensitiveLaunchRefusal | null {
  if (gmailPrivateCheckRunContext(input.run)) {
    return { code: "gmail_private_check_withdrawn",
      message: "This earlier private Gmail check was withdrawn and does not run; ask in the conversation instead." };
  }
  const required = runRequiresIsolatedLaunch(input.run);
  if (!required && !input.modelChannel) return null;
  if (required && (!input.strictHost || !input.modelChannel || input.isolation.egress_profile !== "none")) {
    return runInSensitiveConversation(input.run)
      ? { code: "sensitive_conversation_isolation_required",
          message: "This conversation contains data an Agent read from a private source (such as Gmail). It continues only on a Run bound to a ModelProvider on the built-in strict Host, which launches without network. Start a new conversation for other work." }
      : { code: "sensitive_tool_isolation_required",
          message: "This Agent may read private data with a sensitive tool here, so it runs only bound to a ModelProvider on the built-in strict Host, which launches without network." };
  }
  const sessionId = input.run.session_id ?? null;
  // Any other Agent-scoped Run with no Session (ADR 0030 background plugin reads) has no
  // conversation to belong to: that remaining gap is documented; a core tool never reaches it.
  if (!sessionId) {
    return required
      ? { code: "sensitive_profile_session_unconfirmed",
          message: "This Run may read private data, but its conversation could not be confirmed, so it was not started." }
      : null;
  }
  if (input.scope.container_kind !== "conversation" || input.scope.container_id !== sessionId) {
    return { code: "sensitive_profile_session_unconfirmed",
      message: "This Run may read private data, but its CLI state is not this conversation's own, so it was not started. Send the message again to continue in this conversation's own workspace." };
  }
  const managedShared = input.workspace?.kind === "managed"
    && (input.workspace.container.kind !== "conversation" || input.workspace.container.conversation_id !== sessionId);
  const locationWritable = (input.workspace?.kind === "location" || input.workspaceLocationId !== null)
    && input.isolation.sandbox_mode !== "read_only";
  if (managedShared || locationWritable || input.workspaceAccess.some((entry) => entry.access_mode === "write")) {
    return { code: "sensitive_launch_shared_workspace_refused",
      message: "This Run may read private data, so it works only in this conversation's own managed workspace and cannot write to a shared folder. Use a managed workspace for this conversation." };
  }
  return null;
}
