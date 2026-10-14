/**
 * Who a Memory version reaches, and whether everything it was derived from
 * already reaches them.
 *
 * Used by the canonical applier when it accepts a create or update: the
 * audience is computed from the version's placement and grants rather than
 * from the proposal's claim, and the check runs at accept time because a
 * source can be narrowed, or a reader removed, between proposing and
 * accepting.
 */
import { randomUUID } from "node:crypto";
import { contentAccessSql, projectReadAccessSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { isContentAccessLevel, type ContentAccessLevel } from "../access/contentAccessTypes.js";
import { registeredEntities, resolveContentResourceType } from "../ontology/entities.js";
import type { Queryable } from "./memoryApplyProvenance.js";
import type { ProvenanceEntry } from "./sourceMonitoring.js";

export interface MemoryGrant {
  user_id: string;
  access_level: ContentAccessLevel;
}

export interface MemoryAudiencePlacement {
  scope: string;
  visibility: string;
  accessLevel: string;
  ownerUserId: string | null;
  projectId: string | null;
  grants: readonly MemoryGrant[];
}

/** One reader and the level the version is disclosed to them at. */
export type MemoryAudience = Map<string, ContentAccessLevel>;

/**
 * Provenance whose own read gate decides who may see what was derived from it.
 * A Run is execution context, governed by its context taint rather than by a
 * reader list, and a proposal is the review record of this very write.
 */
const UNGATED_PROVENANCE_SOURCES = new Set(["run", "proposal"]);

let gatedSourceResourceTypes: Map<string, string> | null = null;

function gatedSourceResourceType(sourceType: string): string | null {
  if (!gatedSourceResourceTypes) {
    gatedSourceResourceTypes = new Map();
    for (const definition of registeredEntities()) {
      const provenanceType = definition.provenanceSourceable?.sourceType;
      if (!provenanceType || UNGATED_PROVENANCE_SOURCES.has(provenanceType)) continue;
      const resourceType = resolveContentResourceType(definition.entityType);
      if (resourceType && contentResourceDefinition(resourceType)) {
        gatedSourceResourceTypes.set(provenanceType, resourceType);
      }
    }
  }
  return gatedSourceResourceTypes.get(sourceType) ?? null;
}

/** `target_grants` from a payload; null when the payload does not set them. */
export function grantsFromPayload(value: unknown): MemoryGrant[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new TypeError("target_grants must be an array");
  const byUser = new Map<string, ContentAccessLevel>();
  for (const item of value) {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : null;
    if (!row || typeof row.user_id !== "string" || !row.user_id || !isContentAccessLevel(row.access_level)) {
      throw new TypeError("each target grant needs a user_id and an access_level");
    }
    byUser.set(row.user_id, row.access_level);
  }
  return [...byUser].map(([user_id, access_level]) => ({ user_id, access_level }));
}

export async function activeMemoryGrants(db: Queryable, spaceId: string, memoryId: string): Promise<MemoryGrant[]> {
  const result = await db.query<MemoryGrant>(
    `SELECT grantee_user_id AS user_id, access_level
       FROM content_access_grants
      WHERE space_id = $1 AND resource_type = 'memory' AND resource_id = $2 AND revoked_at IS NULL
      ORDER BY grantee_user_id`,
    [spaceId, memoryId],
  );
  return result.rows;
}

/**
 * Grants belong to the active head. A new version takes over the grants of
 * the one it replaces (or the set the accepted change names), and the
 * replaced version keeps none, so who may read the entry is always read off
 * one row.
 */
export async function transferMemoryGrants(db: Queryable, input: {
  spaceId: string;
  fromMemoryId: string | null;
  toMemoryId: string;
  grants: readonly MemoryGrant[];
  actorUserId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  if (input.fromMemoryId) {
    await db.query(
      `UPDATE content_access_grants
          SET revoked_at = $3, revoked_by_user_id = $4, updated_at = $3
        WHERE space_id = $1 AND resource_type = 'memory' AND resource_id = $2 AND revoked_at IS NULL`,
      [input.spaceId, input.fromMemoryId, now, input.actorUserId],
    );
  }
  for (const grant of input.grants) {
    await db.query(
      `INSERT INTO content_access_grants (
         id, space_id, resource_type, resource_id, grantee_user_id,
         granted_by_user_id, access_level, created_at, updated_at, revoked_at, revoked_by_user_id
       ) VALUES ($1, $2, 'memory', $3, $4, $5, $6, $7, $7, NULL, NULL)
       ON CONFLICT (space_id, resource_type, resource_id, grantee_user_id)
       DO UPDATE SET granted_by_user_id = EXCLUDED.granted_by_user_id,
                     access_level = EXCLUDED.access_level,
                     updated_at = EXCLUDED.updated_at,
                     revoked_at = NULL,
                     revoked_by_user_id = NULL`,
      [randomUUID(), input.spaceId, input.toMemoryId, grant.user_id, input.actorUserId, grant.access_level, now],
    );
  }
}

/** Grantees who are not active members of the Space. */
export async function inactiveGrantees(db: Queryable, spaceId: string, grants: readonly MemoryGrant[]): Promise<string[]> {
  if (grants.length === 0) return [];
  const ids = grants.map((grant) => grant.user_id);
  const result = await db.query<{ user_id: string }>(
    `SELECT sm.user_id
       FROM space_memberships sm
       JOIN users u ON u.id = sm.user_id AND u.status = 'active'
      WHERE sm.space_id = $1 AND sm.user_id = ANY($2::varchar[]) AND sm.status = 'active'`,
    [spaceId, ids],
  );
  const active = new Set(result.rows.map((row) => row.user_id));
  return ids.filter((id) => !active.has(id));
}

/**
 * Everyone the version is disclosed to, with the level each reads it at. The
 * owner and private placements reach the owner alone; selected users reach
 * their grantees; Project Memory reaches every Project reader at the base
 * level, raised by a grant.
 */
export async function memoryAudience(
  db: Queryable,
  spaceId: string,
  placement: MemoryAudiencePlacement,
): Promise<MemoryAudience> {
  const audience: MemoryAudience = new Map();
  if (placement.ownerUserId) audience.set(placement.ownerUserId, "full");
  if (placement.visibility === "private") return audience;
  const base: ContentAccessLevel = placement.accessLevel === "summary" ? "summary" : "full";
  if (placement.visibility === "space_shared" && placement.projectId) {
    const readers = await db.query<{ user_id: string }>(
      `SELECT u.id AS user_id
         FROM users u
         JOIN space_memberships sm ON sm.user_id = u.id AND sm.space_id = $1 AND sm.status = 'active'
        WHERE u.status = 'active' AND ${projectReadAccessSql("$1", "$2", "u.id")}`,
      [spaceId, placement.projectId],
    );
    for (const row of readers.rows) if (!audience.has(row.user_id)) audience.set(row.user_id, base);
  }
  for (const grant of placement.grants) {
    if (grant.user_id === placement.ownerUserId) continue;
    const current = audience.get(grant.user_id);
    if (placement.visibility === "selected_users") audience.set(grant.user_id, grant.access_level);
    else if (current !== undefined && grant.access_level === "full") audience.set(grant.user_id, "full");
  }
  return audience;
}

/** Readers the new audience adds, or raises from summary to full content. */
export function widenedReaders(before: MemoryAudience, after: MemoryAudience): string[] {
  const widened: string[] = [];
  for (const [userId, level] of after) {
    const prior = before.get(userId);
    if (prior === undefined || (prior === "summary" && level === "full")) widened.push(userId);
  }
  return widened;
}

export interface UnreadableSource {
  source_type: string;
  source_id: string;
  reader_user_ids: string[];
}

/**
 * Sources some of these readers may not read. A Memory derived from content
 * reaches no one that content does not already reach: the owner shares the
 * source first, then the Memory.
 */
export async function sourcesUnreadableBy(
  db: Queryable,
  spaceId: string,
  entries: readonly ProvenanceEntry[],
  readerIds: readonly string[],
): Promise<UnreadableSource[]> {
  if (readerIds.length === 0) return [];
  const unreadable: UnreadableSource[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.source_type !== "string" || typeof entry.source_id !== "string") continue;
    const key = `${entry.source_type}:${entry.source_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resourceType = gatedSourceResourceType(entry.source_type);
    if (!resourceType) continue;
    const definition = contentResourceDefinition(resourceType)!;
    const result = await db.query<{ user_id: string }>(
      `SELECT reader.user_id
         FROM unnest($3::varchar[]) AS reader(user_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM ${definition.tableName} source
           WHERE source.space_id = $1 AND source.id::text = $2
             AND ${contentAccessSql({ definition, alias: "source", userExpr: "reader.user_id", includeOversight: false })}
        )`,
      [spaceId, entry.source_id, readerIds],
    );
    if (result.rows.length > 0) {
      unreadable.push({
        source_type: entry.source_type,
        source_id: entry.source_id,
        reader_user_ids: result.rows.map((row) => row.user_id),
      });
    }
  }
  return unreadable;
}

/** Every provenance link recorded on one Memory version. */
export async function memoryProvenanceEntries(db: Queryable, spaceId: string, memoryId: string): Promise<ProvenanceEntry[]> {
  const result = await db.query<ProvenanceEntry>(
    `SELECT source_type, source_id, source_trust
       FROM provenance_links
      WHERE space_id = $1 AND target_type = 'memory' AND target_id = $2`,
    [spaceId, memoryId],
  );
  return result.rows;
}
