import { randomUUID } from "node:crypto";
import type {
  CrossSpaceResolvedItem,
  CrossSpaceRetrievalResponse,
  RetrievalObjectType,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import { knowledgeRetrievalAdapter } from "../knowledge/retrievalAdapter.js";
import { memoryRetrievalAdapter } from "../memory/retrievalAdapter.js";
import { projectRetrievalAdapter } from "../projects/retrievalAdapter.js";
import { inquiryRetrievalAdapter } from "../inquiry/retrievalAdapter.js";
import { RetrievalRegistry } from "../retrieval/registry.js";
import { RetrievalSearchService } from "../retrieval/searchService.js";
import { sourceRetrievalAdapter } from "../sources/retrievalAdapter.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import {
  ContentAccessAuditService,
  contentResourceTypeForRetrievalObject,
} from "../contentAccess/audit.js";

const DISCLOSURE_TTL_MS = 15 * 60 * 1000;

export const personalAggregatedRetrievalRegistry = new RetrievalRegistry();
for (const adapter of [
  knowledgeRetrievalAdapter,
  memoryRetrievalAdapter,
  projectRetrievalAdapter,
  sourceRetrievalAdapter,
  inquiryRetrievalAdapter,
]) {
  personalAggregatedRetrievalRegistry.register(adapter);
}
export const PERSONAL_AGGREGATED_RESOURCE_TYPES = [
  "knowledge_item",
  "note",
  "source",
  "claim",
  "memory_entry",
  "project_public_summary",
  "source_item",
  "extracted_evidence",
  "inquiry_thread",
] as const satisfies readonly RetrievalObjectType[];

const registeredTypes = personalAggregatedRetrievalRegistry.objectTypes().sort();
const exceptionTypes = [...PERSONAL_AGGREGATED_RESOURCE_TYPES].sort();
if (JSON.stringify(registeredTypes) !== JSON.stringify(exceptionTypes)) {
  throw new Error("personal aggregated retrieval registry must match its explicit exception list");
}

interface SpaceRow {
  id: string;
  name: string;
  type: string;
  created_by_user_id: string | null;
  role: string;
  egress_notifications_enabled: boolean;
}

interface PointerRow {
  pointer_id: string;
  space_id: string;
  resource_type: RetrievalObjectType;
  resource_id: string;
  space_name: string;
  egress_notifications_enabled: boolean;
}

export class CrossSpaceRetrievalService {
  constructor(private readonly pool: Pool) {}

  static fromConfig(config: ServerConfig): CrossSpaceRetrievalService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new CrossSpaceRetrievalService(getDbPool(config.databaseUrl));
  }

  async search(input: {
    userId: string;
    query: string;
    resourceTypes?: RetrievalObjectType[];
    maxResults?: number;
  }): Promise<CrossSpaceRetrievalResponse> {
    const spaces = await this.activeSpaces(input.userId);
    const personalSpace = requirePersonalSpace(spaces, input.userId);
    const resourceTypes = input.resourceTypes ?? [...PERSONAL_AGGREGATED_RESOURCE_TYPES];
    assertExceptionTypes(resourceTypes);
    const maxResults = Math.min(Math.max(input.maxResults ?? 20, 1), 50);

    const perSpace = await Promise.all(spaces.map(async (space) => {
      const result = await new RetrievalSearchService(
        this.pool,
        personalAggregatedRetrievalRegistry,
      ).search({
        spaceId: space.id,
        viewerUserId: input.userId,
        objectTypes: resourceTypes,
        query: input.query,
        maxResults,
        mode: "lexical",
      });
      return result.items.map((item) => ({ space, item }));
    }));

    const selected = perSpace.flat()
      .sort((a, b) => b.item.score - a.item.score || a.space.id.localeCompare(b.space.id)
        || a.item.object_id.localeCompare(b.item.object_id))
      .slice(0, maxResults);

    const sessionId = randomUUID();
    const pointerIds = selected.map(() => randomUUID());
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO cross_space_retrieval_sessions
           (id, user_id, personal_space_id, query, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [sessionId, input.userId, personalSpace.id, input.query],
      );
      for (let i = 0; i < selected.length; i += 1) {
        const selectedItem = selected[i]!;
        await client.query(
          `INSERT INTO cross_space_retrieval_pointers
             (id, session_id, user_id, resource_space_id, resource_type, resource_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [pointerIds[i], sessionId, input.userId, selectedItem.space.id,
            selectedItem.item.object_type, selectedItem.item.object_id],
        );
      }
    });

    return {
      session_id: sessionId,
      items: selected.map((entry, index) => ({
        pointer: {
          pointer_id: pointerIds[index]!,
          space_id: entry.space.id,
          resource_type: entry.item.object_type,
          id: entry.item.object_id,
        },
        space_name: entry.space.name,
        title: entry.item.title,
        snippet: entry.item.snippet,
        score: entry.item.score,
      })),
      source_space_ids: [...new Set(selected.map((entry) => entry.space.id))],
      fused_conclusion: null,
      canonical_write_performed: false,
    };
  }

  async resolve(userId: string, pointerIds: string[]): Promise<{
    items: CrossSpaceResolvedItem[];
    unresolved_pointer_ids: string[];
  }> {
    return withTransaction(this.pool, async (client) => {
      const rows = await this.loadPointerRows(userId, pointerIds, client);
      const byId = new Map(rows.map((row) => [row.pointer_id, row]));
      const items: CrossSpaceResolvedItem[] = [];
      const unresolved: string[] = [];
      for (const pointerId of pointerIds) {
        const row = byId.get(pointerId);
        if (!row) {
          unresolved.push(pointerId);
          continue;
        }
        const resolved = await this.revalidatePointer(userId, row, client);
        if (!resolved) {
          unresolved.push(pointerId);
          continue;
        }
        items.push(resolved);
      }
      await this.recordPointerReads(userId, refsForAccessAudit(items), client);
      return { items, unresolved_pointer_ids: unresolved };
    });
  }

  async storeSingleSourceSummary(userId: string, pointerIds: string[], summary: string): Promise<{
    artifact_id: string;
    source_space_id: string;
  }> {
    return withTransaction(this.pool, async (client) => {
      const resolved = await this.resolveAll(userId, pointerIds, client);
      const sourceSpaces = new Set(resolved.map((item) => item.pointer.space_id));
      if (sourceSpaces.size !== 1) {
        throw new HttpError(422, "single-source summary requires pointers from exactly one Space");
      }
      const sourceSpaceId = resolved[0]!.pointer.space_id;
      const artifactId = await insertArtifactRow(client, {
        spaceId: sourceSpaceId,
        ownerUserId: userId,
        artifactType: "cross_space_source_summary",
        title: "Personal source summary",
        content: summary,
        metadata: {
          kind: "cross_space_source_summary",
          source_pointers: resolved.map((item) => item.pointer),
        },
        canonicalFormat: "cross_space_source_summary.v1",
        visibility: "private",
      });
      return { artifact_id: artifactId, source_space_id: sourceSpaceId };
    });
  }

  async discloseEgress(userId: string, pointerIds: string[]): Promise<{
    disclosure_id: string;
    expires_at: string;
    source_spaces: Array<{
      space_id: string;
      space_name: string;
      egress_notifications_enabled: boolean;
      pointers: Array<{ resource_type: RetrievalObjectType; id: string }>;
    }>;
  }> {
    return withTransaction(this.pool, async (client) => {
      const resolved = await this.resolveAll(userId, pointerIds, client);
      const spaces = await this.activeSpaces(userId, client);
      const personalSpace = requirePersonalSpace(spaces, userId);
      const bySpace = groupResolved(resolved, spaces);
      if (bySpace.length < 2) throw new HttpError(422, "fused conclusion requires at least two source Spaces");
      const disclosureId = randomUUID();
      const expiresAt = new Date(Date.now() + DISCLOSURE_TTL_MS).toISOString();
      await client.query(
        `INSERT INTO cross_space_egress_disclosures
           (id, user_id, personal_space_id, pointer_ids_json, settings_snapshot_json,
            disclosed_at, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, now(), $6)`,
        [disclosureId, userId, personalSpace.id, JSON.stringify(normalizeIds(pointerIds)),
          JSON.stringify(bySpace), expiresAt],
      );
      return { disclosure_id: disclosureId, expires_at: expiresAt, source_spaces: bySpace };
    });
  }

  async storeFusedConclusion(input: {
    userId: string;
    disclosureId: string;
    pointerIds: string[];
    conclusion: string;
  }): Promise<{ artifact_id: string; egress_record_ids: string[] }> {
    return withTransaction(this.pool, async (client) => {
      const disclosure = await client.query<{
        personal_space_id: string;
        pointer_ids_json: unknown;
        settings_snapshot_json: unknown;
        expires_at: Date | string;
        consumed_at: Date | string | null;
      }>(
        `SELECT personal_space_id, pointer_ids_json, settings_snapshot_json,
                expires_at, consumed_at
           FROM cross_space_egress_disclosures
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [input.disclosureId, input.userId],
      );
      const row = disclosure.rows[0];
      if (!row) throw new HttpError(404, "egress disclosure not found");
      if (row.consumed_at) throw new HttpError(409, "egress disclosure already consumed");
      if (new Date(row.expires_at).getTime() <= Date.now()) throw new HttpError(409, "egress disclosure expired");
      if (!sameIds(row.pointer_ids_json, input.pointerIds)) {
        throw new HttpError(422, "pointer_ids must match the disclosed set");
      }

      const resolved = await this.resolveAll(input.userId, input.pointerIds, client);
      const contributingSpaceIds = [...new Set(
        resolved.map((item) => item.pointer.space_id),
      )];
      const activeSpaces = await this.activeSpaces(
        input.userId,
        client,
        true,
        contributingSpaceIds,
      );
      const bySpace = groupResolved(resolved, activeSpaces);
      if (bySpace.length < 2) throw new HttpError(422, "fused conclusion requires at least two source Spaces");
      if (!sameSettingsSnapshot(row.settings_snapshot_json, bySpace)) {
        throw new HttpError(409, "source Space egress settings changed; disclose again");
      }

      const artifactId = await insertArtifactRow(client, {
        spaceId: row.personal_space_id,
        ownerUserId: input.userId,
        artifactType: "cross_space_fused_conclusion",
        title: "Stored cross-Space conclusion",
        content: input.conclusion,
        metadata: {
          kind: "cross_space_fused_conclusion",
          source_pointers: resolved.map((item) => item.pointer),
          disclosure_id: input.disclosureId,
        },
        canonicalFormat: "cross_space_fused_conclusion.v1",
        visibility: "private",
      });

      const egressRecordIds: string[] = [];
      for (const source of bySpace) {
        const egressId = randomUUID();
        egressRecordIds.push(egressId);
        const sourcePointers = resolved
          .filter((item) => item.pointer.space_id === source.space_id)
          .map((item) => item.pointer);
        await client.query(
          `INSERT INTO content_egress_records
             (id, source_space_id, actor_user_id, target_personal_space_id,
              target_artifact_id, disclosure_id, source_pointers_json,
              notification_enabled, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())`,
          [egressId, source.space_id, input.userId, row.personal_space_id,
            artifactId, input.disclosureId, JSON.stringify(sourcePointers),
            source.egress_notifications_enabled],
        );
        if (source.egress_notifications_enabled) {
          await broadcast(client, source.space_id, "content_egress", {
            actor_user_id: input.userId,
            egress_record_id: egressId,
            source_pointers: sourcePointers,
            created_at: new Date().toISOString(),
          });
        }
      }
      await client.query(
        `UPDATE cross_space_egress_disclosures SET consumed_at = now() WHERE id = $1`,
        [input.disclosureId],
      );
      return { artifact_id: artifactId, egress_record_ids: egressRecordIds };
    });
  }

  async updateEgressNotificationSetting(userId: string, spaceId: string, enabled: boolean): Promise<{
    space_id: string;
    egress_notifications_enabled: boolean;
    updated_at: string;
  }> {
    return withTransaction(this.pool, async (client) => {
      const role = await client.query<{ role: string }>(
        `SELECT role FROM space_memberships
          WHERE space_id = $1 AND user_id = $2 AND status = 'active'
          FOR UPDATE`,
        [spaceId, userId],
      );
      if (!role.rows[0]) throw new HttpError(404, "Space not found");
      if (!new Set(["owner", "admin"]).has(role.rows[0].role)) {
        throw new HttpError(403, "Requires Space owner or admin role");
      }
      const current = await client.query<{
        egress_notifications_enabled: boolean;
        updated_at: Date | string;
      }>(
        `SELECT egress_notifications_enabled, updated_at
           FROM spaces
          WHERE id = $1
          FOR UPDATE`,
        [spaceId],
      );
      const currentRow = current.rows[0];
      if (!currentRow) throw new HttpError(404, "Space not found");
      if (currentRow.egress_notifications_enabled === enabled) {
        return {
          space_id: spaceId,
          egress_notifications_enabled: enabled,
          updated_at: new Date(currentRow.updated_at).toISOString(),
        };
      }
      const result = await client.query<{ updated_at: Date | string }>(
        `UPDATE spaces
            SET egress_notifications_enabled = $1, updated_at = now()
          WHERE id = $2
          RETURNING updated_at`,
        [enabled, spaceId],
      );
      const updatedAt = new Date(result.rows[0]!.updated_at).toISOString();
      await broadcast(client, spaceId, "egress_notification_setting_changed", {
        changed_by_user_id: userId,
        egress_notifications_enabled: enabled,
        effective_from: updatedAt,
      });
      return { space_id: spaceId, egress_notifications_enabled: enabled, updated_at: updatedAt };
    });
  }

  async listNotifications(userId: string): Promise<{ items: Array<Record<string, unknown>> }> {
    const result = await this.pool.query<{
      id: string;
      space_id: string;
      event_type: string;
      pointer_metadata_json: Record<string, unknown>;
      created_at: Date | string;
      read_at: Date | string | null;
    }>(
      `SELECT n.id, n.space_id, n.event_type, n.pointer_metadata_json,
              n.created_at, n.read_at
         FROM space_member_notifications n
         JOIN space_memberships m
           ON m.space_id = n.space_id AND m.user_id = $1 AND m.status = 'active'
        WHERE n.recipient_user_id = $1
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT 100`,
      [userId],
    );
    return { items: result.rows.map((row) => ({
      id: row.id,
      space_id: row.space_id,
      event_type: row.event_type,
      pointer_metadata: row.pointer_metadata_json,
      created_at: new Date(row.created_at).toISOString(),
      read_at: row.read_at ? new Date(row.read_at).toISOString() : null,
    })) };
  }

  private async activeSpaces(
    userId: string,
    db: Queryable = this.pool,
    lockForEgress = false,
    spaceIds?: readonly string[],
  ): Promise<SpaceRow[]> {
    if (spaceIds?.length === 0) return [];
    const params: unknown[] = [userId];
    const spaceFilter = spaceIds
      ? "AND s.id = ANY($2::varchar[])"
      : "";
    if (spaceIds) params.push(spaceIds);
    const result = await db.query<SpaceRow>(
      `SELECT s.id, s.name, s.type, s.created_by_user_id, m.role,
              s.egress_notifications_enabled
         FROM space_memberships m
         JOIN spaces s ON s.id = m.space_id
        WHERE m.user_id = $1 AND m.status = 'active'
        ${spaceFilter}
        ORDER BY s.id
        ${lockForEgress ? "FOR UPDATE OF s" : ""}`,
      params,
    );
    return result.rows;
  }

  private async loadPointerRows(userId: string, pointerIds: string[], db: Queryable = this.pool): Promise<PointerRow[]> {
    if (pointerIds.length === 0) return [];
    const result = await db.query<PointerRow>(
      `SELECT p.id AS pointer_id, p.resource_space_id AS space_id,
              p.resource_type, p.resource_id, s.name AS space_name,
              s.egress_notifications_enabled
         FROM cross_space_retrieval_pointers p
         JOIN spaces s ON s.id = p.resource_space_id
        WHERE p.user_id = $1 AND p.id = ANY($2::varchar[])`,
      [userId, pointerIds],
    );
    return result.rows;
  }

  private async revalidatePointer(userId: string, row: PointerRow, db: Queryable = this.pool): Promise<CrossSpaceResolvedItem | null> {
    const adapter = personalAggregatedRetrievalRegistry.adapterFor(row.resource_type);
    if (!adapter || !PERSONAL_AGGREGATED_RESOURCE_TYPES.includes(row.resource_type as never)) return null;
    const object = await adapter.revalidate(db, row.space_id, row.resource_type, row.resource_id, userId);
    if (!object) return null;
    return {
      pointer: { pointer_id: row.pointer_id, space_id: row.space_id, resource_type: row.resource_type, id: row.resource_id },
      space_name: row.space_name,
      title: object.title,
      snippet: object.text,
      score: 0,
    };
  }

  private async resolveAll(userId: string, pointerIds: string[], db: Queryable = this.pool): Promise<CrossSpaceResolvedItem[]> {
    const rows = await this.loadPointerRows(userId, pointerIds, db);
    const byId = new Map(rows.map((row) => [row.pointer_id, row]));
    const resolved: CrossSpaceResolvedItem[] = [];
    for (const pointerId of pointerIds) {
      const row = byId.get(pointerId);
      const item = row ? await this.revalidatePointer(userId, row, db) : null;
      if (!item) throw new HttpError(404, "one or more retrieval pointers are no longer resolvable");
      resolved.push(item);
    }
    await this.recordPointerReads(userId, refsForAccessAudit(resolved), db);
    return resolved;
  }

  private async recordPointerReads(userId: string, refs: Array<{
    spaceId: string;
    resourceType: RetrievalObjectType;
    resourceId: string;
  }>, db: Queryable = this.pool): Promise<void> {
    const grouped = new Map<string, { spaceId: string; resourceType: string; ids: string[] }>();
    for (const ref of refs) {
      const resourceType = contentResourceTypeForRetrievalObject(ref.resourceType);
      if (!resourceType) continue;
      const key = `${ref.spaceId}:${resourceType}`;
      const current = grouped.get(key) ?? { spaceId: ref.spaceId, resourceType, ids: [] };
      current.ids.push(ref.resourceId);
      grouped.set(key, current);
    }
    const audit = new ContentAccessAuditService(db);
    for (const group of grouped.values()) {
      await audit.recordReads({
        spaceId: group.spaceId,
        resourceType: group.resourceType,
        resourceIds: group.ids,
        viewerUserId: userId,
        accessType: "explicit_read",
        reason: "cross-space retrieval pointer resolution",
      });
    }
  }
}

function refsForAccessAudit(items: CrossSpaceResolvedItem[]): Array<{
  spaceId: string;
  resourceType: RetrievalObjectType;
  resourceId: string;
}> {
  return items.map((item) => ({
    spaceId: item.pointer.space_id,
    resourceType: item.pointer.resource_type,
    resourceId: item.pointer.id,
  }));
}

function assertExceptionTypes(types: readonly RetrievalObjectType[]): void {
  if (types.some((type) => !PERSONAL_AGGREGATED_RESOURCE_TYPES.includes(type as never))) {
    throw new HttpError(422, "resource type is not allowed for personal aggregated retrieval");
  }
}

function requirePersonalSpace(spaces: SpaceRow[], userId: string): SpaceRow {
  const personal = spaces.filter((space) =>
    space.type === "personal"
    && space.created_by_user_id === userId
    && space.role === "owner");
  if (personal.length !== 1) throw new HttpError(409, "user must have exactly one active Personal Space");
  return personal[0]!;
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return [];
  return [...new Set(value)].sort();
}

function sameIds(stored: unknown, supplied: string[]): boolean {
  return JSON.stringify(normalizeIds(stored)) === JSON.stringify(normalizeIds(supplied));
}

function sameSettingsSnapshot(
  stored: unknown,
  current: Array<{
    space_id: string;
    egress_notifications_enabled: boolean;
    pointers: Array<{ resource_type: RetrievalObjectType; id: string }>;
  }>,
): boolean {
  if (!Array.isArray(stored)) return false;
  const normalize = (rows: unknown[]) => rows.map((entry) => {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return {
      space_id: typeof row.space_id === "string" ? row.space_id : "",
      egress_notifications_enabled: row.egress_notifications_enabled === true,
      pointers: normalizeResourcePointers(row.pointers),
    };
  }).sort((a, b) => a.space_id.localeCompare(b.space_id));
  return JSON.stringify(normalize(stored)) === JSON.stringify(normalize(current));
}

function groupResolved(resolved: CrossSpaceResolvedItem[], spaces: SpaceRow[]) {
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  const grouped = new Map<string, {
    space_id: string;
    space_name: string;
    egress_notifications_enabled: boolean;
    pointers: Array<{ resource_type: RetrievalObjectType; id: string }>;
  }>();
  for (const item of resolved) {
    const space = spaceById.get(item.pointer.space_id);
    if (!space) throw new HttpError(404, "source Space membership is no longer active");
    const group = grouped.get(space.id) ?? {
      space_id: space.id,
      space_name: space.name,
      egress_notifications_enabled: space.egress_notifications_enabled,
      pointers: [],
    };
    if (!group.pointers.some((pointer) =>
      pointer.resource_type === item.pointer.resource_type && pointer.id === item.pointer.id)) {
      group.pointers.push({ resource_type: item.pointer.resource_type, id: item.pointer.id });
    }
    grouped.set(space.id, group);
  }
  return [...grouped.values()]
    .map((group) => ({ ...group, pointers: normalizeResourcePointers(group.pointers) }))
    .sort((a, b) => a.space_id.localeCompare(b.space_id));
}

function normalizeResourcePointers(value: unknown): Array<{
  resource_type: RetrievalObjectType;
  id: string;
}> {
  if (!Array.isArray(value)) return [];
  const keyed = new Map<string, { resource_type: RetrievalObjectType; id: string }>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.resource_type !== "string" || typeof row.id !== "string") continue;
    if (!PERSONAL_AGGREGATED_RESOURCE_TYPES.includes(row.resource_type as never)) continue;
    keyed.set(`${row.resource_type}\u0000${row.id}`, {
      resource_type: row.resource_type as RetrievalObjectType,
      id: row.id,
    });
  }
  return [...keyed.values()].sort((a, b) =>
    a.resource_type.localeCompare(b.resource_type) || a.id.localeCompare(b.id));
}

async function broadcast(
  db: Queryable,
  spaceId: string,
  eventType: "egress_notification_setting_changed" | "content_egress",
  pointerMetadata: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO space_member_notifications
       (id, space_id, recipient_user_id, event_type, pointer_metadata_json, created_at)
     SELECT gen_random_uuid()::text, $1::varchar, m.user_id, $2::varchar, $3::jsonb, now()
       FROM space_memberships m
      WHERE m.space_id = $1::varchar AND m.status = 'active'`,
    [spaceId, eventType, JSON.stringify(pointerMetadata)],
  );
}
