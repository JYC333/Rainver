import type {
  RetrievalBriefResponse,
  RetrievalObjectType,
  RetrievalSearchMode,
  RetrievalSearchResponse,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { RetrievalSearchService } from "..";
import { enforceRetrievalToolCallPolicy, type RetrievalToolPolicyAction } from "./policy";

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
 *  - **Every call passes the policy gateway as the agent/run actor.** A
 *    fail-closed `policy_decision_records` row attributes the call to the
 *    agent/run (pointer metadata only — counts, mode, surface; never the query
 *    or content).
 *  - **Results are returned, not injected.** The tool hands results back to the
 *    caller; a later Runtime Context turn may acquire them only through its
 *    typed Retrieval channel and live reauthorization.
 *
 * It wraps an already-constructed `RetrievalSearchService`, so whatever egress
 * (W9) / rerank / synthesis configuration the caller built is honored
 * unchanged; this layer only adds the actor governance + audit. Managed-run
 * binding lives in `runs/managedRetrievalTools.ts`: opted-in runs expose
 * `retrieval.search` / `retrieval.brief` through a bounded tool loop and
 * preflight modes; this service remains the governed execution surface.
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

export interface RetrievalToolServiceOptions {
  /** When set, each tool call must pass a fail-closed policy gate/audit write. */
  databaseUrl?: string | null;
  /** Tool surface tag recorded in the audit metadata (never content). */
  surface?: string | null;
  /** Retrieval domain label for per-call policy decisions. */
  domain?: string | null;
  /** Policy action/tool name for search calls. */
  searchAction?: RetrievalToolPolicyAction;
  /** Policy action/tool name for brief calls. */
  briefAction?: RetrievalToolPolicyAction;
}

export class RetrievalToolService {
  private lastPolicyDecisionRecordId: string | null = null;
  private readonly databaseUrl: string | null;
  private readonly surface: string;
  private readonly domain: string;
  private readonly searchAction: RetrievalToolPolicyAction;
  private readonly briefAction: RetrievalToolPolicyAction;

  constructor(
    private readonly search: RetrievalSearchService,
    options: RetrievalToolServiceOptions = {},
  ) {
    this.databaseUrl = options.databaseUrl ?? null;
    this.surface = options.surface ?? "retrieval_tool";
    this.domain = options.domain ?? "knowledge";
    this.searchAction = options.searchAction ?? "retrieval.search";
    this.briefAction = options.briefAction ?? "retrieval.brief";
  }

  async toolSearch(
    actor: RetrievalToolActor,
    params: RetrievalToolSearchParams,
    policyAlreadyEnforced = false,
  ): Promise<RetrievalSearchResponse> {
    if (!policyAlreadyEnforced) await this.enforcePolicy(actor, this.searchAction, params);
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
    policyAlreadyEnforced = false,
  ): Promise<RetrievalBriefResponse> {
    if (!policyAlreadyEnforced) await this.enforcePolicy(actor, this.briefAction, params);
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

  private async enforcePolicy(
    actor: RetrievalToolActor,
    action: RetrievalToolPolicyAction,
    params: RetrievalToolSearchParams,
  ): Promise<void> {
    const decision = await enforceRetrievalToolCallPolicy({
      databaseUrl: this.databaseUrl,
      actor,
      action,
      domain: this.domain,
      domainEnabled: true,
      mode: params.mode,
      maxResults: params.maxResults,
      objectTypes: params.objectTypes,
      objectProfiles: params.objectProfiles,
      includeTrace: params.includeTrace,
      surface: this.surface,
    });
    this.lastPolicyDecisionRecordId = decision.policy_decision_record_id;
  }

  consumePolicyDecisionRecordId(): string | null {
    const value = this.lastPolicyDecisionRecordId;
    this.lastPolicyDecisionRecordId = null;
    return value;
  }
}
