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
 * Inquiry graph producer and Combined Project graph composer (plan section
 * graph projection). Threads are never `space_objects` rows (ADR 0011), so this
 * producer queries `inquiry_threads`/`inquiry_thread_relations` directly
 * instead of going through `GraphProjectionRepository`, which only knows
 * about `space_objects`/`object_relations`. The composer simply unions this
 * producer's projection with the existing `space_objects`-based one — Graph
 * remains a reusable renderer/projection contract, never a write authority,
 * and this module never writes to either substrate.
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
      `SELECT id, kind, statement, lifecycle_status, attention_state, updated_at
         FROM inquiry_threads
        WHERE space_id = $1 AND project_id = $2 AND lifecycle_status <> 'superseded'
        ORDER BY created_at ASC, id ASC
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
      `SELECT id, from_thread_id, to_thread_id, relation_kind
         FROM inquiry_thread_relations
        WHERE space_id = $1 AND project_id = $2`,
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

  // Unions this producer's projection with the existing Project-scoped
  // space_objects/object_relations projection (e.g. academic sources,
  // Notes, Knowledge). Both domains use the repository-wide globally unique
  // id convention, so the union preserves their canonical ids.
  async getCombinedProjectGraph(
    identity: SpaceUserIdentity,
    projectId: string,
    options: { limit: number },
  ): Promise<GraphProjection> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const inquiryGraph = await this.getInquiryGraph(identity, projectId, {
      limit: options.limit,
    });
    const objectBudget = Math.max(0, options.limit - inquiryGraph.nodes.length);
    const objectRepository = new GraphProjectionRepository(this.db);
    const objectGraph = objectBudget === 0
      ? emptyObjectGraph(await objectRepository.countVisibleObjects(identity, { projectId }))
      : await new GraphProjectionBuilder(objectRepository).build(identity, {
        mode: "global",
        projectId,
        limit: objectBudget,
        includeClusters: false,
      });
    const nodes = [...inquiryGraph.nodes, ...objectGraph.nodes];
    const edges = [...inquiryGraph.edges, ...objectGraph.edges];
    return {
      nodes,
      edges,
      view: {
        mode: "global",
        limit: options.limit,
        generatedAt: new Date().toISOString(),
        truncated: Boolean(inquiryGraph.view.truncated || objectGraph.view.truncated),
        totalNodeCount:
          (inquiryGraph.view.totalNodeCount ?? inquiryGraph.nodes.length)
          + (objectGraph.view.totalNodeCount ?? objectGraph.nodes.length),
      },
      layout: { mode: "force" },
    };
  }
}

function emptyObjectGraph(totalNodeCount: number): GraphProjection {
  return {
    nodes: [],
    edges: [],
    view: {
      mode: "global",
      limit: 0,
      generatedAt: new Date().toISOString(),
      truncated: totalNodeCount > 0,
      totalNodeCount,
    },
    layout: { mode: "force" },
  };
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
