/**
 * Graph projection wire contract.
 *
 * Producers own graph semantics, filtering, aggregation, and permission
 * trimming before this DTO exists. Consumers render this projection without
 * importing a graph engine or inferring domain rules from engine data.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";

const JsonObjectSchema = z.record(z.unknown());

export const CORE_GRAPH_NODE_KINDS = [
  "knowledge_item",
  "note",
  "source",
  "project",
  "person",
  "claim",
  "tag",
  "collection",
  "plugin",
  "workflow",
  "capability",
  "agent",
  "run",
  "cluster",
] as const;

export const CORE_GRAPH_EDGE_KINDS = [
  "related_to",
  "references",
  "depends_on",
  "part_of",
  "source_for",
  "derived_from",
  "about",
  "supports",
  "contradicts",
  "supersedes",
  "refines",
  "same_as",
  "links_to",
  "mentions",
  "belongs_to",
  "generated_by",
  "similar_to",
  "cluster_contains",
] as const;

export const GRAPH_PROJECTION_VIEW_MODES = [
  "global",
  "local",
  "cluster",
  "search",
  "debug",
] as const;
export type GraphProjectionViewMode =
  (typeof GRAPH_PROJECTION_VIEW_MODES)[number];

export const GRAPH_PROJECTION_LAYOUT_MODES = [
  "preset",
  "force",
  "circular",
  "radial",
  "concentric",
  "clustered",
] as const;
export type GraphProjectionLayoutMode =
  (typeof GRAPH_PROJECTION_LAYOUT_MODES)[number];

export const GraphProjectionNodeSchema = z
  .object({
    id: IdSchema,
    kind: z.string().min(1),
    label: z.string(),
    subtitle: z.string().optional(),
    size: z.number().positive().optional(),
    color: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    clusterId: IdSchema.optional(),
    degree: z.number().int().nonnegative().optional(),
    score: z.number().optional(),
    pinned: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type GraphProjectionNode = z.infer<typeof GraphProjectionNodeSchema>;

export const GraphProjectionEdgeSchema = z
  .object({
    id: IdSchema,
    source: IdSchema,
    target: IdSchema,
    kind: z.string().min(1),
    label: z.string().optional(),
    weight: z.number().nonnegative().optional(),
    color: z.string().optional(),
    size: z.number().positive().optional(),
    hidden: z.boolean().optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type GraphProjectionEdge = z.infer<typeof GraphProjectionEdgeSchema>;

export const GraphProjectionViewSchema = z
  .object({
    mode: z.enum(GRAPH_PROJECTION_VIEW_MODES),
    rootId: IdSchema.optional(),
    depth: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    generatedAt: ISODateTimeSchema,
    truncated: z.boolean().optional(),
    totalNodeCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const GraphProjectionLayoutSchema = z
  .object({
    mode: z.enum(GRAPH_PROJECTION_LAYOUT_MODES),
    version: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

export const GraphProjectionSchema = z
  .object({
    nodes: z.array(GraphProjectionNodeSchema),
    edges: z.array(GraphProjectionEdgeSchema),
    view: GraphProjectionViewSchema,
    layout: GraphProjectionLayoutSchema.optional(),
  })
  .strict()
  .superRefine((projection, ctx) => {
    const nodeIds = new Set(projection.nodes.map((node) => node.id));
    projection.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index, "source"],
          message: "edge source must reference a projection node",
        });
      }
      if (!nodeIds.has(edge.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index, "target"],
          message: "edge target must reference a projection node",
        });
      }
    });
  });
export type GraphProjection = z.infer<typeof GraphProjectionSchema>;
