import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { contentDecisionFromDb, contentOwnerFromDb } from "../access/contentAccessQuery.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";

/**
 * Who may change an Agent — its identity, config, versions and runtime
 * profiles. Its owner may. An unowned Agent is a system-managed one the whole
 * Space runs on (Project Research, source annotation, source post-processing,
 * daily capture reports):
 * reading it is not standing to reconfigure it for everyone, so the Space's
 * owner or admin may. The Assistant is never changed through these paths: its
 * runtime profiles follow its Project's write boundary
 * (`PgAgentRepository.canWriteRuntimeProfiles`).
 */
export async function canChangeAgent(
  db: Queryable,
  identity: SpaceUserIdentity,
  agentId: string,
): Promise<boolean> {
  const found = await db.query<{ owner_user_id: string | null; agent_kind: string }>(
    `SELECT owner_user_id, agent_kind FROM agents WHERE space_id = $1 AND id = $2 LIMIT 1`,
    [identity.spaceId, agentId],
  );
  const agent = found.rows[0];
  if (!agent || agent.agent_kind === "system_assistant") return false;
  if (agent.owner_user_id !== null) return contentOwnerFromDb(db, identity, "agent", agentId);
  const membership = await db.query<{ role: string }>(
    `SELECT role FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active'
      LIMIT 1`,
    [identity.spaceId, identity.userId],
  );
  return isSpaceOwnerOrAdmin(membership.rows[0]?.role);
}

/** The one gate on every Agent mutation; refuses as "not found". */
export async function assertAgentOwner(
  db: Queryable,
  identity: SpaceUserIdentity,
  agentId: string,
): Promise<void> {
  if (!(await canChangeAgent(db, identity, agentId))) throw new HttpError(404, "Agent not found");
}

/** Whether this person can read the Agent at all — the floor for pointing work at it. */
export async function canReadAgent(
  db: Queryable,
  identity: SpaceUserIdentity,
  agentId: string,
): Promise<boolean> {
  return (await contentDecisionFromDb(db, identity, "agent", agentId)) !== "deny";
}
