/**
 * Application updates enabled from a shared conversation of a Project — a Room or the mainline (ADR 0035 §1).
 *
 * The mailbox owner confirms the automation where the team works; the mail itself never enters that
 * conversation:
 *
 * - **Audience on the card.** The card names the conversation's current readers and says that everyone who
 *   later reads its history (a later Room member, or every later Project member for the mainline) reads what
 *   is posted there. Acceptance refuses a card whose conversation gained a reader since it was drafted.
 * - **Private execution.** The automation runs, as ADR 0034 states, in an owner-only conversation of the
 *   Project: the owner's private *execution conversation*, created (or reused) at acceptance with exactly the
 *   Agent binding chosen and frozen on the card (ADR 0036; every card, also one from the owner's private conversation). Mail text, the model's own report and the
 *   per-message outcomes stay there; every ADR 0034 check (owner-only audience, pinned and proven model,
 *   release, facts, flags, settlement) applies to it unchanged.
 * - **Structured results only.** When the automation records a fact on an application the Project reads
 *   (`project_shared`), the host keeps that structured result (`gmail_application_shared_results`); a fact on
 *   an application only the owner reads is never kept or mentioned. After a successful delivery the server
 *   posts notices in batches from the results not yet posted — application label, change, values; never
 *   subject, sender or text — into the shared conversation, while every reader of it reads the Project and only
 *   for applications the Project still reads at that moment; a result recorded by a delivery that then failed is
 *   posted by the next successful one of the same card into the same conversation, once, and never after the
 *   automation was re-carded (another Room, the mainline, other facts). Members read the records themselves through Applications' own
 *   permissions.
 *
 * Lock order is the digest writers' (`gmailDigests.ts`): Project → person → owner + Space mutex → connection →
 * digest → delivery → sessions, with Applications install and enablement locks
 * taken after person and before the Gmail mutex, as in the fact writer.
 */
import { randomUUID } from "node:crypto";
import type { GmailCardAudience, GmailDigestRuntimeBinding, OperationActor } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import type { Queryable } from "../../routeUtils/common.js";

/** The readers of a shared conversation as a card shows them (names capped; ids rechecked at acceptance). */
export async function gmailCardAudience(db: Queryable, input: { spaceId: string; sessionId: string; readers: readonly string[]; isMainline: boolean }): Promise<GmailCardAudience> {
  const room = (await db.query<{ title: string | null }>(
    `SELECT r.title FROM sessions s JOIN rooms r ON r.id=s.room_id AND r.space_id=s.space_id WHERE s.id=$1 AND s.space_id=$2`,
    [input.sessionId, input.spaceId])).rows[0];
  const names = (await db.query<{ display_name: string }>(
    `SELECT display_name FROM users WHERE id=ANY($1::varchar[]) ORDER BY display_name,id LIMIT 50`, [[...input.readers]])).rows.map((row) => row.display_name.slice(0, 200));
  return { kind: input.isMainline ? "mainline" : "room", room_title: room?.title?.slice(0, 512) ?? null, reader_user_ids: [...input.readers].sort(), reader_names: names };
}

/** The sentence a card adds about who reads what the shared conversation receives. */
export function gmailCardAudienceText(audience: GmailCardAudience): string {
  const where = audience.kind === "mainline" ? "the Project mainline" : `the Room${audience.room_title ? ` “${audience.room_title}”` : ""}`;
  const more = audience.reader_user_ids.length > audience.reader_names.length ? ` and ${audience.reader_user_ids.length - audience.reader_names.length} more` : "";
  const later = audience.kind === "mainline" ? "everyone who joins this Project later" : "everyone who joins this Room later";
  return `Posted in ${where}, read now by ${audience.reader_names.join(", ")}${more}, and by ${later} (they can read its history).`;
}

/**
 * Whether the shared conversation's readers now are among those the card showed. A reader added since the card
 * was drafted was never shown to the owner, so the card cannot be accepted (ADR 0035 §1); a reader who left is fine.
 */
export function gmailCardAudienceCovers(audience: GmailCardAudience | null | undefined, readers: readonly string[]): boolean {
  if (!audience) return false;
  const shown = new Set(audience.reader_user_ids);
  return readers.every((id) => shown.has(id));
}

const EXECUTION_TITLE = "Gmail application updates";
const EXECUTION_METADATA_KEY = "gmail_application_execution";

/**
 * The owner's private execution conversation of an automation (ADR 0035 §1; since ADR 0036 for every card, private or shared): an earlier
 * one of the same automation is reused, otherwise one is created. Its Agent binding is resolved as the owner's
 * own (`resolveBinding` with the card's runtime profile requested): the profile must be one the owner may use
 * in a private conversation of the Project — never a Host or login only the Room could reach — and the card's
 * session options are applied to it. The caller then checks the result is exactly what the card froze
 * (`applicationUpdateRuntimeMatches`); a reused conversation fixed to another runtime is replaced by a new one.
 * The Agent must be on the Project's list: a private conversation of the Project admits only such an Agent.
 */
export async function ensureApplicationExecutionConversation(db: Queryable, input: {
  spaceId: string; ownerUserId: string; projectId: string; agentId: string; binding: GmailDigestRuntimeBinding; reuseSessionId: string | null;
}): Promise<string> {
  const { PgProjectAgentRepository } = await import("../../projects/projectAgents.js");
  if (!await new PgProjectAgentRepository(db).projectUsesAgent({ spaceId: input.spaceId, projectId: input.projectId, agentId: input.agentId }))
    throw await applyConflict("gmail_digest_agent_not_in_project", "This Agent is not on the Project's Agent list, so it cannot run the automation in a private conversation of the Project. Add it to the Project, then confirm a new card.");
  const { PgConversationBackendRepository, ConversationBackendError } = await import("../../sessions/conversationBackendRepository.js");
  const backends = new PgConversationBackendRepository(db as never);
  const bind = async (sessionId: string): Promise<boolean> => {
    try {
      await backends.resolveBinding({ space_id: input.spaceId, user_id: input.ownerUserId, session_id: sessionId, agent_id: input.agentId, requested: { runtime_profile_id: input.binding.runtime_profile_id } });
    } catch (error) {
      if (error instanceof ConversationBackendError) return false;
      throw error;
    }
    await backends.saveSessionConfig(input.spaceId, sessionId, input.agentId, input.binding.session_config.map((option) => ({
      id: option.id, type: option.type, value: option.value, ...(option.category ? { category: option.category } : {}),
    })) as never);
    return true;
  };
  const reused = input.reuseSessionId
    ? (await db.query<{ id: string }>(
      `SELECT id FROM sessions WHERE id=$1 AND space_id=$2 AND user_id=$3 AND project_id=$4 AND room_id IS NULL AND status='active'
          AND metadata_json->>'${EXECUTION_METADATA_KEY}'='true' FOR UPDATE`,
      [input.reuseSessionId, input.spaceId, input.ownerUserId, input.projectId])).rows[0]?.id ?? null
    : null;
  if (reused && await bind(reused)) return reused;
  const { PgSessionRepository } = await import("../../sessions/repository.js");
  const created = await new PgSessionRepository(db as never).createSession(input.spaceId, input.ownerUserId, {
    projectId: input.projectId, title: EXECUTION_TITLE, metadata: { [EXECUTION_METADATA_KEY]: true },
  });
  if (!await bind(created.id))
    throw await applyConflict("gmail_digest_runtime_unavailable", "The runtime chosen on the card is not one you can use in your own private conversation of this Project (for example another member's Host), so your mail would leave your reach. Choose an Agent and model on your own runtime on the card, then accept.");
  return created.id;
}

/** A card that cannot be accepted as shown: 409 with a code, what the owner can do and any detail (the proposal apply error). */
export async function applyConflict(code: string, message: string, detail: Record<string, string> = {}): Promise<Error> {
  const { ProposalApplyHttpError } = await import("../../proposals/applyService.js");
  return new ProposalApplyHttpError(409, { ...detail, code, message });
}

interface FactResult {
  outcome?: unknown; replayed?: unknown; project_shared?: unknown; application_id?: unknown; effect?: unknown;
  id?: unknown; deadline_kind?: unknown; before?: unknown; after?: unknown; source_message_id?: unknown; institution?: unknown; program?: unknown;
}
const text = (value: unknown, max: number): string | null => typeof value === "string" ? value.slice(0, max) : null;

/**
 * After `plugin.phd_application.mail_fact.apply` (already admitted by `gmailApplicationFactAdmitted`), in the same
 * transaction: a fact recorded on an application the Project reads, by an automation enabled from a shared
 * conversation, is kept for the automation's next successful notice (this delivery's, or a later one's when this
 * delivery fails after the fact was committed), once per automation and fact. Nothing else is kept — a replay, an
 * unchanged value, a conflict, or any fact on an application only the owner reads.
 */
export async function recordGmailApplicationSharedResult(db: Queryable, actor: Pick<OperationActor, "space_id" | "run_id" | "on_behalf_of_user_id">, raw: unknown): Promise<void> {
  const fact = raw as FactResult | null;
  if (!fact || fact.outcome !== "recorded" || fact.replayed !== false || fact.project_shared !== true || !actor.run_id || !actor.on_behalf_of_user_id) return;
  const messageId = text(fact.source_message_id, 64), applicationId = text(fact.application_id, 64), effect = text(fact.effect, 32);
  const factId = text(fact.id, 36), deadlineKind = text(fact.deadline_kind, 32);
  if (!messageId || !applicationId || !effect || !factId || (effect === "deadline" && !deadlineKind)) return;
  // The destination and card it is recorded under: the automation's shared conversation and accepted card now, which
  // the Run was started for (its contract's rule version) — a Run of an earlier card records nothing here.
  const delivery = (await db.query<{ id: string; digest_id: string; project_id: string; notice_session_id: string; proposal_id: string }>(
    `SELECT dl.id,dl.digest_id,d.project_id,d.notice_session_id,d.proposal_id FROM gmail_digest_deliveries dl JOIN gmail_digests d ON d.id=dl.digest_id
       JOIN runs r ON r.id=dl.run_id AND r.space_id=d.space_id
      WHERE dl.run_id=$1 AND dl.status='running' AND d.space_id=$2 AND d.owner_user_id=$3 AND d.kind='application' AND d.notice_session_id IS NOT NULL
        AND (r.contract_snapshot_json #>> '{workflow_input_json,gmail_digest,rule_version}')=d.proposal_id`,
    [actor.run_id, actor.space_id, actor.on_behalf_of_user_id])).rows[0];
  if (!delivery) return;
  const label = `${text(fact.institution, 290) ?? ""} · ${text(fact.program, 290) ?? ""}`.slice(0, 600);
  await db.query(
    `INSERT INTO gmail_application_shared_results (id,digest_id,delivery_id,space_id,owner_user_id,project_id,google_message_id,application_id,application_label,effect,before_value,after_value,recorded_at,
       notice_session_id,rule_version,fact_id,deadline_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp(),$13,$14,$15,$16) ON CONFLICT DO NOTHING`,
    [randomUUID(), delivery.digest_id, delivery.id, actor.space_id, actor.on_behalf_of_user_id, delivery.project_id, messageId, applicationId, label, effect,
      text(fact.before, 64), text(fact.after, 64), delivery.notice_session_id, delivery.proposal_id, factId, deadlineKind]);
}

interface SharedResultRow { application_label: string; effect: string; deadline_kind: string | null; before_value: string | null; after_value: string | null }

/** One line per recorded result: the application, what changed, before and after. Never mail content. */
export function applicationNoticeText(ownerName: string, rows: readonly SharedResultRow[]): string {
  const lines = rows.map((row) => {
    const label = `- ${row.application_label}:`;
    if (row.effect === "contact") return `${label} ${row.after_value === "outbound" ? "email sent" : "email received"}`;
    if (row.effect === "deadline") return `${label} ${row.deadline_kind ? row.deadline_kind.replaceAll("_", " ") + " " : ""}deadline ${row.before_value ? `moved from ${row.before_value} to ${row.after_value}` : `added for ${row.after_value}`}`;
    return `${label} ${row.effect === "submission_received" ? "submission received" : `status ${row.after_value}`}${row.before_value && row.before_value !== row.after_value ? ` (was ${row.before_value})` : ""}`;
  });
  return [`Gmail application updates from ${ownerName}'s mailbox recorded:`, ...lines, "Mail text stays with the mailbox owner; see PhD Application for the records."].join("\n");
}

/** The Applications package's own table, resolved in its schema by the package role (as `applicationReadRelease.ts` does). */
const APPLICATIONS_TABLE = "applications";

/**
 * The applications among `ids` that the Project reads now — still existing in the Project and `project_shared` —
 * with their current label, read through the Applications package's own role (as its read release does). A
 * result kept when its fact was recorded says nothing about the application now: it may have been made private
 * or removed since. Null when the package cannot be read, so nothing is posted.
 */
async function currentlySharedApplications(db: Queryable, input: { spaceId: string; ownerUserId: string; projectId: string; ids: readonly string[] }): Promise<Map<string, string> | null> {
  const [{ operationTransaction }, { withPluginDb }] = await Promise.all([import("../../../db/operationTransaction.js"), import("../../plugins/operationDb.js")]);
  const transaction = operationTransaction(db);
  try {
    // Only the GUCs (Space, person) of the actor are used by the package role; the owner is the person.
    const actor = { space_id: input.spaceId, on_behalf_of_user_id: input.ownerUserId } as OperationActor;
    const rows = await withPluginDb(transaction.db, "phd_application", actor, async (pluginDb) => (await pluginDb.query<{ id: string; institution: string; program: string }>(
      `SELECT id,institution,program FROM ${APPLICATIONS_TABLE} WHERE space_id=current_setting('rainver.space_id') AND project_id=$1 AND id=ANY($2::text[]) AND project_shared ORDER BY id FOR SHARE`,
      [input.projectId, [...input.ids]])).rows);
    return new Map(rows.map((row) => [row.id, `${row.institution.slice(0, 290)} · ${row.program.slice(0, 290)}`.slice(0, 600)]));
  } catch {
    return null;
  } finally {
    transaction.close();
  }
}

/**
 * One bounded notice for a successful delivery, posted into the automation's shared conversation (the caller
 * holds the digest). It carries results through that delivery's settlement time under the same authorization —
 * this delivery's and any an earlier delivery of the same card recorded for the same conversation before it failed
 * (the fact was committed; its notice was not) — each once (`posted_at`, unique per automation and fact), so a
 * retry neither loses nor repeats one. A result recorded for another conversation or under another card of the
 * automation (it was re-carded since, e.g. to post into another Room) is deleted unposted: what the readers of one
 * conversation were allowed to see is never carried into another. Rechecked now, not when the fact was recorded:
 *
 * - **The conversation's readers** all read the Project (`gmailDigestConversationAdmits`, the digest rule, live and
 *   under the Session lock). Otherwise the results wait for another scheduler pass or successful settlement.
 * - **Applications** is still enabled for the owner and bound to the Project. The caller holds
 *   the plugin scope locks, and the binding stays locked through publication.
 * - **Each application** still exists in the Project and is still shared with it, and is named by its current
 *   label (`currentlySharedApplications`). A result whose application was made private or removed since is
 *   deleted unposted and never mentioned.
 *
 * Nothing is posted when nothing remains; the records keep their own permissions either way.
 */
export async function postGmailApplicationNotice(db: Queryable, config: ServerConfig, digest: {
  id: string; space_id: string; owner_user_id: string; project_id: string; proposal_id: string; notice_session_id: string | null; runtime_binding: GmailDigestRuntimeBinding | null;
}, deliveryId: string, finishedAt: Date | string, continuation = false): Promise<boolean> {
  // Recorded for another destination or card of this automation: never posted, here or anywhere.
  await db.query(`DELETE FROM gmail_application_shared_results WHERE digest_id=$1 AND posted_at IS NULL
      AND (notice_session_id IS DISTINCT FROM $2 OR rule_version IS DISTINCT FROM $3)`, [digest.id, digest.notice_session_id, digest.proposal_id]);
  if (!digest.notice_session_id) return false;
  const pending = (await db.query<{ id: string; application_id: string; effect: string; deadline_kind: string | null; before_value: string | null; after_value: string | null }>(
    `SELECT id,application_id,effect,deadline_kind,before_value,after_value FROM gmail_application_shared_results
      WHERE digest_id=$1 AND posted_at IS NULL AND notice_session_id=$2 AND rule_version=$3 AND recorded_at<=$4
      ORDER BY recorded_at,id LIMIT 50 FOR UPDATE`, [digest.id, digest.notice_session_id, digest.proposal_id, finishedAt])).rows;
  if (!pending.length) return false;
  const { gmailDigestConversationAdmits } = await import("./gmailDigests.js");
  if (!await gmailDigestConversationAdmits(db, { spaceId: digest.space_id, ownerUserId: digest.owner_user_id, projectId: digest.project_id, sessionId: digest.notice_session_id, lock: true })) return false;
  const { operationPluginEnabled } = await import("../../plugins/operationEnablement.js");
  const { isPluginProjectBound } = await import("../../plugins/projectBindings.js");
  if (!await operationPluginEnabled(db, "phd_application", digest.space_id, digest.owner_user_id, config)
    || !await isPluginProjectBound(db, "phd_application", digest.space_id, digest.project_id, true)) return false;
  const shared = await currentlySharedApplications(db, { spaceId: digest.space_id, ownerUserId: digest.owner_user_id, projectId: digest.project_id,
    ids: [...new Set(pending.map((row) => row.application_id))] });
  if (!shared) return false;
  const withdrawn = pending.filter((row) => !shared.has(row.application_id)).map((row) => row.id);
  if (withdrawn.length) await db.query(`DELETE FROM gmail_application_shared_results WHERE id=ANY($1::varchar[]) AND digest_id=$2 AND posted_at IS NULL`, [withdrawn, digest.id]);
  const rows = pending.filter((row) => shared.has(row.application_id));
  if (!rows.length) return withdrawn.length > 0;
  const owner = (await db.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id=$1`, [digest.owner_user_id])).rows[0]?.display_name ?? "the owner";
  const { PgSessionRepository } = await import("../../sessions/repository.js");
  const message = await new PgSessionRepository(db as never).addRoomConversationNotice(digest.space_id, digest.notice_session_id, {
    content: applicationNoticeText(owner, rows.map((row) => ({ ...row, application_label: shared.get(row.application_id)! }))),
    metadata: { execution_event: "gmail_application_updates", execution_event_key: continuation ? `${deliveryId}:${rows[0]!.id}` : deliveryId, execution_details: { digest_id: digest.id, delivery_id: deliveryId, results: rows.length } },
  });
  if (!message) return false;
  await db.query(`UPDATE gmail_application_shared_results SET posted_at=clock_timestamp(),posted_delivery_id=$3 WHERE id=ANY($1::varchar[]) AND digest_id=$2`,
    [rows.map((row) => row.id), digest.id, deliveryId]);
  return true;
}
