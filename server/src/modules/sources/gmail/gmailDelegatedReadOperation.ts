/**
 * `source.gmail.delegated.read` — a member's read of the owner's mail under the owner's delegation (ADR 0035 §4).
 *
 * - **Who and where.** The Run is the member's own `manual` turn in an ordinary conversation of the delegation's
 *   Project whose every reader reads that Project; the delegation is active, bound to the connection's current
 *   generation, the connection is active and opted in, and both people are active and read the Project
 *   (`delegatedReadAdmits`). Offered in the snapshot only where such a delegation exists.
 * - **Within the owner's scope.** Every query is `(<scope>) (<query>)`: the member's words may not contain
 *   parentheses or braces and quotes must balance, so the scope group can never be closed or bypassed; a read
 *   without words is a search of the scope alone. Google stays read-only (`gmailAgentReadContract.ts`).
 * - **Rechecked before every Gmail send and at release.** Before each send (the list and every message of a
 *   page) the call's whole admission is checked again — the Run, its conversation and Project, every reader of
 *   the turn including the Room roster, both people, the delegation and the connection — so a reader outside the
 *   Project who joins between two sends stops the read at the next one. The release (audit transaction) takes the Project
 *   `FOR SHARE` → both people → Run `FOR UPDATE` → owner + Space mutex → connection → delegation `FOR UPDATE`,
 *   the order of every ending (membership writer: Project first; connection writers: mutex → connection;
 *   revocation: mutex → delegation), so an ending either commits first and the result is withheld, or waits.
 * - **The owner's data, the owner's audit.** The Run's taint records a sensitive `core:gmail` read whose owner is
 *   the mailbox owner (a non-instructing owner: the member's Run makes no outward write, no Memory, nothing
 *   materialized; later turns of the conversation inherit it), with `gmail_scope.grant_id` the delegation id —
 *   never a consent id, so no consent-based exemption ever admits it. The owner's audit row
 *   (`delegated_read`, actor = the member, the delegation) and the delegation's count and last use are written
 *   in the same transaction. Arguments and results never enter event logs (`privateToolCalls.ts`).
 */
import { GMAIL_AGENT_PAGE_SIZE, type GmailAgentReadOutput, type GmailDelegatedReadInput, type OperationActor, type RegisteredSystemActionDefinition } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { runHostWorkOutsideOperation } from "../../../db/operationTransaction.js";
import { lockActivePeople } from "../../access/activePerson.js";
import { recordAgentDataRead } from "../../contentAccess/agentReads.js";
import { audienceWithinProject, scenarioOrigin } from "../../plugins/dataAccess.js";
import { actorReaders } from "../../plugins/releaseGate.js";
import { assertProjectReadableLocked, canReadProject } from "../../projects/access.js";
import type { Queryable } from "../../routeUtils/common.js";
import { persistRunContextTaint } from "../../runs/contextTaint.js";
import { effectiveRunTrigger } from "../../systemActions/effectiveRunTrigger.js";
import { assertCurrentActor } from "../../systemActions/operations/actor.js";
import { hidden, OperationError, OperationRefusal } from "../../systemActions/operations/errors.js";
import type { OperationRegistration } from "../../systemActions/operations/types.js";
import { GMAIL_CONSENT_ID } from "./gmailAgentReadGrants.js";
import { readGmailForAgent } from "./gmailAgentReads.js";
import { GmailReadError, recheckGmailRead, type GmailReadSnapshot } from "./gmailReadAuthority.js";
import { lockGmailOwnerSpace } from "./gmailConnections.js";

export const GMAIL_DELEGATED_READ_ACTION = "source.gmail.delegated.read" as const;
const FACTS = Symbol("rainver.gmail.delegated_read_facts");
/** Gmail `q` is capped at 300 characters with the read contract's exclusions appended. */
const SCOPED_QUERY_MAX = 300 - " -in:drafts -in:chats -in:spam -in:trash".length;

interface Delegation { id: string; owner_user_id: string; gmail_connection_id: string; connection_generation: number; project_id: string; query_scope: string; mailbox_email: string }
interface ReleaseFacts { v: 1; snapshot: GmailReadSnapshot; delegationId: string; ownerUserId: string; projectId: string; messageIds: string[]; truncated: boolean; requestId: string }

const withheld = () => new OperationError("operation_audit_unavailable", 503, true);
const MESSAGES: Record<string, string> = {
  gmail_delegation_unavailable: "No mailbox is delegated to this person for this Project any more (the owner ended it, someone left the Project, or the mailbox changed).",
  gmail_delegation_mailbox_ambiguous: "Several mailboxes are delegated to this person in this Project; ask which one and pass mailbox_email.",
  gmail_delegation_audience_outside_project: "Someone who can read this conversation does not work in this Project, so delegated mail is not read here.",
  gmail_delegation_query_invalid: "Use plain Gmail search words without parentheses or braces, with balanced quotes; the owner's scope is added to every search.",
  gmail_delegation_query_too_long: "These search words are too long together with the owner's scope; use fewer words.",
};
const refuse = (status: 409 | 422 | 429, code: string, extra: Record<string, unknown> = {}) => new OperationRefusal(status, "sources", MESSAGES[code] ?? code.replaceAll("_", " "), { code, ...extra });

/** `(<scope>) (<words>)`, or null when the member's words could reach past the owner's scope. */
export function scopedDelegationQuery(scope: string, words: string | undefined): string | null {
  const query = words?.trim();
  if (query && (/[(){}]/.test(query) || (query.match(/"/g)?.length ?? 0) % 2)) return null;
  return query ? `(${scope}) (${query})` : `(${scope})`;
}

/** The member's live delegations whose Project is this conversation's, newest first; no lock. */
async function liveDelegations(db: Queryable, input: { spaceId: string; granteeUserId: string; projectId: string; lock?: boolean }): Promise<Delegation[]> {
  return (await db.query<Delegation>(
    `SELECT d.id,d.owner_user_id,d.gmail_connection_id,d.connection_generation,d.project_id,d.query_scope,c.mailbox_email
       FROM gmail_read_delegations d JOIN gmail_connections c ON c.id=d.gmail_connection_id AND c.space_id=d.space_id AND c.owner_user_id=d.owner_user_id
       JOIN users o ON o.id=d.owner_user_id AND o.status='active'
       JOIN space_memberships om ON om.space_id=d.space_id AND om.user_id=d.owner_user_id AND om.status='active'
      WHERE d.space_id=$1 AND d.grantee_user_id=$2 AND d.project_id=$3 AND d.status='active'
        AND c.status='active' AND c.agent_read_enabled AND c.generation=d.connection_generation
      ORDER BY d.created_at DESC,d.id${input.lock ? " FOR UPDATE OF d" : ""}`,
    [input.spaceId, input.granteeUserId, input.projectId])).rows;
}

/** Whether a member may be offered the tool in this conversation now (snapshot): a live delegation for its Project. */
export async function gmailDelegatedReadAvailable(db: Queryable, input: { spaceId: string; userId: string; sessionId: string | null }): Promise<boolean> {
  if (!input.sessionId) return false;
  const session = (await db.query<{ project_id: string }>(
    `SELECT s.project_id FROM sessions s WHERE s.id=$1 AND s.space_id=$2 AND s.status='active' AND s.project_id IS NOT NULL AND (s.room_id IS NOT NULL OR s.user_id=$3)`,
    [input.sessionId, input.spaceId, input.userId])).rows[0];
  if (!session || !await canReadProject(db, input.spaceId, session.project_id, input.userId)) return false;
  return (await liveDelegations(db, { spaceId: input.spaceId, granteeUserId: input.userId, projectId: session.project_id })).length > 0;
}

/**
 * The member's own turn in an ordinary conversation of a Project whose readers all read it, and the one live
 * delegation it reads under (by `mailbox_email` when several). Refusals carry fixed codes only.
 */
async function delegatedReadAdmits(db: Queryable, actor: OperationActor, mailbox: string | undefined, lock = false): Promise<{ delegation: Delegation; sessionId: string }> {
  const member = actor.on_behalf_of_user_id;
  if (actor.principal.kind !== "agent" || !actor.run_id || !member) throw hidden();
  const run = (await db.query<{ id: string; status: string; session_id: string | null; trigger_origin: string; delegation_id: string | null; instructed_by_user_id: string | null;
    instructed_by_agent_id: string | null; parent_run_id: string | null; visibility: string; owner_user_id: string | null; agent_id: string | null; project_id: string | null; space_id: string }>(
    `SELECT id,status,session_id,trigger_origin,delegation_id,instructed_by_user_id,instructed_by_agent_id,parent_run_id,visibility,owner_user_id,agent_id,project_id,space_id
       FROM runs WHERE id=$1 AND space_id=$2`, [actor.run_id, actor.space_id])).rows[0];
  if (!run || run.status !== "running" || !run.session_id || run.instructed_by_user_id !== member) throw refuse(409, "gmail_delegation_unavailable");
  const effective = await effectiveRunTrigger(db, run as never);
  if (scenarioOrigin(run as never, effective.origin) !== "manual" || effective.instructedByUserId !== member) throw refuse(409, "gmail_delegation_unavailable");
  const session = (await db.query<{ project_id: string }>(
    `SELECT s.project_id FROM sessions s WHERE s.id=$1 AND s.space_id=$2 AND s.status='active' AND s.project_id IS NOT NULL AND (s.room_id IS NOT NULL OR s.user_id=$3)`,
    [run.session_id, actor.space_id, member])).rows[0];
  if (!session || !await canReadProject(db, actor.space_id, session.project_id, member)) throw refuse(409, "gmail_delegation_unavailable");
  if (!await delegatedReadAudienceAdmits(db, { spaceId: actor.space_id, actor, member, sessionId: run.session_id, projectId: session.project_id }))
    throw refuse(409, "gmail_delegation_audience_outside_project");
  const all = await liveDelegations(db, { spaceId: actor.space_id, granteeUserId: member, projectId: session.project_id, lock });
  const chosen = mailbox ? all.filter((row) => row.mailbox_email.toLowerCase() === mailbox) : all;
  if (!chosen.length) throw refuse(409, "gmail_delegation_unavailable");
  if (chosen.length > 1) throw refuse(409, "gmail_delegation_mailbox_ambiguous");
  const delegation = chosen[0]!;
  if (!await canReadProject(db, actor.space_id, delegation.project_id, delegation.owner_user_id)) throw refuse(409, "gmail_delegation_unavailable");
  return { delegation, sessionId: run.session_id };
}

/**
 * Everyone who reads what the member's turn answers, all reading the Project: the Run's own audience
 * (`actorReaders`: its visibility, owner, grantees and the Room's Project readers) plus — in a Room or the
 * mainline — every active roster row, as a Room Run's readers are taken from it (`listActiveRoomUserIds`) and a
 * roster row outlives Project membership. So a person who is not in the Project and joins the Room is a reader
 * here even though `roomAudience` filters them out, and the read stops (the digest rule,
 * `gmailDigestConversationAdmits`).
 */
async function delegatedReadAudienceAdmits(db: Queryable, input: { spaceId: string; actor: OperationActor; member: string; sessionId: string; projectId: string }): Promise<boolean> {
  const readers = new Set((await actorReaders(db, input.actor)).readers);
  if (!readers.has(input.member)) return false;
  for (const row of (await db.query<{ user_id: string }>(
    `SELECT m.user_id FROM sessions s JOIN room_user_members m ON m.space_id=s.space_id AND m.room_id=s.room_id AND m.status='active' WHERE s.id=$1 AND s.space_id=$2`,
    [input.sessionId, input.spaceId])).rows) readers.add(row.user_id);
  return audienceWithinProject(db, input.spaceId, input.projectId, [...readers]);
}

/**
 * Whether exactly this delegation still admits a Gmail send now, checked immediately before every send — the
 * list and each message of a page: the same admission as the call (`delegatedReadAdmits`: the member's running
 * `manual` turn, its conversation still an active one of the delegation's Project, every reader — Run audience
 * and Room roster — reading the Project, both people reading it, the delegation and connection live), and the
 * same delegation chosen. A reader outside the Project who joins between two sends stops the read at the next.
 */
async function delegationLive(db: Queryable, input: { actor: OperationActor; mailbox: string | undefined; delegation: Delegation }): Promise<boolean> {
  try {
    const { delegation } = await delegatedReadAdmits(db, input.actor, input.mailbox);
    return delegation.id === input.delegation.id && delegation.owner_user_id === input.delegation.owner_user_id
      && delegation.gmail_connection_id === input.delegation.gmail_connection_id && delegation.project_id === input.delegation.project_id;
  } catch (error) {
    if (error instanceof OperationError) return false;
    throw error;
  }
}

export function gmailDelegatedReadRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>, config: ServerConfig): OperationRegistration {
  return {
    definition: definitions.get(GMAIL_DELEGATED_READ_ACTION)!,
    readKind: "content",
    async resolve(_db, _raw, actor) {
      return { authority: `gmail_delegated_read:${actor.run_id ?? "none"}`, targets: { run_id: actor.run_id }, resourceType: "gmail_connection", resourceId: null };
    },
    async authorize(db, raw, actor) {
      const input = raw as GmailDelegatedReadInput;
      const { delegation } = await delegatedReadAdmits(db, actor, input.mailbox_email);
      const query = scopedDelegationQuery(delegation.query_scope, input.query);
      if (query === null) throw refuse(422, "gmail_delegation_query_invalid");
      if (query.length > SCOPED_QUERY_MAX) throw refuse(422, "gmail_delegation_query_too_long");
    },
    async execute(db, raw, actor, invocation) {
      const input = raw as GmailDelegatedReadInput;
      const { delegation } = await delegatedReadAdmits(db, actor, input.mailbox_email);
      const query = scopedDelegationQuery(delegation.query_scope, input.query);
      if (query === null || query.length > SCOPED_QUERY_MAX) throw refuse(422, "gmail_delegation_query_invalid");
      let read: Awaited<ReturnType<typeof readGmailForAgent>>;
      try {
        read = await runHostWorkOutsideOperation(async () => readGmailForAgent(config, getDbPool(config.databaseUrl!), {
          spaceId: actor.space_id, ownerUserId: delegation.owner_user_id, connectionId: delegation.gmail_connection_id, projectId: delegation.project_id,
          query, max: input.max_messages ?? GMAIL_AGENT_PAGE_SIZE.default, pageToken: input.page_token,
          signal: invocation?.signal ?? new AbortController().signal,
          // An ending committed before this read refuses the send; one committed after is caught at release.
          authorizeSend: async (tx) => {
            if (!await delegationLive(tx, { actor, mailbox: input.mailbox_email, delegation })) throw new GmailReadError(409, "gmail_delegation_unavailable");
          },
        }));
      } catch (error) {
        if (error instanceof GmailReadError) {
          if (error.code === "gmail_not_found") throw hidden();
          if (error.status === 429) throw refuse(429, error.code, error.retryAt ? { retry_at: error.retryAt } : {});
          if (error.status === 409 || error.status === 422) throw refuse(error.status, error.code);
          throw new OperationError("operation_temporarily_unavailable", 503, true, "sources");
        }
        throw error;
      }
      const output: GmailAgentReadOutput = read.output;
      Object.defineProperty(output, FACTS, { enumerable: false, value: {
        v: 1, snapshot: read.snapshot, delegationId: delegation.id, ownerUserId: delegation.owner_user_id, projectId: delegation.project_id,
        messageIds: output.items.map((item) => item.id), truncated: output.truncated, requestId: invocation?.requestId ?? "",
      } satisfies ReleaseFacts });
      return output;
    },
    releaseFacts(raw) {
      return raw && typeof raw === "object" ? (raw as { [FACTS]?: ReleaseFacts })[FACTS] ?? null : null;
    },
    async releaseGate(audit, release) {
      await releaseGmailDelegatedRead(audit, release.actor, release.facts as ReleaseFacts | null);
    },
  };
}

/** The release of one delegated read, in the audit transaction (lock order in the module comment). */
export async function releaseGmailDelegatedRead(db: Queryable, actor: OperationActor, facts: ReleaseFacts | null): Promise<void> {
  const member = actor.on_behalf_of_user_id;
  if (actor.principal.kind !== "agent" || !member || !facts || facts.v !== 1 || facts.ownerUserId === member) throw withheld();
  try {
    await assertProjectReadableLocked(db, actor.space_id, facts.projectId, member);
    await assertProjectReadableLocked(db, actor.space_id, facts.projectId, facts.ownerUserId);
    await lockActivePeople(db, actor.space_id, [member, facts.ownerUserId]);
  } catch { throw withheld(); }
  const run = (await db.query<{ id: string; visibility: "private" | "selected_users" | "space_shared" }>(
    `SELECT id,visibility FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE`, [actor.run_id, actor.space_id])).rows[0];
  if (!run) throw withheld();
  try { await assertCurrentActor(db, actor); } catch { throw withheld(); }
  await lockGmailOwnerSpace(db, { spaceId: actor.space_id, userId: facts.ownerUserId });
  try { await recheckGmailRead(db, facts.snapshot); } catch { throw withheld(); }
  let admitted: Delegation;
  try { admitted = (await delegatedReadAdmits(db, actor, facts.snapshot.mailboxEmail?.toLowerCase(), true)).delegation; } catch { throw withheld(); }
  if (admitted.id !== facts.delegationId || admitted.owner_user_id !== facts.ownerUserId || admitted.gmail_connection_id !== facts.snapshot.connectionId) throw withheld();
  // The owner's mail in the member's Run: a non-instructing owner's sensitive read (no outward write, Memory or
  // materialization), kept in the Project by the later-turn inheritance; the delegation is its scope.
  await persistRunContextTaint(db, {
    runId: run.id, spaceId: actor.space_id, instructingUserId: member, runVisibility: run.visibility,
    items: [{ ownerUserId: facts.ownerUserId, visibility: "private" }],
    pluginReads: [{ plugin_id: GMAIL_CONSENT_ID, data_class: "sensitive", owner_user_id: facts.ownerUserId,
      gmail_scope: { project_id: facts.projectId, grant_id: facts.delegationId } }],
  });
  await recordAgentDataRead(db, {
    spaceId: actor.space_id, ownerUserId: facts.ownerUserId, runId: run.id, agentId: actor.agent_id, actionId: GMAIL_DELEGATED_READ_ACTION,
    resourceType: "gmail_message", resourceIds: facts.messageIds, dataClass: "sensitive", grantId: null,
  });
  await db.query(
    `INSERT INTO gmail_read_audit_events (id,space_id,owner_user_id,actor_user_id,gmail_connection_id,project_id,selection_id,operation,
       google_thread_id,item_count,truncated,request_id,run_id,agent_id,delegation_id,accessed_at)
     VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,NULL,'delegated_read',NULL,$6,$7,$8,$9,$10,$11,clock_timestamp())`,
    [actor.space_id, facts.ownerUserId, member, facts.snapshot.connectionId, facts.projectId, facts.messageIds.length, facts.truncated,
      facts.requestId.slice(0, 128) || run.id, run.id, actor.agent_id ?? actor.principal.id, facts.delegationId]);
  await db.query(`UPDATE gmail_read_delegations SET read_count=read_count+1,last_used_at=clock_timestamp() WHERE id=$1`, [facts.delegationId]);
}
