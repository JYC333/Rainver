import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { HttpError, optionalString, requiredString } from "../routeUtils/common.js";
import { loadActionRegistry } from "./actionRegistry.js";
import { enforce } from "./service.js";

export class ActionApprovalGrantService {
  constructor(private readonly db: Queryable) {}

  async create(
    config: Pick<ServerConfig, "databaseUrl">,
    identity: { spaceId: string; userId: string },
    body: Record<string, unknown>,
    auditContext: Record<string, unknown> = {},
  ) {
    await this.assertOwner(identity);
    const agentId = requiredString(body.agent_id, "agent_id");
    const actionId = requiredString(body.action_id, "action_id");
    const { SYSTEM_ACTION_REGISTRY } = await import("@rainver/protocol");
    const definition = SYSTEM_ACTION_REGISTRY.find((item) => item.id === actionId);
    if (!definition) throw new HttpError(422, "Unknown system action");
    if (!definition.grantable) throw new HttpError(422, "This action cannot be pre-authorized");
    const projectId = optionalString(body.project_id);
    const targetRunId = optionalString(body.target_run_id);
    const resourceKind = optionalString(body.resource_kind);
    const resourceId = optionalString(body.resource_id);
    await this.assertScopedResource(identity.spaceId, agentId, projectId, targetRunId);
    const maxUses = body.max_uses == null ? null : Number(body.max_uses);
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) throw new HttpError(422, "max_uses must be a positive integer");
    const expiresAt = optionalString(body.expires_at);
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new HttpError(422, "expires_at must be an ISO datetime");
    const decision = await enforce(config, await loadActionRegistry(), {
      action: "policy.action_grant.create",
      actor_type: "user",
      actor_id: identity.userId,
      space_id: identity.spaceId,
      resource_type: "action_approval_grant",
      resource_id: null,
      force_record: true,
      metadata_json: auditContext,
    });
    if (decision.status !== "allow") {
      throw new HttpError(
        decision.status === "blocked" ? 403 : 503,
        decision.message ?? "Policy enforcement failed",
      );
    }
    const now = new Date().toISOString();
    // A grant that has already expired or run out of uses is still 'active' until
    // something touches it (there is no background sweep). Self-heal the exact
    // scope being requested so the owner can immediately replace a spent grant
    // instead of tripping the active-scope unique index below.
    await this.expireStaleGrant(identity.spaceId, agentId, actionId, targetRunId, projectId, resourceKind, resourceId, now);
    try {
      const result = await this.db.query(
        `INSERT INTO action_approval_grants
         (id, space_id, agent_id, action_id, target_run_id, project_id, resource_kind, resource_id,
          granted_by_user_id, status, expires_at, max_uses, use_count, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,0,$12)
         RETURNING *`,
        [randomUUID(), identity.spaceId, agentId, actionId, targetRunId, projectId, resourceKind, resourceId, identity.userId, expiresAt, maxUses, now],
      );
      return result.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HttpError(409, "An active grant already exists for this agent, action, and scope");
      }
      throw error;
    }
  }

  /** Flips a stale (expired or use-exhausted) active grant in the given exact scope to 'expired'. */
  private async expireStaleGrant(
    spaceId: string,
    agentId: string,
    actionId: string,
    targetRunId: string | null,
    projectId: string | null,
    resourceKind: string | null,
    resourceId: string | null,
    now: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE action_approval_grants
          SET status = 'expired'
        WHERE space_id = $1
          AND agent_id = $2
          AND action_id = $3
          AND coalesce(target_run_id, '') = coalesce($4, '')
          AND coalesce(project_id, '') = coalesce($5, '')
          AND coalesce(resource_kind, '') = coalesce($6, '')
          AND coalesce(resource_id, '') = coalesce($7, '')
          AND status = 'active'
          AND ((expires_at IS NOT NULL AND expires_at <= $8)
            OR (max_uses IS NOT NULL AND use_count >= max_uses))`,
      [spaceId, agentId, actionId, targetRunId, projectId, resourceKind, resourceId, now],
    );
  }

  async revoke(identity: { spaceId: string; userId: string }, grantId: string) {
    await this.assertOwner(identity);
    const result = await this.db.query(
      `UPDATE action_approval_grants SET status='revoked', revoked_at=$3
       WHERE id=$1 AND space_id=$2 AND status='active' RETURNING *`,
      [grantId, identity.spaceId, new Date().toISOString()],
    );
    if (!result.rows[0]) throw new HttpError(404, "Action approval grant not found");
    return result.rows[0];
  }

  /**
   * Atomically resolves and consumes one matching grant inside the caller
   * transaction. When several grants match (e.g. a resource-specific grant and
   * a broader project-wide or space-wide one), the most specific grant is
   * consumed first so broader standing grants are preserved for the cases
   * that actually need them.
   */
  async consumeMatching(input: { spaceId: string; agentId: string; actionId: string; runId?: string | null; projectId?: string | null; resourceKind?: string | null; resourceId?: string | null }) {
    const { SYSTEM_ACTION_REGISTRY } = await import("@rainver/protocol");
    const definition = SYSTEM_ACTION_REGISTRY.find((item) => item.id === input.actionId);
    if (!definition?.grantable) return null;
    const now = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE action_approval_grants g SET use_count=g.use_count+1, last_used_at=$8
       WHERE g.id=(SELECT id FROM action_approval_grants
        WHERE space_id=$1 AND agent_id=$2 AND action_id=$3 AND status='active'
          AND (expires_at IS NULL OR expires_at>$8)
          AND (max_uses IS NULL OR use_count<max_uses)
          AND (target_run_id IS NULL OR target_run_id=$4)
          AND (project_id IS NULL OR project_id=$5)
          AND (resource_kind IS NULL OR resource_kind=$6)
          AND (resource_id IS NULL OR resource_id=$7)
        ORDER BY
          (CASE WHEN target_run_id IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN resource_id IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN resource_kind IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN project_id IS NOT NULL THEN 1 ELSE 0 END) DESC,
          created_at ASC
        LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING g.*`,
      [input.spaceId, input.agentId, input.actionId, input.runId ?? null, input.projectId ?? null, input.resourceKind ?? null, input.resourceId ?? null, now],
    );
    return result.rows[0] ?? null;
  }

  /** Read-only invocation check; the owning proposal transaction consumes the grant. */
  async hasMatching(input: { spaceId: string; agentId: string; actionId: string; runId?: string | null; projectId?: string | null; resourceKind?: string | null; resourceId?: string | null }): Promise<boolean> {
    const { SYSTEM_ACTION_REGISTRY } = await import("@rainver/protocol");
    const definition = SYSTEM_ACTION_REGISTRY.find((item) => item.id === input.actionId);
    if (!definition?.grantable) return false;
    const result = await this.db.query(
      `SELECT 1 FROM action_approval_grants
        WHERE space_id=$1 AND agent_id=$2 AND action_id=$3 AND status='active'
          AND (expires_at IS NULL OR expires_at>$8)
          AND (max_uses IS NULL OR use_count<max_uses)
          AND (target_run_id IS NULL OR target_run_id=$4)
          AND (project_id IS NULL OR project_id=$5)
          AND (resource_kind IS NULL OR resource_kind=$6)
          AND (resource_id IS NULL OR resource_id=$7)
        LIMIT 1`,
      [input.spaceId, input.agentId, input.actionId, input.runId ?? null, input.projectId ?? null, input.resourceKind ?? null, input.resourceId ?? null, new Date().toISOString()],
    );
    return Boolean(result.rows[0]);
  }

  private async assertOwner(identity: { spaceId: string; userId: string }) {
    const row = await this.db.query(`SELECT 1 FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active' AND role='owner'`, [identity.spaceId, identity.userId]);
    if (!row.rows[0]) throw new HttpError(403, "Space owner access required");
  }

  private async assertScopedResource(spaceId: string, agentId: string, projectId: string | null, targetRunId: string | null) {
    const agent = await this.db.query(`SELECT 1 FROM agents WHERE id=$1 AND space_id=$2`, [agentId, spaceId]);
    if (!agent.rows[0]) throw new HttpError(404, "Agent not found");
    if (projectId) {
      const project = await this.db.query(`SELECT 1 FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL`, [projectId, spaceId]);
      if (!project.rows[0]) throw new HttpError(404, "Project not found");
    }
    if (targetRunId) {
      const run = await this.db.query(
        `SELECT 1 FROM runs
          WHERE id=$1 AND space_id=$2 AND agent_id=$3
          LIMIT 1`,
        [targetRunId, spaceId, agentId],
      );
      if (!run.rows[0]) throw new HttpError(404, "Target Run not found for this Agent");
    }
  }
}
