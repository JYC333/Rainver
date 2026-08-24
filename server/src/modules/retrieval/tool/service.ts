import type {
  RetrievalBriefResponse,
  RetrievalObjectType,
  RetrievalSearchMode,
  RetrievalSearchResponse,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { RetrievalSearchService } from "..";

/**
 * Agent-space-controlled retrieval tool surface (W10).
 *
 * Managed runs do not expose retrieval as an external MCP server. Vendor tools
 * are adapters, never the system of record:
 * instead this in-platform service is the governed entrypoint a managed run uses
 * to call retrieval / Context Brief. Its governance contract:
 *
 *  - **Viewer is the run's instructing user, not the agent.** The agent cannot
 *    choose whose visibility it searches under — the viewer is always
 *    `instructedByUserId`, so the run can only ever retrieve what that user could
 *    read (the search service's per-viewer revalidate gate does the enforcement).
 *  - **Every call passes the policy gateway as the agent/run actor, before this
 *    service ever runs.** `SystemActionGateway`'s dispatch step is the single
 *    enforcement point (action authority consolidation plan, D6/D7); this
 *    service performs no policy check and writes no `policy_decision_records`
 *    row of its own — it is a plain executor, like every other domain
 *    service the gateway calls after enforcement passes.
 *  - **Results are returned, not injected.** The tool hands results back to the
 *    caller; a later Runtime Context turn may acquire them only through its
 *    typed Retrieval channel and live reauthorization.
 *
 * It wraps an already-constructed `RetrievalSearchService`, so whatever egress
 * (W9) / rerank / synthesis configuration the caller built is honored
 * unchanged; this layer only adds the actor scoping. Managed-run binding lives
 * in `runs/managedRetrievalTools.ts`: opted-in runs expose `retrieval.search`
 * / `retrieval.brief` through a bounded tool loop and preflight modes.
 */
export interface RetrievalToolActor {
  spaceId: string;
  /** The run's instructing user — the viewer for ALL access control. */
  instructedByUserId: string;
  /** Agent id, for audit attribution. */
  agentId?: string | null;
  /** Run id, for audit attribution. */
  runId?: string | null;
}

export interface RetrievalToolSearchParams {
  query: string;
  objectTypes?: RetrievalObjectType[];
  objectProfiles?: string[];
  maxResults?: number;
  mode?: RetrievalSearchMode;
  includeTrace?: boolean;
}

export class RetrievalToolService {
  constructor(private readonly search: RetrievalSearchService) {}

  async toolSearch(
    actor: RetrievalToolActor,
    params: RetrievalToolSearchParams,
  ): Promise<RetrievalSearchResponse> {
    const response = await this.search.search({
      spaceId: actor.spaceId,
      viewerUserId: actor.instructedByUserId, // non-bypassable: the run's user
      query: params.query,
      objectTypes: params.objectTypes,
      objectProfiles: params.objectProfiles,
      maxResults: params.maxResults,
      mode: params.mode,
      includeTrace: params.includeTrace,
      agentId: actor.agentId,
      // No feedbackSurface: a tool call is not a human click signal.
    });
    return response;
  }

  async toolBrief(
    actor: RetrievalToolActor,
    params: RetrievalToolSearchParams,
  ): Promise<RetrievalBriefResponse> {
    const response = await this.search.buildBrief({
      spaceId: actor.spaceId,
      viewerUserId: actor.instructedByUserId, // non-bypassable: the run's user
      query: params.query,
      objectTypes: params.objectTypes,
      objectProfiles: params.objectProfiles,
      maxResults: params.maxResults,
      mode: params.mode,
      includeTrace: params.includeTrace,
      agentId: actor.agentId,
    });
    return response;
  }
}
