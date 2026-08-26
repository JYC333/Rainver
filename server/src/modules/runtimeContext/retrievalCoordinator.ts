import type {
  ContextItem,
  RetrievalObjectType,
  RetrievalSearchResponse,
} from "@rainver/protocol";
import { normalizeContextItem } from "./itemNormalizer.js";
import type { RetrievalEgressDestination } from "../retrieval/egress/egressPolicy.js";

export interface RuntimeContextRetrievalRequest {
  spaceId: string;
  userId: string;
  agentId: string;
  executionControlSnapshotId: string;
  query: string;
  objectTypes?: RetrievalObjectType[];
  maxResults: number;
  mode: "exact" | "hybrid" | "broad";
  excludedRefs?: readonly { type: string; id: string }[];
  allowedRefs?: readonly { type: string; id: string }[];
  egressDestination?: RetrievalEgressDestination;
}

export interface RetrievalEnginePort {
  search(input: {
    spaceId: string;
    viewerUserId: string;
    agentId: string;
    query: string;
    objectTypes?: RetrievalObjectType[];
    maxResults: number;
    mode: "exact" | "lexical" | "hybrid" | "hybrid_rerank";
    includeTrace: true;
    auditAccessType: "context_injection";
    auditReason: string;
  }): Promise<RetrievalSearchResponse>;
  recordReads?(input: {
    spaceId: string;
    userId: string;
    agentId: string;
    items: readonly RetrievalSearchResponse["items"][number][];
  }): Promise<void>;
}

export interface RetrievalContextAuthorizationPort {
  authorize(input: {
    request: RuntimeContextRetrievalRequest;
    result: RetrievalSearchResponse["items"][number];
  }): Promise<{
    sensitivity: ContextItem["sensitivity"];
    visibility: ContextItem["visibility"];
    ownerUserId: string | null;
    egressEligible: boolean;
    revalidation: Record<string, unknown> & { status: "live"; checked_at: string };
  }>;
}

/** The only relevance-driven acquisition seam owned by Runtime Context. */
export class RetrievalCoordinator {
  constructor(
    private readonly retrieval: RetrievalEnginePort,
    private readonly authorization: RetrievalContextAuthorizationPort,
  ) {}

  async retrieve(input: RuntimeContextRetrievalRequest): Promise<{
    items: ContextItem[];
    trace: Record<string, unknown>;
  }> {
    if (input.maxResults === 0 || input.objectTypes?.length === 0) {
      return { items: [], trace: { skipped: "explicit_empty_retrieval_scope" } };
    }
    const result = await this.retrieval.search({
      spaceId: input.spaceId,
      viewerUserId: input.userId,
      agentId: input.agentId,
      query: input.query,
      objectTypes: input.objectTypes,
      maxResults: input.maxResults,
      mode: input.mode === "broad" ? "hybrid_rerank" : input.mode,
      includeTrace: true,
      auditAccessType: "context_injection",
      auditReason: "runtime context retrieval",
    });
    const keysFor = (ref: { type: string; id: string }): string[] => {
      const keys = [`${ref.type}:${ref.id}`];
      if (ref.type === "memory") keys.push(`memory_entry:${ref.id}`);
      return keys;
    };
    const excluded = new Set((input.excludedRefs ?? []).flatMap(keysFor));
    const allowed = new Set((input.allowedRefs ?? []).flatMap(keysFor));
    const visible = result.items.filter((item) => {
      const key = `${item.object_type}:${item.object_id}`;
      return !excluded.has(key) && (allowed.size === 0 || allowed.has(key));
    });
    const authorized = await Promise.all(visible.map(async (item, index) => {
      const authorization = await this.authorization.authorize({ request: input, result: item });
      if (!authorization.egressEligible) return null;
      return { source: item, context: normalizeContextItem({
        sourceRef: { type: item.object_type, id: item.object_id },
        acquisition: "retrieval",
        selection: "ranked",
        semanticRole: "reference_data",
        trust: "derived",
        sensitivity: authorization.sensitivity,
        visibility: authorization.visibility,
        ownerUserId: authorization.ownerUserId,
        egressEligible: true,
        spaceId: input.spaceId,
        text: [item.title, item.snippet].filter(Boolean).join("\n"),
        structuredPayload: { title: item.title, evidence: item.evidence },
        revalidation: authorization.revalidation,
        rank: index + 1,
        score: item.score ?? null,
      }) };
    }));
    const accepted = authorized.filter((item): item is NonNullable<typeof item> => item !== null);
    if (accepted.length > 0) {
      await this.retrieval.recordReads?.({
        spaceId: input.spaceId,
        userId: input.userId,
        agentId: input.agentId,
        items: accepted.map((item) => item.source),
      });
    }
    return {
      items: accepted.map((item) => item.context),
      trace: result.trace ?? {},
    };
  }
}
