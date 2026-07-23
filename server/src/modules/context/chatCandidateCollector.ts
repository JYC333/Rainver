import type { ServerConfig } from "../../config";
import type {
  ChatContextCandidateItem,
  ChatContextCandidatesRequest,
  ChatContextCandidatesResult,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  PgChatCandidateRepository,
  excerpt,
  tokenCount,
  type CandidateRow,
  type ContextPolicy,
} from "./candidateRepository";
import {
  retrievalEgressAllowed,
  type RetrievalEgressPolicy,
} from "../retrieval/egress/egressPolicy";
import {
  sourceEgressPoliciesForSnapshots,
  sourcePolicyAllowsRead,
  type SourcePolicySnapshot,
} from "../retrieval/sourcePolicy";

/**
 * Native server chat context candidate collection.
 *
 * Loads the agent version's `context_policy_json` boundary, then runs the
 * per-source selectors in priority order at their per-source caps, with **no**
 * cumulative budget. Produces the `ChatContextCandidatesResult` consumed by the
 * existing `buildChatContext` budget/dedup loop. Read-only.
 */

/** All source tokens recognised by `context_policy_json.sources`. */
const ALL_SOURCES: readonly string[] = [
  "memory",
  "knowledge_item",
  "note",
  "source",
  "activity_record",
  "project_public_summary",
  "task",
  "project",
  "workspace",
  "run",
  "proposal",
  "artifact",
  "manual_context",
];

const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_MAX_ITEMS = 20;

/** Caps the per-source memory fetch. */
const MEMORY_SOURCE_CAP = 10;

export class ChatContextError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly body: unknown = { detail: message },
  ) {
    super(message);
    this.name = "ChatContextError";
  }
}

export class ChatContextCandidateCollector {
  constructor(private readonly repo: PgChatCandidateRepository) {}

  static fromConfig(config: ServerConfig): ChatContextCandidateCollector {
    return new ChatContextCandidateCollector(
      PgChatCandidateRepository.fromConfig(config),
    );
  }

  async fetchCandidates(
    request: ChatContextCandidatesRequest,
  ): Promise<ChatContextCandidatesResult> {
    const message = request.message.trim();
    if (!message) {
      throw new ChatContextError("message must not be empty", 422);
    }

    const policy = await this.repo.loadContextPolicy(
      request.space_id,
      request.agent_id,
    );
    const { allowed, maxTokens, maxItems } = resolvePolicy(policy);

    const items: ChatContextCandidateItem[] = [];
    const promptGate = this.llmPromptGate(request);

    if (request.project_id && allowed.has("project")) {
      const rows = await this.repo.selectProjectNotes(request.space_id, request.project_id, maxItems);
      pushItems(items, await promptGate("project", rows), "project", 0.9, "research_notebook");
    }

    // Priority order is stable. manual_context, workspace, and the raw `project`
    // source never fire on the chat path (the request carries no such fields),
    // so only the DB-backed space-scoped selectors run. `project_public_summary`
    // is the sanitized space-public discovery layer (not concrete project
    // memory). Ordinary chat may use it for cross-project inspiration;
    // Project Chat restricts it to the requested Project and suppresses the
    // other space-wide selectors above.
    if (!request.project_id&&allowed.has("memory")) {
      const rows = await this.repo.selectMemories(
        request.space_id,
        request.user_id,
        Math.min(maxItems, MEMORY_SOURCE_CAP),
      );
      pushItems(
        items,
        await promptGate("memory", rows),
        "memory",
        0.8,
        "approved_memory",
      );
    }
    if (!request.project_id&&allowed.has("knowledge_item")) {
      const rows = await this.repo.selectKnowledgeItems(
        request.space_id,
        request.user_id,
        message,
        maxItems,
      );
      pushItems(
        items,
        await promptGate("knowledge_item", rows),
        "knowledge_item",
        0.7,
        "knowledge_item",
      );
    }
    if (!request.project_id&&allowed.has("note")) {
      const rows = await this.repo.selectNotes(
        request.space_id,
        request.user_id,
        message,
        maxItems,
      );
      pushItems(items, await promptGate("note", rows), "note", 0.65, "note");
    }
    if (!request.project_id&&allowed.has("source")) {
      const rows = await this.repo.selectSources(request.space_id, maxItems);
      pushItems(items, await promptGate("source", rows), "source", 0.6, "source");
    }
    if (!request.project_id&&allowed.has("activity_record")) {
      const rows = await this.repo.selectActivityRecords(
        request.space_id,
        request.user_id,
        maxItems,
      );
      pushItems(
        items,
        await promptGate("activity_record", rows),
        "activity_record",
        0.5,
        "recent_activity",
      );
    }
    if (allowed.has("project_public_summary")) {
      const rows = await this.repo.selectProjectPublicSummaries(
        request.space_id,
        message,
        maxItems,
        request.project_id??null,
      );
      pushItems(
        items,
        await promptGate("project_public_summary", rows),
        "project_public_summary",
        0.4,
        "project_public_summary",
      );
    }

    return {
      allowed_sources: [...allowed].sort(),
      max_tokens: maxTokens,
      max_items: maxItems,
      // True when a current version backed the policy load.
      context_policy_applied: policy.resolved,
      items,
    };
  }

  private llmPromptGate(request: ChatContextCandidatesRequest) {
    const sourcePolicyCache = new Map<string, SourcePolicySnapshot>();
    let viewerSpaceRolePromise: Promise<string | null> | null = null;
    let externalEgressEnabledPromise: Promise<boolean> | null = null;

    const viewerSpaceRole = () => {
      viewerSpaceRolePromise ??= this.repo.loadViewerSpaceRole(
        request.space_id,
        request.user_id,
      );
      return viewerSpaceRolePromise;
    };
    const externalEgressEnabled = () => {
      externalEgressEnabledPromise ??= this.repo.loadExternalEgressEnabled(
        request.space_id,
      );
      return externalEgressEnabledPromise;
    };
    const snapshotsFor = async (
      sourceConnectionIds: readonly string[],
    ): Promise<Map<string, SourcePolicySnapshot>> => {
      const missing = sourceConnectionIds.filter((id) => !sourcePolicyCache.has(id));
      if (missing.length > 0) {
        const loaded = await this.repo.loadSourcePolicySnapshots(
          request.space_id,
          missing,
        );
        for (const [id, snapshot] of loaded) sourcePolicyCache.set(id, snapshot);
      }
      const out = new Map<string, SourcePolicySnapshot>();
      for (const id of sourceConnectionIds) {
        const snapshot = sourcePolicyCache.get(id);
        if (snapshot) out.set(id, snapshot);
      }
      return out;
    };

    return async (
      objectType: string,
      rows: readonly CandidateRow[],
    ): Promise<CandidateRow[]> => {
      const sourceConnectionIds = uniqueSourceConnectionIds(rows);
      const externalAllowed = await externalEgressEnabled();
      if (!externalAllowed) {
        return rows.filter((row) =>
          retrievalEgressAllowed(
            {
              object_type: objectType,
              object_id: row.item_id,
              source_connection_ids: row.source_connection_ids,
            },
            { externalEgressEnabled: false },
          ),
        );
      }
      if (sourceConnectionIds.length === 0) return [...rows];

      const [role, snapshots] = await Promise.all([
        viewerSpaceRole(),
        snapshotsFor(sourceConnectionIds),
      ]);
      const egressPolicy: RetrievalEgressPolicy = {
        externalEgressEnabled: externalAllowed,
        sourcePolicies: sourceEgressPoliciesForSnapshots(snapshots),
      };
      return rows.filter((row) =>
        sourcePolicyAllowsChatCandidate(row, objectType, {
          snapshots,
          role,
          egressPolicy,
          request,
        }),
      );
    };
  }
}

function sourcePolicyAllowsChatCandidate(
  row: CandidateRow,
  objectType: string,
  context: {
    snapshots: ReadonlyMap<string, SourcePolicySnapshot>;
    role: string | null;
    egressPolicy: RetrievalEgressPolicy;
    request: ChatContextCandidatesRequest;
  },
): boolean {
  const sourceConnectionIds = row.source_connection_ids;
  if (sourceConnectionIds.length === 0) return true;
  const readAllowed = sourceConnectionIds.every((sourceConnectionId) => {
    const snapshot = context.snapshots.get(sourceConnectionId);
    return snapshot
      ? sourcePolicyAllowsRead(snapshot, {
          viewerUserId: context.request.user_id,
          agentId: context.request.agent_id,
          viewerSpaceRole: context.role,
        })
      : false;
  });
  if (!readAllowed) return false;
  return retrievalEgressAllowed(
    {
      object_type: objectType,
      object_id: row.item_id,
      source_connection_ids: sourceConnectionIds,
    },
    context.egressPolicy,
  );
}

function uniqueSourceConnectionIds(rows: readonly CandidateRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const id of row.source_connection_ids) {
      const normalized = id.trim();
      if (normalized && !out.includes(normalized)) out.push(normalized);
    }
  }
  return out;
}

function resolvePolicy(policy: ContextPolicy): {
  allowed: Set<string>;
  maxTokens: number;
  maxItems: number;
} {
  const raw = policy.policy;
  const sources = raw.sources;
  // Empty/absent `sources` means all sources are allowed.
  const allowed =
    Array.isArray(sources) && sources.length > 0
      ? new Set(
          sources.filter(
            (s): s is string => typeof s === "string" && ALL_SOURCES.includes(s),
          ),
        )
      : new Set(ALL_SOURCES);
  return {
    allowed,
    maxTokens: positiveInt(raw.max_tokens, DEFAULT_MAX_TOKENS),
    maxItems: positiveInt(raw.max_items, DEFAULT_MAX_ITEMS),
  };
}

function pushItems(
  items: ChatContextCandidateItem[],
  rows: readonly CandidateRow[],
  itemType: string,
  score: number,
  reason: string,
): void {
  for (const row of rows) {
    items.push({
      item_type: itemType,
      item_id: row.item_id,
      title: row.title,
      excerpt: excerpt(row.text),
      score,
      reason,
      token_count: tokenCount(row.text),
      metadata: {},
    });
  }
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}
