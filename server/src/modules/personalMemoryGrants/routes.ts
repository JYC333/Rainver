import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  dateIso,
  jsonBody,
  objectValue,
  optionalObject,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";

interface GrantRow {
  id: string;
  granting_user_id: string;
  personal_space_id: string;
  target_space_id: string;
  target_run_id: string;
  target_agent_id: string | null;
  grant_scope: string;
  access_mode: string;
  status: string;
  memory_filter_json: unknown;
  read_expires_at: unknown;
  revoked_at: unknown;
  used_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface GrantEventRow {
  id: string;
  grant_id: string;
  event_type: string;
  actor_user_id: string | null;
  run_id: string | null;
  metadata_json: unknown;
  created_at: unknown;
}

interface RunCheckRow {
  id: string;
  space_id: string;
  agent_id: string | null;
  instructed_by_user_id: string | null;
}

const GRANT_COLUMNS = `
  id, granting_user_id, personal_space_id, target_space_id, target_run_id,
  target_agent_id, grant_scope, access_mode, status, memory_filter_json,
  read_expires_at, revoked_at, used_at, created_at, updated_at
`;

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new GrantRepository(dbPool(context.config));

  app.post("/api/v1/personal-memory-grants/preview", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().preview(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/personal-memory-grants", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await repository().create(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/personal-memory-grants", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().list(identity, {
          status: optionalString(query(request).status),
          targetSpaceId: optionalString(query(request).target_space_id),
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/personal-memory-grants/:grantId/revoke", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().revoke(identity, params(request).grantId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/personal-memory-grants/:grantId/audit", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().audit(identity, params(request).grantId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

class GrantRepository {
  constructor(private readonly db: Queryable) {}

  async preview(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const targetSpaceId = requiredBodyString(body.target_space_id, "target_space_id");
    const targetRunId = requiredBodyString(body.target_run_id, "target_run_id");
    this.assertAccessMode(body.access_mode);
    const run = await this.requireEligibleRun(identity, targetSpaceId, targetRunId);
    const seconds = clampSeconds(body.read_expires_in_seconds, 3600);
    return {
      eligible: true,
      target_space_id: targetSpaceId,
      target_run_id: run.id,
      access_mode: "summary_only",
      proposed_read_expires_at: new Date(Date.now() + seconds * 1000).toISOString(),
      warnings: [],
      excluded_sensitivity_levels: ["secret"],
      max_items: maxItems(body.memory_filter),
    };
  }

  async create(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const targetSpaceId = requiredBodyString(body.target_space_id, "target_space_id");
    const targetRunId = requiredBodyString(body.target_run_id, "target_run_id");
    this.assertAccessMode(body.access_mode);
    const run = await this.requireEligibleRun(identity, targetSpaceId, targetRunId);
    const personalSpaceId = await this.personalSpaceId(identity.userId);
    if (!personalSpaceId) throw new HttpError(403, "Personal space not found for granting user");
    const now = new Date().toISOString();
    const readExpiresAt = new Date(Date.now() + clampSeconds(body.read_expires_in_seconds, 3600) * 1000).toISOString();
    const grantId = randomUUID();
    const inserted = await this.db.query<GrantRow>(
      `INSERT INTO personal_memory_grants (
         id, granting_user_id, personal_space_id, target_space_id, target_run_id,
         target_agent_id, grant_scope, access_mode, status, memory_filter_json,
         read_expires_at, egress_review_expires_at, consume_started_at,
         revoked_at, used_at, failed_at, failure_stage, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         NULL, 'run', 'summary_only', 'active', $6::jsonb,
         $7, NULL, NULL,
         NULL, NULL, NULL, NULL, $8, $8
       )
       RETURNING ${GRANT_COLUMNS}`,
      [
        grantId,
        identity.userId,
        personalSpaceId,
        targetSpaceId,
        run.id,
        JSON.stringify(optionalObject(body.memory_filter) ?? {}),
        readExpiresAt,
        now,
      ],
    );
    await this.insertEvent(grantId, "created", identity.userId, run.id, {
      target_space_id: targetSpaceId,
      max_items: maxItems(body.memory_filter),
    });
    return grantToOut(inserted.rows[0]!);
  }

  async list(
    identity: SpaceUserIdentity,
    filters: { status: string | null; targetSpaceId: string | null },
  ): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [identity.userId];
    const clauses = ["granting_user_id = $1"];
    if (filters.status) {
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filters.targetSpaceId) {
      params.push(filters.targetSpaceId);
      clauses.push(`target_space_id = $${params.length}`);
    }
    const rows = await this.db.query<GrantRow>(
      `SELECT ${GRANT_COLUMNS}
         FROM personal_memory_grants
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC`,
      params,
    );
    return rows.rows.map(grantToOut);
  }

  async revoke(identity: SpaceUserIdentity, grantId: string): Promise<Record<string, unknown>> {
    const current = await this.getOwned(identity, grantId);
    if (!current) throw new HttpError(404, "Personal memory grant not found");
    if (!["active", "consuming"].includes(current.status)) return grantToOut(current);
    const now = new Date().toISOString();
    const updated = await this.db.query<GrantRow>(
      `UPDATE personal_memory_grants
          SET status = 'revoked', revoked_at = $3, updated_at = $3
        WHERE id = $1 AND granting_user_id = $2
        RETURNING ${GRANT_COLUMNS}`,
      [grantId, identity.userId, now],
    );
    await this.insertEvent(grantId, "revoked", identity.userId, current.target_run_id, {});
    return grantToOut(updated.rows[0]!);
  }

  async audit(identity: SpaceUserIdentity, grantId: string): Promise<Record<string, unknown>> {
    const grant = await this.getOwned(identity, grantId);
    if (!grant) throw new HttpError(404, "Personal memory grant not found");
    const events = await this.db.query<GrantEventRow>(
      `SELECT id, grant_id, event_type, actor_user_id, run_id, metadata_json, created_at
         FROM personal_memory_grant_events
        WHERE grant_id = $1
        ORDER BY created_at ASC, id ASC`,
      [grantId],
    );
    return { grant: grantToOut(grant), events: events.rows.map(eventToOut) };
  }

  private async getOwned(identity: SpaceUserIdentity, grantId: string): Promise<GrantRow | null> {
    const result = await this.db.query<GrantRow>(
      `SELECT ${GRANT_COLUMNS}
         FROM personal_memory_grants
        WHERE id = $1 AND granting_user_id = $2
        LIMIT 1`,
      [grantId, identity.userId],
    );
    return result.rows[0] ?? null;
  }

  private async requireEligibleRun(
    identity: SpaceUserIdentity,
    targetSpaceId: string,
    targetRunId: string,
  ): Promise<RunCheckRow> {
    const membership = await this.db.query(
      `SELECT 1
         FROM space_memberships
        WHERE space_id = $1
          AND user_id = $2
          AND status = 'active'
        LIMIT 1`,
      [targetSpaceId, identity.userId],
    );
    if (membership.rows.length === 0) {
      throw new HttpError(403, "Granting user is not an active member of target_space_id");
    }
    const result = await this.db.query<RunCheckRow>(
      `SELECT id, space_id, agent_id, instructed_by_user_id
         FROM runs
        WHERE id = $1 AND space_id = $2
        LIMIT 1`,
      [targetRunId, targetSpaceId],
    );
    const run = result.rows[0];
    if (!run) throw new HttpError(404, "Target run not found");
    if (run.instructed_by_user_id !== identity.userId) {
      throw new HttpError(403, "Only the user who instructed this run can grant personal context");
    }
    return run;
  }

  private async personalSpaceId(userId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT s.id
         FROM spaces s
         JOIN space_memberships sm ON sm.space_id = s.id
        WHERE s.type = 'personal'
          AND sm.user_id = $1
          AND sm.status = 'active'
          AND sm.role = 'owner'
        ORDER BY s.created_at ASC
        LIMIT 1`,
      [userId],
    );
    return result.rows[0]?.id ?? null;
  }

  private assertAccessMode(value: unknown): void {
    if (value !== "summary_only") throw new HttpError(422, "access_mode must be summary_only");
  }

  private async insertEvent(
    grantId: string,
    eventType: string,
    actorUserId: string,
    runId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO personal_memory_grant_events (
         id, grant_id, event_type, actor_user_id, run_id, metadata_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [randomUUID(), grantId, eventType, actorUserId, runId, JSON.stringify(metadata), new Date().toISOString()],
    );
  }
}

function grantToOut(row: GrantRow): Record<string, unknown> {
  return {
    id: row.id,
    granting_user_id: row.granting_user_id,
    personal_space_id: row.personal_space_id,
    target_space_id: row.target_space_id,
    target_run_id: row.target_run_id,
    target_agent_id: row.target_agent_id,
    grant_scope: row.grant_scope,
    access_mode: row.access_mode,
    status: row.status,
    memory_filter_json: row.memory_filter_json === null ? null : objectValue(row.memory_filter_json),
    read_expires_at: dateIso(row.read_expires_at) ?? new Date(0).toISOString(),
    revoked_at: dateIso(row.revoked_at),
    used_at: dateIso(row.used_at),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function eventToOut(row: GrantEventRow): Record<string, unknown> {
  return {
    id: row.id,
    grant_id: row.grant_id,
    event_type: row.event_type,
    actor_user_id: row.actor_user_id,
    run_id: row.run_id,
    metadata_json: row.metadata_json === null ? null : objectValue(row.metadata_json),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function requiredBodyString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) throw new HttpError(422, `${field} is required`);
  return text;
}

function clampSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(60, Math.min(86_400, Math.trunc(parsed)));
}

function maxItems(value: unknown): number | null {
  const raw = optionalObject(value)?.max_items;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(50, Math.trunc(parsed)));
}
