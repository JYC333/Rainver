import { graphableEntityTypes } from "../ontology/entities.js";
import type {
  GraphProjection,
  GraphProjectionEdge,
  GraphProjectionNode,
  GraphProjectionViewMode,
} from "@rainver/protocol";
import type { SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";
import {
  GraphProjectionRepository,
  type ClusterEdgeSummaryRow,
  type GraphEdgeRow,
  type GraphObjectRow,
  type KindCountRow,
} from "./projectionRepository.js";

export type ServerGraphProjectionMode = Exclude<GraphProjectionViewMode, "debug">;
export type GraphLensId = "academic_citation_v1";

export interface BuildProjectionOptions {
  mode: ServerGraphProjectionMode;
  rootId?: string;
  depth?: number;
  nodeKinds?: readonly string[];
  edgeKinds?: readonly string[];
  q?: string;
  projectId?: string;
  lensId?: GraphLensId;
  limit: number;
  includeClusters: boolean;
}

const EDGE_CAP_MULTIPLIER = 3;
const NO_LENS_MATCH = "__graph_lens_no_match__";
/**
 * The graph renders what the ontology says is graphable (B12G). A lens narrows
 * that set; it cannot widen it into a type the registry never declared.
 */
function isGraphableKind(kind: string): boolean {
  return graphableEntityTypes().includes(kind);
}

const GRAPH_LENSES: Record<GraphLensId, { nodeKinds: readonly string[]; edgeKinds: readonly string[] }> = {
  academic_citation_v1: {
    nodeKinds: ["source", "person", "organization"],
    edgeKinds: ["cites", "authored_by", "affiliated_with"],
  },
};

export function parseGraphLensId(value: string | undefined): GraphLensId | undefined {
  if (!value) return undefined;
  if (value === "academic_citation_v1") return value;
  throw new HttpError(422, "invalid graph lens_id");
}

export function resolveGraphProjectionOptions(options: BuildProjectionOptions): BuildProjectionOptions {
  if (!options.lensId) return options;
  const lens = GRAPH_LENSES[options.lensId];
  return {
    ...options,
    nodeKinds: applyLensFilter(lens.nodeKinds, options.nodeKinds).filter(isGraphableKind),
    edgeKinds: applyLensFilter(lens.edgeKinds, options.edgeKinds),
  };
}

export class GraphProjectionBuilder {
  constructor(private readonly repository: GraphProjectionRepository) {}

  async build(
    identity: SpaceUserIdentity,
    options: BuildProjectionOptions,
  ): Promise<GraphProjection> {
    const resolved = resolveGraphProjectionOptions(options);
    switch (resolved.mode) {
      case "global":
        return this.globalProjection(identity, resolved);
      case "local":
        return this.localProjection(identity, resolved);
      case "cluster":
        return this.clusterProjection(identity, resolved);
      case "search":
        return this.searchProjection(identity, resolved);
    }
  }

  private async globalProjection(
    identity: SpaceUserIdentity,
    options: BuildProjectionOptions,
  ): Promise<GraphProjection> {
    const [totalNodeCount, kindCounts] = await Promise.all([
      this.repository.countVisibleObjects(identity, { nodeKinds: options.nodeKinds, projectId: options.projectId }),
      this.repository.listKindCounts(identity, { nodeKinds: options.nodeKinds, projectId: options.projectId }),
    ]);
    const allClusterNodes = options.includeClusters
      ? kindCounts.map(clusterNodeFromCount)
      : [];
    const clusterNodes = allClusterNodes.slice(0, options.limit);
    const surfaceBudget = Math.max(0, options.limit - clusterNodes.length);
    const hubBudget = Math.ceil(surfaceBudget * 0.6);
    const recentBudget = Math.max(0, surfaceBudget - hubBudget);
    const [hubRows, recentRows, clusterEdges] = await Promise.all([
      this.repository.listHubObjects(identity, {
        nodeKinds: options.nodeKinds,
        edgeKinds: options.edgeKinds,
        projectId: options.projectId,
        limit: hubBudget,
      }),
      this.repository.listRecentObjects(identity, {
        nodeKinds: options.nodeKinds,
        projectId: options.projectId,
        limit: recentBudget,
      }),
      options.includeClusters
        ? this.repository.listClusterEdgeSummaries(identity, {
            nodeKinds: options.nodeKinds,
            edgeKinds: options.edgeKinds,
            projectId: options.projectId,
          })
        : Promise.resolve([]),
    ]);
    const surfaced = dedupeObjects([...hubRows, ...recentRows]).slice(0, surfaceBudget);
    const objectNodes = surfaced.map((row) => objectNode(row, { clusterId: clusterIdForKind(row.object_type) }));
    const nodeIds = new Set([...clusterNodes.map((node) => node.id), ...objectNodes.map((node) => node.id)]);
    const edgeLimit = edgeCap(options.limit);
    const nodeEdges = await this.repository.listEdgesForNodeIds(identity, surfaced.map((row) => row.id), {
      edgeKinds: options.edgeKinds,
      limit: edgeLimit + 1,
    });
    const edgeCandidates = [
      ...clusterEdges.map(clusterSummaryEdge).filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
      ...clusterContainsEdges(surfaced).filter((edge) =>
        nodeIds.has(edge.source) && nodeIds.has(edge.target) && edgeKindAllowed(edge.kind, options.edgeKinds)
      ),
      ...nodeEdges.map(objectEdge).filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    ];
    const edges = capEdgesByWeight(edgeCandidates, edgeLimit);

    return {
      nodes: [...clusterNodes, ...objectNodes],
      edges,
      view: {
        mode: "global",
        limit: options.limit,
        generatedAt: new Date().toISOString(),
        truncated:
          totalNodeCount > surfaced.length ||
          allClusterNodes.length > clusterNodes.length ||
          edgeCandidates.length > edgeLimit,
        totalNodeCount,
      },
      layout: { mode: options.includeClusters ? "clustered" : "force" },
    };
  }

  private async localProjection(
    identity: SpaceUserIdentity,
    options: BuildProjectionOptions,
  ): Promise<GraphProjection> {
    const rootId = requiredRootId(options.rootId, "root_id is required for local graph mode");
    const depth = normalizeDepth(options.depth);
    const result = await this.repository.listLocalObjects(identity, rootId, {
      depth,
      limit: options.limit,
      nodeKinds: options.nodeKinds,
      edgeKinds: options.edgeKinds,
      projectId: options.projectId,
    });
    if (!result.rows.length) throw new HttpError(404, "Graph root not found");
    const nodes = result.rows.map((row) => objectNode(row, { clusterId: clusterIdForKind(row.object_type) }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edgeLimit = edgeCap(options.limit);
    const edgeCandidates = (await this.repository.listEdgesForNodeIds(identity, nodes.map((node) => node.id), {
      edgeKinds: options.edgeKinds,
      limit: edgeLimit + 1,
    }))
      .map(objectEdge)
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    const edges = edgeCandidates.slice(0, edgeLimit);

    return {
      nodes,
      edges,
      view: {
        mode: "local",
        rootId,
        depth,
        limit: options.limit,
        generatedAt: new Date().toISOString(),
        truncated: result.truncated === true || result.total > nodes.length || edgeCandidates.length > edgeLimit,
        totalNodeCount: result.total,
      },
      layout: { mode: "force" },
    };
  }

  private async clusterProjection(
    identity: SpaceUserIdentity,
    options: BuildProjectionOptions,
  ): Promise<GraphProjection> {
    const rootId = requiredRootId(options.rootId, "root_id is required for cluster graph mode");
    const kind = await this.clusterKindForRoot(identity, rootId, options.projectId);
    if (options.nodeKinds?.length && !options.nodeKinds.includes(kind)) {
      return emptyProjection("cluster", options, rootId, "clustered");
    }
    const result = await this.repository.listClusterObjects(identity, kind, {
      limit: options.limit,
      projectId: options.projectId,
      edgeKinds: options.edgeKinds,
    });
    const nodes = result.rows.map((row) => objectNode(row, { clusterId: clusterIdForKind(row.object_type) }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edgeLimit = edgeCap(options.limit);
    const edgeCandidates = (await this.repository.listEdgesForNodeIds(identity, nodes.map((node) => node.id), {
      edgeKinds: options.edgeKinds,
      limit: edgeLimit + 1,
    }))
      .map(objectEdge)
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    const edges = edgeCandidates.slice(0, edgeLimit);

    return {
      nodes,
      edges,
      view: {
        mode: "cluster",
        rootId,
        limit: options.limit,
        generatedAt: new Date().toISOString(),
        truncated: result.total > nodes.length || edgeCandidates.length > edgeLimit,
        totalNodeCount: result.total,
      },
      layout: { mode: "clustered" },
    };
  }

  private async searchProjection(
    identity: SpaceUserIdentity,
    options: BuildProjectionOptions,
  ): Promise<GraphProjection> {
    const search = options.q?.trim();
    if (!search) throw new HttpError(422, "q is required for search graph mode");
    const result = await this.repository.listSearchNeighborhood(identity, search, {
      limit: options.limit,
      nodeKinds: options.nodeKinds,
      edgeKinds: options.edgeKinds,
      projectId: options.projectId,
    });
    const nodes = result.rows.map((row) =>
      objectNode(row, {
        clusterId: clusterIdForKind(row.object_type),
        forceLabel: row.matched === true,
      }),
    );
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edgeLimit = edgeCap(options.limit);
    const edgeCandidates = (await this.repository.listEdgesForNodeIds(identity, nodes.map((node) => node.id), {
      edgeKinds: options.edgeKinds,
      limit: edgeLimit + 1,
    }))
      .map(objectEdge)
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    const edges = edgeCandidates.slice(0, edgeLimit);

    return {
      nodes,
      edges,
      view: {
        mode: "search",
        limit: options.limit,
        generatedAt: new Date().toISOString(),
        truncated: result.truncated === true || result.total > nodes.length || edgeCandidates.length > edgeLimit,
        totalNodeCount: result.total,
      },
      layout: { mode: "force" },
    };
  }

  private async clusterKindForRoot(
    identity: SpaceUserIdentity,
    rootId: string,
    projectId: string | undefined,
  ): Promise<string> {
    if (rootId.startsWith("cluster:")) return kindFromClusterRoot(rootId);
    const root = await this.repository.getVisibleObject(identity, rootId, { projectId });
    if (!root) throw new HttpError(404, "Graph cluster root not found");
    return root.object_type;
  }
}

function objectNode(
  row: GraphObjectRow,
  options: { clusterId?: string; forceLabel?: boolean } = {},
): GraphProjectionNode {
  return {
    id: row.id,
    kind: row.object_type,
    label: row.title,
    subtitle: row.summary ? row.summary.slice(0, 160) : undefined,
    clusterId: options.clusterId,
    degree: row.degree,
    metadata: {
      status: row.status,
      updatedAt: iso(row.updated_at),
      depth: row.depth,
      forceLabel: options.forceLabel || undefined,
    },
  };
}

function emptyProjection(
  mode: ServerGraphProjectionMode,
  options: Pick<BuildProjectionOptions, "limit">,
  rootId: string | undefined,
  layoutMode: "force" | "clustered",
): GraphProjection {
  return {
    nodes: [],
    edges: [],
    view: {
      mode,
      rootId,
      limit: options.limit,
      generatedAt: new Date().toISOString(),
      truncated: false,
      totalNodeCount: 0,
    },
    layout: { mode: layoutMode },
  };
}

function applyLensFilter(
  allowed: readonly string[],
  requested: readonly string[] | undefined,
): readonly string[] {
  const normalized = [...new Set((requested ?? []).map((value) => value.trim()).filter(Boolean))];
  if (!normalized.length) return [...allowed];
  const allowedSet = new Set(allowed);
  const intersection = normalized.filter((value) => allowedSet.has(value));
  return intersection.length ? intersection : [NO_LENS_MATCH];
}

function objectEdge(row: GraphEdgeRow): GraphProjectionEdge {
  return {
    id: row.id,
    source: row.from_object_id,
    target: row.to_object_id,
    kind: row.link_type,
    weight: row.confidence ?? undefined,
    metadata: {
      evidenceSummary: row.evidence_summary ?? undefined,
      updatedAt: iso(row.updated_at),
    },
  };
}

function clusterNodeFromCount(row: KindCountRow): GraphProjectionNode {
  return {
    id: clusterIdForKind(row.kind),
    kind: "cluster",
    label: labelForKind(row.kind),
    subtitle: `${row.total} object${row.total === 1 ? "" : "s"}`,
    size: Math.min(84, 38 + Math.log2(row.total + 1) * 7),
    degree: row.total,
    collapsed: true,
    metadata: {
      clusterKind: row.kind,
      count: row.total,
    },
  };
}

function clusterSummaryEdge(row: ClusterEdgeSummaryRow): GraphProjectionEdge {
  return {
    id: `cluster-edge:${row.source_kind}:${row.target_kind}:${row.link_type}`,
    source: clusterIdForKind(row.source_kind),
    target: clusterIdForKind(row.target_kind),
    kind: row.link_type,
    weight: row.weight,
    metadata: {
      aggregated: true,
      count: row.weight,
    },
  };
}

function clusterContainsEdges(rows: readonly GraphObjectRow[]): GraphProjectionEdge[] {
  return rows.map((row) => ({
    id: `cluster-contains:${row.object_type}:${row.id}`,
    source: clusterIdForKind(row.object_type),
    target: row.id,
    kind: "cluster_contains",
    weight: 1,
    metadata: {
      aggregated: true,
    },
  }));
}

function edgeKindAllowed(kind: string, edgeKinds: readonly string[] | undefined): boolean {
  return !edgeKinds?.length || edgeKinds.includes(kind);
}

function dedupeObjects(rows: readonly GraphObjectRow[]): GraphObjectRow[] {
  const byId = new Map<string, GraphObjectRow>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (!existing || row.degree > existing.degree) byId.set(row.id, { ...existing, ...row });
  }
  return [...byId.values()];
}

function clusterIdForKind(kind: string): string {
  return `cluster:${kind}`;
}

function kindFromClusterRoot(rootId: string): string {
  return rootId.startsWith("cluster:") ? rootId.slice("cluster:".length) : rootId;
}

function labelForKind(kind: string): string {
  return kind
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function requiredRootId(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new HttpError(422, message);
  return normalized;
}

function normalizeDepth(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1 || value > 2) {
    throw new HttpError(422, "depth must be 1 or 2");
  }
  return value;
}

function edgeCap(limit: number): number {
  return Math.max(1, limit * EDGE_CAP_MULTIPLIER);
}

function capEdgesByWeight(edges: GraphProjectionEdge[], limit: number): GraphProjectionEdge[] {
  return [...edges]
    .sort((left, right) =>
      (right.weight ?? 0) - (left.weight ?? 0) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, limit);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
