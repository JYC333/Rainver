import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { inheritContentAccessGrants } from "../access/contentAccessInheritance.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import {
  HttpError,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { assertProjectWriter } from "./access.js";
import { ProjectKernelService } from "./kernelService.js";

export interface ProjectDefinitionProposalActor {
  agentId?: string | null;
  runId?: string | null;
  idempotencyKey?: string | null;
  visibility?: "private" | "space_shared" | "selected_users";
  /**
   * Replaces the active Brief's decisions and source references, for a caller
   * that has computed them.
   *
   * Deliberately here and not in `body`: the same service backs the
   * agent-callable `project.propose_definition` action, whose input schema is
   * passthrough, so a body key would let an agent silently replace — or empty
   * — a Project's confirmed decisions as a side effect of proposing a goal.
   * An argument is reachable only from server code that meant to set it.
   */
  confirmedDecisions?: unknown[];
  sourceRefs?: unknown[];
}

const TEXT_FIELDS = [
  "scope_included",
  "scope_excluded",
  "success_definition",
  "constraints",
  "assumptions",
] as const;

/** Drafts a formal Project definition; the active Brief changes only on acceptance. */
export class ProjectDefinitionProposalService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): ProjectDefinitionProposalService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new ProjectDefinitionProposalService(getDbPool(config.databaseUrl));
  }

  async proposeDefinition(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
    actor: ProjectDefinitionProposalActor = {},
  ): Promise<{ proposal: Record<string, unknown> }> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const goal = requiredString(body.goal, "goal");
    if (actor.runId && actor.idempotencyKey) {
      const existing = await this.db.query<{ id: string; status: string }>(
        `SELECT id, status FROM proposals
          WHERE space_id=$1 AND created_by_run_id=$2
            AND proposal_type='project_brief_publish' AND action_idempotency_key=$3`,
        [identity.spaceId, actor.runId, actor.idempotencyKey],
      );
      if (existing.rows[0]) return { proposal: existing.rows[0] };
    }

    const active = await new ProjectKernelService(this.db).getActiveBriefVersion(identity, projectId);
    const definition: Record<string, unknown> = {
      goal,
      confirmed_decisions: actor.confirmedDecisions ?? active?.confirmed_decisions ?? [],
      workspace_identity: active?.workspace_identity ?? {},
      workspace_boundary: active?.workspace_boundary ?? {},
      source_refs: actor.sourceRefs ?? active?.source_refs ?? [],
    };
    for (const field of TEXT_FIELDS) {
      const supplied = optionalString(body[field]);
      const previous = optionalString(active?.[field]);
      if (supplied ?? previous) definition[field] = supplied ?? previous;
    }

    const payload = {
      proposal_type: "project_brief_publish",
      action_id: "project.propose_definition",
      project_id: projectId,
      ...definition,
    };
    const visibility = actor.visibility ?? "space_shared";
    const proposal = await withQueryableTransaction(this.db, async (db) => {
      if (actor.agentId) {
        // A Project has one current definition in flight at a time; a
        // retried or re-planned run must reuse it, not spawn a sibling.
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`project-definition-propose:${identity.spaceId}:${projectId}`],
        );
        const existing = await db.query<Record<string, unknown> & { id: string }>(
          `SELECT id, space_id, created_by_user_id, project_folder_id,
                  created_by_run_id, proposal_type, status, risk_level, urgency,
                  preview, title, payload_json, rationale, visibility,
                  review_deadline, expires_at, created_at, reviewed_at, project_id
             FROM proposals
            WHERE space_id=$1 AND project_id=$2 AND proposal_type='project_brief_publish'
              AND status='pending' AND created_by_agent_id=$3`,
          [identity.spaceId, projectId, actor.agentId],
        );
        if (existing.rows[0]) return existing.rows[0];
      }
      const inserted = await insertProposalRow(db, {
        spaceId: identity.spaceId,
        proposalType: "project_brief_publish",
        title: `Define Project: ${goal}`,
        payload,
        rationale: "Agent-drafted Project goal/core problem from a Room conversation, pending owner review.",
        createdByUserId: actor.agentId ? null : identity.userId,
        ownerUserId: identity.userId,
        createdByAgentId: actor.agentId ?? null,
        createdByRunId: actor.runId ?? null,
        actionIdempotencyKey: actor.idempotencyKey ?? null,
        projectId,
        visibility,
        riskLevel: "medium",
        requiredApproverRole: "owner",
      });
      if (visibility === "selected_users" && actor.runId) {
        await inheritContentAccessGrants(db, {
          spaceId: identity.spaceId,
          sourceResourceType: "run",
          sourceResourceId: actor.runId,
          targetResourceType: "proposal",
          targetResourceId: inserted.id,
          inheritedAt: new Date().toISOString(),
        });
      }
      return inserted;
    });
    return { proposal: proposal as unknown as Record<string, unknown> };
  }
}
