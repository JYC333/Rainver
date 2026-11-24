import type { GmailAgentReadGrant } from "@rainver/protocol";
import { projectReadAccessSql } from "../../access/contentAccessSql.js";
import { assertProjectReadableLocked, canReadProject } from "../../projects/access.js";
import { HttpError, type Queryable } from "../../routeUtils/common.js";
import { endPendingCoreConsentRequests } from "../../policy/consentRequestLifecycle.js";
import { GMAIL_PROJECT_CONVERSATION_SQL } from "./gmailAgentReadAvailability.js";

/**
 * The owner's standing consent for Agent mail reads (ADR 0033), stored as a
 * `plugin_data_grants` row of `project` scope for `core:gmail`:
 *
 * - **Bound** to the mailbox owner (grantor = data owner), one Project, one
 *   connection at the generation it had when the owner consented, and one
 *   purpose (`on_demand_read`). It has no time limit.
 * - **Used** by the owner's own turns in any ordinary conversation of that
 *   Project — their private conversation, a Room or the mainline — on the
 *   conversation's own runtime, answering that conversation's audience while
 *   every reader of it reads the Project (ADR 0033 §6). Never by another
 *   Project's conversation; the per-Run read bounds stay.
 * - **Ends** when the owner revokes it, turns Agent reads off, disconnects,
 *   reconnects or forgets the connection (`endGmailAgentReadGrants`, status
 *   `revoked`), and stops admitting as soon as the connection is not active,
 *   not opted in, has another generation or is gone — a new consent is then
 *   needed. The connection id is a snapshot: a forgotten connection's ended
 *   consents stay as the approval's evidence and match no live row.
 *
 * - **Follows the owner's current Project access**: admission, every physical
 *   Gmail send and the release require that the owner is an active person of
 *   the Space and still reads the Project (`LIVE_SQL`). Losing the Project
 *   ends the consent in the membership writer's own transaction
 *   (`endProjectDataConsents`), so being added back never revives it.
 *
 * There is no per-Run Gmail consent any more: an earlier one never admits.
 */
export const GMAIL_CONSENT_ID = "core:gmail";
export const GMAIL_AGENT_READ_PURPOSE = "on_demand_read" as const;

/**
 * Whether the owner's Project consent `g` (joined with its live connection `c`) still admits, for a
 * consent id and purpose: active, unexpired, given by the owner, the connection active, opted in and at
 * the bound generation, the owner an active person of the Space who still reads the Project. `$1` is the
 * Space and `$2` the owner. Shared by on-demand reads and scheduled digests (`gmailDigests.ts`).
 */
export function liveGmailConsentSql(consentId: string, purposeSql: string): string {
  return `g.space_id=$1 AND g.plugin_id='${consentId}' AND g.toolset='read' AND g.data_class='sensitive' AND g.scope='project'
  AND g.purpose ${purposeSql} AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>now())
  AND g.data_owner_user_id=$2 AND g.granted_by_user_id=$2
  AND c.status='active' AND c.agent_read_enabled AND c.generation=g.connection_generation
  AND EXISTS (SELECT 1 FROM users owner_user JOIN space_memberships owner_member ON owner_member.user_id=owner_user.id AND owner_member.space_id=g.space_id AND owner_member.status='active'
               WHERE owner_user.id=g.data_owner_user_id AND owner_user.status='active')
  AND ${projectReadAccessSql("g.space_id", "g.project_id", "g.data_owner_user_id")}`;
}
const LIVE_SQL = liveGmailConsentSql(GMAIL_CONSENT_ID, `='${GMAIL_AGENT_READ_PURPOSE}'`);

/** Every Gmail consent id: on-demand reads and scheduled digests. All of a connection's end together. */
export const GMAIL_CONSENT_IDS = [GMAIL_CONSENT_ID, "core:gmail_digest"] as const;

interface ConsentRow { id: string; connection_id: string; expanded_json: unknown }

/**
 * The owner's live consents for the Project of the Run's conversation, oldest
 * first; with `connectionId`, only that connection's. `lock` takes the consent
 * `FOR SHARE` (revocation takes it `FOR UPDATE`).
 */
export async function liveGmailAgentReadConsents(db: Queryable, input: {
  spaceId: string; ownerUserId: string; runId: string; connectionId?: string | null; lock?: boolean;
}): Promise<ConsentRow[]> {
  return (await db.query<ConsentRow>(
    `SELECT g.id,g.connection_id,g.expanded_json FROM plugin_data_grants g
       JOIN gmail_connections c ON c.id=g.connection_id AND c.space_id=g.space_id AND c.owner_user_id=g.data_owner_user_id
       JOIN runs r ON r.id=$3 AND r.space_id=g.space_id
      WHERE ${LIVE_SQL} AND ($4::varchar IS NULL OR g.connection_id=$4)
        -- Only a conversation of the consent's own Project: another Project's conversation never inherits it.
        AND (r.project_id IS NULL OR r.project_id=g.project_id)
        AND EXISTS (SELECT 1 FROM sessions s WHERE s.id=r.session_id AND s.space_id=r.space_id AND s.project_id=g.project_id AND ${GMAIL_PROJECT_CONVERSATION_SQL})
      ORDER BY g.created_at,g.id${input.lock ? " FOR SHARE OF g" : ""}`,
    [input.spaceId, input.ownerUserId, input.runId, input.connectionId ?? null],
  )).rows;
}

/** Whether a consent still admits a physical Gmail send now (checked before every send). */
export async function gmailAgentReadConsentLive(db: Queryable, input: { spaceId: string; ownerUserId: string; grantId: string; projectId?: string }): Promise<boolean> {
  return (await db.query(
    `SELECT 1 FROM plugin_data_grants g JOIN gmail_connections c ON c.id=g.connection_id AND c.space_id=g.space_id AND c.owner_user_id=g.data_owner_user_id
      WHERE ${LIVE_SQL} AND g.id=$3 AND ($4::text IS NULL OR g.project_id=$4)
      ${input.projectId ? "FOR SHARE OF c, g" : ""}`,
    [input.spaceId, input.ownerUserId, input.grantId, input.projectId ?? null],
  )).rows.length > 0;
}

/** A consent's Project, read without a lock, so a release can take the Project lock first. */
export async function gmailAgentReadConsentProject(db: Queryable, input: { spaceId: string; grantId: string }): Promise<string | null> {
  return (await db.query<{ project_id: string | null }>(`SELECT project_id FROM plugin_data_grants WHERE id=$1 AND space_id=$2 AND plugin_id='${GMAIL_CONSENT_ID}'`, [input.grantId, input.spaceId])).rows[0]?.project_id ?? null;
}

/**
 * The frozen part of a consent request (ADR 0033): what the owner is shown and what an approval writes.
 * `generation` is the connection's at the time of the request.
 */
export interface GmailAgentReadConsentBinding { ownerUserId: string; projectId: string; connectionId: string; generation: number; purpose: typeof GMAIL_AGENT_READ_PURPOSE }

/**
 * What a new consent from this Run's conversation binds: the Project of the
 * ordinary Project conversation the owner asked in (private, Room or
 * mainline), and the connection the refused call would have used, at its
 * current generation. Refused unless that connection is the owner's, active
 * and opted in, and every reader of the Run reads that Project: so no card is
 * offered, shown as approvable or approved for an audience outside it.
 */
export async function gmailAgentReadConsentTarget(db: Queryable, input: {
  spaceId: string; ownerUserId: string; runId: string; connectionId: string | null; lock?: boolean;
}): Promise<{ projectId: string; connectionId: string; generation: number }> {
  const session = (await db.query<{ project_id: string | null }>(
    `SELECT s.project_id FROM runs r JOIN sessions s ON s.id=r.session_id AND s.space_id=r.space_id
      WHERE r.id=$1 AND r.space_id=$2 AND (r.project_id IS NULL OR r.project_id=s.project_id) AND ${GMAIL_PROJECT_CONVERSATION_SQL.replaceAll("$2", "$3")}`,
    [input.runId, input.spaceId, input.ownerUserId],
  )).rows[0];
  if (!session?.project_id) throw new HttpError(409, "Gmail reading is allowed only in a conversation of a Project");
  // An approval holds the Project as its membership writer's counterpart (`lockProjectAudienceForChange`),
  // so a removal either commits first and is seen here, or waits and then ends what this writes.
  if (input.lock) {
    try { await assertProjectReadableLocked(db, input.spaceId, session.project_id, input.ownerUserId); } catch { throw new HttpError(403, "You no longer work in this Project"); }
  } else if (!await canReadProject(db, input.spaceId, session.project_id, input.ownerUserId)) throw new HttpError(403, "You no longer work in this Project");
  // Every reader of the Run — the conversation's audience, as the release gate counts it — reads that Project.
  // Otherwise no card is issued and an approval writes nothing: the card's projection, the request and the
  // approval all ask this same function (ADR 0033 §6). Imported when needed: `plugins/dataAccess` →
  // `coreDataTools` imports this module.
  const { audienceWithinProject, runAudience } = await import("../../plugins/dataAccess.js");
  const run = (await db.query<{ visibility: string; owner_user_id: string | null; session_id: string | null }>(
    `SELECT visibility,owner_user_id,session_id FROM runs WHERE id=$1 AND space_id=$2`, [input.runId, input.spaceId])).rows[0];
  const readers = run ? await runAudience(db, { spaceId: input.spaceId, visibility: run.visibility, ownerUserId: run.owner_user_id, sessionId: run.session_id, runId: input.runId }) : [];
  if (!readers.includes(input.ownerUserId) || !await audienceWithinProject(db, input.spaceId, session.project_id, readers)) {
    throw new HttpError(409, "Someone who reads this conversation does not work in its Project, so Gmail cannot be allowed here", { code: "gmail_agent_read_audience_outside_project" });
  }
  if (!input.connectionId) throw new HttpError(409, "Name the mailbox to allow; several of your Gmail connections allow Agent reads");
  const connection = (await db.query<{ generation: number }>(
    `SELECT generation FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND status='active' AND agent_read_enabled FOR SHARE`,
    [input.connectionId, input.spaceId, input.ownerUserId],
  )).rows[0];
  if (!connection) throw new HttpError(409, "This Gmail connection no longer allows Agent reads");
  return { projectId: session.project_id, connectionId: input.connectionId, generation: connection.generation };
}

/**
 * The connection row `FOR SHARE` for a consent approval, taken after the Run and before the request row and
 * deciding nothing (`gmailAgentReadConsentTarget` judges it later in the same transaction). Every writer that
 * ends consents and requests on a connection (opt-out, disconnect, reconnect, re-authorization, forget, the
 * refresh's reauth transition) holds it `FOR UPDATE` before it touches a consent or a request, so either
 * that writer commits first and the approval sees the change, or it waits until the approval commits and
 * then ends what the approval wrote. A vanished row locks nothing; the approval then refuses.
 */
export async function lockGmailConsentConnection(db: Queryable, input: { spaceId: string; ownerUserId: string; connectionId: string }): Promise<void> {
  await db.query(`SELECT id FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR SHARE`, [input.connectionId, input.spaceId, input.ownerUserId]);
}

/**
 * Ends every active consent on a connection (opt-out, disconnect, reconnect, re-authorization, forget) — on-demand
 * reads and digests alike, and with them the digests — and every pending request that would have written one, inside the caller's connection writer transaction.
 * History rows stay; an ended request is never approved later (`endPendingCoreConsentRequests`).
 */
export async function endGmailAgentReadGrants(db: Queryable, input: { spaceId: string; ownerUserId: string; connectionId: string }): Promise<void> {
  await db.query(
    `UPDATE plugin_data_grants SET status='revoked',revoked_at=now(),revoked_by_user_id=$2,updated_at=now()
      WHERE space_id=$1 AND data_owner_user_id=$2 AND connection_id=$3 AND plugin_id=ANY($4::varchar[]) AND status='active'`,
    [input.spaceId, input.ownerUserId, input.connectionId, [...GMAIL_CONSENT_IDS]],
  );
  // Their digests stop with them (a digest's authority is its consent); history stays.
  await db.query(`UPDATE gmail_digests SET status='ended',ended_at=now(),next_run_at=NULL,last_error_code='gmail_digest_consent_ended',updated_at=now()
      WHERE space_id=$1 AND owner_user_id=$2 AND gmail_connection_id=$3 AND status<>'ended'`, [input.spaceId, input.ownerUserId, input.connectionId]);
  await endPendingCoreConsentRequests(db, { spaceId: input.spaceId, ownerUserId: input.ownerUserId, connectionId: input.connectionId });
  // Read delegations of this mailbox end with them (ADR 0035 §4); nothing revives them.
  const { endGmailConnectionDelegations } = await import("./gmailDelegations.js");
  await endGmailConnectionDelegations(db, input);
}

/** The owner's active consents by connection, for the Gmail management card. Content-free. */
export async function listGmailAgentReadGrants(db: Queryable, identity: { spaceId: string; userId: string }): Promise<Map<string, GmailAgentReadGrant[]>> {
  const rows = (await db.query<{ id: string; connection_id: string; project_id: string; project_name: string | null; created_at: Date | string; last_used_at: Date | string | null }>(
    `SELECT g.id,g.connection_id,g.project_id,p.name AS project_name,g.created_at,
            (SELECT max(l.accessed_at) FROM agent_data_read_logs l WHERE l.space_id=g.space_id AND l.grant_id=g.id) AS last_used_at
       FROM plugin_data_grants g JOIN projects p ON p.id=g.project_id AND p.space_id=g.space_id
      WHERE g.space_id=$1 AND g.data_owner_user_id=$2 AND g.plugin_id='${GMAIL_CONSENT_ID}' AND g.purpose='${GMAIL_AGENT_READ_PURPOSE}' AND g.scope='project' AND g.status='active'
      ORDER BY g.created_at,g.id LIMIT 500`,
    [identity.spaceId, identity.userId],
  )).rows;
  const iso = (value: Date | string) => new Date(value).toISOString();
  const out = new Map<string, GmailAgentReadGrant[]>();
  for (const row of rows) {
    // The owner sees a Project's name only while they still read it.
    if (!await canReadProject(db, identity.spaceId, row.project_id, identity.userId)) row.project_name = null;
    const list = out.get(row.connection_id) ?? [];
    list.push({ grant_id: row.id, project_id: row.project_id, project_name: row.project_name, purpose: GMAIL_AGENT_READ_PURPOSE, created_at: iso(row.created_at), last_used_at: row.last_used_at ? iso(row.last_used_at) : null });
    out.set(row.connection_id, list);
  }
  return out;
}
