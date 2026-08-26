import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import type { ServerConfig } from "../../config.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { contentDecisionFromDb, contentOwnerFromDb } from "../access/contentAccessQuery.js";
import {
  dbPool,
  HttpError,
  type Queryable,
  type SpaceUserIdentity,
  withDbTransaction,
} from "../routeUtils/common.js";
import { publicationAdapter } from "./publicationRegistry.js";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

interface PublicationRow {
  id: string;
  source_space_id: string;
  source_resource_type: string;
  source_resource_id: string;
  version: number;
  snapshot_schema_version: number;
  snapshot_json: unknown;
  snapshot_hash: string;
  published_by_user_id: string;
  status: string;
  created_at: unknown;
  updated_at: unknown;
  revoked_at: unknown;
  revoked_by_user_id: string | null;
}

interface ImportRow {
  id: string;
  publication_id: string;
  target_space_id: string;
  publication_version: number;
  snapshot_hash: string;
  imported_resource_type: string;
  imported_resource_id: string;
  imported_by_user_id: string;
  created_at: unknown;
}

interface PublicationListRow extends PublicationRow {
  target_space_ids: string[];
  import_id: string | null;
  imported_resource_type: string | null;
  imported_resource_id: string | null;
  imported_by_user_id: string | null;
  imported_at: unknown;
}

interface PublicationImportSummary {
  id: string;
  imported_resource_type: string;
  imported_resource_id: string;
  imported_by_user_id: string;
  created_at: string;
}

export interface CreatePublicationInput {
  resource_type: string;
  resource_id: string;
  target_space_ids: string[];
}

export class PublicationService {
  constructor(private readonly pool: Pool) {}

  static fromConfig(config: ServerConfig): PublicationService {
    return new PublicationService(dbPool(config));
  }

  async create(identity: SpaceUserIdentity, input: CreatePublicationInput) {
    const adapter = requireAdapter(input.resource_type);
    const targetSpaceIds = dedupeTargetSpaces(identity.spaceId, input.target_space_ids);
    return withDbTransaction(this.pool, async (db) => {
      const decision = await contentDecisionFromDb(
        db,
        identity,
        input.resource_type,
        input.resource_id,
      );
      const isOwner = await contentOwnerFromDb(
        db,
        identity,
        input.resource_type,
        input.resource_id,
      );
      if (decision !== "full" || !isOwner) throw new HttpError(404, "Content not found");

      await assertActiveMemberships(db, identity.userId, targetSpaceIds);
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${identity.spaceId}:${input.resource_type}:${input.resource_id}`],
      );
      const snapshot = await adapter.serialize(db, identity.spaceId, input.resource_id);
      const canonicalSnapshot = canonicalJson(snapshot);
      if (Buffer.byteLength(canonicalSnapshot, "utf8") > MAX_SNAPSHOT_BYTES) {
        throw new HttpError(422, "Publication snapshot exceeds 1 MiB");
      }
      const snapshotHash = createHash("sha256").update(canonicalSnapshot).digest("hex");
      const versionResult = await db.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0)::int + 1 AS version
           FROM content_publications
          WHERE source_space_id = $1 AND source_resource_type = $2 AND source_resource_id = $3`,
        [identity.spaceId, input.resource_type, input.resource_id],
      );
      const version = versionResult.rows[0]?.version ?? 1;
      const id = randomUUID();
      const now = new Date().toISOString();
      const result = await db.query<PublicationRow>(
        `INSERT INTO content_publications (
           id, source_space_id, source_resource_type, source_resource_id, version,
           snapshot_schema_version, snapshot_json, snapshot_hash,
           published_by_user_id, status, created_at, updated_at,
           revoked_at, revoked_by_user_id
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7::jsonb, $8,
           $9, 'active', $10, $10,
           NULL, NULL
         ) RETURNING *`,
        [
          id, identity.spaceId, input.resource_type, input.resource_id, version,
          adapter.schemaVersion, canonicalSnapshot, snapshotHash, identity.userId, now,
        ],
      );
      for (const targetSpaceId of targetSpaceIds) {
        await db.query(
          `INSERT INTO content_publication_targets (id, publication_id, target_space_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), id, targetSpaceId, now],
        );
      }
      return publicationOut(result.rows[0]!, targetSpaceIds, null);
    });
  }

  async listReceived(identity: SpaceUserIdentity) {
    const rows = await this.pool.query<PublicationListRow>(
      `SELECT cp.*,
              ARRAY[$1]::varchar[] AS target_space_ids,
              cpi.id AS import_id,
              cpi.imported_resource_type,
              cpi.imported_resource_id,
              cpi.imported_by_user_id,
              cpi.created_at AS imported_at
         FROM content_publications cp
         JOIN content_publication_targets cpt
           ON cpt.publication_id = cp.id AND cpt.target_space_id = $1
         JOIN space_memberships sm
           ON sm.space_id = cpt.target_space_id
          AND sm.user_id = $2
          AND sm.status = 'active'
         LEFT JOIN content_publication_imports cpi
           ON cpi.publication_id = cp.id AND cpi.target_space_id = $1
        WHERE (cp.status = 'active' OR cpi.id IS NOT NULL)
        ORDER BY cp.created_at DESC, cp.id DESC`,
      [identity.spaceId, identity.userId],
    );
    return { items: rows.rows.map(publicationListOut) };
  }

  async listPublished(identity: SpaceUserIdentity) {
    const rows = await this.pool.query<PublicationListRow>(
      `SELECT cp.*,
              ARRAY_AGG(cpt.target_space_id ORDER BY cpt.target_space_id) AS target_space_ids,
              NULL::varchar AS import_id,
              NULL::varchar AS imported_resource_type,
              NULL::varchar AS imported_resource_id,
              NULL::varchar AS imported_by_user_id,
              NULL::timestamptz AS imported_at
         FROM content_publications cp
         JOIN content_publication_targets cpt ON cpt.publication_id = cp.id
         JOIN space_memberships sm
           ON sm.space_id = cp.source_space_id
          AND sm.user_id = $2
          AND sm.status = 'active'
        WHERE cp.source_space_id = $1 AND cp.published_by_user_id = $2
        GROUP BY cp.id
        ORDER BY cp.created_at DESC, cp.id DESC`,
      [identity.spaceId, identity.userId],
    );
    return { items: rows.rows.map(publicationListOut) };
  }

  async get(identity: SpaceUserIdentity, publicationId: string) {
    const result = await this.pool.query<PublicationListRow>(
      `SELECT cp.*,
              CASE
                WHEN cp.source_space_id = $2 AND cp.published_by_user_id = $3
                  THEN ARRAY_AGG(cpt_all.target_space_id ORDER BY cpt_all.target_space_id)
                ELSE ARRAY[$2]::varchar[]
              END AS target_space_ids,
              cpi.id AS import_id,
              cpi.imported_resource_type,
              cpi.imported_resource_id,
              cpi.imported_by_user_id,
              cpi.created_at AS imported_at
         FROM content_publications cp
         JOIN content_publication_targets cpt_all ON cpt_all.publication_id = cp.id
         LEFT JOIN content_publication_targets current_target
           ON current_target.publication_id = cp.id AND current_target.target_space_id = $2
         LEFT JOIN content_publication_imports cpi
           ON cpi.publication_id = cp.id AND cpi.target_space_id = $2
        WHERE cp.id = $1
          AND (
            (
              (cp.status = 'active' OR cpi.id IS NOT NULL)
              AND current_target.id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM space_memberships sm
                 WHERE sm.space_id = $2 AND sm.user_id = $3 AND sm.status = 'active'
              )
            )
            OR (
              cp.source_space_id = $2
              AND cp.published_by_user_id = $3
              AND EXISTS (
                SELECT 1 FROM space_memberships sm
                 WHERE sm.space_id = $2 AND sm.user_id = $3 AND sm.status = 'active'
              )
            )
          )
        GROUP BY cp.id, cpi.id
        LIMIT 1`,
      [publicationId, identity.spaceId, identity.userId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Publication not found");
    return publicationListOut(row);
  }

  async import(identity: SpaceUserIdentity, publicationId: string) {
    return withDbTransaction(this.pool, async (db) => {
      await assertActiveMemberships(db, identity.userId, [identity.spaceId]);
      const result = await db.query<PublicationRow>(
        `SELECT cp.*
           FROM content_publications cp
           JOIN content_publication_targets cpt
             ON cpt.publication_id = cp.id AND cpt.target_space_id = $2
          WHERE cp.id = $1
          LIMIT 1 FOR UPDATE OF cp`,
        [publicationId, identity.spaceId],
      );
      const publication = result.rows[0];
      if (!publication) throw new HttpError(404, "Publication not found");

      const existing = await loadImport(db, publicationId, identity.spaceId);
      if (existing) return importOut(existing);
      if (publication.status !== "active") throw new HttpError(409, "Publication has been revoked");

      const adapter = requireAdapter(publication.source_resource_type);
      if (adapter.schemaVersion !== publication.snapshot_schema_version) {
        throw new HttpError(409, "Unsupported publication snapshot version");
      }
      const canonicalSnapshot = canonicalJson(publication.snapshot_json);
      const actualHash = createHash("sha256").update(canonicalSnapshot).digest("hex");
      if (actualHash !== publication.snapshot_hash) {
        throw new HttpError(409, "Publication snapshot integrity check failed");
      }
      const imported = await adapter.importSnapshot(db, {
        targetSpaceId: identity.spaceId,
        ownerUserId: identity.userId,
      }, publication.snapshot_json);
      const now = new Date().toISOString();
      const importedRow = await db.query<ImportRow>(
        `INSERT INTO content_publication_imports (
           id, publication_id, target_space_id, publication_version, snapshot_hash,
           imported_resource_type, imported_resource_id, imported_by_user_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          randomUUID(), publication.id, identity.spaceId, publication.version,
          publication.snapshot_hash, imported.resource_type, imported.resource_id,
          identity.userId, now,
        ],
      );
      return importOut(importedRow.rows[0]!);
    });
  }

  async revoke(identity: SpaceUserIdentity, publicationId: string) {
    return withDbTransaction(this.pool, async (db) => {
      const now = new Date().toISOString();
      const result = await db.query<PublicationRow>(
        `UPDATE content_publications cp
            SET status = 'revoked', revoked_at = $4, revoked_by_user_id = $3, updated_at = $4
          WHERE cp.id = $1
            AND cp.source_space_id = $2
            AND cp.published_by_user_id = $3
            AND cp.status = 'active'
            AND EXISTS (
              SELECT 1 FROM space_memberships sm
               WHERE sm.space_id = $2 AND sm.user_id = $3 AND sm.status = 'active'
            )
          RETURNING cp.*`,
        [publicationId, identity.spaceId, identity.userId, now],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "Active publication not found");
      const targets = await loadTargets(db, publicationId);
      return publicationOut(row, targets, null);
    });
  }
}

function requireAdapter(resourceType: string) {
  const definition = contentResourceDefinition(resourceType);
  const adapter = publicationAdapter(resourceType);
  if (!definition || !definition.publishable || !adapter) {
    throw new HttpError(422, "Resource type is not publishable");
  }
  return adapter;
}

function dedupeTargetSpaces(sourceSpaceId: string, targetSpaceIds: string[]): string[] {
  const result = [...new Set(targetSpaceIds.filter(Boolean))];
  if (result.length === 0) throw new HttpError(422, "At least one target space is required");
  if (result.length > 20) throw new HttpError(422, "At most 20 target spaces are allowed");
  if (result.includes(sourceSpaceId)) throw new HttpError(422, "Target space must differ from source space");
  return result;
}

async function assertActiveMemberships(
  db: Queryable,
  userId: string,
  spaceIds: readonly string[],
): Promise<void> {
  const result = await db.query<{ space_id: string }>(
    `SELECT space_id FROM space_memberships
      WHERE user_id = $1 AND space_id = ANY($2::varchar[]) AND status = 'active'`,
    [userId, spaceIds],
  );
  const active = new Set(result.rows.map((row) => row.space_id));
  if (spaceIds.some((spaceId) => !active.has(spaceId))) {
    throw new HttpError(404, "Target space not found");
  }
}

async function loadTargets(db: Queryable, publicationId: string): Promise<string[]> {
  const result = await db.query<{ target_space_id: string }>(
    `SELECT target_space_id FROM content_publication_targets
      WHERE publication_id = $1 ORDER BY target_space_id`,
    [publicationId],
  );
  return result.rows.map((row) => row.target_space_id);
}

async function loadImport(
  db: Queryable,
  publicationId: string,
  targetSpaceId: string,
): Promise<ImportRow | null> {
  const result = await db.query<ImportRow>(
    `SELECT * FROM content_publication_imports
      WHERE publication_id = $1 AND target_space_id = $2 LIMIT 1`,
    [publicationId, targetSpaceId],
  );
  return result.rows[0] ?? null;
}

function publicationListOut(row: PublicationListRow) {
  const imported = row.import_id ? {
    id: row.import_id,
    imported_resource_type: row.imported_resource_type!,
    imported_resource_id: row.imported_resource_id!,
    imported_by_user_id: row.imported_by_user_id!,
    created_at: dateIso(row.imported_at),
  } : null;
  return publicationOut(row, row.target_space_ids, imported);
}

function publicationOut(
  row: PublicationRow,
  targetSpaceIds: readonly string[],
  imported: PublicationImportSummary | null,
) {
  const snapshot = row.snapshot_json as { title?: unknown };
  return {
    id: row.id,
    source_space_id: row.source_space_id,
    source_resource_type: row.source_resource_type,
    source_resource_id: row.source_resource_id,
    version: row.version,
    snapshot_schema_version: row.snapshot_schema_version,
    snapshot_hash: row.snapshot_hash,
    title: typeof snapshot?.title === "string" ? snapshot.title : "Untitled publication",
    snapshot: row.snapshot_json,
    published_by_user_id: row.published_by_user_id,
    target_space_ids: [...targetSpaceIds],
    status: row.status,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
    revoked_at: nullableDateIso(row.revoked_at),
    revoked_by_user_id: row.revoked_by_user_id,
    import: imported,
  };
}

function importOut(row: ImportRow) {
  return {
    id: row.id,
    publication_id: row.publication_id,
    target_space_id: row.target_space_id,
    publication_version: row.publication_version,
    snapshot_hash: row.snapshot_hash,
    imported_resource_type: row.imported_resource_type,
    imported_resource_id: row.imported_resource_id,
    imported_by_user_id: row.imported_by_user_id,
    created_at: dateIso(row.created_at),
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(422, "Publication snapshot contains an invalid number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) output[key] = canonicalValue(entry);
    }
    return output;
  }
  throw new HttpError(422, "Publication snapshot is not JSON serializable");
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function nullableDateIso(value: unknown): string | null {
  return value == null ? null : dateIso(value);
}
