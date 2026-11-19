/**
 * `source.gmail.digest.propose` — an Agent turns "send me a summary of my mail
 * every morning at 8" into the one confirmation card of a scheduled digest
 * (ADR 0033 phase B). It reads no mail and returns no mail data.
 *
 * Only in the mailbox owner's own turn (`manual`, not delegated or
 * unattended) of an ordinary conversation of a Project — their own private
 * conversation (whose audience is the owner alone), a Room or the Project
 * mainline (whose every reader reads the Project) — which is the conversation
 * the digest will deliver into, and only for an active connection on which the
 * owner turned Agent reads on. The draft is a private `gmail_digest_create`
 * proposal (owner-only type, shown and decidable only by the owner, also in a
 * Room): its card shows the mailbox, kind, time and time zone, window and the
 * delivery conversation, and only the owner can accept it
 * (`registerGmailDigestProposalApplier`), which writes the consent and the
 * digest together. Scenario check, replay lookup and insert share one
 * transaction behind the owner's person lock and mutex.
 */
import type { GmailDigestProposeInput, SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { lockActivePerson } from "../../access/activePerson.js";
import { canReadProject } from "../../projects/access.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import { withQueryableTransaction, type Queryable } from "../../routeUtils/common.js";
import type { RunRecord } from "../../runs/repository.js";
import type { SystemActionExecutor } from "../../systemActions/gateway.js";
import { lockGmailOwnerSpace } from "./gmailConnections.js";
import { gmailMonitorScenarioAllowed } from "./gmailMonitorProposal.js";
import { validGmailDigestTimeZone } from "./gmailDigestSchedule.js";
import { GMAIL_DIGEST_RECONFIRM_CODE, gmailDigestConversationAdmits } from "./gmailDigests.js";
import { effectiveRunTrigger } from "../../systemActions/effectiveRunTrigger.js";
import { scenarioOrigin } from "../../plugins/dataAccess.js";

const TOOL = "source.gmail.digest.propose" as const;
type Refusal = "gmail_digest_private_turn_required" | "gmail_digest_audience_outside_project" | "gmail_not_connected" | "gmail_digest_mailbox_ambiguous" | "gmail_digest_time_zone_invalid" | "gmail_digest_exists" | "gmail_digest_reconfirm_elsewhere";

const refusal = (code: Refusal, message: string, extra: Record<string, unknown> = {}) => ({
  modelResult: { ok: false, error: code, message, ...extra },
  summary: { tool_name: TOOL, ok: false, error: code },
});
const PRIVATE = "A Gmail digest can only be set up by the mailbox owner, in their own turn, in a conversation of a Project: their private conversation, a Room or the Project mainline. Ask them to continue there.";
const OUTSIDE = "Someone who reads this conversation does not work in its Project, so a Gmail digest cannot be delivered here. The owner sets it up in their private conversation of the Project, or in a Room whose members all work in it.";

interface StoredRun {
  id: string; space_id: string; agent_id: string | null; project_id: string | null; visibility: string; owner_user_id: string | null;
  session_id: string | null; trigger_origin: string; delegation_id: string | null; instructed_by_agent_id: string | null;
  instructed_by_user_id: string | null; parent_run_id: string | null;
}

export async function proposeGmailDigest(db: Queryable, runId: string, spaceId: string, input: GmailDigestProposeInput, idempotencyKey: string | null) {
  const owner = (await db.query<{ instructed_by_user_id: string | null }>(`SELECT instructed_by_user_id FROM runs WHERE id=$1 AND space_id=$2`, [runId, spaceId])).rows[0]?.instructed_by_user_id ?? null;
  if (!owner) return refusal("gmail_digest_private_turn_required", PRIVATE);
  return withQueryableTransaction(db, async (tx) => {
    try { await lockActivePerson(tx, spaceId, owner); } catch { return refusal("gmail_digest_private_turn_required", "The mailbox owner is no longer an active member here."); }
    await lockGmailOwnerSpace(tx, { spaceId, userId: owner });
    const run = (await tx.query<StoredRun>(`SELECT id,space_id,agent_id,project_id,visibility,owner_user_id,session_id,trigger_origin,delegation_id,instructed_by_agent_id,
        instructed_by_user_id,parent_run_id FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE`, [runId, spaceId])).rows[0];
    if (!run || run.instructed_by_user_id !== owner || !run.agent_id || !run.session_id) return refusal("gmail_digest_private_turn_required", PRIVATE);
    // The conversation the digest delivers into: an ordinary conversation of a Project the owner reads.
    const session = (await tx.query<{ project_id: string | null; room_id: string | null }>(
      `SELECT project_id,room_id FROM sessions WHERE id=$1 AND space_id=$2 AND status='active' AND project_id IS NOT NULL AND (room_id IS NOT NULL OR user_id=$3)`,
      [run.session_id, spaceId, owner])).rows[0];
    if (!session?.project_id || !await canReadProject(tx, spaceId, session.project_id, owner)) return refusal("gmail_digest_private_turn_required", PRIVATE);
    if (session.room_id) {
      // A Room or mainline: the owner's own turn, and every reader of the conversation works in its Project.
      const effective = await effectiveRunTrigger(tx, run);
      if (scenarioOrigin(run, effective.origin) !== "manual" || effective.instructedByUserId !== owner) return refusal("gmail_digest_private_turn_required", PRIVATE);
      if (!await gmailDigestConversationAdmits(tx, { spaceId, ownerUserId: owner, projectId: session.project_id, sessionId: run.session_id, runId: run.id }))
        return refusal("gmail_digest_audience_outside_project", OUTSIDE);
    } else if (!(await gmailMonitorScenarioAllowed(tx, run))) return refusal("gmail_digest_private_turn_required", PRIVATE);
    if (idempotencyKey) {
      const existing = (await tx.query<{ id: string; status: string }>(
        `SELECT id,status FROM proposals WHERE space_id=$1 AND created_by_run_id=$2 AND proposal_type='gmail_digest_create' AND action_idempotency_key=$3`,
        [spaceId, run.id, idempotencyKey])).rows[0];
      if (existing) return accepted(existing.id, existing.status);
    }
    if (input.kind === "daily" && !validGmailDigestTimeZone(input.time_zone)) return refusal("gmail_digest_time_zone_invalid", "Use an IANA time zone such as Europe/Berlin or Asia/Shanghai; ask the owner if unsure.");
    const connections = (await tx.query<{ id: string; mailbox_email: string; generation: number }>(
      `SELECT id,mailbox_email,generation FROM gmail_connections WHERE space_id=$1 AND owner_user_id=$2 AND status='active' AND agent_read_enabled ORDER BY connected_at FOR SHARE`,
      [spaceId, owner])).rows;
    const chosen = input.mailbox_email ? connections.filter((row) => row.mailbox_email.toLowerCase() === input.mailbox_email) : connections;
    if (!chosen.length) return refusal("gmail_not_connected", "No Gmail connection here allows Agent reads. The owner connects Gmail and turns on Agent reads under Sources → Access and Gmail first.");
    // The reply reaches the whole conversation: the owner's addresses are listed only in their private one.
    if (chosen.length > 1) return refusal("gmail_digest_mailbox_ambiguous", session.room_id ? "Ask the owner which mailbox, then pass mailbox_email." : "Ask which mailbox, then pass mailbox_email.", session.room_id ? {} : { mailboxes: chosen.map((row) => row.mailbox_email) });
    const connection = chosen[0]!;
    if ((await tx.query(`SELECT 1 FROM gmail_digests d JOIN plugin_data_grants g ON g.id=d.grant_id
      WHERE d.gmail_connection_id=$1 AND d.project_id=$2 AND d.kind=$3 AND d.status<>'ended' AND g.status='active' AND g.connection_generation=$4`, [connection.id, session.project_id, input.kind, connection.generation])).rows.length)
      return refusal("gmail_digest_exists", "A digest of this kind already exists for this mailbox and Project. The owner pauses, resumes or ends it under Sources → Access and Gmail.");
    // A digest of this kind paused for re-confirmation (migration 0040) is confirmed again only in its own
    // conversation, where it resumes in place with its history; a card drafted elsewhere could only conflict.
    if ((await tx.query(`SELECT 1 FROM gmail_digests WHERE gmail_connection_id=$1 AND project_id=$2 AND kind=$3 AND status='paused' AND last_error_code=$4 AND session_id<>$5`,
      [connection.id, session.project_id, input.kind, GMAIL_DIGEST_RECONFIRM_CODE, run.session_id])).rows.length)
      return refusal("gmail_digest_reconfirm_elsewhere", "This mailbox already has a digest of this kind in this Project, paused until the owner confirms it again in the conversation where it was set up. Ask them to set it up again there (it resumes with its history), or to end it under Sources → Access and Gmail first.");
    const kindTitle = input.kind === "daily" ? "Daily Gmail digest" : "Gmail monitor-match digest";
    const localTime = input.kind === "daily" ? input.local_time : null;
    const timeZone = input.kind === "daily" ? input.time_zone : null;
    const proposal = await insertProposalRow(tx, {
      spaceId, proposalType: "gmail_digest_create",
      title: `${kindTitle} · ${connection.mailbox_email}${localTime ? ` · ${localTime} ${timeZone}` : ""}`,
      summary: digestCardSummary({ kind: input.kind, mailbox_email: connection.mailbox_email, local_time: localTime, time_zone: timeZone, shared: !!session.room_id }),
      rationale: `Drafted from the mailbox owner's request. Accepting allows this Agent to read this mailbox for this digest only, on this conversation's own runtime (its CLI and model process the mail), and to post the summary only into this ${session.room_id ? "conversation, where every member reads it" : "private conversation"}. Pause or end it any time under Sources → Access and Gmail.`,
      payload: {
        proposal_type: "gmail_digest_create", action_id: TOOL, kind: input.kind, connection_id: connection.id, connection_generation: connection.generation,
        mailbox_email: connection.mailbox_email, project_id: session.project_id, session_id: run.session_id, agent_id: run.agent_id,
        local_time: localTime, time_zone: timeZone, shared_conversation: !!session.room_id,
      },
      createdByUserId: null, createdByAgentId: run.agent_id, createdByRunId: run.id, ownerUserId: owner,
      visibility: "private", riskLevel: "high", projectId: null, actionIdempotencyKey: idempotencyKey,
    });
    return accepted(proposal.id, proposal.status);
  });
}

/** What the one card tells the owner before they decide (shown only to them). */
export function digestCardSummary(payload: { kind: string; mailbox_email: string; local_time: string | null; time_zone: string | null; shared?: boolean }): string {
  const what = payload.kind === "daily"
    ? "every day, a summary of your inbox since the previous digest (one daily window, including daylight-saving changes; no search words)"
    : "a summary when your Gmail monitors match new mail (each message once)";
  const where = payload.shared ? "delivered only into this conversation, where every member (all of them in this Project) reads it" : "delivered only into this private conversation";
  return `Mailbox ${payload.mailbox_email}: ${what}${payload.kind === "daily" ? `, at ${payload.local_time} (${payload.time_zone})` : ""}, ${where}.`;
}

function accepted(proposalId: string, status: string) {
  return {
    modelResult: {
      ok: true, proposal_id: proposalId, status,
      next_step: "Nothing runs yet. The mailbox owner accepts or declines the card in this conversation. After acceptance the digest arrives here according to the schedule or matching rule shown; they can pause or end it under Sources → Access and Gmail.",
    },
    summary: { tool_name: TOOL, ok: true },
  };
}

export function registerGmailDigestTools(executors: Map<SystemActionId, SystemActionExecutor>, config: ServerConfig, run: RunRecord): void {
  executors.set(TOOL as SystemActionId, async (input, context) =>
    proposeGmailDigest(getDbPool(config.databaseUrl!), run.id, run.space_id, input as GmailDigestProposeInput, context.idempotency_key ?? null));
}
