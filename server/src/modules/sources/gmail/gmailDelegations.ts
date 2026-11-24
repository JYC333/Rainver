/**
 * Standing read-only delegated Gmail access (ADR 0035 §4): the mailbox owner lets one member of one Project read
 * and search one mailbox, confined to a Gmail search scope the owner states, from that member's own turns in the
 * Project's conversations, until it ends.
 *
 * - **Given once, on the owner's card.** `source.gmail.delegation.propose` drafts the owner-only
 *   `gmail_read_delegation` card in the owner's own turn of a conversation of the Project (every reader inside
 *   it); the card names the mailbox, Project, member, scope and who reads the answers. Acceptance (the owner
 *   deciding directly) writes one `gmail_read_delegations` row bound to the connection's generation; a new card for
 *   the same member replaces the earlier one (another scope). No Google authorization is added: the connection is
 *   read-only and stays so.
 * - **Checked on every request.** The member's read (`gmailDelegatedReadOperation.ts`) is admitted only while the
 *   delegation is active, both people are active and read the Project, the connection is active, opted in and at
 *   the bound generation, and the Run is the member's own turn whose readers all read the Project — at call time,
 *   before every Gmail send and at release, where it commits under the locks every ending takes.
 * - **Ends at once, never revived.** The owner ends it (`source.gmail.delegation.end` / `.revoke`, also from the
 *   Access page); it ends with every ending of the connection's consents (opt-out, disconnect, reconnect,
 *   re-authorization; forgetting deletes it) and when either person leaves the Project or is disabled
 *   (`endProjectDataConsents`). A read in flight then delivers nothing.
 */
import { randomUUID } from "node:crypto";
import {
  GmailDelegationProposalPayloadSchema, type GmailDelegationProposeInput, type SystemActionId,
} from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { lockActivePeople, lockActivePerson } from "../../access/activePerson.js";
import { assertProjectReadableLocked, canReadProject } from "../../projects/access.js";
import type { ProposalApplierRegistry } from "../../proposals/applierRegistry.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import { withQueryableTransaction, type Queryable } from "../../routeUtils/common.js";
import type { RunRecord } from "../../runs/repository.js";
import type { SystemActionExecutor } from "../../systemActions/gateway.js";
import { hidden, OperationError } from "../../systemActions/operations/errors.js";
import { lockGmailOwnerSpace } from "./gmailConnections.js";
import { ownerOnlyConversation, ownerTurn } from "./gmailApplicationUpdates.js";
import { gmailCardAudience, gmailCardAudienceText } from "./gmailApplicationSharedConversation.js";

const PROPOSE = "source.gmail.delegation.propose" as const;
const LIST = "source.gmail.delegation.list" as const;
const END = "source.gmail.delegation.end" as const;
const result = (tool: string, modelResult: Record<string, unknown>) => ({ modelResult, summary: { tool_name: tool, ok: modelResult.ok === true, ...(modelResult.ok === true ? {} : { error: modelResult.error }) } });
const refusal = (tool: string, code: string, message: string, extra: Record<string, unknown> = {}) => result(tool, { ok: false, error: code, message, ...extra });
const OWNER_TURN = "Only the mailbox owner lets others read their Gmail, in their own turn, in a conversation of this Project whose readers all work in it. Ask them to continue there.";

/** Gmail search grouping a scope may use: balanced parentheses and quotes, no braces (they would change what OR binds). */
export function gmailDelegationScopeValid(scope: string): boolean {
  if (/[{}]/.test(scope) || (scope.match(/"/g)?.length ?? 0) % 2) return false;
  let depth = 0;
  for (const ch of scope.replace(/"[^"]*"/g, "")) {
    if (ch === "(") depth += 1;
    if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** The Project member the owner named — by display name or email, case-insensitive — among those who read it. */
async function projectMember(db: Queryable, input: { spaceId: string; projectId: string; owner: string; member: string }) {
  const rows = (await db.query<{ id: string; display_name: string }>(
    `SELECT u.id,u.display_name FROM users u JOIN space_memberships m ON m.user_id=u.id AND m.space_id=$1 AND m.status='active'
      WHERE u.status='active' AND u.id<>$2 AND (lower(u.display_name)=lower($3) OR lower(u.email)=lower($3)) ORDER BY u.display_name,u.id LIMIT 20`,
    [input.spaceId, input.owner, input.member])).rows;
  const readers = [];
  for (const row of rows) if (await canReadProject(db, input.spaceId, input.projectId, row.id)) readers.push(row);
  return readers;
}

export async function proposeGmailDelegation(db: Queryable, runId: string, spaceId: string, input: GmailDelegationProposeInput, idempotencyKey: string | null) {
  return withQueryableTransaction(db, async (tx) => {
    const turn = await ownerTurn(tx, runId, spaceId, "SHARE", true);
    if (!turn) return refusal(PROPOSE, "gmail_delegation_owner_turn_required", OWNER_TURN);
    const { run, owner, projectId } = turn;
    const shared = !ownerOnlyConversation(turn);
    if (idempotencyKey) {
      const existing = (await tx.query<{ id: string; status: string }>(
        `SELECT id,status FROM proposals WHERE space_id=$1 AND created_by_run_id=$2 AND proposal_type='gmail_read_delegation' AND action_idempotency_key=$3`,
        [spaceId, run.id, idempotencyKey])).rows[0];
      if (existing) return result(PROPOSE, { ok: true, proposal_id: existing.id, status: existing.status });
    }
    if (!gmailDelegationScopeValid(input.query_scope))
      return refusal(PROPOSE, "gmail_delegation_scope_invalid", "Use Gmail search words with balanced parentheses and quotes and no braces, for example label:applications or from:@uni.example.");
    const connections = (await tx.query<{ id: string; mailbox_email: string; generation: number }>(
      `SELECT id,mailbox_email,generation FROM gmail_connections WHERE space_id=$1 AND owner_user_id=$2 AND status='active' AND agent_read_enabled ORDER BY connected_at FOR SHARE`,
      [spaceId, owner])).rows;
    const chosen = input.mailbox_email ? connections.filter((row) => row.mailbox_email.toLowerCase() === input.mailbox_email) : connections;
    if (!chosen.length) return refusal(PROPOSE, "gmail_not_connected", "No Gmail connection here allows Agent reads. The owner connects Gmail and turns on Agent reads under Sources → Access and Gmail first.");
    if (chosen.length > 1) return refusal(PROPOSE, "gmail_digest_mailbox_ambiguous", "Ask the owner which mailbox, then pass mailbox_email.", shared ? {} : { mailboxes: chosen.map((row) => row.mailbox_email) });
    const connection = chosen[0]!;
    const members = await projectMember(tx, { spaceId, projectId, owner, member: input.member });
    if (!members.length) return refusal(PROPOSE, "gmail_delegation_member_unknown", "No active member of this Project has that name or email. Ask the owner who exactly, as shown in the Project's members.");
    if (members.length > 1) return refusal(PROPOSE, "gmail_delegation_member_ambiguous", "Several Project members match; ask the owner for the member's email address.", { candidates: members.map((row) => row.display_name) });
    const grantee = members[0]!;
    const scope = input.query_scope.trim();
    const current = (await tx.query<{ query_scope: string }>(`SELECT query_scope FROM gmail_read_delegations WHERE gmail_connection_id=$1 AND project_id=$2 AND grantee_user_id=$3 AND status='active' AND connection_generation=$4`,
      [connection.id, projectId, grantee.id, connection.generation])).rows[0];
    if (current?.query_scope === scope) return result(PROPOSE, { ok: true, already_allowed: true, next_step: `${grantee.display_name} can already read this mailbox within that scope in this Project; nothing new needs confirming.` });
    const audience = shared ? await gmailCardAudience(tx, { spaceId, sessionId: run.session_id!, readers: turn.conversation.readers, isMainline: turn.conversation.isMainline }) : null;
    const summary = [
      `Lets ${grantee.display_name} read and search ${connection.mailbox_email} on request, from their own turns in this Project's conversations, only mail matching “${scope}” (added to every search they make).`,
      "Read-only: nothing is sent, labelled, archived or deleted.",
      `Their answers are visible to whoever reads the conversation they ask in (everyone in it works in this Project), including people who join later and can read its history.`,
      "You see how often and when they read under Sources → Access and Gmail and can end it at once; it ends by itself when either of you leaves the Project, or this mailbox is disconnected, reconnected or Agent reads are turned off.",
      ...(current ? [`This replaces their current scope “${current.query_scope}”.`] : []),
      ...(audience ? [gmailCardAudienceText(audience).replace("Posted in", "This card was drafted in")] : []),
    ].join(" ");
    const payload = GmailDelegationProposalPayloadSchema.parse({
      proposal_type: "gmail_read_delegation", action_id: PROPOSE, connection_id: connection.id, connection_generation: connection.generation,
      mailbox_email: connection.mailbox_email, project_id: projectId, session_id: run.session_id, grantee_user_id: grantee.id,
      grantee_name: grantee.display_name.slice(0, 200), query_scope: scope,
    });
    const proposal = await insertProposalRow(tx, {
      spaceId, proposalType: "gmail_read_delegation",
      title: `Let ${grantee.display_name} read Gmail · ${connection.mailbox_email}`,
      summary,
      rationale: "Drafted from the mailbox owner's request. Accepting gives one Project member standing read-only access within the stated search scope; it is checked on every read.",
      payload,
      createdByUserId: null, createdByAgentId: run.agent_id, createdByRunId: run.id, ownerUserId: owner,
      visibility: "private", riskLevel: "high", projectId: null, actionIdempotencyKey: idempotencyKey,
    });
    return result(PROPOSE, { ok: true, proposal_id: proposal.id, status: proposal.status, next_step: "Nothing is allowed yet. Only the mailbox owner sees and decides the card." });
  });
}

/**
 * Accepting the card (the owner deciding directly): rechecks the owner and member are active and read the Project,
 * the connection is active, opted in and at the shown generation, then writes the delegation, replacing the
 * member's earlier one in this Project. Locks: Project → people → owner + Space mutex → connection → delegation.
 */
export function registerGmailDelegationProposalApplier(registry: ProposalApplierRegistry): void {
  registry.register("gmail_read_delegation", async ({ db, proposal, userId, ownerCardDecision }) => {
    const payload = GmailDelegationProposalPayloadSchema.parse(proposal.payload_json);
    if (!ownerCardDecision || !proposal.owner_user_id || proposal.owner_user_id !== userId || proposal.visibility !== "private") throw hidden();
    if (payload.grantee_user_id === userId || !gmailDelegationScopeValid(payload.query_scope)) throw new OperationError("operation_conflict", 409);
    const spaceId = proposal.space_id;
    try { await assertProjectReadableLocked(db, spaceId, payload.project_id, userId); } catch { throw new OperationError("operation_conflict", 409); }
    try { await lockActivePeople(db, spaceId, [userId, payload.grantee_user_id]); } catch { throw new OperationError("operation_conflict", 409); }
    if (!await canReadProject(db, spaceId, payload.project_id, payload.grantee_user_id)) throw new OperationError("operation_conflict", 409);
    await lockGmailOwnerSpace(db, { spaceId, userId });
    const connection = (await db.query<{ status: string; agent_read_enabled: boolean; generation: number }>(
      `SELECT status,agent_read_enabled,generation FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR SHARE`,
      [payload.connection_id, spaceId, userId])).rows[0];
    if (!connection) throw hidden();
    if (connection.status !== "active" || !connection.agent_read_enabled || connection.generation !== payload.connection_generation) throw new OperationError("operation_conflict", 409);
    await db.query(`UPDATE gmail_read_delegations SET status='revoked',revoked_at=now(),revoked_by_user_id=$4,end_reason='gmail_delegation_replaced'
      WHERE gmail_connection_id=$1 AND project_id=$2 AND grantee_user_id=$3 AND status='active'`, [payload.connection_id, payload.project_id, payload.grantee_user_id, userId]);
    const id = randomUUID();
    await db.query(`INSERT INTO gmail_read_delegations (id,space_id,owner_user_id,gmail_connection_id,connection_generation,project_id,grantee_user_id,query_scope,proposal_id,status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',now())`,
      [id, spaceId, userId, payload.connection_id, payload.connection_generation, payload.project_id, payload.grantee_user_id, payload.query_scope, proposal.id]);
    return { result_type: "gmail_read_delegation" as const, result: { delegation_id: id, connection_id: payload.connection_id } };
  });
}

/** The owner ends one delegation now (narrowing; no card). Locks: person → mutex → delegation. */
export async function revokeGmailDelegation(db: Queryable, identity: { spaceId: string; userId: string }, delegationId: string, reason = "gmail_delegation_revoked") {
  return withQueryableTransaction(db, async (tx) => {
    try { await lockActivePerson(tx, identity.spaceId, identity.userId); } catch { throw hidden(); }
    await lockGmailOwnerSpace(tx, identity);
    const row = (await tx.query<{ id: string; status: string }>(`SELECT id,status FROM gmail_read_delegations WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR UPDATE`,
      [delegationId, identity.spaceId, identity.userId])).rows[0];
    if (!row) throw hidden();
    if (row.status === "active") await tx.query(`UPDATE gmail_read_delegations SET status='revoked',revoked_at=now(),revoked_by_user_id=$2,end_reason=$3 WHERE id=$1`, [row.id, identity.userId, reason]);
    return { delegation_id: row.id, status: "revoked" as const };
  });
}

/** Ends every active delegation of a connection, in the caller's connection writer transaction (`endGmailAgentReadGrants`). */
export async function endGmailConnectionDelegations(db: Queryable, input: { spaceId: string; ownerUserId: string; connectionId: string }): Promise<void> {
  await db.query(`UPDATE gmail_read_delegations SET status='revoked',revoked_at=now(),revoked_by_user_id=$2,end_reason='gmail_delegation_connection_ended'
    WHERE space_id=$1 AND owner_user_id=$2 AND gmail_connection_id=$3 AND status='active'`, [input.spaceId, input.ownerUserId, input.connectionId]);
}

/** Ends the delegations a person gave or received in a Project (or everywhere), when they leave it or are disabled. */
export async function endPersonGmailDelegations(db: Queryable, input: { spaceId?: string; projectId?: string; userId: string; endedByUserId: string }): Promise<void> {
  await db.query(`UPDATE gmail_read_delegations SET status='revoked',revoked_at=now(),revoked_by_user_id=$4,end_reason='gmail_delegation_member_left'
    WHERE status='active' AND (owner_user_id=$3 OR grantee_user_id=$3) AND ($1::varchar IS NULL OR space_id=$1) AND ($2::varchar IS NULL OR project_id=$2)`,
    [input.spaceId ?? null, input.projectId ?? null, input.userId, input.endedByUserId]);
}

interface DelegationRow {
  id: string; status: "active" | "revoked"; project_id: string; grantee_user_id: string; grantee_name: string; mailbox_email: string;
  query_scope: string; read_count: number; last_used_at: Date | string | null; created_at: Date | string; end_reason: string | null;
}
const iso = (value: Date | string) => new Date(value).toISOString();

/** The owner's delegations (optionally of one Project), content-free. */
export async function listGmailDelegations(db: Queryable, identity: { spaceId: string; userId: string }, projectId?: string) {
  const rows = (await db.query<DelegationRow>(
    `SELECT d.id,d.status,d.project_id,d.grantee_user_id,u.display_name AS grantee_name,c.mailbox_email,d.query_scope,d.read_count,d.last_used_at,d.created_at,d.end_reason
       FROM gmail_read_delegations d JOIN users u ON u.id=d.grantee_user_id JOIN gmail_connections c ON c.id=d.gmail_connection_id
      WHERE d.space_id=$1 AND d.owner_user_id=$2 AND ($3::varchar IS NULL OR d.project_id=$3)
      ORDER BY (d.status='active') DESC,d.created_at DESC,d.id LIMIT 100`, [identity.spaceId, identity.userId, projectId ?? null])).rows;
  return rows.map((row) => ({
    delegation_id: row.id, status: row.status, project_id: row.project_id, grantee_user_id: row.grantee_user_id, grantee_name: row.grantee_name.slice(0, 200),
    mailbox_email: row.mailbox_email, query_scope: row.query_scope, read_count: row.read_count, last_used_at: row.last_used_at ? iso(row.last_used_at) : null,
    created_at: iso(row.created_at), end_reason: row.end_reason,
  }));
}

export function registerGmailDelegationTools(executors: Map<SystemActionId, SystemActionExecutor>, config: ServerConfig, run: RunRecord): void {
  const db = () => getDbPool(config.databaseUrl!);
  executors.set(PROPOSE as SystemActionId, async (input, context) =>
    proposeGmailDelegation(db(), run.id, run.space_id, input as GmailDelegationProposeInput, context.idempotency_key ?? null));
  executors.set(LIST as SystemActionId, async () => withQueryableTransaction(db(), async (tx) => {
    const turn = await ownerTurn(tx, run.id, run.space_id, "SHARE", true);
    if (!turn) return refusal(LIST, "gmail_delegation_owner_turn_required", OWNER_TURN);
    // A mailbox address is named only to a conversation only its owner reads.
    const own = ownerOnlyConversation(turn);
    const delegations = (await listGmailDelegations(tx, { spaceId: run.space_id, userId: turn.owner }, turn.projectId))
      .map(({ mailbox_email, ...rest }) => own ? { ...rest, mailbox_email } : rest);
    return result(LIST, { ok: true, delegations });
  }));
  executors.set(END as SystemActionId, async (input) => {
    const owner = run.instructed_by_user_id;
    const turn = await withQueryableTransaction(db(), (tx) => ownerTurn(tx, run.id, run.space_id, "SHARE", true));
    if (!turn || !owner) return refusal(END, "gmail_delegation_owner_turn_required", OWNER_TURN);
    try {
      return result(END, { ok: true, ...await revokeGmailDelegation(db(), { spaceId: run.space_id, userId: owner }, String((input as { delegation_id?: unknown }).delegation_id ?? "")) });
    } catch {
      return refusal(END, "gmail_delegation_not_found", "No such delegation of the owner. Call source.gmail.delegation.list and copy its delegation_id.");
    }
  });
}
