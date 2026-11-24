/**
 * The owner's automatic application updates from Gmail (ADR 0034): a Gmail digest of kind
 * `application`, set up, queried, paused and changed in conversation, and run in the background.
 *
 * - **One confirmation.** `source.gmail.application_updates.propose` drafts the owner-only
 *   `gmail_digest_create` card in the mailbox owner's own `manual` turn of a conversation of the Project whose
 *   readers all read it: their private conversation, or a Room or the mainline (ADR 0035 §1), whose card names
 *   its readers now and later and whose automation still runs in the owner's private execution conversation
 *   (`gmailApplicationSharedConversation.ts`), posting only structured results on shared applications there.
 *   The card shows the mailbox, what is read, the facts it may record, who reads the results, and the Agent and
 *   model it runs on — the owner's choice among the Project's Agents and Assistant, from the same runtime options and
 *   model picker their own conversation offers, independent of this conversation's own binding
 *   (`gmailApplicationExecution.ts`, ADR 0036, 0037). The owner's acceptance writes the
 *   automation and its consent (`core:gmail_digest`, purpose `application_update`) on the connection
 *   they already opted in — no new Gmail authorization. A later card for the same mailbox and Project
 *   changes (or resumes) the same automation in place.
 * - **Background.** The mailbox sync records every new inbox message for it (no criteria); the Sources
 *   scheduler starts one automation-origin Run in the owner's private execution conversation on the chosen runtime, launched as
 *   that conversation launches its turns (ADR 0037), whose only
 *   tools read its frozen messages and the Project's applications, record one fact
 *   (`plugin.applications.mail_fact.apply`) or keep a message for review (`.flag`). Its reply — the
 *   reminder — is stored only in that private execution conversation, which only the owner ever reads.
 * - **The fact gate** (`gmailApplicationFactAdmitted`, called by the operation host for that command):
 *   the caller is the running delivery's Run of an active automation of the owner in the targeted
 *   Project, its consent and audience still admit it, the message was frozen for this delivery,
 *   released to this Run and received exactly at the stated time, the effect is one the rule allows,
 *   the Run runs on the frozen runtime and model and its runtime reported no fallback, it is of the rule version in force, and every other
 *   sensitive read it holds is the owner's own mail of this Project released under a live consent (an
 *   earlier on-demand read in the same private conversation; `onlyOwnProjectMail`). The plugin then decides
 *   uniqueness of the deadline, revision, ordering and replay. No other write is admitted from such a Run.
 * - **The ledger** (`plugin.applications.mail_fact.list`) reaches the owner directly, or an Agent only in
 *   their own Run of their private conversation of that Project (`gmailApplicationFactsAudienceAdmitted`).
 * - **Narrowing in conversation.** `.list` (content-free; per-message outcomes only where the owner alone
 *   reads) and `.set_status` (pause or end) run in the owner's own turn in a conversation of the Project whose
 *   readers all read it, also after the conversation read mail: they widen nothing. Resuming or changing is a
 *   new card.
 *
 * Lock order as every Gmail writer and release: Project → person → Run → (the request's launch attempt) →
 * owner + Space mutex → connection → digest → consent. The fact command takes its Project `FOR UPDATE` before
 * the operation core's actor pin (`plugins/operationRegistry.ts`), so the pin's person and Run (`FOR SHARE`,
 * never upgraded: taint is read `FOR SHARE`) follow it, as in the digest read's release, which holds the
 * Project `FOR SHARE` before the Run `FOR UPDATE`; a conversation tool that records a read takes the Run
 * `FOR UPDATE` directly. A fact, a flag and a release are judged for the launch the request came from
 * (`runs/runToolRequest.ts`), never a later one.
 */
import {
  GMAIL_APPLICATION_FACT_ACTION, GMAIL_APPLICATION_UPDATE_EFFECTS, type GmailApplicationUpdateEffect, type GmailApplicationUpdatesFlagInput,
  type GmailApplicationUpdatesListOutput, type GmailApplicationUpdatesProposeInput, type GmailCardAudience, type GmailDigestRuntimeBinding, type OperationActor, type SystemActionId,
} from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { lockActivePerson } from "../../access/activePerson.js";
import { canReadProject, canWriteProject } from "../../projects/access.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import { withQueryableTransaction, type Queryable } from "../../routeUtils/common.js";
import type { RunRecord } from "../../runs/repository.js";
import { persistRunContextTaint, readRunContextTaint } from "../../runs/contextTaint.js";
import { stopAtCommitOnModelFallback } from "../../runs/runtimeModelFallback.js";
import { runToolRequest } from "../../runs/runToolRequest.js";
import { hidden } from "../../systemActions/operations/errors.js";
import type { SystemActionExecutor } from "../../systemActions/gateway.js";
import { effectiveRunTrigger } from "../../systemActions/effectiveRunTrigger.js";
import { lockGmailOwnerSpace } from "./gmailConnections.js";
import { applicationUpdateRunState, currentApplicationUpdateRuntime, GMAIL_APPLICATION_FLAG_ACTION } from "./gmailApplicationUpdateRuns.js";
import { applicationExecutionConfigurations, defaultApplicationExecution, type ApplicationExecutionList } from "./gmailApplicationExecution.js";
import { gmailAgentReadConsentLive, GMAIL_CONSENT_ID } from "./gmailAgentReadGrants.js";
import {
  APPLICATION_RUN_CURRENT_SQL, endGmailDigestIn, GMAIL_DIGEST_CONSENT_ID, GMAIL_DIGEST_READ_ACTION, gmailApplicationMailCounts, gmailDigestConversationAdmits, gmailDigestRunAdmits,
  setGmailDigestStatusIn, type DigestRow,
} from "./gmailDigests.js";
import { gmailWebUrl } from "./gmailMessageText.js";
import { gmailCardAudience, gmailCardAudienceText } from "./gmailApplicationSharedConversation.js";

const PROPOSE = "source.gmail.application_updates.propose" as const;
const LIST = "source.gmail.application_updates.list" as const;
const SET_STATUS = "source.gmail.application_updates.set_status" as const;
type Identity = { spaceId: string; userId: string };

const OWNER_TURN = "Automatic application updates are set up and managed only by the mailbox owner, in their own turn, in a conversation of this Project whose readers all work in it (their private conversation, a Room or the mainline). Ask them to continue there.";
const result = (tool: string, modelResult: Record<string, unknown>) => ({ modelResult, summary: { tool_name: tool, ok: modelResult.ok === true, ...(modelResult.ok === true ? {} : { error: modelResult.error }) } });
const refusal = (tool: string, code: string, message: string, extra: Record<string, unknown> = {}) => result(tool, { ok: false, error: code, message, ...extra });

interface StoredRun {
  id: string; space_id: string; agent_id: string | null; project_id: string | null; visibility: string; owner_user_id: string | null;
  session_id: string | null; trigger_origin: string; delegation_id: string | null; instructed_by_agent_id: string | null;
  instructed_by_user_id: string | null; parent_run_id: string | null;
}
const RUN_COLUMNS = `id,space_id,agent_id,project_id,visibility,owner_user_id,session_id,trigger_origin,delegation_id,instructed_by_agent_id,instructed_by_user_id,parent_run_id`;

export interface OwnerTurn { run: StoredRun; owner: string; projectId: string; conversation: { roomId: string | null; isMainline: boolean; readers: string[] } }

/**
 * The owner's own `manual` turn in an active ordinary conversation of a Project: with `shared`, their private
 * conversation, a Room or the mainline whose every reader reads the Project (ADR 0035 §1); without it, only a
 * conversation whose whole audience is the owner (ADR 0034). Locks as every Gmail release does: person → the
 * Run (`FOR UPDATE` when the caller records a read in its taint, so that lock is never upgraded) → owner + Space
 * mutex. Returns the Run, owner, Project and the conversation's readers, or null.
 */
export async function ownerTurn(tx: Queryable, runId: string, spaceId: string, runLock: "SHARE" | "UPDATE", shared: boolean): Promise<OwnerTurn | null> {
  const owner = (await tx.query<{ instructed_by_user_id: string | null }>(`SELECT instructed_by_user_id FROM runs WHERE id=$1 AND space_id=$2`, [runId, spaceId])).rows[0]?.instructed_by_user_id ?? null;
  if (!owner) return null;
  try { await lockActivePerson(tx, spaceId, owner); } catch { return null; }
  const run = (await tx.query<StoredRun>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id=$1 AND space_id=$2 FOR ${runLock}`, [runId, spaceId])).rows[0];
  await lockGmailOwnerSpace(tx, { spaceId, userId: owner });
  if (!run || run.instructed_by_user_id !== owner || !run.agent_id || !run.session_id) return null;
  const session = (await tx.query<{ project_id: string | null }>(
    `SELECT project_id FROM sessions WHERE id=$1 AND space_id=$2 AND status='active' AND project_id IS NOT NULL AND (room_id IS NOT NULL OR user_id=$3)`,
    [run.session_id, spaceId, owner])).rows[0];
  if (!session?.project_id || !await canReadProject(tx, spaceId, session.project_id, owner)) return null;
  const { scenarioOrigin } = await import("../../plugins/dataAccess.js");
  const effective = await effectiveRunTrigger(tx, run);
  if (scenarioOrigin(run, effective.origin) !== "manual" || effective.instructedByUserId !== owner) return null;
  const conversation = await gmailDigestConversationAdmits(tx, { spaceId, ownerUserId: owner, projectId: session.project_id, sessionId: run.session_id, runId: run.id, ownerOnly: !shared });
  if (!conversation) return null;
  return { run, owner, projectId: session.project_id, conversation };
}

/** Whether only the owner reads the turn's conversation (their private conversation of the Project). */
export const ownerOnlyConversation = (turn: OwnerTurn) => !turn.conversation.roomId && turn.conversation.readers.length === 1 && turn.conversation.readers[0] === turn.owner;

const EFFECT_LABEL: Record<GmailApplicationUpdateEffect, string> = {
  under_review: "under review", interview: "interview invitations", waitlisted: "waitlist notices", offer: "offers", rejected: "rejections",
  submission_received: "received submissions", deadline: "new or moved deadlines", contact: "application email correspondence",
};

/** What the one card tells the owner before they decide (shown only to them). */
export function applicationUpdatesCardSummary(payload: {
  mailbox_email: string; effects: readonly GmailApplicationUpdateEffect[]; binding: Pick<GmailDigestRuntimeBinding, "agent_name" | "model_label"> | null; change?: boolean; audience?: GmailCardAudience | null; include_sent?: boolean;
}): string {
  const facts = payload.effects.map((effect) => EFFECT_LABEL[effect]).join(", ");
  // ADR 0036: what runs is chosen on the card, independent of the conversation it was asked in.
  const who = payload.binding ? `${payload.binding.agent_name} on ${payload.binding.model_label}` : "the Agent and model you choose on this card";
  const head = `Mailbox ${payload.mailbox_email}: in the background, ${who} reads each new ${payload.include_sent ? "inbox or sent" : "inbox"} message from acceptance on (no search words; never spam, trash, ${payload.include_sent ? "" : "sent mail, "}drafts or chats; up to 20 per check) and records clear facts on the one matching application of this Project — ${facts}.`;
  const where = payload.audience
    // ADR 0035 §1: the mail and the model's own report stay in the owner's private execution conversation.
    ? ` Mail text, the Agent's report and unclear messages stay with you in a private conversation of this Project ("Gmail application updates"). Only the recorded changes on applications shared with the Project (application, change, dates) are posted here; applications only you can see are never mentioned. ${gmailCardAudienceText(payload.audience)}`
    : " Mail text, the Agent's report and unclear messages stay with you in your private conversation of this Project (\"Gmail application updates\"); nothing is posted anywhere else.";
  const choose = payload.binding ? "" : " No Agent and model is chosen yet: choose one that can run it before accepting.";
  // ADR 0037: launched as that conversation launches its turns; a runtime's explicit fallback report stops the round.
  const fallback = " It runs as your own conversation with that Agent runs. If its runtime reports that it answered with another model, that round stops, posts nothing and you get one notice; what was already handed out before the report cannot be taken back.";
  return `${head}${where} Accepting, declining or withdrawing, archiving, deleting and sending are never automatic. It runs only on the Agent and model you accept here; changing them is a new card.${fallback}${choose}${payload.change ? " This changes your existing automation for this mailbox and Project." : ""}`;
}

/** What `draftOnly` returns instead of inserting the card: the part one combined card (`gmail_setup`) carries. */
export interface GmailSetupDraftPart { payload: Record<string, unknown>; summary: string; change: boolean }

export async function proposeGmailApplicationUpdates(db: Queryable, config: ServerConfig, runId: string, spaceId: string, input: GmailApplicationUpdatesProposeInput, idempotencyKey: string | null,
  options: { draftOnly?: (part: GmailSetupDraftPart) => void } = {}) {
  return withQueryableTransaction(db, async (tx) => {
    const turn = await ownerTurn(tx, runId, spaceId, "SHARE", true);
    if (!turn) return refusal(PROPOSE, "gmail_digest_owner_turn_required", OWNER_TURN);
    const { run, owner, projectId } = turn;
    const shared = !ownerOnlyConversation(turn);
    if (idempotencyKey && !options.draftOnly) {
      const existing = (await tx.query<{ id: string; status: string }>(
        `SELECT id,status FROM proposals WHERE space_id=$1 AND created_by_run_id=$2 AND proposal_type='gmail_digest_create' AND action_idempotency_key=$3`,
        [spaceId, run.id, idempotencyKey])).rows[0];
      if (existing) return accepted(existing.id, existing.status);
    }
    // The automation writes through the Applications package bound to this Project, as the owner.
    const { operationPluginEnabled } = await import("../../plugins/operationEnablement.js");
    const { isPluginProjectBound } = await import("../../plugins/projectBindings.js");
    const bound = await isPluginProjectBound(tx, "applications", spaceId, projectId);
    if (!bound || !await operationPluginEnabled(tx, "applications", spaceId, owner, config) || !await canWriteProject(tx, spaceId, projectId, owner))
      return refusal(PROPOSE, "gmail_digest_applications_unavailable", "Application management is not enabled and bound to this Project for the owner, or they cannot edit it. They turn it on in the Project's plugin settings first.");
    const connections = (await tx.query<{ id: string; mailbox_email: string; generation: number }>(
      `SELECT id,mailbox_email,generation FROM gmail_connections WHERE space_id=$1 AND owner_user_id=$2 AND status='active' AND agent_read_enabled ORDER BY connected_at FOR SHARE`,
      [spaceId, owner])).rows;
    const chosen = input.mailbox_email ? connections.filter((row) => row.mailbox_email.toLowerCase() === input.mailbox_email) : connections;
    if (!chosen.length) return refusal(PROPOSE, "gmail_not_connected", "No Gmail connection here allows Agent reads. The owner connects Gmail and turns on Agent reads under Sources → Access and Gmail first.");
    // The reply reaches the whole conversation: the owner's addresses are listed only in a conversation only they read.
    if (chosen.length > 1) return refusal(PROPOSE, "gmail_digest_mailbox_ambiguous", shared ? "Ask the owner which mailbox, then pass mailbox_email." : "Ask which mailbox, then pass mailbox_email.", shared ? {} : { mailboxes: chosen.map((row) => row.mailbox_email) });
    const connection = chosen[0]!;
    const effects = [...new Set(input.effects ?? GMAIL_APPLICATION_UPDATE_EFFECTS)].sort((a, b) => GMAIL_APPLICATION_UPDATE_EFFECTS.indexOf(a) - GMAIL_APPLICATION_UPDATE_EFFECTS.indexOf(b));
    // The automation this card changes, frozen with its version (the accepted card in force now): acceptance refuses the
    // card once another card changed it or the owner ended it, and a card for a new one once one exists (ADR 0036).
    const existing = (await tx.query<{ id: string; proposal_id: string; agent_id: string; runtime_binding: GmailDigestRuntimeBinding | null }>(
      `SELECT id,proposal_id,agent_id,runtime_binding FROM gmail_digests WHERE gmail_connection_id=$1 AND project_id=$2 AND kind='application' AND status<>'ended' ORDER BY created_at DESC LIMIT 1`,
      [connection.id, projectId])).rows[0] ?? null;
    const change = existing !== null;
    // ADR 0036: the Agent and model are the owner's choice on the card, among those that can run it in the background;
    // this conversation's own binding is only one candidate, so a binding that could never run it opens the card anyway.
    const executionScope = { spaceId, ownerUserId: owner, projectId, draftingSessionId: run.session_id! };
    const choices = await applicationExecutionConfigurations(tx, executionScope);
    const drafting = await currentApplicationUpdateRuntime(tx, { spaceId, sessionId: run.session_id!, agentId: run.agent_id! });
    const preset = await defaultApplicationExecution(tx, executionScope, choices,
      [existing ? { agentId: existing.agent_id, binding: existing.runtime_binding } : null, { agentId: run.agent_id!, binding: drafting }]);
    const audience = shared ? await gmailCardAudience(tx, { spaceId, sessionId: run.session_id!, readers: turn.conversation.readers, isMainline: turn.conversation.isMainline }) : null;
    const binding = preset?.binding ?? null;
    const summary = applicationUpdatesCardSummary({ mailbox_email: connection.mailbox_email, effects, binding, change, audience, include_sent: true });
    const payload = {
      proposal_type: "gmail_digest_create", action_id: PROPOSE, kind: "application", connection_id: connection.id, connection_generation: connection.generation,
      mailbox_email: connection.mailbox_email, project_id: projectId, session_id: run.session_id, agent_id: preset?.agentId ?? run.agent_id,
      local_time: null, time_zone: null, shared_conversation: shared, effects, include_sent: true, runtime_binding: binding, ...(audience ? { audience } : {}),
      replaces_digest_id: existing?.id ?? null, replaces_proposal_id: existing?.proposal_id ?? null,
    };
    if (options.draftOnly) {
      options.draftOnly({ payload, summary, change });
      return result(PROPOSE, { ok: true, execution: executionNote(choices, binding) });
    }
    const proposal = await insertProposalRow(tx, {
      spaceId, proposalType: "gmail_digest_create",
      title: `${change ? "Change automatic" : "Automatic"} application updates from Gmail · ${connection.mailbox_email}`,
      summary,
      rationale: `Drafted from the mailbox owner's request. Accepting allows the Agent chosen on the card to read each new message of this mailbox in the background, on the model chosen there (it processes the mail), and to record only the listed facts on this Project's applications, each checked by Rainver first. ${shared ? "Mail text and the Agent's report reach only you; this conversation receives only the recorded changes on applications shared with the Project." : "Only you read the results, in your private conversation \"Gmail application updates\"."} Pause or end it here in conversation or under Sources → Access and Gmail.`,
      payload,
      createdByUserId: null, createdByAgentId: run.agent_id, createdByRunId: run.id, ownerUserId: owner,
      visibility: "private", riskLevel: "high", projectId: null, actionIdempotencyKey: idempotencyKey,
    });
    return accepted(proposal.id, proposal.status, shared, executionNote(choices, binding));
  });
}

/**
 * What the drafting Agent tells the owner about the execution choice (names only, never ids): what is preselected, how
 * many models can run it and how many configurations cannot (each counted once), and when nothing can run it, that every
 * configuration's reason is on the card.
 */
function executionNote(listed: ApplicationExecutionList, binding: GmailDigestRuntimeBinding | null) {
  return {
    preselected: binding ? { agent_name: binding.agent_name, model: binding.pinned_model ?? null } : null,
    available_choices: listed.configurations.reduce((count, entry) => count + entry.bindings.size, 0),
    unavailable_choices: listed.configurations.filter((entry) => !entry.configuration.available).length,
    // More configurations than the card's first page: the owner continues the list on the card itself.
    ...(listed.next ? { more_on_card: true } : {}),
  };
}

function accepted(proposalId: string, status: string, shared = false, execution?: ReturnType<typeof executionNote>) {
  const choose = execution && !execution.preselected
    ? " No Agent and runtime in this Project can run it in their private conversation now; the card lists each configuration with the reason. The owner makes one available (for example by bringing its Host online), then chooses it on the card."
    : " The owner can choose another Agent and model on the card before accepting.";
  return result(PROPOSE, {
    ok: true, proposal_id: proposalId, status, ...(execution ? { execution } : {}),
    next_step: (shared
      ? "Nothing runs yet. Only the mailbox owner sees and decides the card. After acceptance, new inbox mail is checked in the background in their private conversation; only recorded changes on applications shared with the Project are posted here. Do not repeat mail content here."
      : "Nothing runs yet. The mailbox owner accepts or declines the card in this conversation. After acceptance, new inbox mail is checked in the background in their private conversation \"Gmail application updates\", which only they read.") + choose,
  });
}

/** The owner's automations of this Project, content-free, with their recent per-message outcome. */
export async function listGmailApplicationUpdates(db: Queryable, runId: string, spaceId: string) {
  return withQueryableTransaction(db, async (tx) => {
    const turn = await ownerTurn(tx, runId, spaceId, "UPDATE", true);
    if (!turn) return refusal(LIST, "gmail_digest_owner_turn_required", OWNER_TURN);
    // Per-message outcomes are the owner's mail: only a conversation only they read receives them, and this
    // Run then holds them, as if it had read the mail. A shared conversation gets the content-free status only.
    const detailed = ownerOnlyConversation(turn);
    if (detailed) await recordGmailDerivedRead(tx, { spaceId, runId: turn.run.id, ownerUserId: turn.owner, visibility: turn.run.visibility });
    const rows = (await tx.query<DigestRow & { mailbox_email: string; consent_live: boolean }>(
      `SELECT d.*,c.mailbox_email,EXISTS (SELECT 1 FROM plugin_data_grants g WHERE g.id=d.grant_id AND g.status='active') AS consent_live
         FROM gmail_digests d JOIN gmail_connections c ON c.id=d.gmail_connection_id
        WHERE d.space_id=$1 AND d.owner_user_id=$2 AND d.project_id=$3 AND d.kind='application' AND (d.status<>'ended' OR d.ended_at>now()-interval '30 days')
        ORDER BY d.created_at DESC LIMIT 10`, [spaceId, turn.owner, turn.projectId])).rows;
    const automations: GmailApplicationUpdatesListOutput["automations"] = [];
    for (const row of rows) {
      const base = {
        // A mailbox address is named only to a conversation only its owner reads.
        digest_id: row.id, status: row.status === "ended" || !row.consent_live ? "ended" as const : row.status, ...(detailed ? { mailbox_email: row.mailbox_email } : {}), effects: row.effects ?? [],
        agent_name: row.runtime_binding?.agent_name ?? "", model_label: row.runtime_binding?.model_label ?? "",
        covered_until: new Date(row.covered_until).toISOString(), last_delivered_at: row.last_delivered_at ? new Date(row.last_delivered_at).toISOString() : null,
        last_error_code: row.last_error_code, failure_count: row.failure_count, results_to: row.notice_session_id ? "shared" as const : "private" as const,
      };
      if (!detailed) { automations.push(base); continue; }
      const recent = (await tx.query<{ google_message_id: string; received_at: Date; status: "pending" | "done" | "review" | "failed"; reason: string | null; candidate_application_ids: string[] }>(
        `SELECT google_message_id,received_at,status,reason,candidate_application_ids FROM gmail_digest_mail_items WHERE digest_id=$1
          ORDER BY (status IN ('review','failed')) DESC,received_at DESC LIMIT 20`, [row.id])).rows;
      automations.push({
        ...base, mail_items: await gmailApplicationMailCounts(tx, row.id),
        recent: recent.map((item) => ({
          message_id: item.google_message_id, gmail_url: gmailWebUrl(row.mailbox_email, item.google_message_id), received_at: new Date(item.received_at).toISOString(), status: item.status,
          reason: item.reason === "read_failed" || item.reason === "not_eligible" ? null : item.reason as never, candidate_application_ids: Array.isArray(item.candidate_application_ids) ? item.candidate_application_ids.slice(0, 5) : [],
        })),
      });
    }
    return result(LIST, { ok: true, automations, next_step: detailed
      ? "For what was recorded on each application, call plugin.applications.mail_fact.list for this Project. To change or resume an automation, draft a new card with source.gmail.application_updates.propose."
      : "This conversation is read by others, so per-message outcomes are not listed here; the owner sees them in their private conversation of this Project. To change or resume an automation, draft a new card with source.gmail.application_updates.propose." });
  });
}

/** Pause or end one automation (narrowing only). The owner's own digest commands do the work under the same locks. */
export async function setGmailApplicationUpdatesStatus(db: Queryable, runId: string, spaceId: string, input: { digest_id: string; status: "paused" | "ended" }) {
  return withQueryableTransaction(db, async (tx) => {
    // Pausing or ending narrows and tells nothing about the mail: also from a shared conversation of the Project.
    const turn = await ownerTurn(tx, runId, spaceId, "SHARE", true);
    if (!turn) return refusal(SET_STATUS, "gmail_digest_owner_turn_required", OWNER_TURN);
    const row = (await tx.query<{ id: string }>(`SELECT id FROM gmail_digests WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND project_id=$4 AND kind='application'`,
      [input.digest_id, spaceId, turn.owner, turn.projectId])).rows[0];
    if (!row) return refusal(SET_STATUS, "gmail_digest_not_found", "No such automation of the owner in this Project. Call source.gmail.application_updates.list and copy its digest_id.");
    const identity: Identity = { spaceId, userId: turn.owner };
    try {
      const done = input.status === "ended" ? await endGmailDigestIn(tx, identity, row.id) : await setGmailDigestStatusIn(tx, identity, row.id, "paused");
      return result(SET_STATUS, { ok: true, digest_id: done.digest_id, status: done.status });
    } catch {
      return refusal(SET_STATUS, "gmail_digest_ended", "This automation has already ended. A new card from source.gmail.application_updates.propose starts it again.");
    }
  });
}

/**
 * The automation Run's running delivery under the rule version in force, with its automation, or null —
 * locked in the order of every Gmail writer (`gmailConnections.ts`): (person and Run, held by the caller) →
 * the request's launch attempt `FOR SHARE` → owner + Space mutex → connection `FOR SHARE` → digest
 * `FOR SHARE`. Before any lock past the Run, the Run must run on the automation's frozen configuration, for
 * `launchId` — the launch the request came from — while it is still the current one, and its runtime must not have
 * reported a fallback (`applicationUpdateRunState`, its attempt held until commit so a relaunch waits). Disconnect,
 * reconnect, the opt-in writer and a new card take the mutex and the connection before the digest, so each
 * either commits first (and this sees its result) or waits until the caller's check and write have
 * committed; none waits on a digest this holds while holding what this needs.
 */
async function lockedAutomationDelivery(db: Queryable, input: {
  spaceId: string; ownerUserId: string; runId: string; launchId: string | null | undefined;
  /** What the step throws at its commit boundary when this process received a fallback report after this check. */
  fallbackAtCommit: () => Error;
}) {
  const select = (lock: string) => db.query<DigestRow & { delivery_id: string; message_ids: string[] | null }>(
    `SELECT d.*,dl.id AS delivery_id,dl.message_ids FROM gmail_digest_deliveries dl JOIN gmail_digests d ON d.id=dl.digest_id
       JOIN runs r ON r.id=dl.run_id AND r.space_id=d.space_id
      WHERE dl.run_id=$1 AND dl.status='running' AND d.space_id=$2 AND d.owner_user_id=$3 AND d.kind='application' AND d.status='active'
        AND ${APPLICATION_RUN_CURRENT_SQL}${lock}`,
    [input.runId, input.spaceId, input.ownerUserId]);
  const seen = (await select("")).rows[0];
  if (!seen) return null;
  if (await applicationUpdateRunState(db, { spaceId: input.spaceId, runId: input.runId, binding: seen.runtime_binding, launchId: input.launchId, lock: true }) !== "ok") return null;
  // A report this process receives from here on — while a statement below or the step's own write waits — stops the
  // step at its commit boundary instead (ADR 0037 §11).
  stopAtCommitOnModelFallback(db, { spaceId: input.spaceId, runId: input.runId }, input.fallbackAtCommit);
  await lockGmailOwnerSpace(db, { spaceId: input.spaceId, userId: input.ownerUserId });
  await db.query(`SELECT id FROM gmail_connections WHERE id=$1 FOR SHARE`, [seen.gmail_connection_id]);
  // Read again under the locks: a writer that committed while this waited is seen. The same card (its id is
  // the rule version) keeps the same frozen binding, so the runtime check above still applies.
  const digest = (await select(" FOR SHARE OF d")).rows[0];
  return digest && digest.id === seen.id && digest.gmail_connection_id === seen.gmail_connection_id && digest.proposal_id === seen.proposal_id ? digest : null;
}

/**
 * Records in the Run's merge-only taint that it now holds the owner's Gmail-derived data — the automation's
 * per-message outcomes or the facts its mail recorded — as the digest read records the mail itself
 * (`core:gmail_digest`, sensitive, the owner's): its outward writes are refused from here on, and later
 * Runs of the conversation inherit it (ADR 0030 §7, ADR 0034). The caller holds the Run `FOR UPDATE`.
 */
async function recordGmailDerivedRead(db: Queryable, input: { spaceId: string; runId: string; ownerUserId: string; visibility: string }): Promise<void> {
  await persistRunContextTaint(db, {
    runId: input.runId, spaceId: input.spaceId, instructingUserId: input.ownerUserId,
    runVisibility: input.visibility === "selected_users" || input.visibility === "space_shared" ? input.visibility : "private",
    items: [{ ownerUserId: input.ownerUserId, visibility: "private" }],
    pluginReads: [{ plugin_id: GMAIL_DIGEST_CONSENT_ID, data_class: "sensitive", owner_user_id: input.ownerUserId }],
  });
}

/**
 * Direction of a frozen message released to this request's launch. A new
 * launch can cite only mail it read itself (ADR 0034).
 */
async function releasedMessageDirection(db: Queryable, input: { spaceId: string; runId: string; launchId: string | null | undefined; messageId: string; frozen: readonly string[] | null }): Promise<"inbound" | "outbound" | null> {
  if (!input.launchId || !input.frozen?.includes(input.messageId)) return null;
  const row = (await db.query<{ resource_type: "gmail_message" | "gmail_sent_message" }>(`SELECT resource_type FROM agent_data_read_logs
      WHERE space_id=$1 AND run_id=$2 AND action_id=$3 AND resource_type IN ('gmail_message','gmail_sent_message')
        AND launch_id=$5 AND resource_ids_json ? $4 ORDER BY accessed_at DESC, id DESC LIMIT 1`,
    [input.spaceId, input.runId, GMAIL_DIGEST_READ_ACTION, input.messageId, input.launchId])).rows[0];
  return row ? (row.resource_type === "gmail_sent_message" ? "outbound" : "inbound") : null;
}

/**
 * Every sensitive read this Run holds — its own and those it inherited from its conversation — is the
 * owner's own mail of this Project: its automation's digest reads, and on-demand reads the owner made
 * earlier in this same private conversation, each released under a Gmail consent of the owner for this
 * Project (`gmail_scope`, verified at that release) that is still live. A read of unknown owner, of
 * someone else, of another source or Project, or one whose consent ended keeps the write refused, as
 * does personal Memory; and the Run must itself have read its frozen mail.
 */
async function onlyOwnProjectMail(db: Queryable, input: { spaceId: string; runId: string; ownerUserId: string; projectId: string }): Promise<boolean> {
  // Held until commit without upgrading the operation core's FOR SHARE pin of the Run (`readRunContextTaint`).
  const taint = await readRunContextTaint(db, input.spaceId, input.runId, { forShare: true });
  if (!taint || taint.personal_memory_grant_ids.length || taint.non_instructing_owner_user_ids.length) return false;
  const reads = taint.plugin_reads ?? [];
  if (!reads.some((read) => read.plugin_id === GMAIL_DIGEST_CONSENT_ID && read.data_class === "sensitive" && read.owner_user_id === input.ownerUserId)) return false;
  const onDemandGrants = new Set<string>();
  for (const read of reads) {
    if (read.owner_user_id !== input.ownerUserId) return false;
    if (read.plugin_id === GMAIL_DIGEST_CONSENT_ID) continue;
    if (read.plugin_id !== GMAIL_CONSENT_ID || read.data_class !== "sensitive" || read.gmail_scope?.project_id !== input.projectId) return false;
    onDemandGrants.add(read.gmail_scope.grant_id);
  }
  for (const grantId of [...onDemandGrants].sort()) {
    if (!await gmailAgentReadConsentLive(db, { spaceId: input.spaceId, ownerUserId: input.ownerUserId, grantId, projectId: input.projectId })) return false;
  }
  return true;
}

/** The rule effect a fact command records. */
function factEffect(input: unknown): GmailApplicationUpdateEffect | null {
  const effect = (input as { effect?: { kind?: unknown; status?: unknown } } | null)?.effect;
  if (effect?.kind === "status" && typeof effect.status === "string" && (GMAIL_APPLICATION_UPDATE_EFFECTS as readonly string[]).includes(effect.status)) return effect.status as GmailApplicationUpdateEffect;
  if (effect?.kind === "submission_received") return "submission_received";
  if (effect?.kind === "deadline") return "deadline";
  if (effect?.kind === "contact") return "contact";
  return null;
}

/**
 * The host gate of `plugin.applications.mail_fact.apply` (ADR 0034): true only for the running
 * delivery's Run of the owner's active automation, in the Project the call targets, while its consent
 * and owner-only audience admit it, for a message frozen for that delivery, released to this Run,
 * received exactly at `source.received_at` and still waiting, for an effect the rule allows, and with no
 * other sensitive read in the Run. Anything else — a person, another Run, another message — is refused.
 */
export async function gmailApplicationFactAdmitted(db: Queryable, actor: Pick<OperationActor, "space_id" | "run_id" | "effective_origin" | "on_behalf_of_user_id" | "principal">, input: unknown): Promise<boolean> {
  if (actor.principal.kind !== "agent" || actor.effective_origin !== "automation" || !actor.run_id || !actor.on_behalf_of_user_id) return false;
  const call = input as { project_id?: unknown; source?: { kind?: unknown; message_id?: unknown; received_at?: unknown }; effect?: { direction?: unknown } } | null;
  const messageId = call?.source?.message_id, receivedAt = call?.source?.received_at;
  if (call?.source?.kind !== "gmail" || typeof messageId !== "string" || typeof receivedAt !== "string" || typeof call.project_id !== "string") return false;
  const owner = actor.on_behalf_of_user_id;
  // On the frozen configuration, for the launch this request came from and still current, with no fallback reported:
  // a request of an earlier launch never writes for a later launch (checked inside, before the mutex).
  const launchId = runToolRequest()?.launchId;
  const digest = await lockedAutomationDelivery(db, { spaceId: actor.space_id, ownerUserId: owner, runId: actor.run_id, launchId, fallbackAtCommit: hidden });
  if (!digest || digest.project_id !== call.project_id) return false;
  const effect = factEffect(input);
  if (!effect || !(digest.effects ?? []).includes(effect)) return false;
  const admitted = await gmailDigestRunAdmits(db, { spaceId: actor.space_id, ownerUserId: owner, runId: actor.run_id });
  if (!admitted.ok || admitted.grantId !== digest.grant_id) return false;
  const expectedDirection = effect === "contact" ? call.effect?.direction : "inbound";
  const direction = await releasedMessageDirection(db, { spaceId: actor.space_id, runId: actor.run_id, launchId, messageId, frozen: digest.message_ids });
  if (!direction || direction !== expectedDirection) return false;
  const item = (await db.query<{ received_at: Date }>(`SELECT received_at FROM gmail_digest_mail_items WHERE digest_id=$1 AND google_message_id=$2 AND status IN ('pending','review')`,
    [digest.id, messageId])).rows[0];
  if (!item || new Date(item.received_at).getTime() !== Date.parse(receivedAt)) return false;
  return onlyOwnProjectMail(db, { spaceId: actor.space_id, runId: actor.run_id, ownerUserId: owner, projectId: digest.project_id });
}

/**
 * The host gate of `plugin.applications.mail_fact.list` (ADR 0034): the ledger of what the owner's mail
 * changed is the owner's alone. A person reads their own rows directly; an Agent only in a Run of the
 * owner's own private conversation of that Project whose whole audience is the owner
 * (`gmailDigestConversationAdmits` with `ownerOnly`), so the answer is never stored where anyone else reads
 * — a Room or the mainline, a delegated or shared Run, another conversation or Project.
 */
export async function gmailApplicationFactsAudienceAdmitted(db: Queryable, actor: Pick<OperationActor, "space_id" | "run_id" | "on_behalf_of_user_id" | "principal">, input: unknown): Promise<boolean> {
  const owner = actor.on_behalf_of_user_id;
  const projectId = (input as { project_id?: unknown } | null)?.project_id;
  if (!owner || typeof projectId !== "string") return false;
  if (actor.principal.kind === "user") return actor.principal.id === owner;
  if (actor.principal.kind !== "agent" || !actor.run_id) return false;
  const run = (await db.query<{ session_id: string | null }>(`SELECT session_id FROM runs WHERE id=$1 AND space_id=$2`, [actor.run_id, actor.space_id])).rows[0];
  if (!run?.session_id) return false;
  return !!await gmailDigestConversationAdmits(db, { spaceId: actor.space_id, ownerUserId: owner, projectId, sessionId: run.session_id, runId: actor.run_id, ownerOnly: true });
}

/** Inside an automation Run: keep one read message for the owner's review. Ids and a fixed reason only. */
export async function flagGmailApplicationMessage(db: Queryable, run: RunRecord, input: GmailApplicationUpdatesFlagInput) {
  const tool = GMAIL_APPLICATION_FLAG_ACTION;
  const owner = run.instructed_by_user_id;
  if (!owner || run.trigger_origin !== "automation") return refusal(tool, "gmail_digest_unavailable", "Only an automatic application-update Run keeps messages for review.");
  const stopped = refusal(tool, "gmail_digest_unavailable", "This automation cannot record anything any more. Say the check could not be completed.");
  return withQueryableTransaction(db, async (tx) => {
    // Held to what a fact is held to (`gmailApplicationFactAdmitted`): it runs on the frozen configuration for this
    // request's own launch (`lockedAutomationDelivery`), and the consent and owner-only audience still admit the Run.
    // A Run whose runtime reported a fallback to another model, or whose consent ended, keeps nothing more for review.
    const launchId = runToolRequest()?.launchId;
    const digest = await lockedAutomationDelivery(tx, { spaceId: run.space_id, ownerUserId: owner, runId: run.id, launchId, fallbackAtCommit: () => new FlagStoppedAtCommit() });
    const admitted = digest ? await gmailDigestRunAdmits(tx, { spaceId: run.space_id, ownerUserId: owner, runId: run.id }) : null;
    if (!digest || !admitted?.ok || admitted.grantId !== digest.grant_id) return stopped;
    if (!await releasedMessageDirection(tx, { spaceId: run.space_id, runId: run.id, launchId, messageId: input.message_id, frozen: digest.message_ids }))
      return refusal(tool, "gmail_digest_message_unknown", "Flag only a message id that source.gmail.digest.read returned to you since this Run last started.");
    const updated = await tx.query(`UPDATE gmail_digest_mail_items SET status='review',reason=$3,candidate_application_ids=$4::jsonb,updated_at=clock_timestamp()
        WHERE digest_id=$1 AND google_message_id=$2 AND status IN ('pending','review')`,
      [digest.id, input.message_id, input.reason, JSON.stringify([...new Set(input.candidate_application_ids ?? [])].slice(0, 5))]);
    if (!updated.rowCount) return refusal(tool, "gmail_digest_message_unknown", "This message was already settled.");
    return result(tool, { ok: true, message_id: input.message_id, status: "review" });
  }).catch((error: unknown) => { if (error instanceof FlagStoppedAtCommit) return stopped; throw error; });
}

/** A flag rolled back at its commit boundary by a fallback report received after its check (`lockedAutomationDelivery`). */
class FlagStoppedAtCommit extends Error {}

export function registerGmailApplicationUpdateTools(executors: Map<SystemActionId, SystemActionExecutor>, config: ServerConfig, run: RunRecord): void {
  const db = () => getDbPool(config.databaseUrl!);
  executors.set(PROPOSE as SystemActionId, async (input, context) =>
    proposeGmailApplicationUpdates(db(), config, run.id, run.space_id, input as GmailApplicationUpdatesProposeInput, context.idempotency_key ?? null));
  executors.set(LIST as SystemActionId, async () => listGmailApplicationUpdates(db(), run.id, run.space_id));
  executors.set(SET_STATUS as SystemActionId, async (input) => setGmailApplicationUpdatesStatus(db(), run.id, run.space_id, input as { digest_id: string; status: "paused" | "ended" }));
  executors.set(GMAIL_APPLICATION_FLAG_ACTION as SystemActionId, async (input) => flagGmailApplicationMessage(db(), run, input as GmailApplicationUpdatesFlagInput));
}

export { GMAIL_APPLICATION_FACT_ACTION };
