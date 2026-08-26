import { randomUUID } from "node:crypto";
import { isContentVisibility, type ContentVisibility } from "../access/contentAccessTypes.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";

const DISCLOSURE_TTL_MS = 15 * 60 * 1000;

export interface DemotionExposure {
  readers: Array<{
    user_id: string;
    display_name: string;
    access_count: number;
    last_accessed_at: string;
    link: string;
  }>;
  consuming_runs: Array<{
    run_id: string;
    title: string;
    status: string;
    link: string;
  }>;
  shared_derived_outputs: Array<{
    resource_type: "artifact" | "proposal";
    id: string;
    title: string;
    visibility: string;
    link: string;
  }>;
}

export interface DemotionDisclosure {
  confirmation_id: string;
  expires_at: string;
  resource_type: string;
  resource_id: string;
  target_visibility: ContentVisibility;
  exposure: DemotionExposure;
}

export class ContentDemotionService {
  constructor(private readonly db: Queryable) {}

  async disclose(
    identity: SpaceUserIdentity,
    resourceType: string,
    resourceId: string,
    targetVisibility: ContentVisibility,
  ): Promise<DemotionDisclosure> {
    const currentVisibility = await this.requireOwner(identity, resourceType, resourceId);
    if (!narrowsVisibility(currentVisibility, targetVisibility)) {
      throw new HttpError(422, "Demotion target must be narrower than current visibility");
    }
    const exposure = await this.loadExposure(
      identity.spaceId,
      identity.userId,
      resourceType,
      resourceId,
    );
    const confirmationId = randomUUID();
    const expiresAt = new Date(Date.now() + DISCLOSURE_TTL_MS).toISOString();
    await this.db.query(
      `INSERT INTO content_demotion_disclosures (
         id, space_id, resource_type, resource_id, owner_user_id,
         target_visibility, exposure_snapshot_json, disclosed_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),$8)`,
      [confirmationId, identity.spaceId, resourceType, resourceId,
        identity.userId, targetVisibility, JSON.stringify(exposure), expiresAt],
    );
    return {
      confirmation_id: confirmationId,
      expires_at: expiresAt,
      resource_type: resourceType,
      resource_id: resourceId,
      target_visibility: targetVisibility,
      exposure,
    };
  }

  async validate(
    db: Queryable,
    identity: SpaceUserIdentity,
    resourceType: string,
    resourceId: string,
    targetVisibility: ContentVisibility,
    confirmationId: string | null | undefined,
  ): Promise<void> {
    if (!confirmationId) {
      throw new HttpError(409, "Demotion requires exposure disclosure", { code: "demotion_disclosure_required" });
    }
    const result = await db.query<{
      exposure_snapshot_json: unknown;
      expires_at: Date | string;
      consumed_at: Date | string | null;
    }>(
      `SELECT exposure_snapshot_json, expires_at, consumed_at
         FROM content_demotion_disclosures
        WHERE id = $1 AND space_id = $2 AND resource_type = $3
          AND resource_id = $4 AND owner_user_id = $5 AND target_visibility = $6
        FOR UPDATE`,
      [confirmationId, identity.spaceId, resourceType, resourceId,
        identity.userId, targetVisibility],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Demotion disclosure not found");
    if (row.consumed_at) throw new HttpError(409, "Demotion disclosure already consumed");
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new HttpError(409, "Demotion disclosure expired");
    }
    const current = await this.loadExposure(
      identity.spaceId,
      identity.userId,
      resourceType,
      resourceId,
      db,
    );
    if (stableJson(row.exposure_snapshot_json) !== stableJson(current)) {
      throw new HttpError(409, "Exposure changed; review demotion again", { code: "demotion_exposure_changed" });
    }
  }

  async consume(db: Queryable, confirmationId: string): Promise<void> {
    await db.query(
      `UPDATE content_demotion_disclosures SET consumed_at = now() WHERE id = $1`,
      [confirmationId],
    );
  }

  private async requireOwner(
    identity: SpaceUserIdentity,
    resourceType: string,
    resourceId: string,
  ): Promise<ContentVisibility> {
    const definition = contentResourceDefinition(resourceType);
    if (!definition) throw new HttpError(404, "Content type not found");
    const alias = "demoted_resource";
    const active = definition.activePredicate?.(alias) ?? "true";
    const result = await this.db.query<{ visibility: string }>(
      `SELECT ${alias}.visibility FROM ${definition.tableName} ${alias}
        WHERE ${alias}.space_id = $1 AND ${alias}.id = $2
          AND ${active} AND ${alias}.${definition.ownerColumn} = $3
        LIMIT 1`,
      [identity.spaceId, resourceId, identity.userId],
    );
    const visibility = result.rows[0]?.visibility;
    if (!isContentVisibility(visibility)) throw new HttpError(404, "Content not found");
    return visibility;
  }

  private async loadExposure(
    spaceId: string,
    ownerUserId: string,
    resourceType: string,
    resourceId: string,
    db: Queryable = this.db,
  ): Promise<DemotionExposure> {
    const readers = await db.query<{
      user_id: string;
      display_name: string;
      access_count: string | number;
      last_accessed_at: Date | string;
    }>(
      `SELECT l.viewer_user_id AS user_id, u.display_name,
              count(*)::text AS access_count, max(l.accessed_at) AS last_accessed_at
         FROM content_access_logs l
         JOIN users u ON u.id = l.viewer_user_id
        WHERE l.space_id = $1 AND l.resource_type = $2 AND l.resource_id = $3
          AND l.owner_user_id = $4
        GROUP BY l.viewer_user_id, u.display_name
        ORDER BY u.display_name, l.viewer_user_id`,
      [spaceId, resourceType, resourceId, ownerUserId],
    );
    const contextTypes = await this.contextItemTypes(db, spaceId, resourceType, resourceId);
    const runs = await db.query<{
      run_id: string;
      title: string;
      status: string;
    }>(
      `SELECT DISTINCT r.id AS run_id,
              COALESCE(NULLIF(r.instruction, ''), NULLIF(r.prompt, ''), 'Run ' || left(r.id, 8)) AS title,
              r.status
         FROM invocation_snapshots snapshot
         JOIN runs r ON r.id = snapshot.invocation_id AND r.space_id = snapshot.space_id
        WHERE snapshot.space_id = $1
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements(snapshot.safe_snapshot_json->'source_refs') AS source_ref
             WHERE source_ref->>'id' = $2
               AND source_ref->>'type' = ANY($3::varchar[])
          )
        ORDER BY title, r.id`,
      [spaceId, resourceId, contextTypes],
    );
    const runIds = runs.rows.map((row) => row.run_id);
    const outputs = runIds.length === 0
      ? { rows: [] as Array<{ resource_type: "artifact" | "proposal"; id: string; title: string; visibility: string }> }
      : await db.query<{ resource_type: "artifact" | "proposal"; id: string; title: string; visibility: string }>(
        `SELECT 'artifact'::text AS resource_type, id, title, visibility
           FROM artifacts
          WHERE space_id = $1 AND run_id = ANY($2::varchar[]) AND visibility <> 'private'
         UNION ALL
         SELECT 'proposal'::text AS resource_type, id, title, visibility
           FROM proposals
          WHERE space_id = $1 AND created_by_run_id = ANY($2::varchar[]) AND visibility <> 'private'
         ORDER BY resource_type, title, id`,
        [spaceId, runIds],
      );
    return {
      readers: readers.rows.map((row) => ({
        user_id: row.user_id,
        display_name: row.display_name,
        access_count: Number(row.access_count),
        last_accessed_at: new Date(row.last_accessed_at).toISOString(),
        link: "/space-settings",
      })),
      consuming_runs: runs.rows.map((row) => ({ ...row, link: `/runs/${row.run_id}` })),
      shared_derived_outputs: outputs.rows.map((row) => ({
        ...row,
        link: row.resource_type === "artifact" ? `/artifacts/${row.id}` : `/proposals/${row.id}`,
      })),
    };
  }

  private async contextItemTypes(
    db: Queryable,
    spaceId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<string[]> {
    if (resourceType !== "space_object") return [resourceType];
    const result = await db.query<{ object_type: string }>(
      `SELECT object_type FROM space_objects WHERE space_id = $1 AND id = $2 LIMIT 1`,
      [spaceId, resourceId],
    );
    return [...new Set([resourceType, result.rows[0]?.object_type].filter((value): value is string => Boolean(value)))];
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function narrowsVisibility(current: ContentVisibility, requested: ContentVisibility): boolean {
  const rank: Record<ContentVisibility, number> = {
    private: 0,
    selected_users: 1,
    space_shared: 2,
  };
  return rank[requested] < rank[current];
}
