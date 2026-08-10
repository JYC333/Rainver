import type { GraphProjection, GraphProjectionEdge, GraphProjectionNode } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import { getDbPool } from "../../db/pool";
import { assertProjectReadable } from "../projects/access";
import { GraphProjectionBuilder } from "../graph/projectionBuilder";
import { GraphProjectionRepository } from "../graph/projectionRepository";

interface ThreadNodeRow {
  id: string;
  kind: string;
  statement: string;
  lifecycle_status: string;
  attention_state: string;
  updated_at: unknown;
}

const DEFAULT_GRAPH_LIMIT = 300;

interface RelationEdgeRow {
  id: string;
  from_thread_id: string;
  to_thread_id: string;
  relation_kind: string;
}

/**
 * Inquiry graph producer (plan section graph projection).
 *
 * Threads are `space_objects` rows and their edges are `object_relations`
 * (ADR 0011 decision 1/3), so this reads the same substrate as every other
 * domain. It still exists as a producer because Inquiry adds domain metadata to
 * each node — lifecycle and attention state — that the generic projection has
 * no reason to know about. It never writes.
 */
export class InquiryGraphService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): InquiryGraphService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new InquiryGraphService(getDbPool(config.databaseUrl));
  }

  async getInquiryGraph(
    identity: SpaceUserIdentity,
    projectId: string,
    options: { limit: number } = { limit: DEFAULT_GRAPH_LIMIT },
  ): Promise<GraphProjection> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const [threads, total] = await Promise.all([
      this.db.query<ThreadNodeRow>(
      `SELECT t.object_id AS id, t.kind, t.statement, t.lifecycle_status, t.attention_state, so.updated_at
         FROM inquiry_threads t
         JOIN space_objects so ON so.id = t.object_id AND so.space_id = t.space_id
        WHERE t.space_id = $1 AND t.project_id = $2 AND t.lifecycle_status <> 'superseded'
        ORDER BY so.created_at ASC, t.object_id ASC
        LIMIT $3`,
      [identity.spaceId, projectId, options.limit],
      ),
      this.db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM inquiry_threads
          WHERE space_id=$1 AND project_id=$2 AND lifecycle_status <> 'superseded'`,
        [identity.spaceId, projectId],
      ),
    ]);
    const threadIds = new Set(threads.rows.map((row) => row.id));
    const relations = await this.db.query<RelationEdgeRow>(
      `SELECT r.id, r.from_object_id AS from_thread_id, r.to_object_id AS to_thread_id,
              r.link_type AS relation_kind
         FROM object_relations r
         JOIN inquiry_threads ft ON ft.object_id = r.from_object_id AND ft.space_id = r.space_id
         JOIN inquiry_threads tt ON tt.object_id = r.to_object_id AND tt.space_id = r.space_id
        WHERE r.space_id = $1 AND r.status = 'active'
          AND ft.project_id = $2 AND tt.project_id = $2`,
      [identity.spaceId, projectId],
    );

    const nodes: GraphProjectionNode[] = threads.rows.map((row) => ({
      id: row.id,
      kind: row.kind === "question" ? "inquiry_question" : "inquiry_hypothesis",
      label: row.statement,
      metadata: {
        lifecycleStatus: row.lifecycle_status,
        attentionState: row.attention_state,
        updatedAt: isoOrNull(row.updated_at),
      },
    }));
    // Working relations only (plan section 9.3: "working Project relations,
    // not proposal-gated canonical Ontology relations") — every edge this
    // producer emits is tagged `tier: "working"` so a combined view can
    // visually distinguish it from canonical/derived edges sourced elsewhere.
    const edges: GraphProjectionEdge[] = relations.rows
      .filter((row) => threadIds.has(row.from_thread_id) && threadIds.has(row.to_thread_id))
      .map((row) => ({
        id: row.id,
        source: row.from_thread_id,
        target: row.to_thread_id,
        kind: row.relation_kind,
        metadata: { tier: "working" },
      }));

    return {
      nodes,
      edges,
      view: {
        mode: "local",
        limit: nodes.length,
        generatedAt: new Date().toISOString(),
        truncated: (total.rows[0]?.count ?? 0) > nodes.length,
        totalNodeCount: total.rows[0]?.count ?? nodes.length,
      },
      layout: { mode: "force" },
    };
  }
  /**
   * The Project graph.
   *
   * This used to union an Inquiry-specific projection with the
   * `space_objects`/`object_relations` one, because Threads lived outside the
   * ontology and the generic projection could not see them. They are ontology
   * objects now, so the generic projection already covers them — keeping the
   * union would double every Thread node.
   */
  async getCombinedProjectGraph(
    identity: SpaceUserIdentity,
    projectId: string,
    options: { limit: number },
  ): Promise<GraphProjection> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const objectRepository = new GraphProjectionRepository(this.db);
    return new GraphProjectionBuilder(objectRepository).build(identity, {
      mode: "global",
      projectId,
      limit: options.limit,
      includeClusters: false,
    });
  }
}


function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
