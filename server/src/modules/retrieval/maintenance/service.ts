import type { RetrievalObjectType } from "@agent-space/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import type { RetrievalRegistry } from "../registry.js";
import {
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourceConnectionIdsFromJson,
  sourcePolicyAllowsRead,
} from "../sourcePolicy.js";
import type { RevalidatedObject } from "../types.js";

/**
 * Retrieval maintenance scan — the "context review cycle" review-candidate generator (W7).
 *
 * The maintenance loop dedups pages, fixes links, flags contradictions, etc.
 * agent-space implements the low-risk, derived-only half as a READ-ONLY scan
 * over the retrieval projection that emits BATCHED review candidates. Hard rules
 * (invariant 6):
 *
 *  - **Never a canonical write.** The scan reads only the derived `retrieval_*`
 *    tables and returns findings; it never touches knowledge/memory tables. Acting
 *    on a finding stays on the existing proposal/approval flow.
 *  - **Batched, not one-per-finding.** The scan returns a single clustered report
 *    (duplicates grouped by shared name; each kind capped), never a proposal per
 *    finding.
 *  - **Access-safe.** Every referenced object is run through the SAME adapter
 *    revalidate gate as search AND the same source-connection read-policy gate
 *    (`sourcePolicyAllowsRead` over the projection's `source_connection_ids`), so
 *    a finding never exposes an object (or its title) the operator cannot read or
 *    whose source connection restricts them; a cluster that drops below two
 *    readable members, or a relation whose endpoint is unreadable, is discarded.
 *
 * Stale detection uses `retrieval_objects.source_updated_at` — the CANONICAL
 * object's last-update time projected by the adapters — so "stale" means the
 * content is genuinely old, not just that the index was rebuilt a while ago.
 * Memory is not scanned here (private-row exposure is a separate design); the
 * scan is Knowledge-registry only.
 */
export type MaintenanceFindingKind = "duplicate" | "orphan" | "thin" | "stale" | "relation_suggestion";

export interface MaintenanceObjectRef {
  object_type: RetrievalObjectType;
  object_id: string;
  title: string;
}

export interface MaintenanceFinding {
  kind: MaintenanceFindingKind;
  /** The clustered objects (a duplicate group; a single orphan/thin page; a relation's two endpoints). */
  objects: MaintenanceObjectRef[];
  reason: string;
  /** Optional review action. Applying it still goes through the proposal flow. */
  proposed_action?: Record<string, unknown> | null;
}

export interface MaintenanceReport {
  findings: MaintenanceFinding[];
  counts: Record<MaintenanceFindingKind, number>;
  /** Distinct objects referenced across all findings (after revalidation). */
  scanned: number;
  /** True when any detector hit its per-kind cap (more findings may exist). */
  truncated: boolean;
}

export interface MaintenanceConfig {
  /** An object whose total searchable text is shorter than this is "thin". */
  thinTextChars: number;
  /** An object whose canonical content is older than this many days is "stale". */
  staleAfterDays: number;
  /** Per-kind cap on findings returned (keeps the report a bounded batch). */
  perKindLimit: number;
}

export const DEFAULT_MAINTENANCE_CONFIG: MaintenanceConfig = {
  thinTextChars: 120,
  staleAfterDays: 365,
  perKindLimit: 50,
};

interface DuplicateRow {
  normalized_alias: string;
  members: Array<{ object_type: RetrievalObjectType; object_id: string }>;
}
interface ObjectRow {
  object_type: RetrievalObjectType;
  object_id: string;
}
interface RelationRow {
  from_object_type: RetrievalObjectType;
  from_object_id: string;
  to_object_type: RetrievalObjectType;
  to_object_id: string;
  link_type: string;
}

const EMPTY_COUNTS = (): Record<MaintenanceFindingKind, number> => ({
  duplicate: 0,
  orphan: 0,
  thin: 0,
  stale: 0,
  relation_suggestion: 0,
});

/**
 * Generic, domain-agnostic maintenance scanner. Detectors read only the
 * `retrieval_*` tables (scoped by space + the registry's object types); the
 * registered adapter provides the single read-access gate for the findings.
 */
export class RetrievalMaintenanceService {
  constructor(
    private readonly db: Queryable,
    private readonly registry: RetrievalRegistry,
    private readonly config: MaintenanceConfig = DEFAULT_MAINTENANCE_CONFIG,
  ) {}

  async scan(spaceId: string, viewerUserId: string): Promise<MaintenanceReport> {
    const objectTypes = this.registry.objectTypes();
    const limit = this.config.perKindLimit;
    // Over-fetch by one so we can report truncation without a second count query.
    const fetch = limit + 1;

    const [duplicates, orphans, thin, stale, relations] = await Promise.all([
      this.detectDuplicates(spaceId, objectTypes, fetch),
      this.detectOrphans(spaceId, objectTypes, fetch),
      this.detectThin(spaceId, objectTypes, fetch),
      this.detectStale(spaceId, objectTypes, fetch),
      this.detectRelationSuggestions(spaceId, objectTypes, fetch),
    ]);

    // Revalidate every referenced object once, through the adapter gate.
    const refs = [
      ...duplicates.flatMap((d) => d.members),
      ...orphans,
      ...thin,
      ...stale,
      ...relations.flatMap((r) => [
        { object_type: r.from_object_type, object_id: r.from_object_id },
        { object_type: r.to_object_type, object_id: r.to_object_id },
      ]),
    ];
    const cache = await this.revalidate(spaceId, viewerUserId, refs);
    // Second gate: the same source-connection read policy as search. An object the
    // operator can canonically read may still be source-restricted (allowed
    // readers / agents / `allow_space_admins = false`); such objects must never
    // surface in a finding (invariant 3/7).
    const sourceAllowed = await this.loadSourceAllowedKeys(spaceId, viewerUserId, refs);
    const readable = (ref: { object_type: RetrievalObjectType; object_id: string }): MaintenanceObjectRef | null => {
      const key = `${ref.object_type}:${ref.object_id}`;
      const row = cache.get(key);
      if (!row || !sourceAllowed.has(key)) return null;
      return { object_type: ref.object_type, object_id: ref.object_id, title: row.title };
    };

    const findings: MaintenanceFinding[] = [];
    const counts = EMPTY_COUNTS();
    let truncated = false;

    // Duplicates: keep only clusters with >= 2 readable members.
    truncated = duplicates.length > limit || truncated;
    for (const cluster of duplicates.slice(0, limit)) {
      const members = cluster.members.map(readable).filter((m): m is MaintenanceObjectRef => m !== null);
      if (members.length < 2) continue;
      findings.push({
        kind: "duplicate",
        objects: members,
        reason: `${members.length} objects share the name "${cluster.normalized_alias}"`,
      });
      counts.duplicate += 1;
    }

    truncated = orphans.length > limit || truncated;
    for (const row of orphans.slice(0, limit)) {
      const ref = readable(row);
      if (!ref) continue;
      findings.push({ kind: "orphan", objects: [ref], reason: "no retrieval links to or from this object" });
      counts.orphan += 1;
    }

    truncated = thin.length > limit || truncated;
    for (const row of thin.slice(0, limit)) {
      const ref = readable(row);
      if (!ref) continue;
      findings.push({ kind: "thin", objects: [ref], reason: "sparse searchable content" });
      counts.thin += 1;
    }

    truncated = stale.length > limit || truncated;
    for (const row of stale.slice(0, limit)) {
      const ref = readable(row);
      if (!ref) continue;
      findings.push({
        kind: "stale",
        objects: [ref],
        reason: `canonical content not updated in over ${this.config.staleAfterDays} days`,
      });
      counts.stale += 1;
    }

    truncated = relations.length > limit || truncated;
    for (const row of relations.slice(0, limit)) {
      const from = readable({ object_type: row.from_object_type, object_id: row.from_object_id });
      const to = readable({ object_type: row.to_object_type, object_id: row.to_object_id });
      if (!from || !to) continue; // both endpoints must be readable
      const reason = `suggested ${row.link_type} relation from extracted links`;
      findings.push({
        kind: "relation_suggestion",
        objects: [from, to],
        reason,
        proposed_action: relationSuggestionAction(from, to, row.link_type, reason),
      });
      counts.relation_suggestion += 1;
    }

    const distinct = new Set(findings.flatMap((f) => f.objects.map((o) => `${o.object_type}:${o.object_id}`)));
    return { findings, counts, scanned: distinct.size, truncated };
  }

  private async detectDuplicates(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    limit: number,
  ): Promise<DuplicateRow[]> {
    const result = await this.db.query<DuplicateRow>(
      `SELECT normalized_alias,
              json_agg(json_build_object('object_type', object_type, 'object_id', object_id)
                       ORDER BY object_id) AS members
         FROM (
           SELECT DISTINCT normalized_alias, object_type, object_id
             FROM retrieval_aliases
            WHERE space_id = $1
              AND object_type = ANY($2::retrieval_object_type[])
              AND alias_kind IN ('title', 'alias')
         ) a
        GROUP BY normalized_alias
       HAVING COUNT(*) > 1
        ORDER BY normalized_alias
        LIMIT $3`,
      [spaceId, objectTypes, limit],
    );
    return result.rows;
  }

  private async detectOrphans(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    limit: number,
  ): Promise<ObjectRow[]> {
    const result = await this.db.query<ObjectRow>(
      `SELECT ro.object_type, ro.object_id
         FROM retrieval_objects ro
        WHERE ro.space_id = $1
          AND ro.object_type = ANY($2::retrieval_object_type[])
          AND NOT EXISTS (
            SELECT 1 FROM retrieval_edges e
             WHERE e.space_id = ro.space_id
               AND e.edge_status <> 'rejected'
               AND (
                 (e.from_object_type = ro.object_type AND e.from_object_id = ro.object_id)
                 OR (e.to_object_type = ro.object_type AND e.to_object_id = ro.object_id)
               )
          )
        ORDER BY ro.object_id
        LIMIT $3`,
      [spaceId, objectTypes, limit],
    );
    return result.rows;
  }

  private async detectThin(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    limit: number,
  ): Promise<ObjectRow[]> {
    const result = await this.db.query<ObjectRow>(
      `SELECT ro.object_type, ro.object_id
         FROM retrieval_objects ro
         LEFT JOIN retrieval_chunks rc ON rc.retrieval_object_id = ro.id
        WHERE ro.space_id = $1
          AND ro.object_type = ANY($2::retrieval_object_type[])
        GROUP BY ro.id, ro.object_type, ro.object_id
       HAVING COALESCE(SUM(length(rc.plain_text)), 0) < $3
        ORDER BY ro.object_id
        LIMIT $4`,
      [spaceId, objectTypes, this.config.thinTextChars, limit],
    );
    return result.rows;
  }

  private async detectStale(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    limit: number,
  ): Promise<ObjectRow[]> {
    // Uses source_updated_at (canonical content freshness), NOT updated_at/
    // indexed_at (reindex time); rows without a canonical timestamp are skipped.
    const result = await this.db.query<ObjectRow>(
      `SELECT object_type, object_id
         FROM retrieval_objects
        WHERE space_id = $1
          AND object_type = ANY($2::retrieval_object_type[])
          AND source_updated_at IS NOT NULL
          AND source_updated_at < now() - ($3 || ' days')::interval
        ORDER BY source_updated_at ASC
        LIMIT $4`,
      [spaceId, objectTypes, this.config.staleAfterDays, limit],
    );
    return result.rows;
  }

  private async detectRelationSuggestions(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    limit: number,
  ): Promise<RelationRow[]> {
    const result = await this.db.query<RelationRow>(
      `SELECT from_object_type, from_object_id, to_object_type, to_object_id, link_type
         FROM retrieval_edges
        WHERE space_id = $1
          AND edge_status = 'suggested'
          AND from_object_type = ANY($2::retrieval_object_type[])
          AND to_object_type = ANY($2::retrieval_object_type[])
        ORDER BY from_object_id, to_object_id
        LIMIT $3`,
      [spaceId, objectTypes, limit],
    );
    return result.rows;
  }

  /**
   * Keys (`type:id`) that pass the source-connection read policy for the viewer.
   * An object with no source connection ids is always allowed; an object with
   * source ids requires every named connection to grant the viewer read access
   * (fail-closed: a missing/malformed snapshot denies), mirroring search's
   * `enforceSourceReadPolicy`.
   */
  private async loadSourceAllowedKeys(
    spaceId: string,
    viewerUserId: string,
    refs: ReadonlyArray<{ object_type: RetrievalObjectType; object_id: string }>,
  ): Promise<Set<string>> {
    const keys = [...new Set(refs.map((ref) => `${ref.object_type}:${ref.object_id}`))];
    if (keys.length === 0) return new Set();
    const rows = await this.db.query<{ object_type: string; object_id: string; source_connection_ids_json: unknown }>(
      `SELECT object_type, object_id, source_connection_ids_json
         FROM retrieval_objects
        WHERE space_id = $1
          AND (object_type || ':' || object_id) = ANY($2::text[])`,
      [spaceId, keys],
    );
    const sourceIdsByKey = new Map<string, string[]>();
    const allSourceIds = new Set<string>();
    for (const row of rows.rows) {
      const ids = sourceConnectionIdsFromJson(row.source_connection_ids_json);
      sourceIdsByKey.set(`${row.object_type}:${row.object_id}`, ids);
      for (const id of ids) allSourceIds.add(id);
    }
    const [snapshots, viewerSpaceRole] = allSourceIds.size
      ? await Promise.all([
          loadSourcePolicySnapshots(this.db, spaceId, [...allSourceIds]),
          loadViewerSpaceRole(this.db, spaceId, viewerUserId),
        ])
      : [new Map(), null as string | null];
    const allowed = new Set<string>();
    for (const key of keys) {
      const ids = sourceIdsByKey.get(key) ?? [];
      const ok = ids.every((sourceId) => {
        const snapshot = snapshots.get(sourceId);
        return snapshot ? sourcePolicyAllowsRead(snapshot, { viewerUserId, viewerSpaceRole }) : false;
      });
      if (ok) allowed.add(key);
    }
    return allowed;
  }

  /** Revalidate the referenced objects through the registered adapter gate. */
  private async revalidate(
    spaceId: string,
    viewerUserId: string,
    refs: ReadonlyArray<{ object_type: RetrievalObjectType; object_id: string }>,
  ): Promise<Map<string, RevalidatedObject>> {
    const byType = new Map<RetrievalObjectType, Set<string>>();
    for (const ref of refs) {
      const ids = byType.get(ref.object_type) ?? new Set<string>();
      ids.add(ref.object_id);
      byType.set(ref.object_type, ids);
    }
    const cache = new Map<string, RevalidatedObject>();
    for (const [objectType, idSet] of byType) {
      const adapter = this.registry.adapterFor(objectType);
      if (!adapter) continue;
      const ids = [...idSet];
      if (adapter.revalidateMany) {
        const readable = await adapter.revalidateMany(this.db, spaceId, objectType, ids, viewerUserId);
        for (const [id, row] of readable) cache.set(`${objectType}:${id}`, row);
      } else {
        for (const id of ids) {
          const row = await adapter.revalidate(this.db, spaceId, objectType, id, viewerUserId);
          if (row) cache.set(`${objectType}:${id}`, row);
        }
      }
    }
    return cache;
  }
}

function relationSuggestionAction(
  from: MaintenanceObjectRef,
  to: MaintenanceObjectRef,
  linkType: string,
  reason: string,
): Record<string, unknown> | null {
  if (from.object_type !== "knowledge_item" || to.object_type !== "knowledge_item") return null;
  return {
    proposal_type: "object_relation_create",
    title: `Relate: ${from.title} -> ${to.title}`,
    payload: {
      operation: "object_relation_create",
      from_object_id: from.object_id,
      to_object_id: to.object_id,
      link_type: linkType,
      status: "candidate",
      confidence: null,
      evidence_summary: reason,
      metadata: {
        candidate_origin: "retrieval_maintenance",
        endpoint_type: "knowledge_item",
      },
    },
  };
}
