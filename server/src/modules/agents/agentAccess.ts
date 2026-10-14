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

/**
 * Who configures a managed Assistant — its soft settings and its Skill
 * overlays. There are three Assistants and three answers (plan decision 2):
 * the personal Space's Assistant is its person's; a shared Space's Assistant
 * is the Space creator's, by `spaces.created_by_user_id` and not by role, so
 * another owner/admin does not reconfigure what the creator set; a Project's
 * Assistant is the Project owner's, by `projects.owner_user_id`. Nothing
 * transfers or takes over this authority.
 */
export async function canConfigureAssistant(
  db: Queryable,
  identity: SpaceUserIdentity,
  target: { projectId: string | null },
): Promise<boolean> {
  if (target.projectId) {
    const project = await db.query<{ owner_user_id: string | null }>(
      `SELECT owner_user_id FROM projects
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL AND status = 'active'
        LIMIT 1`,
      [target.projectId, identity.spaceId],
    );
    const owner = project.rows[0]?.owner_user_id ?? null;
    return owner !== null && owner === identity.userId;
  }
  const space = await db.query<{ type: string; created_by_user_id: string | null; role: string | null }>(
    `SELECT s.type, s.created_by_user_id, m.role
       FROM spaces s
       LEFT JOIN space_memberships m
         ON m.space_id = s.id AND m.user_id = $2 AND m.status = 'active'
      WHERE s.id = $1
      LIMIT 1`,
    [identity.spaceId, identity.userId],
  );
  const row = space.rows[0];
  if (!row) return false;
  if (row.type === "personal") return row.role === "owner";
  return row.created_by_user_id !== null && row.created_by_user_id === identity.userId;
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
