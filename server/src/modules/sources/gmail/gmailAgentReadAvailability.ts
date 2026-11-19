import type { Queryable } from "../../routeUtils/common.js";

/**
 * The ordinary conversations of a Project the person takes part in (ADR 0033 §6): their own private
 * conversation of the Project, or a Room conversation of it (a Room or the Project mainline). `s` is the
 * Session, `$2` the person. Whether they are in that Room's audience now is the scenario's rule
 * (`pluginDataEligibility`: the instructing person must be a reader), and whether every reader reads the
 * consent's Project is decided with the consent.
 */
export const GMAIL_PROJECT_CONVERSATION_SQL = `s.project_id IS NOT NULL AND s.status='active' AND (s.room_id IS NOT NULL OR s.user_id=$2)`;

/**
 * Where `source.gmail.mail.read` may be offered (ADR 0032/0033 §6), checked when the Run's snapshot is
 * built and again at every call:
 *
 * - the conversation is an ordinary conversation of a **Project** — the person's own private one, a Room
 *   or the Project mainline. The Agent reads in that conversation, on its own selected runtime, and answers
 *   its audience. A conversation outside every Project has nothing a consent could be bound to;
 * - the person has an active Gmail connection in this Space whose owner turned Agent reads on
 *   (`agent_read_enabled`).
 *
 * This only decides whether the tool exists for the Run. Reading still needs the owner's own `manual` turn,
 * their standing consent for this Project and that connection, and an audience inside that Project,
 * rechecked under lock at release.
 */
export async function gmailAgentReadAvailable(db: Queryable, input: { spaceId: string; userId: string; sessionId: string | null; runId?: string | null }): Promise<boolean> {
  if (!input.sessionId) return false;
  const row = (await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM sessions s WHERE s.id=$3 AND s.space_id=$1 AND ${GMAIL_PROJECT_CONVERSATION_SQL})
        AND EXISTS (SELECT 1 FROM gmail_connections c WHERE c.space_id=$1 AND c.owner_user_id=$2 AND c.status='active' AND c.agent_read_enabled) AS ok`,
    [input.spaceId, input.userId, input.sessionId],
  )).rows[0];
  return row?.ok === true;
}
