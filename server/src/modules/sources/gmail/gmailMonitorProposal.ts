/**
 * `source.gmail.monitor.propose` — the one Gmail Agent tool. An Agent turns
 * what the person said ("tell me when the admissions office replies") into a
 * fixed-field monitor draft; it never reads mail and gets no Gmail data back.
 *
 * Scenario (ADR 0030 decision 4, the personal/sensitive-write row, from one
 * pure check on the stored Run): the Run is a person's own turn (`manual`
 * root, not delegated, not a continuation or unattended wake), and its
 * audience is that person alone (`runAudience`: a mainline Room is every
 * Project reader, a limited Room its roster). A monitor says what someone
 * waits for, so a shared conversation must not carry it. Otherwise the tool
 * refuses with a fixed code and writes nothing.
 *
 * Output: a private `gmail_monitor_create` proposal (visibility `private`,
 * owner = that person, no Project on the row — a Project is only the
 * monitor's context label in the payload). Only the owner can accept it
 * (`registerGmailMonitorProposalApplier`). The tool result carries the
 * proposal id and status, not the criteria.
 */
import {
  GmailMonitorCriteriaSchema, type GmailMonitorProposeInput, type SystemActionId,
} from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { lockActivePerson } from "../../access/activePerson.js";
import { runAudience, scenarioOrigin } from "../../plugins/dataAccess.js";
import { canReadProject } from "../../projects/access.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import { withQueryableTransaction, type Queryable } from "../../routeUtils/common.js";
import type { RunRecord } from "../../runs/repository.js";
import { effectiveRunTrigger } from "../../systemActions/effectiveRunTrigger.js";
import type { SystemActionExecutor } from "../../systemActions/gateway.js";
import { lockGmailOwnerSpace } from "./gmailConnections.js";

const TOOL = "source.gmail.monitor.propose" as const;

interface StoredRun {
  id: string; space_id: string; agent_id: string | null; project_id: string | null; visibility: string; owner_user_id: string | null;
  session_id: string | null; trigger_origin: string; delegation_id: string | null; instructed_by_agent_id: string | null;
  instructed_by_user_id: string | null; parent_run_id: string | null;
}

export type GmailMonitorProposalRefusal =
  | "gmail_monitor_private_turn_required" | "gmail_not_connected" | "gmail_monitor_mailbox_ambiguous" | "gmail_monitor_criteria_invalid";

const refusal = (code: GmailMonitorProposalRefusal, message: string) => ({
  modelResult: { ok: false, error: code, message },
  summary: { tool_name: TOOL, ok: false, error: code },
});

/** The stored Run's live scenario: the person's own turn and an audience of that person alone. */
export async function gmailMonitorScenarioAllowed(db: Queryable, run: StoredRun): Promise<boolean> {
  const person = run.instructed_by_user_id;
  if (!person) return false;
  const effective = await effectiveRunTrigger(db, run);
  if (scenarioOrigin(run, effective.origin) !== "manual" || effective.instructedByUserId !== person) return false;
  const audience = await runAudience(db, { spaceId: run.space_id, visibility: run.visibility, ownerUserId: run.owner_user_id, sessionId: run.session_id, runId: run.id });
  return audience.length === 1 && audience[0] === person;
}

const PRIVATE_TURN_MESSAGE = "A Gmail monitor can only be drafted in the mailbox owner's own conversation that nobody else can read, in their own turn. Ask them to continue in a private conversation.";
const RUN_COLUMNS = `id,space_id,agent_id,project_id,visibility,owner_user_id,session_id,trigger_origin,delegation_id,instructed_by_agent_id,
            instructed_by_user_id,parent_run_id`;

/**
 * The scenario check, the replay lookup and the insert share one transaction
 * behind the owner's person lock and owner + Space mutex: two concurrent calls
 * with one key cannot both insert, and an audience or membership change that
 * commits first is what the check sees. The unlocked read only finds whose
 * locks to take.
 */
export async function proposeGmailMonitor(db: Queryable, runId: string, spaceId: string, input: GmailMonitorProposeInput, idempotencyKey: string | null) {
  const owner = (await db.query<{ instructed_by_user_id: string | null }>(
    `SELECT instructed_by_user_id FROM runs WHERE id=$1 AND space_id=$2`, [runId, spaceId])).rows[0]?.instructed_by_user_id ?? null;
  if (!owner) return refusal("gmail_monitor_private_turn_required", PRIVATE_TURN_MESSAGE);
  const criteria = GmailMonitorCriteriaSchema.safeParse({ from_any: input.from_any ?? [], subject_any: input.subject_any ?? [], label_any: input.label_any ?? [] });
  return withQueryableTransaction(db, async (tx) => {
    try { await lockActivePerson(tx, spaceId, owner); } catch { return refusal("gmail_monitor_private_turn_required", "The mailbox owner is no longer an active member here."); }
    await lockGmailOwnerSpace(tx, { spaceId, userId: owner });
    const run = (await tx.query<StoredRun>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE`, [runId, spaceId])).rows[0];
    if (!run || run.instructed_by_user_id !== owner || !(await gmailMonitorScenarioAllowed(tx, run))) return refusal("gmail_monitor_private_turn_required", PRIVATE_TURN_MESSAGE);
    if (idempotencyKey) {
      const existing = (await tx.query<{ id: string; status: string }>(
        `SELECT id,status FROM proposals WHERE space_id=$1 AND created_by_run_id=$2 AND proposal_type='gmail_monitor_create' AND action_idempotency_key=$3`,
        [spaceId, run.id, idempotencyKey])).rows[0];
      if (existing) return accepted(existing.id, existing.status);
    }
    if (!criteria.success) return refusal("gmail_monitor_criteria_invalid", "Give at least one sender, subject phrase or label.");
    const connections = (await tx.query<{ id: string; mailbox_email: string }>(
      `SELECT id,mailbox_email FROM gmail_connections WHERE space_id=$1 AND owner_user_id=$2 AND status='active' ORDER BY connected_at FOR SHARE`,
      [spaceId, owner])).rows;
    const chosen = input.mailbox_email ? connections.filter((row) => row.mailbox_email.toLowerCase() === input.mailbox_email) : connections;
    if (!connections.length || (input.mailbox_email && !chosen.length)) {
      return refusal("gmail_not_connected", "This person has no active Gmail connection here. They connect Gmail once under Sources → Access and Gmail.");
    }
    if (chosen.length > 1) {
      // The audience is the owner alone, so naming their own mailboxes back to them is safe.
      return { ...refusal("gmail_monitor_mailbox_ambiguous", "Ask which mailbox, then pass mailbox_email."), modelResult: { ok: false, error: "gmail_monitor_mailbox_ambiguous", mailboxes: chosen.map((row) => row.mailbox_email) } };
    }
    const connection = chosen[0]!;
    const projectId = run.project_id && await canReadProject(tx, spaceId, run.project_id, owner) ? run.project_id : null;
    const proposal = await insertProposalRow(tx, {
      spaceId, proposalType: "gmail_monitor_create",
      title: "Gmail new-mail monitor", summary: input.purpose.trim(),
      rationale: "Drafted from the mailbox owner's request. The server matches new mail against these fields and reminds only the owner, without subject or text. No Agent reads the mail.",
      payload: { proposal_type: "gmail_monitor_create", action_id: TOOL, connection_id: connection.id, purpose: input.purpose.trim(), criteria: criteria.data, target_project_id: projectId },
      createdByUserId: null, createdByAgentId: run.agent_id, createdByRunId: run.id, ownerUserId: owner,
      visibility: "private", riskLevel: "medium", projectId: null, actionIdempotencyKey: idempotencyKey,
    });
    return accepted(proposal.id, proposal.status);
  });
}

function accepted(proposalId: string, status: string) {
  return {
    modelResult: {
      ok: true, proposal_id: proposalId, status,
      next_step: "Nothing is monitored yet. The mailbox owner accepts or declines this draft (Sources → Access and Gmail, or by telling you to accept it). You will not see any mail; matches reach only the owner as a private reminder.",
    },
    // Run evidence stays content-free: no proposal id (the draft is found by its Run and call key).
    summary: { tool_name: TOOL, ok: true },
  };
}

export function registerGmailMonitorTools(executors: Map<SystemActionId, SystemActionExecutor>, config: ServerConfig, run: RunRecord): void {
  executors.set(TOOL as SystemActionId, async (input, context) =>
    proposeGmailMonitor(getDbPool(config.databaseUrl!), run.id, run.space_id, input as GmailMonitorProposeInput, context.idempotency_key ?? null));
}
