import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, objectValue, requiredString, withQueryableTransaction } from "../routeUtils/common.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import type { ProposalRow } from "../proposals/repository.js";
import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { ProjectOperationService } from "../projects/projectOperationService.js";
import { PgProposalApplyService } from "../proposals/applyService.js";
import {
  assertSupportedStrategy,
  normalizeQuota,
  normalizeStrategy,
  planSegments,
  resolveStrategyBounds,
  type BackfillQuotaPolicy,
  type BackfillSegmentWindow,
  type BackfillStrategy,
} from "./sourceBackfillStrategy.js";

export interface BackfillPreview {
  strategy: BackfillStrategy;
  segments: BackfillSegmentWindow[];
  quota_policy: BackfillQuotaPolicy;
}

interface BackfillActor {
  agentId?: string | null;
  runId?: string | null;
  idempotencyKey?: string | null;
  projectId?: string | null;
}

export class SourceBackfillPlanningService {
  constructor(
    private readonly db: Queryable,
    private readonly config?: ServerConfig,
  ) {}

  async preview(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>): Promise<BackfillPreview> {
    const connectorKey = await this.assertReadable(identity, connectionId);
    const strategy = resolveStrategyBounds(normalizeStrategy(body));
    assertSupportedStrategy(connectorKey, strategy);
    return { strategy, segments: planSegments(strategy), quota_policy: normalizeQuota(body.quota_policy) };
  }

  async create(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    const connectorKey = await this.assertManage(identity, connectionId);
    const strategy = resolveStrategyBounds(normalizeStrategy(body));
    const quotaPolicy = normalizeQuota(body.quota_policy);
    assertSupportedStrategy(connectorKey, strategy);
    const plannedSegments = planSegments(strategy);
    const key = requiredString(body.idempotency_key, "idempotency_key");
    return withQueryableTransaction(this.db, (db) =>
      new SourceBackfillPlanningService(db, this.config).createLocked(identity, connectionId, body, key, {
        strategy,
        segments: plannedSegments,
        quota_policy: quotaPolicy,
      }),
    );
  }

  async proposeStart(identity: SpaceUserIdentity, connectionId: string, planId: string, actor: BackfillActor = {}) {
    await this.assertManage(identity, connectionId);
    if (actor.projectId) await this.assertPlanInProject(identity.spaceId, connectionId, planId, actor.projectId);

    const reused = await this.reuseProposalByRunIdempotencyKey(identity.spaceId, actor);
    if (reused) return reused;

    const proposal = await withQueryableTransaction(this.db, (db) =>
      this.createBackfillStartProposalLocked(db, identity, connectionId, planId, actor),
    );

    const autoApplied = actor.agentId && this.config && proposal.status === "pending"
      ? await PgProposalApplyService.fromConfig(this.config).acceptAgentProposalIfGranted(proposal.id, {
          actionId: "source.backfill.propose_start",
          projectId: actor.projectId ?? null,
          resourceKind: "source_backfill_plan",
          resourceId: planId,
        })
      : null;
    return { proposal: autoApplied?.proposal ?? proposal, auto_applied: Boolean(autoApplied) };
  }

  async list(identity: SpaceUserIdentity, connectionId: string) {
    await this.assertReadable(identity, connectionId);
    const rows = await this.db.query(
      `SELECT * FROM source_backfill_plans WHERE space_id=$1 AND source_channel_id=$2 ORDER BY created_at DESC`,
      [identity.spaceId, connectionId],
    );
    return rows.rows;
  }

  async get(identity: SpaceUserIdentity, connectionId: string, planId: string) {
    await this.assertReadable(identity, connectionId);
    return this.details(identity.spaceId, connectionId, planId);
  }

  async setPaused(identity: SpaceUserIdentity, connectionId: string, planId: string, paused: boolean) {
    await this.assertManage(identity, connectionId);
    await this.plan(identity.spaceId, connectionId, planId);
    const status = paused ? "paused" : "approved";
    const row = await this.db.query(
      `UPDATE source_backfill_plans
          SET status=$4, next_eligible_at=NULL, updated_at=$5
        WHERE id=$1 AND space_id=$2 AND source_channel_id=$3 AND status IN ('approved','running','paused')
        RETURNING *`,
      [planId, identity.spaceId, connectionId, status, new Date().toISOString()],
    );
    if (!row.rows[0]) throw new HttpError(409, "Plan cannot change pause state");
    return row.rows[0];
  }

  private async connection(spaceId: string, id: string): Promise<{ connector_key: string; source_connection_id: string }> {
    const r = await this.db.query<{ connector_key: string; source_connection_id: string }>(
      `SELECT c.connector_key, sc.id AS source_connection_id
         FROM source_channels ch
         JOIN source_connections sc ON sc.id=ch.source_connection_id
         JOIN source_provider_connectors spc ON spc.id=sc.provider_connector_id
         JOIN source_connectors c ON c.id=spc.connector_id
        WHERE ch.id=$1 AND ch.space_id=$2 AND ch.status <> 'archived' AND sc.deleted_at IS NULL`,
      [id, spaceId],
    );
    if (!r.rows[0]) throw new HttpError(404, "Source connection not found");
    return r.rows[0];
  }

  private async assertReadable(identity: SpaceUserIdentity, id: string): Promise<string> {
    const channel = await this.connection(identity.spaceId, id);
    if ((await contentDecisionFromDb(this.db, identity, "source_connection", channel.source_connection_id)) === "deny") {
      throw new HttpError(404, "Source connection not found");
    }
    return channel.connector_key;
  }

  private async assertManage(identity: SpaceUserIdentity, id: string): Promise<string> {
    const channel = await this.connection(identity.spaceId, id);
    if ((await contentDecisionFromDb(this.db, identity, "source_connection", channel.source_connection_id)) === "deny") {
      throw new HttpError(404, "Source connection not found");
    }
    const r = await this.db.query(
      `SELECT 1 FROM source_channels ch
        JOIN source_connections sc ON sc.id=ch.source_connection_id
        WHERE ch.id=$1 AND ch.space_id=$2 AND ch.status <> 'archived'
          AND (sc.owner_user_id=$3
               OR EXISTS(SELECT 1 FROM space_memberships sm WHERE sm.space_id=$2 AND sm.user_id=$3 AND sm.status='active' AND sm.role IN ('owner','admin')))`,
      [id, identity.spaceId, identity.userId],
    );
    if (!r.rows[0]) throw new HttpError(403, "Source owner or space admin access required");
    return channel.connector_key;
  }

  private async plan(spaceId: string, connectionId: string, id: string): Promise<Record<string, unknown>> {
    const r = await this.db.query(
      `SELECT * FROM source_backfill_plans WHERE id=$1 AND space_id=$2 AND source_channel_id=$3`,
      [id, spaceId, connectionId],
    );
    if (!r.rows[0]) throw new HttpError(404, "Backfill plan not found");
    return r.rows[0];
  }

  private async details(spaceId: string, connectionId: string, planId: string): Promise<Record<string, unknown>> {
    const plan = await this.plan(spaceId, connectionId, planId);
    const segments = await this.db.query(
      `SELECT * FROM source_backfill_segments WHERE plan_id=$1 AND space_id=$2 ORDER BY seq`,
      [planId, spaceId],
    );
    return { ...plan, segments: segments.rows };
  }

  private async assertPlanInProject(spaceId: string, connectionId: string, planId: string, projectId: string): Promise<void> {
    const scoped = await this.db.query(
      `SELECT 1
         FROM source_backfill_plans p LEFT JOIN project_source_bindings b ON b.id=p.project_source_binding_id AND b.space_id=p.space_id
         LEFT JOIN project_operations o ON o.id=p.project_operation_id AND o.space_id=p.space_id
        WHERE p.id=$1 AND p.space_id=$2 AND p.source_channel_id=$3
          AND (b.project_id=$4 OR o.project_id=$4)
          AND (b.project_id IS NULL OR b.project_id=$4)
          AND (o.project_id IS NULL OR o.project_id=$4)`,
      [planId, spaceId, connectionId, projectId],
    );
    if (!scoped.rows[0]) throw new HttpError(404, "Backfill plan not found in this Project");
  }

  private async reuseProposalByRunIdempotencyKey(spaceId: string, actor: BackfillActor) {
    if (!actor.runId || !actor.idempotencyKey) return null;
    const existing = await this.db.query<{ id: string; status: string }>(
      `SELECT * FROM proposals WHERE space_id=$1 AND created_by_run_id=$2 AND proposal_type='source_backfill_start' AND action_idempotency_key=$3`,
      [spaceId, actor.runId, actor.idempotencyKey],
    );
    if (!existing.rows[0]) return null;
    return { proposal: existing.rows[0], auto_applied: existing.rows[0].status === "accepted" };
  }

  private async createBackfillStartProposalLocked(
    db: Queryable,
    identity: SpaceUserIdentity,
    connectionId: string,
    planId: string,
    actor: BackfillActor,
  ) {
    const planRow = await db.query<{ status: string; proposal_id: string | null; strategy_json: unknown; quota_policy_json: unknown }>(
      `SELECT * FROM source_backfill_plans WHERE id=$1 AND space_id=$2 AND source_channel_id=$3 FOR UPDATE`,
      [planId, identity.spaceId, connectionId],
    );
    const plan = planRow.rows[0];
    if (!plan) throw new HttpError(404, "Backfill plan not found");
    if (plan.status === "proposed" && plan.proposal_id) {
      const existing = await db.query<ProposalRow>(`SELECT * FROM proposals WHERE id=$1 AND space_id=$2`, [plan.proposal_id, identity.spaceId]);
      if (existing.rows[0]) return existing.rows[0];
    }
    if (plan.status !== "draft") throw new HttpError(409, "Only draft plans can be proposed");

    const created = await insertProposalRow(db, {
      spaceId: identity.spaceId,
      proposalType: "source_backfill_start",
      title: "Start Source history import",
      payload: {
        proposal_type: "source_backfill_start",
        action_id: "source.backfill.propose_start",
        source_channel_id: connectionId,
        source_backfill_plan_id: planId,
        ...(actor.projectId ? { project_id: actor.projectId } : {}),
        strategy_json: plan.strategy_json,
        quota_policy_json: plan.quota_policy_json,
        ...(actor.idempotencyKey ? { idempotency_key: actor.idempotencyKey } : {}),
      },
      rationale: objectValue(plan.strategy_json).history_mode === "all_available"
        ? "Run a quota-controlled import across all available arXiv history."
        : "Run a bounded, quota-controlled history import.",
      createdByUserId: actor.agentId ? null : identity.userId,
      createdByAgentId: actor.agentId ?? null,
      createdByRunId: actor.runId ?? null,
      actionIdempotencyKey: actor.idempotencyKey ?? null,
      projectId: actor.projectId ?? null,
      visibility: "space_shared",
      riskLevel: "high",
      requiredApproverRole: "owner",
    });
    await db.query(
      `UPDATE source_backfill_plans SET status='proposed', proposal_id=$4, origin=$5, updated_at=$6 WHERE id=$1 AND space_id=$2 AND source_channel_id=$3`,
      [planId, identity.spaceId, connectionId, created.id, actor.agentId ? "agent_proposal" : "user", new Date().toISOString()],
    );
    return created;
  }

  private async createLocked(
    identity: SpaceUserIdentity,
    connectionId: string,
    body: Record<string, unknown>,
    key: string,
    preview: BackfillPreview,
  ) {
    const { bindingId, operationId, operationProjectId, operationKind, operationMaxItems } = await this.resolveProjectScope(identity, connectionId, body);
    const researchOperation = operationKind === "research";
    const strategy = researchOperation
      ? { ...preview.strategy, max_items: operationMaxItems! }
      : preview.strategy;
    const segments = researchOperation ? planSegments(strategy) : preview.segments;
    const persistedStrategy = researchOperation
      ? Object.fromEntries(Object.entries(strategy).filter(([key]) => key !== "max_items"))
      : strategy;

    const id = randomUUID();
    const now = new Date().toISOString();
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO source_backfill_plans (
         id, space_id, source_channel_id, project_source_binding_id, project_operation_id,
         requested_by_user_id, origin, strategy_json, quota_policy_json, status,
         segments_total, segments_completed, segments_failed, items_ingested,
         idempotency_key, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'user',$7::jsonb,$8::jsonb,'draft',$9,0,0,0,$10,$11,$11)
       ON CONFLICT (space_id,idempotency_key) DO NOTHING
       RETURNING id`,
      [
        id,
        identity.spaceId,
        connectionId,
        bindingId,
        operationId,
        identity.userId,
        JSON.stringify(persistedStrategy),
        JSON.stringify(preview.quota_policy),
        segments.length,
        key,
        now,
      ],
    );
    if (!inserted.rows[0]) return this.reuseIdempotentPlan(identity.spaceId, connectionId, key);

    for (let i = 0; i < segments.length; i++) {
      await this.db.query(
        `INSERT INTO source_backfill_segments (id, plan_id, space_id, seq, window_json, status, attempt_count, items_ingested)
         VALUES ($1,$2,$3,$4,$5::jsonb,'pending',0,0)`,
        [randomUUID(), id, identity.spaceId, i, JSON.stringify(segments[i])],
      );
    }
    if (operationId && operationProjectId) {
      await new ProjectOperationService(this.db).link(identity.spaceId, operationProjectId, operationId, "source_backfill_plan", id, "backfill_plan");
    }
    return this.details(identity.spaceId, connectionId, id);
  }

  private async resolveProjectScope(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    const bindingId = typeof body.project_source_binding_id === "string" ? body.project_source_binding_id : null;
    const operationId = typeof body.project_operation_id === "string" ? body.project_operation_id : null;

    let bindingProjectId: string | null = null;
    if (bindingId) {
      const binding = await this.db.query<{ project_id: string }>(
        `SELECT project_id FROM project_source_bindings WHERE id=$1 AND space_id=$2 AND source_channel_id=$3`,
        [bindingId, identity.spaceId, connectionId],
      );
      if (!binding.rows[0]) throw new HttpError(404, "Project source binding not found");
      bindingProjectId = binding.rows[0].project_id;
    }

    let operationProjectId: string | null = null;
    let operationKind: string | null = null;
    let operationMaxItems: number | null = null;
    if (operationId) {
      const operation = await this.db.query<{ project_id: string; kind: string; max_items: number | null }>(
        `SELECT project_id, kind, (progress_json->'history'->>'max_items')::int AS max_items
           FROM project_operations
          WHERE id=$1 AND space_id=$2
          FOR UPDATE`,
        [operationId, identity.spaceId],
      );
      if (!operation.rows[0]) throw new HttpError(404, "Project operation not found");
      operationProjectId = operation.rows[0].project_id;
      operationKind = operation.rows[0].kind;
      operationMaxItems = operation.rows[0].max_items;
      if (bindingProjectId && bindingProjectId !== operationProjectId) {
        throw new HttpError(422, "Project operation and source binding must belong to the same project");
      }
      if (!bindingId) {
        const projectBinding = await this.db.query(
          `SELECT 1 FROM project_source_bindings WHERE project_id=$1 AND space_id=$2 AND source_channel_id=$3 AND status='active'`,
          [operationProjectId, identity.spaceId, connectionId],
        );
        if (!projectBinding.rows[0]) throw new HttpError(422, "Project operation requires an active binding to this source connection");
      }
      if (operationKind === "research" && (!operationMaxItems || operationMaxItems < 1)) {
        throw new HttpError(409, "Project Research operation has no valid item budget");
      }
    }

    return { bindingId, operationId, bindingProjectId, operationProjectId, operationKind, operationMaxItems };
  }

  private async reuseIdempotentPlan(spaceId: string, connectionId: string, key: string) {
    const existing = await this.db.query<{ id: string; source_channel_id: string }>(
      `SELECT id, source_channel_id FROM source_backfill_plans WHERE space_id=$1 AND idempotency_key=$2`,
      [spaceId, key],
    );
    if (!existing.rows[0]) throw new Error("Backfill plan idempotency conflict could not be resolved");
    if (existing.rows[0].source_channel_id !== connectionId) {
      throw new HttpError(409, "idempotency_key is already used by another source connection");
    }
    return this.details(spaceId, connectionId, existing.rows[0].id);
  }
}
