import { randomUUID } from "node:crypto";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, dateIso, numberValue, objectValue, optionalString, requiredString } from "../routeUtils/common.js";
import { canAccessProject } from "../memory/projectAccess.js";
import { assertProjectWriter, lockActiveProjectForMutation } from "./access.js";
import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { projectSourceBindingOut } from "../sources/sourceRepositoryMappers.js";
import { PROJECT_SOURCE_BINDING_COLUMNS, type ProjectSourceBindingRow } from "../sources/sourceRepositoryRows.js";
import { recomputeProjectSourceBindingLinks } from "./projectSourceRoutingService.js";
import { defaultExtractionProfileRegistry } from "../extractionProfiles/registry.js";

const PROJECT_SOURCE_DELIVERY_SCOPES = new Set(["project_members", "source_subscribers"]);

type ConnectionRow = {
  id: string; owner_user_id: string; credential_id: string | null; visibility: string;
  handler_kind: string; connector_type: string | null; connector_key: string | null;
};

export class ProjectSourceBindingRepository {
  constructor(private readonly db: Queryable) {}

  async listProjectSourceBindings(identity: SpaceUserIdentity, filters: { projectId: string; sourceChannelId: string | null }) {
    if (!(await canAccessProject(this.db, identity.spaceId, filters.projectId, identity.userId))) {
      throw new HttpError(404, "Project not found");
    }
    const params: unknown[] = [identity.spaceId];
    const clauses = ["space_id = $1"];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filters.sourceChannelId) clauses.push(`source_channel_id = ${add(filters.sourceChannelId)}`);
    clauses.push(`project_id = ${add(filters.projectId)}`);
    clauses.push(`status <> 'archived'`);
    const rows = await this.db.query<ProjectSourceBindingRow>(
      `SELECT ${PROJECT_SOURCE_BINDING_COLUMNS}
         FROM project_source_bindings
        WHERE ${clauses.join(" AND ")}
        ORDER BY priority DESC, updated_at DESC, id DESC`,
      params,
    );
    return rows.rows.map(projectSourceBindingWithProfileOut);
  }

  async createProjectSourceBinding(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const sourceChannelId = requiredString(body.source_channel_id, "source_channel_id");
    const projectId = requiredString(body.project_id, "project_id");
    const connection = await this.getConnectionRow(identity, sourceChannelId);
    if (!connection || !(await this.canViewConnectionMetadata(identity, connection))) {
      throw new HttpError(404, "Source connection not found");
    }
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const deliveryScope = this.resolveProjectSourceDeliveryScope(identity, connection, body);
    const bindingKey = optionalString(body.binding_key) ?? "default";
    const now = new Date().toISOString();
    const existing = await this.db.query<ProjectSourceBindingRow>(
      `SELECT ${PROJECT_SOURCE_BINDING_COLUMNS}
         FROM project_source_bindings
        WHERE space_id = $1
          AND project_id = $2
          AND source_channel_id = $3
          AND binding_key = $4
        FOR UPDATE`,
      [identity.spaceId, projectId, sourceChannelId, bindingKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].status !== "archived") {
        throw new HttpError(409, "Source is already bound to this Project");
      }
      const restored = await this.db.query<ProjectSourceBindingRow>(
        `UPDATE project_source_bindings
            SET status = 'active',
                priority = $3::int,
                delivery_scope = $4,
                collection_notifications_enabled = $5::boolean,
                standing_comparison_enabled = $6::boolean,
                filters_json = $7::jsonb,
                routing_policy_json = $8::jsonb,
                extraction_policy_json = $9::jsonb,
                updated_at = $10
          WHERE space_id = $1 AND id = $2
          RETURNING ${PROJECT_SOURCE_BINDING_COLUMNS}`,
        [
          identity.spaceId,
          existing.rows[0].id,
          numberValue(body.priority) ?? 0,
          deliveryScope,
          booleanBody(body.collection_notifications_enabled, "collection_notifications_enabled", true),
          booleanBody(body.standing_comparison_enabled, "standing_comparison_enabled", false),
          JSON.stringify(objectValue(body.filters)),
          JSON.stringify(objectValue(body.routing_policy)),
          JSON.stringify(objectValue(body.extraction_policy)),
          now,
        ],
      );
      const out = projectSourceBindingWithProfileOut(restored.rows[0]!);
      if (!booleanBody(body.backfill_history, "backfill_history", false)) return out;
      return { ...out, backfill_result: await this.backfillProjectSourceBindingRow(identity, restored.rows[0]!) };
    }
    const result = await this.db.query<ProjectSourceBindingRow>(
      `INSERT INTO project_source_bindings (
         id, space_id, project_id, source_channel_id, binding_key,
         status, priority, delivery_scope, collection_notifications_enabled, standing_comparison_enabled,
         filters_json, routing_policy_json, extraction_policy_json,
         created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6::int, $7, $8::boolean, $9::boolean, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $14)
       RETURNING ${PROJECT_SOURCE_BINDING_COLUMNS}`,
      [
        randomUUID(),
        identity.spaceId,
        projectId,
        sourceChannelId,
        bindingKey,
        numberValue(body.priority) ?? 0,
        deliveryScope,
        booleanBody(body.collection_notifications_enabled, "collection_notifications_enabled", true),
        booleanBody(body.standing_comparison_enabled, "standing_comparison_enabled", false),
        JSON.stringify(objectValue(body.filters)),
        JSON.stringify(objectValue(body.routing_policy)),
        JSON.stringify(objectValue(body.extraction_policy)),
        identity.userId,
        now,
      ],
    );
    const row = result.rows[0]!;
    const out = projectSourceBindingWithProfileOut(row);
    if (!booleanBody(body.backfill_history, "backfill_history", false)) return out;
    return {
      ...out,
      backfill_result: await this.backfillProjectSourceBindingRow(identity, row),
    };
  }

  async updateProjectSourceBinding(identity: SpaceUserIdentity, bindingId: string, body: Record<string, unknown>) {
    const row = await this.getProjectSourceBindingRow(identity.spaceId, bindingId);
    if (!row) throw new HttpError(404, "Project source binding not found");
    await assertProjectWriter(this.db, identity.spaceId, row.project_id, identity.userId);
    await lockActiveProjectForMutation(this.db, identity.spaceId, row.project_id);
    const connection = await this.getConnectionRow(identity, row.source_channel_id);
    if (!connection) throw new HttpError(404, "Source connection not found");
    const status = optionalString(body.status) ?? row.status;
    if (!["active", "paused", "archived"].includes(status)) throw new HttpError(422, "invalid project source binding status");
    const deliveryScope = body.delivery_scope === undefined
      ? row.delivery_scope
      : this.resolveProjectSourceDeliveryScope(identity, connection, body);
    const now = new Date().toISOString();
    const updated = await this.db.query<ProjectSourceBindingRow>(
      `UPDATE project_source_bindings
          SET binding_key = $3,
              status = $4,
              priority = $5::int,
              delivery_scope = $6,
              collection_notifications_enabled = $7::boolean,
              standing_comparison_enabled = $8::boolean,
              filters_json = $9::jsonb,
              routing_policy_json = $10::jsonb,
              extraction_policy_json = $11::jsonb,
              updated_at = $12
        WHERE space_id = $1
          AND id = $2
        RETURNING ${PROJECT_SOURCE_BINDING_COLUMNS}`,
      [
        identity.spaceId,
        bindingId,
        optionalString(body.binding_key) ?? row.binding_key,
        status,
        numberValue(body.priority) ?? row.priority,
        deliveryScope,
        booleanBody(body.collection_notifications_enabled, "collection_notifications_enabled", row.collection_notifications_enabled),
        booleanBody(body.standing_comparison_enabled, "standing_comparison_enabled", row.standing_comparison_enabled),
        JSON.stringify(body.filters === undefined ? row.filters_json ?? {} : objectValue(body.filters)),
        JSON.stringify(body.routing_policy === undefined ? row.routing_policy_json ?? {} : objectValue(body.routing_policy)),
        JSON.stringify(body.extraction_policy === undefined ? row.extraction_policy_json ?? {} : objectValue(body.extraction_policy)),
        now,
      ],
    );
    const out = projectSourceBindingWithProfileOut(updated.rows[0]!);
    if (status === "active") {
      await this.backfillProjectSourceBindingRow(identity, updated.rows[0]!);
    } else {
      await this.archiveProjectSourceBindingLinks(identity.spaceId, bindingId, row.project_id);
    }
    return out;
  }

  async deleteProjectSourceBinding(identity: SpaceUserIdentity, bindingId: string) {
    const row = await this.getProjectSourceBindingRow(identity.spaceId, bindingId);
    if (!row) throw new HttpError(404, "Project source binding not found");
    await assertProjectWriter(this.db, identity.spaceId, row.project_id, identity.userId);
    await lockActiveProjectForMutation(this.db, identity.spaceId, row.project_id);
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE project_source_bindings
          SET status = 'archived',
              updated_at = $3
        WHERE space_id = $1
          AND id = $2`,
      [identity.spaceId, bindingId, now],
    );
    await this.archiveProjectSourceBindingLinks(identity.spaceId, bindingId, row.project_id);
    return { id: bindingId, status: "archived" };
  }

  async backfillProjectSourceBinding(identity: SpaceUserIdentity, bindingId: string) {
    const row = await this.getProjectSourceBindingRow(identity.spaceId, bindingId);
    if (!row) throw new HttpError(404, "Project source binding not found");
    await assertProjectWriter(this.db, identity.spaceId, row.project_id, identity.userId);
    await lockActiveProjectForMutation(this.db, identity.spaceId, row.project_id);
    return this.backfillProjectSourceBindingRow(identity, row);
  }

  private async getProjectSourceBindingRow(spaceId: string, bindingId: string): Promise<ProjectSourceBindingRow | null> {
    const rows = await this.db.query<ProjectSourceBindingRow>(
      `SELECT ${PROJECT_SOURCE_BINDING_COLUMNS}
         FROM project_source_bindings
        WHERE space_id = $1
          AND id = $2`,
      [spaceId, bindingId],
    );
    return rows.rows[0] ?? null;
  }

  private async backfillProjectSourceBindingRow(
    identity: SpaceUserIdentity,
    row: ProjectSourceBindingRow,
  ): Promise<Record<string, unknown>> {
    if (row.status !== "active") {
      throw new HttpError(422, "Only active project source bindings can backfill history");
    }
    const result = await recomputeProjectSourceBindingLinks(this.db, {
      spaceId: identity.spaceId,
      bindingId: row.id,
    });
    return {
      binding_id: row.id,
      project_id: row.project_id,
      source_channel_id: row.source_channel_id,
      ...result,
    };
  }

  async projectSourceHealth(identity: SpaceUserIdentity, projectId: string) {
    if (!(await canAccessProject(this.db, identity.spaceId, projectId, identity.userId))) {
      throw new HttpError(404, "Project not found");
    }
    const rows = await this.db.query<{
      binding_id: string;
      project_id: string;
      source_channel_id: string;
      source_name: string;
      binding_status: string;
      connection_status: string;
      scheduler_status: string | null;
      next_run_at: unknown;
      last_run_at: unknown;
      last_success_at: unknown;
      last_failure_at: unknown;
      last_error: string | null;
      queued_jobs: string;
      running_jobs: string;
      recent_new_items: string;
      consecutive_failures: string;
    }>(
      `WITH last_success AS (
         SELECT DISTINCT ON (space_id, connection_id) space_id, connection_id, completed_at
           FROM extraction_jobs
          WHERE space_id = $1 AND connection_id IS NOT NULL AND status = 'succeeded'
          ORDER BY space_id, connection_id, completed_at DESC NULLS LAST, created_at DESC
       ),
       last_failure AS (
         SELECT DISTINCT ON (space_id, connection_id) space_id, connection_id, completed_at, error_message
           FROM extraction_jobs
          WHERE space_id = $1 AND connection_id IS NOT NULL AND status = 'failed'
          ORDER BY space_id, connection_id, completed_at DESC NULLS LAST, created_at DESC
       )
       SELECT psb.id AS binding_id,
              psb.project_id,
              psb.source_channel_id,
              sch.name AS source_name,
              psb.status AS binding_status,
              sc.status AS connection_status,
              st.status AS scheduler_status,
              st.next_run_at,
              st.last_run_at,
              ls.completed_at AS last_success_at,
              lf.completed_at AS last_failure_at,
              lf.error_message AS last_error,
              (SELECT count(*)::text FROM extraction_jobs ej WHERE ej.space_id = psb.space_id AND ej.connection_id = sc.id AND ej.metadata_json->>'source_channel_id' = psb.source_channel_id AND ej.status = 'pending') AS queued_jobs,
              (SELECT count(*)::text FROM extraction_jobs ej WHERE ej.space_id = psb.space_id AND ej.connection_id = sc.id AND ej.metadata_json->>'source_channel_id' = psb.source_channel_id AND ej.status = 'running') AS running_jobs,
              (SELECT count(*)::text FROM project_source_item_links psil WHERE psil.space_id = psb.space_id AND psil.project_source_binding_id = psb.id AND psil.status = 'active' AND psil.matched_at >= now() - interval '24 hours') AS recent_new_items,
              (SELECT count(*)::text
                 FROM extraction_jobs failed
                WHERE failed.space_id = psb.space_id
                  AND failed.connection_id = sc.id
                  AND failed.metadata_json->>'source_channel_id' = psb.source_channel_id
                  AND failed.status = 'failed'
                  AND (ls.completed_at IS NULL OR failed.completed_at > ls.completed_at)) AS consecutive_failures
         FROM project_source_bindings psb
         JOIN source_channels sch
           ON sch.space_id = psb.space_id
          AND sch.id = psb.source_channel_id
         JOIN source_connections sc
           ON sc.space_id = sch.space_id
          AND sc.id = sch.source_connection_id
          AND sc.deleted_at IS NULL
         LEFT JOIN scheduler_tasks st
           ON st.space_id = psb.space_id
          AND st.task_type = 'source_channel_scan'
          AND st.task_key = psb.source_channel_id
         LEFT JOIN last_success ls
           ON ls.space_id = psb.space_id
          AND ls.connection_id = sc.id
         LEFT JOIN last_failure lf
           ON lf.space_id = psb.space_id
          AND lf.connection_id = sc.id
        WHERE psb.space_id = $1
          AND psb.project_id = $2
          AND psb.status <> 'archived'
        ORDER BY psb.priority DESC, psb.updated_at DESC`,
      [identity.spaceId, projectId],
    );
    return rows.rows.map((row) => {
      const queuedJobs = Number(row.queued_jobs) || 0;
      const runningJobs = Number(row.running_jobs) || 0;
      const consecutiveFailures = Number(row.consecutive_failures) || 0;
      const lastFailureAt = dateIso(row.last_failure_at);
      const lastSuccessAt = dateIso(row.last_success_at);
      const hasCurrentFailure = Boolean(lastFailureAt && (!lastSuccessAt || lastFailureAt > lastSuccessAt));
      let status = "healthy";
      if (row.binding_status === "paused" || row.connection_status === "paused" || row.scheduler_status === "paused") {
        status = "paused";
      } else if (runningJobs > 0 || queuedJobs > 0) {
        status = "running";
      } else if (consecutiveFailures >= 3) {
        status = "failing";
      } else if (hasCurrentFailure) {
        status = "attention";
      }
      return {
        binding_id: row.binding_id,
        project_id: row.project_id,
        source_channel_id: row.source_channel_id,
        source_name: row.source_name,
        status,
        last_success_at: lastSuccessAt,
        last_failure_at: lastFailureAt,
        last_error: hasCurrentFailure ? row.last_error : null,
        next_run_at: dateIso(row.next_run_at),
        queued_jobs: queuedJobs,
        running_jobs: runningJobs,
        recent_new_items: Number(row.recent_new_items) || 0,
        consecutive_failures: consecutiveFailures,
      };
    });
  }

  private async archiveProjectSourceBindingLinks(spaceId: string, bindingId: string, projectId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `WITH archived_links AS (
         UPDATE project_source_item_links
            SET status = 'archived',
                updated_at = $4
          WHERE space_id = $1
            AND project_source_binding_id = $2
            AND project_id = $3
            AND status <> 'archived'
          RETURNING source_item_id
       )
       UPDATE evidence_links el
          SET status = 'archived',
              updated_at = $4
        WHERE el.space_id = $1
          AND el.target_type = 'project'
          AND el.target_id = $3
          AND el.status = 'active'
          AND el.reason = 'project_source_binding:' || $2
          AND EXISTS (
            SELECT 1
              FROM extracted_evidence ev
              JOIN archived_links al ON al.source_item_id = ev.source_item_id
             WHERE ev.space_id = el.space_id
               AND ev.id = el.evidence_id
          )`,
      [spaceId, bindingId, projectId, now],
    );
  }

  private async getConnectionRow(identity: SpaceUserIdentity, connectionId: string): Promise<ConnectionRow | null> {
    const result = await this.db.query<ConnectionRow>(
      `SELECT sc.id, sc.owner_user_id, sc.credential_id, sc.visibility, sc.handler_kind,
              c.connector_type, c.connector_key
         FROM source_channels ch
         JOIN source_connections sc ON sc.id = ch.source_connection_id
         JOIN source_provider_connectors spc ON spc.id = sc.provider_connector_id
         JOIN source_connectors c ON c.id = spc.connector_id
        WHERE ch.space_id = $1 AND ch.id = $2 AND ch.status <> 'archived' AND sc.deleted_at IS NULL`,
      [identity.spaceId, connectionId],
    );
    return result.rows[0] ?? null;
  }

  private async canViewConnectionMetadata(identity: SpaceUserIdentity, connection: ConnectionRow): Promise<boolean> {
    return (await contentDecisionFromDb(this.db, identity, "source_connection", connection.id)) !== "deny";
  }

  private resolveProjectSourceDeliveryScope(identity: SpaceUserIdentity, connection: ConnectionRow, body: Record<string, unknown>): string {
    const requested = optionalString(body.delivery_scope);
    if (requested && !PROJECT_SOURCE_DELIVERY_SCOPES.has(requested)) throw new HttpError(422, "delivery_scope must be project_members or source_subscribers");
    const restricted = connection.visibility !== "space_shared" || Boolean(connection.credential_id) ||
      connection.handler_kind === "generated_custom" || connection.connector_type === "custom" || connection.connector_key === "custom";
    const scope = requested ?? (restricted ? "source_subscribers" : "project_members");
    if (scope === "project_members" && restricted && connection.owner_user_id !== identity.userId) {
      throw new HttpError(403, "Only the source owner can share a private or credentialed source with project members");
    }
    return scope;
  }
}

function projectSourceBindingWithProfileOut(row: ProjectSourceBindingRow) {
  const out = projectSourceBindingOut(row);
  const policy = out.extraction_policy_json as Record<string, unknown>;
  const profileKey = typeof policy.profile_key === "string" ? policy.profile_key : null;
  const profile = profileKey ? defaultExtractionProfileRegistry.get(profileKey) : null;
  return {
    ...out,
    extraction_profile: profile ? {
      key: profile.key,
      display_name: profile.displayName,
      entity_type: profile.entityType,
      graph_lens_id: profile.graphLensId ?? null,
    } : null,
  };
}

function booleanBody(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new HttpError(422, `${field} must be a boolean`);
  return value;
}
