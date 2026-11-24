/**
 * One Gmail card for what the owner asked for in this conversation (ADR 0035 §2): `source.gmail.setup.propose`.
 *
 * - **One card, separate records.** The owner names everything at once — on-demand reading, a daily or rule
 *   digest, automatic application updates — and confirms one owner-only `gmail_setup` card. Acceptance writes
 *   each part exactly as its own card would (`applyGmailDigestCard`, the `core:gmail` on-demand consent), in one
 *   transaction: each keeps its own consent row and automation, so each pauses, ends and is revoked on its own.
 * - **Reuse, never re-ask.** What is already allowed in this Project for this mailbox — a live on-demand consent,
 *   an active digest of that kind in this conversation, by this Agent, at the asked time and time zone (daily) and
 *   still on the configuration its card showed, an active automation with the same facts, Agent, model and
 *   delivery — is listed as reused and not put on the card; when everything is, no card is drafted. Only something
 *   new or different is confirmed (an automation is reused while its own private execution conversation still binds the
 *   Agent and model confirmed for it, ADR 0036): an active digest that differs in time, time zone, conversation or configuration
 *   is a part that changes it in place (`replaces_digest_id`), keeping its history.
 * - **Same checks as each card.** Every part is drafted by its own drafting code in draft-only mode (owner's turn,
 *   conversation audience inside the Project, Applications binding, pinned model, time zone, re-confirmation in
 *   its own conversation), so the combined card can never admit what a single card would refuse.
 *
 * Lock order as every Gmail writer: Project → person → Run → owner + Space mutex → connection → digest → consent.
 */
import {
  GmailDigestProposalPayloadSchema, GmailSetupProposalPayloadSchema, GMAIL_APPLICATION_UPDATE_EFFECTS,
  type GmailSetupProposeInput, type GmailSetupProposalPayload, type SystemActionId,
} from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { assertProjectReadableLocked } from "../../projects/access.js";
import type { ProposalApplierRegistry } from "../../proposals/applierRegistry.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import { withQueryableTransaction, type Queryable } from "../../routeUtils/common.js";
import type { RunRecord } from "../../runs/repository.js";
import { hidden, OperationError } from "../../systemActions/operations/errors.js";
import type { SystemActionExecutor } from "../../systemActions/gateway.js";
import { lockActivePerson } from "../../access/activePerson.js";
import { lockGmailOwnerSpace } from "./gmailConnections.js";
import { GMAIL_AGENT_READ_PURPOSE, GMAIL_CONSENT_ID } from "./gmailAgentReadGrants.js";
import { applyGmailDigestCard, gmailDigestConversationAdmits, type DigestRow } from "./gmailDigests.js";
import { proposeGmailDigest } from "./gmailDigestProposal.js";
import { ownerOnlyConversation, ownerTurn, proposeGmailApplicationUpdates, type GmailSetupDraftPart } from "./gmailApplicationUpdates.js";
import { applicationUpdateRuntimeMatches, digestRuntimeMatches } from "./gmailApplicationUpdateRuns.js";
import { applyConflict, gmailCardAudience, gmailCardAudienceCovers, gmailCardAudienceText } from "./gmailApplicationSharedConversation.js";

const TOOL = "source.gmail.setup.propose" as const;
type Purpose = GmailSetupProposalPayload["reused"][number];
const result = (modelResult: Record<string, unknown>) => ({ modelResult, summary: { tool_name: TOOL, ok: modelResult.ok === true, ...(modelResult.ok === true ? {} : { error: modelResult.error }) } });
const refusal = (code: string, message: string, extra: Record<string, unknown> = {}) => result({ ok: false, error: code, message, ...extra });
const OWNER_TURN = "Gmail access is set up only by the mailbox owner, in their own turn, in a conversation of this Project whose readers all work in it (their private conversation, a Room or the mainline). Ask them to continue there.";

/** Whether a live on-demand read consent of the owner already covers this Project and mailbox at its generation. */
async function liveReadConsent(db: Queryable, input: { spaceId: string; ownerUserId: string; projectId: string; connectionId: string; generation: number; lock?: boolean }): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM plugin_data_grants WHERE space_id=$1 AND data_owner_user_id=$2 AND plugin_id=$3 AND purpose=$4 AND scope='project'
      AND project_id=$5 AND connection_id=$6 AND connection_generation=$7 AND status='active'${input.lock ? " FOR UPDATE" : ""}`,
    [input.spaceId, input.ownerUserId, GMAIL_CONSENT_ID, GMAIL_AGENT_READ_PURPOSE, input.projectId, input.connectionId, input.generation])).rows.length > 0;
}

/** The live digest of a kind for this mailbox and Project whose consent still admits at this generation, if any. */
async function liveDigest(db: Queryable, input: { connectionId: string; projectId: string; kind: string; generation: number }): Promise<DigestRow | null> {
  return (await db.query<DigestRow>(`SELECT d.* FROM gmail_digests d JOIN plugin_data_grants g ON g.id=d.grant_id
      WHERE d.gmail_connection_id=$1 AND d.project_id=$2 AND d.kind=$3 AND d.status='active' AND g.status='active' AND g.connection_generation=$4`,
    [input.connectionId, input.projectId, input.kind, input.generation])).rows[0] ?? null;
}

const sortedEffects = (effects: readonly string[]) => [...new Set(effects)].sort((a, b) =>
  GMAIL_APPLICATION_UPDATE_EFFECTS.indexOf(a as never) - GMAIL_APPLICATION_UPDATE_EFFECTS.indexOf(b as never));

/**
 * The combined card's text: one line per part (on-demand reading, each digest part's own line), what is reused, and
 * the audience when only reading is new. Also redrawn when the owner chooses the application part's Agent and model
 * on the card (`gmailApplicationExecution.ts`).
 */
export function gmailSetupSummary(input: {
  onDemandRead: boolean; mailboxEmail: string; partLines: readonly string[]; reused: readonly string[]; audience: GmailSetupProposalPayload["audience"];
}): string {
  const lines = [
    ...(input.onDemandRead ? [`On request: Agents may read and search ${input.mailboxEmail} in every conversation of this Project (your private conversations, its Rooms and the mainline), 5 messages per page by default and up to 500, until you revoke it; never in another Project. Answers are visible to whoever reads the conversation you asked in, including people who join later and can read its history.`] : []),
    ...input.partLines,
    ...(input.reused.length ? [`Already allowed and kept as is: ${input.reused.join(", ")}.`] : []),
    "Each part is kept, paused and ended on its own under Sources → Access and Gmail.",
  ];
  return lines.map((line) => `• ${line}`).join("\n") + (input.audience && input.onDemandRead && !input.partLines.length ? `\n${gmailCardAudienceText(input.audience)}` : "");
}

export async function proposeGmailSetup(db: Queryable, config: ServerConfig, runId: string, spaceId: string, input: GmailSetupProposeInput, idempotencyKey: string | null) {
  return withQueryableTransaction(db, async (tx) => {
    const turn = await ownerTurn(tx, runId, spaceId, "SHARE", true);
    if (!turn) return refusal("gmail_digest_owner_turn_required", OWNER_TURN);
    const { run, owner, projectId } = turn;
    const shared = !ownerOnlyConversation(turn);
    if (idempotencyKey) {
      const existing = (await tx.query<{ id: string; status: string }>(
        `SELECT id,status FROM proposals WHERE space_id=$1 AND created_by_run_id=$2 AND proposal_type='gmail_setup' AND action_idempotency_key=$3`,
        [spaceId, run.id, idempotencyKey])).rows[0];
      if (existing) return result({ ok: true, proposal_id: existing.id, status: existing.status });
    }
    const connections = (await tx.query<{ id: string; mailbox_email: string; generation: number }>(
      `SELECT id,mailbox_email,generation FROM gmail_connections WHERE space_id=$1 AND owner_user_id=$2 AND status='active' AND agent_read_enabled ORDER BY connected_at FOR SHARE`,
      [spaceId, owner])).rows;
    const chosen = input.mailbox_email ? connections.filter((row) => row.mailbox_email.toLowerCase() === input.mailbox_email) : connections;
    if (!chosen.length) return refusal("gmail_not_connected", "No Gmail connection here allows Agent reads. The owner connects Gmail and turns on Agent reads under Sources → Access and Gmail first.");
    if (chosen.length > 1) return refusal("gmail_digest_mailbox_ambiguous", "Ask the owner which mailbox, then pass mailbox_email.", shared ? {} : { mailboxes: chosen.map((row) => row.mailbox_email) });
    const connection = chosen[0]!;
    const mailbox = connection.mailbox_email.toLowerCase();
    const reused: Purpose[] = [];
    const parts: GmailSetupDraftPart[] = [];
    let onDemandRead = false;
    if (input.read) {
      if (await liveReadConsent(tx, { spaceId, ownerUserId: owner, projectId, connectionId: connection.id, generation: connection.generation })) reused.push("read");
      else onDemandRead = true;
    }
    // Each digest part is drafted by its own code, which refuses exactly what its own card would.
    for (const [purpose, digestInput] of [
      ["daily_digest", input.daily_digest ? { kind: "daily" as const, ...input.daily_digest, mailbox_email: mailbox } : null],
      ["rule_digest", input.rule_digest ? { kind: "rule" as const, mailbox_email: mailbox } : null],
    ] as const) {
      if (!digestInput) continue;
      // Reused only when it is exactly what was asked for here: the same conversation and Agent, the same time and
      // time zone, and the execution configuration its card showed is still this conversation's. Otherwise the
      // card changes it in place (the owner sees what it is now) — never a silent "already allowed".
      const current = await liveDigest(tx, { connectionId: connection.id, projectId, kind: digestInput.kind, generation: connection.generation });
      const differences = current ? [
        ...(current.session_id !== run.session_id || current.agent_id !== run.agent_id ? ["delivered in another conversation or by another Agent"] : []),
        ...(digestInput.kind === "daily" && (current.local_time !== digestInput.local_time || current.time_zone !== digestInput.time_zone)
          ? [`now at ${current.local_time} (${current.time_zone})`] : []),
      ] : [];
      if (current && !differences.length && !await digestRuntimeMatches(tx, current)) differences.push("now on another Agent runtime, Provider, model or session options");
      if (current && !differences.length) { reused.push(purpose); continue; }
      let part: GmailSetupDraftPart | null = null;
      const drafted = await proposeGmailDigest(tx, runId, spaceId, digestInput, null, {
        draftOnly: (value) => { part = value; }, ...(current ? { replace: { digestId: current.id, proposalId: current.proposal_id, localTime: current.local_time, note: differences.join("; ") } } : {}) });
      if (!drafted.modelResult.ok || !part) return result({ ...drafted.modelResult, part: purpose });
      parts.push(part);
    }
    if (input.application_updates) {
      const effects = sortedEffects(input.application_updates.effects ?? GMAIL_APPLICATION_UPDATE_EFFECTS);
      const current = await liveDigest(tx, { connectionId: connection.id, projectId, kind: "application", generation: connection.generation });
      // The same facts on the same Agent and model, delivering to the same place: already allowed.
      // Its Agent and model are its own (ADR 0036), held by its private execution conversation, not this one's: it is
      // reused while that conversation still binds exactly what was confirmed. Another Agent or model is a new card
      // (`source.gmail.application_updates.propose`). One confirmed before cards said it runs as the conversation runs
      // (no `conversation_launch`, any backend) is never reused: it waits for a new card, and its start pauses it until
      // one is accepted (ADR 0037 §6, §7), so it is drafted again here and changed in place on acceptance.
      const same = current && current.runtime_binding?.conversation_launch === true && !!current.runtime_binding.sent_from
        && JSON.stringify(sortedEffects(current.effects ?? [])) === JSON.stringify(effects)
        && (current.notice_session_id ?? null) === (shared ? run.session_id : null)
        && await applicationUpdateRuntimeMatches(tx, current);
      if (same) reused.push("application_updates");
      else {
        let part: GmailSetupDraftPart | null = null;
        const drafted = await proposeGmailApplicationUpdates(tx, config, runId, spaceId, { effects: effects as never, mailbox_email: mailbox }, null, { draftOnly: (value) => { part = value; } });
        if (drafted.modelResult.ok !== true || !part) return result({ ...drafted.modelResult, part: "application_updates" });
        parts.push(part);
      }
    }
    if (!onDemandRead && !parts.length) {
      return result({ ok: true, already_allowed: reused, next_step: "Everything asked for is already allowed in this Project for this mailbox; nothing new needs confirming. Use it directly." });
    }
    const audience = shared ? await gmailCardAudience(tx, { spaceId, sessionId: run.session_id!, readers: turn.conversation.readers, isMainline: turn.conversation.isMainline }) : null;
    const summary = gmailSetupSummary({ onDemandRead, mailboxEmail: connection.mailbox_email, partLines: parts.map((part) => part.summary), reused, audience });
    const payload: GmailSetupProposalPayload = {
      proposal_type: "gmail_setup", action_id: TOOL, connection_id: connection.id, connection_generation: connection.generation, mailbox_email: connection.mailbox_email,
      project_id: projectId, session_id: run.session_id!, agent_id: run.agent_id!, shared_conversation: shared, audience,
      on_demand_read: onDemandRead, parts: parts.map((part) => ({ ...GmailDigestProposalPayloadSchema.parse(part.payload), card_summary: part.summary })), reused,
    };
    const proposal = await insertProposalRow(tx, {
      spaceId, proposalType: "gmail_setup",
      title: `Gmail for this Project · ${connection.mailbox_email}`,
      summary,
      rationale: "Drafted from the mailbox owner's request in this conversation: one confirmation for every part listed, each written as its own permission. Nothing that is already allowed is asked again.",
      payload,
      createdByUserId: null, createdByAgentId: run.agent_id, createdByRunId: run.id, ownerUserId: owner,
      visibility: "private", riskLevel: "high", projectId: null, actionIdempotencyKey: idempotencyKey,
    });
    return result({
      ok: true, proposal_id: proposal.id, status: proposal.status, reused,
      next_step: shared
        ? "Nothing runs yet. Only the mailbox owner sees and decides the card. Do not repeat mail content here."
        : "Nothing runs yet. The mailbox owner accepts or declines the one card in this conversation.",
    });
  });
}

/**
 * Accepting the combined card: each part exactly as its own card's acceptance (rechecked live), in one
 * transaction — all of them or nothing. On-demand reading writes the owner's standing `core:gmail` consent for
 * this Project and mailbox unless one is live already (ADR 0033 §1), after the same rechecks as an approval:
 * the owner reads the Project, the connection is active, opted in and at the shown generation, and the
 * conversation's readers all read the Project and were shown on the card.
 */
export function registerGmailSetupProposalApplier(registry: ProposalApplierRegistry): void {
  registry.register("gmail_setup", async ({ db, proposal, userId, config, ownerCardDecision, revisionConfirmed }) => {
    const payload = GmailSetupProposalPayloadSchema.parse(proposal.payload_json);
    if (!ownerCardDecision || !proposal.owner_user_id || proposal.owner_user_id !== userId || proposal.visibility !== "private") throw hidden();
    if (payload.shared_conversation !== !!payload.audience) throw new OperationError("operation_conflict", 409);
    for (const part of payload.parts) {
      if (part.connection_id !== payload.connection_id || part.project_id !== payload.project_id || part.session_id !== payload.session_id
        || part.connection_generation !== payload.connection_generation) throw new OperationError("operation_conflict", 409);
    }
    const identity = { spaceId: proposal.space_id, userId };
    let readGrantId: string | null = null;
    if (payload.on_demand_read) {
      try { await assertProjectReadableLocked(db, identity.spaceId, payload.project_id, userId); } catch { throw new OperationError("operation_conflict", 409); }
      try { await lockActivePerson(db, identity.spaceId, userId); } catch { throw hidden(); }
      await lockGmailOwnerSpace(db, identity);
      const connection = (await db.query<{ status: string; agent_read_enabled: boolean; generation: number }>(
        `SELECT status,agent_read_enabled,generation FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR SHARE`,
        [payload.connection_id, identity.spaceId, userId])).rows[0];
      if (!connection) throw hidden();
      if (connection.status !== "active" || !connection.agent_read_enabled || connection.generation !== payload.connection_generation) throw new OperationError("operation_conflict", 409);
      const conversation = await gmailDigestConversationAdmits(db, { spaceId: identity.spaceId, ownerUserId: userId, projectId: payload.project_id, sessionId: payload.session_id, ownerOnly: !payload.shared_conversation });
      if (!conversation) throw new OperationError("operation_conflict", 409);
      if (payload.shared_conversation && !gmailCardAudienceCovers(payload.audience, conversation.readers))
        throw await applyConflict("gmail_digest_audience_changed", "Someone can read this conversation who was not shown on the card. Draft a new card here so it names everyone who will read the answers.");
      if (!await liveReadConsent(db, { spaceId: identity.spaceId, ownerUserId: userId, projectId: payload.project_id, connectionId: payload.connection_id, generation: payload.connection_generation, lock: true })) {
        const { PluginDataGrantRepository } = await import("../../plugins/dataGrantRepository.js");
        readGrantId = await new PluginDataGrantRepository(db, config).createCoreProjectConsent(identity, {
          consentId: GMAIL_CONSENT_ID, projectId: payload.project_id, connectionId: payload.connection_id,
          generation: payload.connection_generation, purpose: GMAIL_AGENT_READ_PURPOSE,
        });
      }
    }
    const digests: string[] = [];
    for (const part of payload.parts) {
      const applied = await applyGmailDigestCard({ db, proposal, userId, config, ownerCardDecision, revisionConfirmed }, part);
      digests.push(String(applied.result.digest_id));
    }
    return { result_type: "gmail_setup" as const, result: { connection_id: payload.connection_id, read_grant_id: readGrantId, digest_ids: digests } };
  });
}

export function registerGmailSetupTools(executors: Map<SystemActionId, SystemActionExecutor>, config: ServerConfig, run: RunRecord): void {
  executors.set(TOOL as SystemActionId, async (input, context) =>
    proposeGmailSetup(getDbPool(config.databaseUrl!), config, run.id, run.space_id, input as GmailSetupProposeInput, context.idempotency_key ?? null));
}
