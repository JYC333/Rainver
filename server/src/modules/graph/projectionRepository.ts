import { objectStatusScalarSql } from "../../db/objectStatusSql";
import { contentReadSql } from "../access/contentAccessSql";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";

export interface GraphObjectRow {
  id: string;
  object_type: string;
  title: string;
  summary: string | null;
  status: string;
  updated_at: Date | string;
  degree: number;
  depth?: number;
  matched?: boolean;
}

export interface GraphEdgeRow {
  id: string;
  from_object_id: string;
  to_object_id: string;
  link_type: string;
  confidence: number | null;
  evidence_summary: string | null;
  updated_at: Date | string;
}

export interface KindCountRow {
  kind: string;
  total: number;
}

export interface ClusterEdgeSummaryRow {
  source_kind: string;
  target_kind: string;
  link_type: string;
  weight: number;
}

export interface PagedRows<T> {
  rows: T[];
  total: number;
  truncated?: boolean;
}

interface FilterOptions {
  nodeKinds?: readonly string[];
  edgeKinds?: readonly string[];
  projectId?: string;
}

export class GraphProjectionRepository {
  constructor(private readonly db: Queryable) {}

  async getVisibleObject(
    identity: SpaceUserIdentity,
    objectId: string,
    options: Pick<FilterOptions, "projectId"> = {},
  ): Promise<GraphObjectRow | null> {
    const params: unknown[] = [identity.spaceId, identity.userId, objectId];
    const projectCorpusClause = pushProjectCorpusClause(params, "so", options.projectId);
    const rows = await this.db.query<GraphObjectRow>(
      `SELECT so.id, so.object_type, so.title, so.summary, ${objectStatusScalarSql("so")} AS status, so.updated_at,
              0::int AS degree
         FROM space_objects so
        WHERE so.space_id = $1
          AND so.id = $3
          AND ${activeObjectClause("so")}
          AND ${contentReadSql("space_object", "so", "$2")}
          ${projectCorpusClause}`,
      params,
    );
    return rows.rows[0] ?? null;
  }

  async countVisibleObjects(
    identity: SpaceUserIdentity,
    options: Pick<FilterOptions, "nodeKinds" | "projectId"> = {},
  ): Promise<number> {
    const params: unknown[] = [identity.spaceId, identity.userId];
    const kindClause = pushArrayClause(params, "so.object_type", options.nodeKinds);
    const projectCorpusClause = pushProjectCorpusClause(params, "so", options.projectId);
    const row = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM space_objects so
        WHERE so.space_id = $1
          AND ${activeObjectClause("so")}
          AND ${contentReadSql("space_object", "so", "$2")}
          ${kindClause}
          ${projectCorpusClause}`,
      params,
    );
    return numberFromPg(row.rows[0]?.total);
  }

  async listKindCounts(
    identity: SpaceUserIdentity,
    options: Pick<FilterOptions, "nodeKinds" | "projectId"> = {},
  ): Promise<KindCountRow[]> {
    const params: unknown[] = [identity.spaceId, identity.userId];
    const kindClause = pushArrayClause(params, "so.object_type", options.nodeKinds);
    const projectCorpusClause = pushProjectCorpusClause(params, "so", options.projectId);
    const rows = await this.db.query<{ kind: string; total: string }>(
      `SELECT so.object_type AS kind, count(*)::text AS total
         FROM space_objects so
        WHERE so.space_id = $1
          AND ${activeObjectClause("so")}
          AND ${contentReadSql("space_object", "so", "$2")}
          ${kindClause}
          ${projectCorpusClause}
        GROUP BY so.object_type
        ORDER BY total DESC, so.object_type ASC`,
      params,
    );
    return rows.rows.map((row) => ({ kind: row.kind, total: numberFromPg(row.total) }));
  }

  async listHubObjects(
    identity: SpaceUserIdentity,
    options: FilterOptions & { limit: number },
  ): Promise<GraphObjectRow[]> {
    const params: unknown[] = [identity.spaceId, identity.userId, options.limit];
    const nodeKindClause = pushArrayClause(params, "so.object_type", options.nodeKinds);
    const edgeKindClause = pushArrayClause(params, "r.link_type", options.edgeKinds);
    const projectCorpusClause = pushProjectCorpusClause(params, "so", options.projectId);
    const rows = await this.db.query<GraphObjectRow>(
      `WITH visible_objects AS (
         SELECT so.id, so.object_type, so.title, so.summary, ${objectStatusScalarSql("so")} AS status, so.updated_at
           FROM space_objects so
          WHERE so.space_id = $1
            AND ${activeObjectClause("so")}
            AND ${contentReadSql("space_object", "so", "$2")}
            ${nodeKindClause}
            ${projectCorpusClause}
       ),
       visible_edges AS (
         SELECT r.from_object_id, r.to_object_id
           FROM object_relations r
           JOIN visible_objects from_so ON from_so.id = r.from_object_id
           JOIN visible_objects to_so ON to_so.id = r.to_object_id
          WHERE r.space_id = $1
            AND r.status = 'active'
            ${edgeKindClause}
       ),
       degree_counts AS (
         SELECT object_id, count(*)::int AS degree
           FROM (
             SELECT from_object_id AS object_id FROM visible_edges
             UNION ALL
             SELECT to_object_id AS object_id FROM visible_edges
           ) edges
          GROUP BY object_id
       )
       SELECT vo.id, vo.object_type, vo.title, vo.summary, vo.status, vo.updated_at,
              COALESCE(dc.degree, 0)::int AS degree
         FROM visible_objects vo
         LEFT JOIN degree_counts dc ON dc.object_id = vo.id
        ORDER BY COALESCE(dc.degree, 0) DESC, vo.updated_at DESC, vo.id ASC
        LIMIT $3`,
      params,
    );
    return rows.rows;
  }

  async listRecentObjects(
    identity: SpaceUserIdentity,
    options: Pick<FilterOptions, "nodeKinds" | "projectId"> & { limit: number },
  ): Promise<GraphObjectRow[]> {
    const params: unknown[] = [identity.spaceId, identity.userId, options.limit];
    const nodeKindClause = pushArrayClause(params, "so.object_type", options.nodeKinds);
    const projectCorpusClause = pushProjectCorpusClause(params, "so", options.projectId);
    const rows = await this.db.query<GraphObjectRow>(
      `SELECT so.id, so.object_type, so.title, so.summary, ${objectStatusScalarSql("so")} AS status, so.updated_at,
              0::int AS degree
         FROM space_objects so
        WHERE so.space_id = $1
          AND ${activeObjectClause("so")}
          AND ${contentReadSql("space_object", "so", "$2")}
          ${nodeKindClause}
          ${projectCorpusClause}
        ORDER BY so.updated_at DESC, so.id ASC
        LIMIT $3`,
      params,
    );
    return rows.rows;
  }

  async listClusterEdgeSummaries(
    identity: SpaceUserIdentity,
    options: FilterOptions = {},
  ): Promise<ClusterEdgeSummaryRow[]> {
    const params: unknown[] = [identity.spaceId, identity.userId];
    const nodeKindClause = pushArrayClause(params, "from_so.object_type", options.nodeKinds);
    const targetNodeKindClause = pushArrayClause(params, "to_so.object_type", options.nodeKinds);
    const edgeKindClause = pushArrayClause(params, "r.link_type", options.edgeKinds);
    const fromProjectCorpusClause = pushProjectCorpusClause(params, "from_so", options.projectId);
    const toProjectCorpusClause = pushProjectCorpusClause(params, "to_so", options.projectId);
    const rows = await this.db.query<{
      source_kind: string;
      target_kind: string;
      link_type: string;
      weight: string;
    }>(
      `SELECT from_so.object_type AS source_kind,
              to_so.object_type AS target_kind,
              r.link_type,
              count(*)::text AS weight
         FROM object_relations r
         JOIN space_objects from_so
           ON from_so.id = r.from_object_id
          AND from_so.space_id = r.space_id
          AND ${activeObjectClause("from_so")}
         JOIN space_objects to_so
           ON to_so.id = r.to_object_id
          AND to_so.space_id = r.space_id
          AND ${activeObjectClause("to_so")}
        WHERE r.space_id = $1
          AND r.status = 'active'
          AND ${contentReadSql("space_object", "from_so", "$2")}
          AND ${contentReadSql("space_object", "to_so", "$2")}
          AND from_so.object_type <> to_so.object_type
          ${nodeKindClause}
          ${targetNodeKindClause}
          ${edgeKindClause}
          ${fromProjectCorpusClause}
          ${toProjectCorpusClause}
        GROUP BY from_so.object_type, to_so.object_type, r.link_type
        ORDER BY count(*) DESC, from_so.object_type ASC, to_so.object_type ASC
        LIMIT 500`,
      params,
    );
    return rows.rows.map((row) => ({
      source_kind: row.source_kind,
      target_kind: row.target_kind,
      link_type: row.link_type,
      weight: numberFromPg(row.weight),
    }));
  }

  async listEdgesForNodeIds(
    identity: SpaceUserIdentity,
    nodeIds: readonly string[],
    options: Pick<FilterOptions, "edgeKinds"> & { limit: number },
  ): Promise<GraphEdgeRow[]> {
    if (nodeIds.length === 0) return [];
    const params: unknown[] = [identity.spaceId, identity.userId, nodeIds, options.limit];
    const edgeKindClause = pushArrayClause(params, "r.link_type", options.edgeKinds);
    const rows = await this.db.query<GraphEdgeRow>(
      `SELECT r.id, r.from_object_id, r.to_object_id, r.link_type,
              r.confidence, r.evidence_summary, r.updated_at
         FROM object_relations r
         JOIN space_objects from_so
           ON from_so.id = r.from_object_id
          AND from_so.space_id = r.space_id
          AND ${activeObjectClause("from_so")}
         JOIN space_objects to_so
           ON to_so.id = r.to_object_id
          AND to_so.space_id = r.space_id
          AND ${activeObjectClause("to_so")}
        WHERE r.space_id = $1
          AND r.status = 'active'
          AND r.from_object_id = ANY($3::varchar[])
          AND r.to_object_id = ANY($3::varchar[])
          AND ${contentReadSql("space_object", "from_so", "$2")}
          AND ${contentReadSql("space_object", "to_so", "$2")}
          ${edgeKindClause}
        ORDER BY COALESCE(r.confidence, 0) DESC, r.updated_at DESC, r.id ASC
        LIMIT $4`,
      params,
    );
    return rows.rows;
  }

  async listLocalObjects(
    identity: SpaceUserIdentity,
    rootId: string,
    options: FilterOptions & { depth: number; limit: number },
  ): Promise<PagedRows<GraphObjectRow>> {
    const perHopLimit = perHopCap(options.limit);
    const params: unknown[] = [
      identity.spaceId,
      identity.userId,
      rootId,
      options.depth,
      options.limit,
      perHopLimit,
    ];
    const edgeKindClause = pushArrayClause(params, "r.link_type", options.edgeKinds);
    const nodeKindClause = pushArrayClause(params, "so.object_type", options.nodeKinds);
    const projectCorpusClause = pushProjectCorpusClause(params, "so", options.projectId);
    const rows = await this.db.query<GraphObjectRow & { total_count: string; cap_hit: boolean }>(
      `WITH visible_objects AS (
         SELECT so.id, so.object_type, so.title, so.summary, ${objectStatusScalarSql("so")} AS status, so.updated_at
           FROM space_objects so
          WHERE so.space_id = $1
            AND ${activeObjectClause("so")}
            AND ${contentReadSql("space_object", "so", "$2")}
            ${nodeKindClause ? `AND (so.id = $3 OR ${nodeKindClause.replace(/^ AND /, "")})` : ""}
            ${projectCorpusClause}
       ),
       visible_edges AS (
         SELECT r.from_object_id, r.to_object_id, r.updated_at
           FROM object_relations r
           JOIN visible_objects from_so ON from_so.id = r.from_object_id
           JOIN visible_objects to_so ON to_so.id = r.to_object_id
          WHERE r.space_id = $1
            AND r.status = 'active'
            ${edgeKindClause}
       ),
       root_node AS (
         SELECT $3::varchar AS node_id, 0 AS depth
          WHERE EXISTS (SELECT 1 FROM visible_objects WHERE id = $3)
       ),
       first_ranked AS (
         SELECT CASE WHEN e.from_object_id = $3 THEN e.to_object_id ELSE e.from_object_id END AS node_id,
                row_number() OVER (
                  ORDER BY e.updated_at DESC,
                           CASE WHEN e.from_object_id = $3 THEN e.to_object_id ELSE e.from_object_id END ASC
                ) AS rn
           FROM visible_edges e
          WHERE e.from_object_id = $3 OR e.to_object_id = $3
       ),
       first_frontier AS (
         SELECT node_id, 1 AS depth
           FROM first_ranked
          WHERE rn <= $6
       ),
       second_ranked AS (
         SELECT CASE WHEN e.from_object_id = f.node_id THEN e.to_object_id ELSE e.from_object_id END AS node_id,
                row_number() OVER (
                  PARTITION BY f.node_id
                  ORDER BY e.updated_at DESC,
                           CASE WHEN e.from_object_id = f.node_id THEN e.to_object_id ELSE e.from_object_id END ASC
                ) AS rn
           FROM first_frontier f
           JOIN visible_edges e ON e.from_object_id = f.node_id OR e.to_object_id = f.node_id
          WHERE $4 >= 2
            AND CASE WHEN e.from_object_id = f.node_id THEN e.to_object_id ELSE e.from_object_id END <> $3
       ),
       second_frontier AS (
         SELECT node_id, 2 AS depth
           FROM second_ranked
          WHERE rn <= $6
       ),
       walk AS (
         SELECT node_id, depth FROM root_node
         UNION ALL
         SELECT node_id, depth FROM first_frontier
         UNION ALL
         SELECT node_id, depth FROM second_frontier
       ),
       min_walk AS (
         SELECT node_id, min(depth)::int AS depth
           FROM walk
          GROUP BY node_id
       ),
       degree_counts AS (
         SELECT object_id, count(*)::int AS degree
           FROM (
             SELECT from_object_id AS object_id FROM visible_edges
             UNION ALL
             SELECT to_object_id AS object_id FROM visible_edges
           ) edges
          GROUP BY object_id
       ),
       filtered AS (
         SELECT vo.id, vo.object_type, vo.title, vo.summary, vo.status, vo.updated_at,
                COALESCE(dc.degree, 0)::int AS degree, mw.depth
           FROM min_walk mw
          JOIN visible_objects vo ON vo.id = mw.node_id
           LEFT JOIN degree_counts dc ON dc.object_id = vo.id
       ),
       cap_state AS (
         SELECT (
           EXISTS (SELECT 1 FROM first_ranked WHERE rn > $6)
           OR EXISTS (SELECT 1 FROM second_ranked WHERE rn > $6)
         ) AS cap_hit
       )
       SELECT filtered.*, count(*) OVER()::text AS total_count, cap_state.cap_hit
         FROM filtered
         CROSS JOIN cap_state
        ORDER BY depth ASC, degree DESC, updated_at DESC, id ASC
        LIMIT $5`,
      params,
    );
    return {
      rows: rows.rows,
      total: rows.rows.length ? numberFromPg(rows.rows[0]?.total_count) : 0,
      truncated: rows.rows.some((row) => row.cap_hit),
    };
  }

  async listClusterObjects(
    identity: SpaceUserIdentity,
    kind: string,
    options: { limit: number; projectId?: string; edgeKinds?: readonly string[] },
  ): Promise<PagedRows<GraphObjectRow>> {
    const params: unknown[] = [identity.spaceId, identity.userId, kind, options.limit];
    const projectCorpusClause = pushProjectCorpusClause(params, "so", options.projectId);
    const edgeKindClause = pushArrayClause(params, "r.link_type", options.edgeKinds);
    const rows = await this.db.query<GraphObjectRow & { total_count: string }>(
      `WITH visible_objects AS (
         SELECT so.id, so.object_type, so.title, so.summary, ${objectStatusScalarSql("so")} AS status, so.updated_at
           FROM space_objects so
          WHERE so.space_id = $1
            AND so.object_type = $3
            AND ${activeObjectClause("so")}
            AND ${contentReadSql("space_object", "so", "$2")}
            ${projectCorpusClause}
       ),
       visible_edges AS (
         SELECT r.from_object_id, r.to_object_id
           FROM object_relations r
           JOIN visible_objects from_so ON from_so.id = r.from_object_id
           JOIN visible_objects to_so ON to_so.id = r.to_object_id
         WHERE r.space_id = $1
           AND r.status = 'active'
           ${edgeKindClause}
       ),
       degree_counts AS (
         SELECT object_id, count(*)::int AS degree
           FROM (
             SELECT from_object_id AS object_id FROM visible_edges
             UNION ALL
             SELECT to_object_id AS object_id FROM visible_edges
           ) edges
          GROUP BY object_id
       )
       SELECT vo.id, vo.object_type, vo.title, vo.summary, vo.status, vo.updated_at,
              COALESCE(dc.degree, 0)::int AS degree, count(*) OVER()::text AS total_count
         FROM visible_objects vo
         LEFT JOIN degree_counts dc ON dc.object_id = vo.id
        ORDER BY degree DESC, vo.updated_at DESC, vo.id ASC
        LIMIT $4`,
      params,
    );
    return {
      rows: rows.rows,
      total: rows.rows.length ? numberFromPg(rows.rows[0]?.total_count) : 0,
    };
  }

  async listSearchNeighborhood(
    identity: SpaceUserIdentity,
    search: string,
    options: FilterOptions & { limit: number },
  ): Promise<PagedRows<GraphObjectRow>> {
    const matchLimit = options.limit;
    const neighborLimit = perHopCap(options.limit);
    const params: unknown[] = [
      identity.spaceId,
      identity.userId,
      `%${escapeLike(search)}%`,
      options.limit,
      matchLimit,
      neighborLimit,
    ];
    const edgeKindClause = pushArrayClause(params, "r.link_type", options.edgeKinds);
    const nodeKindClause = pushArrayClause(params, "so.object_type", options.nodeKinds);
    const projectCorpusClause = pushProjectCorpusClause(params, "so", options.projectId);
    const rows = await this.db.query<GraphObjectRow & { total_count: string; cap_hit: boolean }>(
      `WITH visible_objects AS (
         SELECT so.id, so.object_type, so.title, so.summary, ${objectStatusScalarSql("so")} AS status, so.updated_at
           FROM space_objects so
          WHERE so.space_id = $1
            AND ${activeObjectClause("so")}
            AND ${contentReadSql("space_object", "so", "$2")}
            ${nodeKindClause}
            ${projectCorpusClause}
       ),
       matched_ranked AS (
         SELECT id,
                row_number() OVER (ORDER BY updated_at DESC, id ASC) AS rn
           FROM visible_objects
          WHERE title ILIKE $3 ESCAPE '\\'
             OR COALESCE(summary, '') ILIKE $3 ESCAPE '\\'
       ),
       matched AS (
         SELECT id
           FROM matched_ranked
          WHERE rn <= $5
       ),
       visible_edges AS (
         SELECT r.from_object_id, r.to_object_id, r.updated_at
           FROM object_relations r
           JOIN visible_objects from_so ON from_so.id = r.from_object_id
           JOIN visible_objects to_so ON to_so.id = r.to_object_id
          WHERE r.space_id = $1
            AND r.status = 'active'
            ${edgeKindClause}
       ),
       neighbor_ranked AS (
         SELECT CASE WHEN e.from_object_id = m.id THEN e.to_object_id ELSE e.from_object_id END AS node_id,
                false AS matched,
                row_number() OVER (
                  PARTITION BY m.id
                  ORDER BY e.updated_at DESC,
                           CASE WHEN e.from_object_id = m.id THEN e.to_object_id ELSE e.from_object_id END ASC
                ) AS rn
           FROM matched m
           JOIN visible_edges e ON e.from_object_id = m.id OR e.to_object_id = m.id
       ),
       candidate_ids AS (
         SELECT id AS node_id, true AS matched FROM matched
         UNION
         SELECT node_id, matched
           FROM neighbor_ranked
          WHERE rn <= $6
       ),
       deduped AS (
         SELECT node_id, bool_or(matched) AS matched
           FROM candidate_ids
          GROUP BY node_id
       ),
       degree_counts AS (
         SELECT object_id, count(*)::int AS degree
           FROM (
             SELECT from_object_id AS object_id FROM visible_edges
             UNION ALL
             SELECT to_object_id AS object_id FROM visible_edges
           ) edges
          GROUP BY object_id
       ),
       filtered AS (
         SELECT vo.id, vo.object_type, vo.title, vo.summary, vo.status, vo.updated_at,
                COALESCE(dc.degree, 0)::int AS degree, d.matched
           FROM deduped d
           JOIN visible_objects vo ON vo.id = d.node_id
           LEFT JOIN degree_counts dc ON dc.object_id = vo.id
       )
       SELECT *, count(*) OVER()::text AS total_count
              , (
                  EXISTS (SELECT 1 FROM matched_ranked WHERE rn > $5)
                  OR EXISTS (SELECT 1 FROM neighbor_ranked WHERE rn > $6)
                ) AS cap_hit
         FROM filtered
        ORDER BY matched DESC, degree DESC, updated_at DESC, id ASC
        LIMIT $4`,
      params,
    );
    return {
      rows: rows.rows,
      total: rows.rows.length ? numberFromPg(rows.rows[0]?.total_count) : 0,
      truncated: rows.rows.some((row) => row.cap_hit),
    };
  }
}

function pushArrayClause(
  params: unknown[],
  expression: string,
  values: readonly string[] | undefined,
): string {
  const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  if (!normalized.length) return "";
  params.push(normalized);
  return ` AND ${expression} = ANY($${params.length}::varchar[])`;
}

function pushProjectCorpusClause(
  params: unknown[],
  objectAlias: string,
  projectId: string | undefined,
): string {
  const normalized = projectId?.trim();
  if (!normalized) return "";
  params.push(normalized);
  // An object belongs to a Project either by being in its corpus or by
  // declaring it as its own Project. Only the first was checked, which was
  // invisible while every Project-scoped object was corpus material — Inquiry
  // Threads are the first that are not.
  return ` AND (${objectAlias}.primary_project_id = $${params.length} OR EXISTS (
    SELECT 1
      FROM project_corpus_items pci
     WHERE pci.space_id = ${objectAlias}.space_id
       AND pci.project_id = $${params.length}
       AND pci.object_id = ${objectAlias}.id
       AND pci.status = 'active'
  ))`;
}

function activeObjectClause(alias: string): string {
  // Graph projection is polymorphic over every object type, so it reads status
  // through the shared scalar helper rather than joining one extension table.
  // Note this is deliberately not `archived_at IS NULL`: those are not
  // equivalent (ADR 0012 / P1 notes).
  return `${alias}.deleted_at IS NULL AND ${objectStatusScalarSql(alias)} NOT IN ('archived', 'deleted')`;
}

function perHopCap(limit: number): number {
  return Math.max(25, Math.min(500, limit * 2));
}

function numberFromPg(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
