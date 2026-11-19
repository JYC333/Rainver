import type { HostLaunchIsolation, LaunchWorkspace } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { coreDataTool, coreDataTools, projectBoundPin } from "../plugins/coreDataTools.js";
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
 * exactly that profile (Agent, container, runtime and backend). A session id
 * read before the pointer moved on (a stale snapshot) is not resumed, even
 * when the newer pointer would be. Earlier launches of the thread do not count
 * either way: a reset clears pointer and binding together, so a session a
 * later isolated launch started resumes even though older unisolated history
 * remains. A pointer with no binding (no recorded launch, or one from before
 * the binding existed) is not resumed.
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
        WHERE t.id = $1 AND t.vendor_session_id = $3::text
          AND COALESCE(a.launch_isolation_json->>'egress_profile', '') = 'none'
          AND COALESCE(a.launch_isolation_json->>'host_kind', '') = 'server'
          AND COALESCE(a.launch_isolation_json->>'model_channel', '') = 'provider_lease'
          AND ($2::text IS NULL OR COALESCE(a.launch_isolation_json->>'profile_key', '') = $2::text)
     ) AS ok`,
    [threadId, input.profileKey ?? null, input.vendorSessionId],
  )).rows[0];
  return row?.ok === true;
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
