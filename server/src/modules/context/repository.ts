import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool";
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import {
  MEMORY_COLUMNS,
  type MemoryRow,
  type Queryable,
} from "../memory/repository";
import { HttpError } from "../routeUtils/common";
import { canAccessProject } from "../memory/projectAccess";
import { workspaceProjectReadAccessSql } from "../workspaces/access";
import {
  contentAccessLevelSql,
  contentOwnerFilterSql,
  contentReadSql,
  contentVisibilityFilterSql,
} from "../access/contentAccessSql";
import { contentResourceDefinition } from "../access/contentAccessRegistry";
import { resolveOversightLevel } from "../access/oversightResolver";
import { evidenceProvenanceReadableClause } from "../sources/sourceItemAccess";
import {
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourcePolicyAllowsRead,
} from "../retrieval";
import {
  addArrayFilter,
  clampMaxItems,
  evidenceSelectionFromRow,
  generatePersonalSummary,
  hardFilterRows,
  memorySourceRef,
  numeric,
  policySourceRef,
  resolveReadableScopes,
  type EvidenceContextRow,
} from "./contextRepositoryHelpers";
import { memorySensitivityReadSql } from "../memory/memorySensitivitySql";

const ALLOWED_RELATION_TYPES = [
  "derived_from",
  "related_to",
  "applies_to",
  "supports",
  "caused_by",
] as const;

const MAX_HOPS = 2;
const DEFAULT_MAX_MEMORIES = 20;

const CONTEXT_MEMORY_COLUMNS = `${MEMORY_COLUMNS}, agent_id, access_count, last_accessed_at, last_retrieved_at`;
const MEMORY_DEFINITION = contentResourceDefinition("memory")!;
const CONTEXT_EVIDENCE_DEFINITION = contentResourceDefinition("extracted_evidence")!;
const CONTEXT_SOURCE_ITEM_DEFINITION = contentResourceDefinition("source_item")!;
const CONTEXT_SOURCE_SNAPSHOT_DEFINITION = contentResourceDefinition("source_snapshot")!;

function contextMemoryColumns(alias: string, userExpr: string): string {
  return `${CONTEXT_MEMORY_COLUMNS}, ${contentAccessLevelSql({
    definition: MEMORY_DEFINITION,
    alias,
    userExpr,
  })} AS effective_access_level`;
}

export interface ContextMemoryRow extends MemoryRow {
  agent_id: string | null;
  access_count: number | string;
  last_accessed_at: unknown;
  last_retrieved_at: unknown;
}

export interface RunContextRecord {
  id: string;
  space_id: string;
  agent_id: string | null;
  agent_version_id: string | null;
  context_snapshot_id: string | null;
  prompt: string | null;
  workspace_id: string | null;
  project_id: string | null;
  session_id: string | null;
  instructed_by_user_id: string | null;
  capability_id: string | null;
  trigger_origin: string | null;
  data_exposure_level: string | null;
  trust_level: string | null;
  has_personal_grant_context: boolean;
  personal_grant_context_json: unknown;
  request_json: unknown;
  contract_snapshot_json?: unknown;
  system_prompt: string | null;
  capabilities_json: unknown;
  memory_policy_json: unknown;
  model_config_json: unknown;
}

export interface PolicyRow {
  id: string;
  name: string;
  domain: string;
  policy_key: string | null;
  enforcement_mode: string | null;
  priority: number | string;
  policy_json: unknown;
}

export interface SessionSummaryRow {
  id: string;
  session_id: string;
  summary_text: string;
  version: number | string;
  condenser_version: string | null;
}

export interface ContextDigestRow {
  id: string;
  digest_type: "policy_bundle" | "workspace" | "agent";
  version: number | string;
  status: string;
  content: string | null;
  source_memory_ids_json: unknown;
  source_policy_ids_json: unknown;
  source_relation_ids_json: unknown;
  source_hash: string | null;
  content_hash: string | null;
}

export interface DigestBundle {
  policy_bundle: ContextDigestRow | null;
  workspace: ContextDigestRow | null;
  agent: ContextDigestRow | null;
}

export interface PersonalGrantMetadata {
  grant_id: string;
  granting_user_id: string;
  personal_space_id: string;
  target_space_id: string;
  access_mode: string;
  memory_count: number;
  raw_private_memory_included: false;
  personal_summary_persisted: false;
}

export interface PersonalGrantResult {
  personal_context_block: string;
  metadata: PersonalGrantMetadata | null;
}

export interface ContextEvidenceSelection {
  item: Record<string, unknown>;
  ref: Record<string, unknown>;
}

export interface ContextArtifactAttachmentSelection {
  item: Record<string, unknown>;
  ref: Record<string, unknown>;
}

export type ContextArtifactRevocationScope = "workspace" | "project";

export interface ContextArtifactRevocationRecord {
  id: string;
  space_id: string;
  artifact_id: string;
  scope_type: ContextArtifactRevocationScope;
  scope_id: string;
  reason: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

interface ContextArtifactRow {
  id: string;
  artifact_type: string;
  title: string;
  content: string | null;
  metadata_json: unknown;
  visibility: string;
  owner_user_id: string | null;
  project_id: string | null;
  workspace_id: string | null;
  created_at: unknown;
}

const CONTEXT_ATTACHABLE_ARTIFACT_TYPES = new Set([
  "retrieval_brief",
  "retrieval_eval_report",
  "retrieval_explain_report",
  "retrieval_maintenance_report",
  "memory_maintenance_report",
  "literature_matrix",
]);

const MAX_CONTEXT_ARTIFACT_ATTACHMENTS = 8;
const MAX_ATTACHMENT_CONTENT_CHARS = 6_000;

interface PersonalGrantRow {
  id: string;
  granting_user_id: string;
  personal_space_id: string;
  target_space_id: string;
  access_mode: string;
  memory_filter_json: unknown;
}

export interface SnapshotUpdateInput {
  snapshotId: string;
  spaceId: string;
  sourceRefs: readonly Record<string, unknown>[];
  includedEvidenceRefs: readonly Record<string, unknown>[];
  retrievalTrace: readonly Record<string, unknown>[];
  tokenBudget: Record<string, unknown>;
  compiledPrefixText: string;
  compiledTailText: string;
  prefixHash: string;
  tailHash: string;
  compilerVersion: string;
  tokenEstimate: number;
  policyBundleVersion?: string | null;
  memoryDigestVersion?: string | null;
  workspaceDigestVersion?: string | null;
}

/**
 * Repository for the full-run server context.prepare path.
 *
 * This intentionally stays under `modules/context`, even though it touches
 * memory/context tables: context assembly is the "what the runtime saw"
 * authority. Public memory reads continue to live in `modules/memory`.
 */
export class PgRunContextRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgRunContextRepository {
    if (!config.databaseUrl) {
      throw new Error("Run context repository requires SERVER_DATABASE_URL");
    }
    return new PgRunContextRepository(getDbPool(config.databaseUrl));
  }

  static poolFromConfig(config: ServerConfig): Pool {
    if (!config.databaseUrl) {
      throw new Error("Run context repository requires SERVER_DATABASE_URL");
    }
    return getDbPool(config.databaseUrl);
  }

  async loadRun(spaceId: string, runId: string): Promise<RunContextRecord | null> {
    const result = await this.db.query<RunContextRecord>(
      `SELECT r.id, r.space_id, r.agent_id, r.agent_version_id,
              r.context_snapshot_id, r.prompt, r.workspace_id, r.project_id,
              r.session_id, r.instructed_by_user_id, r.capability_id, r.trigger_origin,
              r.data_exposure_level, r.trust_level,
              r.has_personal_grant_context, r.personal_grant_context_json,
              cs.request_json, r.contract_snapshot_json,
              av.system_prompt,
              COALESCE(NULLIF(r.capabilities_json, '[]'::jsonb), av.capabilities_json) AS capabilities_json,
              av.memory_policy_json, av.model_config_json
         FROM runs r
         LEFT JOIN agent_versions av
           ON av.id = r.agent_version_id
          AND av.space_id = r.space_id
          AND av.agent_id = r.agent_id
         LEFT JOIN context_snapshots cs
           ON cs.id = r.context_snapshot_id
          AND cs.space_id = r.space_id
        WHERE r.space_id = $1 AND r.id = $2
        LIMIT 1`,
      [spaceId, runId],
    );
    return result.rows[0] ?? null;
  }

  async retrieve(params: {
    spaceId: string;
    userId: string;
    workspaceId: string | null;
    agentId: string | null;
    capabilityId?: string | null;
    query: string | null;
    agentMemoryPolicy: Record<string, unknown> | null;
    includeSystemScope: boolean;
    maxMemories?: number;
    // The run/caller's project. Activates project cutting:
    //   undefined -> no project filtering (unscoped callers — agents/runs without a project scope)
    //   null      -> caller has no project: only project-free memory
    //   "P"       -> project P's memory (only if the user can access P) + project-free
    projectId?: string | null;
  }): Promise<{
    memories: ContextMemoryRow[];
    activePolicies: PolicyRow[];
    sourceRefs: Record<string, unknown>[];
    retrievalTrace: Record<string, unknown>;
    tokenBudget: Record<string, unknown>;
  }> {
    const { projectId, ...base } = params;
    const [projectFilter, oversightLevel] = await Promise.all([
      this.resolveProjectFilter(base.spaceId, base.userId, projectId),
      resolveOversightLevel(this.db, base.spaceId, base.userId),
    ]);
    const input = { ...base, projectFilter, oversightLevel };
    const readableScopes = resolveReadableScopes(
      input.agentMemoryPolicy,
      input.includeSystemScope,
    );
    const hardFilterTrace = {
      space_id: input.spaceId,
      user_id: input.userId,
      readable_scopes: [...readableScopes].sort(),
      excluded_statuses: [
        "archived",
        "deleted",
        "proposed",
        "rejected",
        "superseded",
      ],
      cross_space_blocked: true,
      private_other_user_blocked: true,
      project_filter: projectFilter
        ? { active: true, allowed_project_id: projectFilter.allowedProjectId }
        : { active: false },
    };

    const seenIds = new Set<string>();
    const sourceRefs: Record<string, unknown>[] = [];
    const stageTraces: Record<string, unknown>[] = [];

    const symbolRows = hardFilterRows(
      await this.symbolMatch({
        ...input,
        readableScopes,
      }),
      input,
    );
    for (const row of symbolRows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      sourceRefs.push(memorySourceRef(row, "symbol_match", "symbol_match"));
    }
    stageTraces.push({
      stage: "symbol_match",
      found: sourceRefs.filter((r) => r.stage === "symbol_match").length,
      ids: sourceRefs
        .filter((r) => r.stage === "symbol_match")
        .map((r) => r.source_id),
    });

    if (seenIds.size > 0) {
      const { rows, hopsUsed } = await this.graphExpand({
        ...input,
        seedIds: seenIds,
        readableScopes,
      });
      const newGraphIds: string[] = [];
      for (const row of rows) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        newGraphIds.push(row.id);
        sourceRefs.push(
          memorySourceRef(row, `graph_expansion_hop_${hopsUsed}`, "graph_expansion"),
        );
      }
      stageTraces.push({
        stage: "graph_expansion",
        hops_used: hopsUsed,
        found: newGraphIds.length,
        ids: newGraphIds,
      });
    } else {
      stageTraces.push({
        stage: "graph_expansion",
        hops_used: 0,
        found: 0,
        ids: [],
      });
    }

    const keywordNewIds: string[] = [];
    if (input.query?.trim()) {
      const keywordRows = await this.keywordFallback({
        ...input,
        readableScopes,
      });
      for (const row of keywordRows) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        keywordNewIds.push(row.id);
        sourceRefs.push(memorySourceRef(row, "keyword_fallback", "keyword_fallback"));
      }
    }
    stageTraces.push({
      stage: "keyword_fallback",
      query: input.query ?? "",
      found: keywordNewIds.length,
      ids: keywordNewIds,
    });

    // Embedding fallback currently delegates to the same keyword result set, so
    // after the keyword stage there are no new rows left to add.
    stageTraces.push({
      stage: "embedding_fallback",
      backend: "keyword_delegation",
      found: 0,
      ids: [],
    });

    const finalMemories = await this.loadAndRank({
      ...input,
      ids: [...seenIds],
      maxMemories: input.maxMemories ?? DEFAULT_MAX_MEMORIES,
    });
    const finalIds = new Set(finalMemories.map((row) => row.id));
    const finalSourceRefs = sourceRefs.filter((ref) =>
      typeof ref.source_id === "string" && finalIds.has(ref.source_id),
    );

    const activePolicies = await this.loadActivePolicies(input.spaceId);
    finalSourceRefs.push(...activePolicies.map(policySourceRef));

    const tokenBudget = {
      default_budget_chars: 128_000,
      source: "default",
      note: "token_budget populated by ContextSnapshotPopulator",
    };
    return {
      memories: finalMemories,
      activePolicies,
      sourceRefs: finalSourceRefs,
      tokenBudget,
      retrievalTrace: {
        retrieved_at: new Date().toISOString(),
        space_id: input.spaceId,
        hard_filter: hardFilterTrace,
        stages: stageTraces,
        total_selected: finalMemories.length,
        selected_ids: finalMemories.map((row) => row.id),
        policy_count: activePolicies.length,
        token_budget: tokenBudget,
      },
    };
  }

  async recordContextMemoryAccess(input: {
    memories: readonly ContextMemoryRow[];
    spaceId: string;
    userId: string;
    agentId: string | null;
    runId: string;
    reason: string;
  }): Promise<void> {
    if (input.memories.length === 0) return;
    const now = new Date().toISOString();
    const logCols =
      "id, space_id, memory_id, user_id, agent_id, run_id, access_type, reason, accessed_at";
    const logGroups: string[] = [];
    const logParams: unknown[] = [];
    for (const memory of input.memories) {
      const base = logParams.length;
      logGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
          `$${base + 5}, $${base + 6}, 'context_injection', $${base + 7}, $${base + 8})`,
      );
      logParams.push(
        randomUUID(),
        input.spaceId,
        memory.id,
        input.userId,
        input.agentId,
        input.runId,
        input.reason,
        now,
      );
    }
    await this.db.query(
      `INSERT INTO memory_access_logs (${logCols}) VALUES ${logGroups.join(", ")}`,
      logParams,
    );
    const idPlaceholders = input.memories.map((_, i) => `$${i + 3}`).join(", ");
    await this.db.query(
      `UPDATE memory_entries
          SET access_count = COALESCE(access_count, 0) + 1,
              last_accessed_at = $1,
              last_retrieved_at = $1
        WHERE space_id = $2 AND id IN (${idPlaceholders})`,
      [now, input.spaceId, ...input.memories.map((m) => m.id)],
    );
  }

  async recordContextDigestMemoryAccess(input: {
    memoryIds: readonly string[];
    spaceId: string;
    userId: string;
    agentId: string | null;
    runId: string;
    reason: string;
  }): Promise<void> {
    const memoryIds = [...new Set(input.memoryIds.filter((id) => id.length > 0))];
    if (memoryIds.length === 0) return;
    const now = new Date().toISOString();
    const logCols =
      "id, space_id, memory_id, user_id, agent_id, run_id, access_type, reason, accessed_at";
    const logGroups: string[] = [];
    const logParams: unknown[] = [];
    for (const memoryId of memoryIds) {
      const base = logParams.length;
      logGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
          `$${base + 5}, $${base + 6}, 'context_injection', $${base + 7}, $${base + 8})`,
      );
      logParams.push(
        randomUUID(),
        input.spaceId,
        memoryId,
        input.userId,
        input.agentId,
        input.runId,
        input.reason,
        now,
      );
    }
    await this.db.query(
      `INSERT INTO memory_access_logs (${logCols}) VALUES ${logGroups.join(", ")}`,
      logParams,
    );
    await this.db.query(
      `UPDATE memory_entries
          SET access_count = COALESCE(access_count, 0) + 1,
              last_accessed_at = $1,
              last_retrieved_at = $1
        WHERE space_id = $2
          AND id = ANY($3::varchar[])`,
      [now, input.spaceId, memoryIds],
    );
  }

  /**
   * Re-validate the memory ids a digest *claims* as its sources against the
   * live memory_entries, scoped to the digest's own scope. context_digests only
   * FKs space_id, so a stale or tampered `source_memory_ids_json` could
   * otherwise drive false audit logs or suppress direct rendering of private
   * memory. Only ids that are still in this space + scope, active, undeleted,
   * shared at the digest tier's visibility, project-free, and not
   * `highly_restricted` survive — mirroring the generator's own eligibility
   * filter (see loadScopeMemories).
   */
  async filterEligibleDigestMemoryIds(input: {
    spaceId: string;
    scopeType: "workspace" | "agent";
    scopeId: string;
    memoryIds: readonly string[];
  }): Promise<string[]> {
    const ids = [...new Set(input.memoryIds.filter((id) => id.length > 0))];
    if (ids.length === 0) return [];
    const idColumn = input.scopeType === "workspace" ? "workspace_id" : "agent_id";
    const result = await this.db.query<{ id: string }>(
      `SELECT me.id
         FROM memory_entries me
        WHERE me.space_id = $1
          AND me.scope_type = $2
          AND ${idColumn} = $3
          AND me.status = 'active'
          AND me.deleted_at IS NULL
          AND me.project_id IS NULL
          AND ${contentVisibilityFilterSql("me", ["space_shared"])}
          AND COALESCE(me.sensitivity_level, 'normal') <> 'highly_restricted'
          AND me.id = ANY($4::varchar[])`,
      [input.spaceId, input.scopeType, input.scopeId, ids],
    );
    return result.rows.map((row) => row.id);
  }

  async loadLatestSessionSummary(
    spaceId: string,
    sessionId: string | null,
  ): Promise<SessionSummaryRow | null> {
    if (!sessionId) return null;
    const result = await this.db.query<SessionSummaryRow>(
      `SELECT id, session_id, summary_text, version, condenser_version
         FROM session_summaries
        WHERE space_id = $1
          AND session_id = $2
          AND status = 'active'
        ORDER BY version DESC
        LIMIT 1`,
      [spaceId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  async selectEvidenceForContext(input: {
    spaceId: string;
    userId: string;
    workspaceId: string | null;
    projectId: string | null;
    runId: string | null;
    limit?: number;
  }): Promise<ContextEvidenceSelection[]> {
    const targets: Array<{ type: string; id: string }> = [
      { type: "space", id: input.spaceId },
    ];
    if (input.workspaceId) {
      targets.push({ type: "workspace", id: input.workspaceId });
    }
    if (
      input.projectId &&
      (await canAccessProject(this.db, input.spaceId, input.projectId, input.userId))
    ) {
      targets.push({ type: "project", id: input.projectId });
    }
    if (input.runId) {
      targets.push({ type: "run", id: input.runId });
    }

    const params: unknown[] = [
      input.spaceId,
      ["context_candidate", "supports", "mentions"],
      input.userId,
    ];
    const targetPredicates = targets.map((target) => {
      const typeIndex = params.length + 1;
      params.push(target.type);
      const idIndex = params.length + 1;
      params.push(target.id);
      return `(el.target_type = $${typeIndex} AND el.target_id = $${idIndex})`;
    });
    const limit = input.limit ?? 8;
    params.push(Math.min(Math.max(limit * 4, limit), 50));

    const result = await this.db.query<EvidenceContextRow>(
      `SELECT ev.id, ev.title, ev.content_excerpt, ev.evidence_type,
              ev.trust_level, COALESCE(ev.source_item_id, ev.origin_source_item_id) AS source_item_id, ev.source_snapshot_id,
              ev.artifact_id, ev.source_uri,
              COALESCE(ii.connection_id, ss.connection_id) AS source_connection_id,
              el.id AS link_id, el.link_type, el.target_type, el.target_id
         FROM extracted_evidence ev
         JOIN evidence_links el
           ON el.evidence_id = ev.id
          AND el.space_id = ev.space_id
         LEFT JOIN source_items ii
           ON ii.space_id = ev.space_id
          AND ii.id = COALESCE(ev.source_item_id, ev.origin_source_item_id)
          AND ii.deleted_at IS NULL
         LEFT JOIN source_snapshots ss
           ON ss.space_id = ev.space_id
          AND ss.id = ev.source_snapshot_id
         LEFT JOIN source_connections sc
           ON sc.space_id = ev.space_id
          AND sc.id = COALESCE(ii.connection_id, ss.connection_id)
          AND sc.status <> 'archived'
          AND sc.deleted_at IS NULL
        WHERE ev.space_id = $1
          AND ev.status IN ('candidate', 'active')
          AND ev.deleted_at IS NULL
          AND ${contentReadSql("extracted_evidence", "ev", "$3")}
          AND ${contentAccessLevelSql({ definition: CONTEXT_EVIDENCE_DEFINITION, alias: "ev", userExpr: "$3" })} = 'full'
          AND ${evidenceProvenanceReadableClause("ev", "$3", true)}
          AND (
            COALESCE(ev.source_item_id, ev.origin_source_item_id) IS NULL
            OR (
              ii.id IS NOT NULL
              AND ${contentReadSql("source_item", "ii", "$3")}
              AND ${contentAccessLevelSql({ definition: CONTEXT_SOURCE_ITEM_DEFINITION, alias: "ii", userExpr: "$3" })} = 'full'
            )
          )
          AND (
            ev.source_snapshot_id IS NULL
            OR (
              ss.id IS NOT NULL
              AND ${contentReadSql("source_snapshot", "ss", "$3")}
              AND ${contentAccessLevelSql({ definition: CONTEXT_SOURCE_SNAPSHOT_DEFINITION, alias: "ss", userExpr: "$3" })} = 'full'
            )
          )
          AND el.status = 'active'
          AND el.link_type = ANY($2::varchar[])
          AND (${targetPredicates.join(" OR ")})
        ORDER BY el.confidence DESC, ev.created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    const sourceConnectionIds = [
      ...new Set(result.rows.map((row) => row.source_connection_id).filter((id): id is string => Boolean(id))),
    ];
    const [sourcePolicySnapshots, viewerSpaceRole] = await Promise.all([
      loadSourcePolicySnapshots(this.db, input.spaceId, sourceConnectionIds),
      sourceConnectionIds.length > 0
        ? loadViewerSpaceRole(this.db, input.spaceId, input.userId)
        : Promise.resolve(null),
    ]);
    const seen = new Set<string>();
    const selections: ContextEvidenceSelection[] = [];
    for (const row of result.rows) {
      if (seen.has(row.id)) continue;
      if (row.source_connection_id) {
        const snapshot = sourcePolicySnapshots.get(row.source_connection_id);
        if (!snapshot || !sourcePolicyAllowsRead(snapshot, {
          viewerUserId: input.userId,
          viewerSpaceRole,
        })) {
          continue;
        }
      }
      seen.add(row.id);
      if (input.runId) {
        try {
          await this.insertUsedInContextEvidenceLink({
            spaceId: input.spaceId,
            evidenceId: row.id,
            runId: input.runId,
          });
        } catch {
          // used_in_context is a best-effort audit link; context selection has
          // already passed the source read gate.
        }
      }
      selections.push(evidenceSelectionFromRow(row));
      if (selections.length >= limit) break;
    }
    return selections;
  }

  async selectArtifactAttachments(input: {
    spaceId: string;
    userId: string;
    workspaceId?: string | null;
    projectId?: string | null;
    artifactIds: readonly string[];
    ignoreRevocations?: boolean;
  }): Promise<ContextArtifactAttachmentSelection[]> {
    const ids = normalizeContextArtifactIds(input.artifactIds);
    if (ids.length === 0) return [];
    const result = await this.db.query<ContextArtifactRow>(
      `SELECT a.id, a.artifact_type, a.title, a.content, a.metadata_json, a.visibility,
              a.owner_user_id, a.project_id, a.workspace_id, a.created_at
         FROM artifacts a
        WHERE a.space_id = $1
          AND a.id = ANY($2::varchar[])
          AND ${contentReadSql("artifact", "a", "$3")}
          AND (a.workspace_id IS NULL OR ($4::varchar IS NOT NULL AND a.workspace_id = $4))
          AND (a.project_id IS NULL OR ($5::varchar IS NOT NULL AND a.project_id = $5))`,
      [
        input.spaceId,
        ids,
        input.userId,
        input.workspaceId ?? null,
        input.projectId ?? null,
      ],
    );
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    const revocations = input.ignoreRevocations
      ? new Map<string, ContextArtifactRevocationRecord>()
      : await this.activeArtifactRevocationsForContext({
          spaceId: input.spaceId,
          artifactIds: ids,
          workspaceId: input.workspaceId ?? null,
          projectId: input.projectId ?? null,
        });
    const selections: ContextArtifactAttachmentSelection[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        selections.push(blockedArtifactAttachment("artifact not found or not visible"));
        continue;
      }
      if (!CONTEXT_ATTACHABLE_ARTIFACT_TYPES.has(row.artifact_type)) {
        selections.push(blockedArtifactAttachment("artifact type is not attachable to context"));
        continue;
      }
      if (row.project_id && !(await canAccessProject(this.db, input.spaceId, row.project_id, input.userId))) {
        selections.push(blockedArtifactAttachment("artifact project is not visible"));
        continue;
      }
      const revocation = revocations.get(row.id);
      if (revocation) {
        selections.push(blockedArtifactAttachment(revocationReason(revocation)));
        continue;
      }
      const sourcePolicy = await this.artifactSourcePolicyContext(
        input.spaceId,
        input.userId,
        row.metadata_json,
        row.owner_user_id !== input.userId,
      );
      // A source-derived artifact (e.g. a Context Brief) records the source
      // connection ids it synthesized from. When a NON-creator attaches it, the
      // bounded answer/citations could include source content the attaching
      // viewer's current source policy no longer permits, so re-gate before
      // attachment (G3). The owner attaching their own artifact is unaffected;
      // persisted run snapshots stay immutable — only future attachment is gated.
      if (row.owner_user_id !== input.userId && sourcePolicy.denies) {
        selections.push(blockedArtifactAttachment("source policy no longer permits this evidence for the current viewer"));
        continue;
      }
      selections.push(artifactAttachmentFromRow(row, sourcePolicy.snapshot));
    }
    return selections;
  }

  async listArtifactRevocations(input: {
    spaceId: string;
    userId: string;
    workspaceId?: string | null;
    projectId?: string | null;
    artifactIds?: readonly string[];
  }): Promise<ContextArtifactRevocationRecord[]> {
    const scopes = await this.accessibleRevocationScopes(input);
    if (scopes.length === 0) return [];
    const params: unknown[] = [input.spaceId];
    const scopePredicates = scopes.map((scope) => {
      params.push(scope.scope_type);
      const typeIndex = params.length;
      params.push(scope.scope_id);
      const idIndex = params.length;
      return `(scope_type = $${typeIndex} AND scope_id = $${idIndex})`;
    });
    const ids = normalizeArtifactRevocationIds(input.artifactIds ?? []);
    let artifactPredicate = "";
    if (ids.length > 0) {
      params.push(ids);
      artifactPredicate = `AND artifact_id = ANY($${params.length}::varchar[])`;
    }
    const result = await this.db.query<ContextArtifactRevocationRecord>(
      `SELECT id, space_id, artifact_id, scope_type, scope_id, reason,
              created_by_user_id, created_at
         FROM context_artifact_revocations
        WHERE space_id = $1
          AND deleted_at IS NULL
          AND (${scopePredicates.join(" OR ")})
          ${artifactPredicate}
        ORDER BY created_at DESC, id DESC`,
      params,
    );
    return result.rows;
  }

  async createArtifactRevocation(input: {
    spaceId: string;
    userId: string;
    artifactId: string;
    scopeType: ContextArtifactRevocationScope;
    scopeId: string;
    reason?: string | null;
  }): Promise<ContextArtifactRevocationRecord> {
    await this.assertRevocationScopeAccess(input.spaceId, input.userId, input.scopeType, input.scopeId);
    const workspaceId = input.scopeType === "workspace" ? input.scopeId : null;
    const projectId = input.scopeType === "project" ? input.scopeId : null;
    const selections = await this.selectArtifactAttachments({
      spaceId: input.spaceId,
      userId: input.userId,
      workspaceId,
      projectId,
      artifactIds: [input.artifactId],
      ignoreRevocations: true,
    });
    const blocked = selections.find((selection) => selection.item.approved === false);
    if (blocked) {
      const reason = typeof blocked.item.rejection_reason === "string"
        ? blocked.item.rejection_reason
        : "artifact is not attachable";
      throw new HttpError(422, `context artifact cannot be revoked: ${reason}`);
    }
    const now = new Date().toISOString();
    const result = await this.db.query<ContextArtifactRevocationRecord>(
      `INSERT INTO context_artifact_revocations (
          id, space_id, artifact_id, scope_type, scope_id, reason,
          created_by_user_id, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (space_id, artifact_id, scope_type, scope_id)
       WHERE deleted_at IS NULL
       DO UPDATE SET
          reason = EXCLUDED.reason,
          created_by_user_id = EXCLUDED.created_by_user_id,
          created_at = EXCLUDED.created_at
       RETURNING id, space_id, artifact_id, scope_type, scope_id, reason,
                 created_by_user_id, created_at`,
      [
        randomUUID(),
        input.spaceId,
        input.artifactId,
        input.scopeType,
        input.scopeId,
        normalizeRevocationReason(input.reason),
        input.userId,
        now,
      ],
    );
    return result.rows[0]!;
  }

  async deleteArtifactRevocation(input: {
    spaceId: string;
    userId: string;
    artifactId: string;
    scopeType: ContextArtifactRevocationScope;
    scopeId: string;
  }): Promise<boolean> {
    await this.assertRevocationScopeAccess(input.spaceId, input.userId, input.scopeType, input.scopeId);
    const result = await this.db.query(
      `UPDATE context_artifact_revocations
          SET deleted_at = $6,
              deleted_by_user_id = $2
        WHERE space_id = $1
          AND artifact_id = $3
          AND scope_type = $4
          AND scope_id = $5
          AND deleted_at IS NULL`,
      [
        input.spaceId,
        input.userId,
        input.artifactId,
        input.scopeType,
        input.scopeId,
        new Date().toISOString(),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async activeArtifactRevocationsForContext(input: {
    spaceId: string;
    artifactIds: readonly string[];
    workspaceId: string | null;
    projectId: string | null;
  }): Promise<Map<string, ContextArtifactRevocationRecord>> {
    const scopes: Array<{ scope_type: ContextArtifactRevocationScope; scope_id: string }> = [];
    if (input.projectId) scopes.push({ scope_type: "project", scope_id: input.projectId });
    if (input.workspaceId) scopes.push({ scope_type: "workspace", scope_id: input.workspaceId });
    if (scopes.length === 0 || input.artifactIds.length === 0) return new Map();
    const params: unknown[] = [input.spaceId, [...input.artifactIds]];
    const scopePredicates = scopes.map((scope) => {
      params.push(scope.scope_type);
      const typeIndex = params.length;
      params.push(scope.scope_id);
      const idIndex = params.length;
      return `(scope_type = $${typeIndex} AND scope_id = $${idIndex})`;
    });
    const result = await this.db.query<ContextArtifactRevocationRecord>(
      `SELECT id, space_id, artifact_id, scope_type, scope_id, reason,
              created_by_user_id, created_at
         FROM context_artifact_revocations
        WHERE space_id = $1
          AND artifact_id = ANY($2::varchar[])
          AND deleted_at IS NULL
          AND (${scopePredicates.join(" OR ")})
        ORDER BY CASE WHEN scope_type = 'project' THEN 0 ELSE 1 END,
                 created_at DESC, id DESC`,
      params,
    );
    const byArtifactId = new Map<string, ContextArtifactRevocationRecord>();
    for (const row of result.rows) {
      if (!byArtifactId.has(row.artifact_id)) byArtifactId.set(row.artifact_id, row);
    }
    return byArtifactId;
  }

  private async accessibleRevocationScopes(input: {
    spaceId: string;
    userId: string;
    workspaceId?: string | null;
    projectId?: string | null;
  }): Promise<Array<{ scope_type: ContextArtifactRevocationScope; scope_id: string }>> {
    const scopes: Array<{ scope_type: ContextArtifactRevocationScope; scope_id: string }> = [];
    if (input.workspaceId) {
      await this.assertRevocationScopeAccess(input.spaceId, input.userId, "workspace", input.workspaceId);
      scopes.push({ scope_type: "workspace", scope_id: input.workspaceId });
    }
    if (input.projectId) {
      await this.assertRevocationScopeAccess(input.spaceId, input.userId, "project", input.projectId);
      scopes.push({ scope_type: "project", scope_id: input.projectId });
    }
    return scopes;
  }

  private async assertRevocationScopeAccess(
    spaceId: string,
    userId: string,
    scopeType: ContextArtifactRevocationScope,
    scopeId: string,
  ): Promise<void> {
    const accessible = scopeType === "project"
      ? await canAccessProject(this.db, spaceId, scopeId, userId)
      : await this.canAccessWorkspace(spaceId, scopeId, userId);
    if (!accessible) {
      throw new HttpError(403, `${scopeType} scope is not accessible`);
    }
  }

  private async canAccessWorkspace(
    spaceId: string,
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ one: number }>(
      `SELECT 1 AS one
         FROM workspaces w
        WHERE w.space_id = $1
          AND w.id = $2
          AND ${workspaceProjectReadAccessSql({ spaceExpr: "w.space_id", workspaceExpr: "w.id", userExpr: "$3" })}
        LIMIT 1`,
      [spaceId, workspaceId, userId],
    );
    return result.rows.length > 0;
  }

  /**
   * Build the policy preview shown for artifact attachments, and report whether
   * current source read policy denies the attaching viewer. Fail closed when a
   * named connection has no readable snapshot.
   */
  private async artifactSourcePolicyContext(
    spaceId: string,
    userId: string,
    metadataJson: unknown,
    enforceForAttachment: boolean,
  ): Promise<{ denies: boolean; snapshot: Record<string, unknown> }> {
    const metadata = recordValue(metadataJson);
    const ids = sourceConnectionIdsFromArtifactMetadata(metadataJson);
    const baseSnapshot = sourcePolicySnapshot(metadata, {
      sourceConnectionIds: ids,
      sourcePolicySnapshots: {},
      readerGate: {
        evaluated: ids.length > 0,
        enforced_for_attachment: enforceForAttachment,
        allowed: true,
        allowed_count: 0,
        denied_count: 0,
        missing_count: 0,
      },
    });
    if (ids.length === 0) return { denies: false, snapshot: baseSnapshot };
    const [snapshots, viewerSpaceRole] = await Promise.all([
      loadSourcePolicySnapshots(this.db, spaceId, ids),
      loadViewerSpaceRole(this.db, spaceId, userId),
    ]);
    const sourcePolicySnapshots: Record<string, unknown> = {};
    let allowedCount = 0;
    let deniedCount = 0;
    let missingCount = 0;
    for (const [id, snapshot] of snapshots.entries()) {
      sourcePolicySnapshots[id] = snapshot;
    }
    for (const id of ids) {
      const snapshot = snapshots.get(id);
      const allowed = snapshot
        ? sourcePolicyAllowsRead(snapshot, { viewerUserId: userId, viewerSpaceRole })
        : false;
      if (allowed) allowedCount += 1;
      else deniedCount += 1;
      if (!snapshot) missingCount += 1;
    }
    const denies = deniedCount > 0;
    return {
      denies,
      snapshot: sourcePolicySnapshot(metadata, {
        sourceConnectionIds: ids,
        sourcePolicySnapshots,
        readerGate: {
          evaluated: true,
          enforced_for_attachment: enforceForAttachment,
          allowed: !denies,
          allowed_count: allowedCount,
          denied_count: deniedCount,
          missing_count: missingCount,
          viewer_space_role: viewerSpaceRole,
        },
      }),
    };
  }

  async loadDigestBundle(input: {
    spaceId: string;
    workspaceId: string | null;
    agentId: string | null;
  }): Promise<DigestBundle> {
    const policy = await this.loadActiveDigest(
      input.spaceId,
      "space",
      null,
      "policy_bundle",
    );
    const workspace = input.workspaceId
      ? await this.loadActiveDigest(
          input.spaceId,
          "workspace",
          input.workspaceId,
          "workspace",
        )
      : null;
    const agent = input.agentId
      ? await this.loadActiveDigest(input.spaceId, "agent", input.agentId, "agent")
      : null;
    return { policy_bundle: policy, workspace, agent };
  }

  async updateSnapshot(input: SnapshotUpdateInput): Promise<void> {
    await this.db.query(
      `UPDATE context_snapshots
          SET compiled_prefix_text = $1,
              compiled_tail_text = $2,
              prefix_hash = $3,
              tail_hash = $4,
              source_refs_json = $5::jsonb,
              included_evidence_refs_json = $6::jsonb,
              retrieval_trace_json = $7::jsonb,
              token_budget_json = $8::jsonb,
              compiler_version = $9,
              token_estimate = $10,
              policy_bundle_version = $11,
              memory_digest_version = $12,
              workspace_digest_version = $13
        WHERE id = $14
          AND space_id = $15`,
      [
        input.compiledPrefixText,
        input.compiledTailText,
        input.prefixHash,
        input.tailHash,
        JSON.stringify(input.sourceRefs),
        JSON.stringify(input.includedEvidenceRefs),
        JSON.stringify(input.retrievalTrace),
        JSON.stringify(input.tokenBudget),
        input.compilerVersion,
        input.tokenEstimate,
        input.policyBundleVersion ?? null,
        input.memoryDigestVersion ?? null,
        input.workspaceDigestVersion ?? null,
        input.snapshotId,
        input.spaceId,
      ],
    );
  }

  async resolvePersonalGrantForRun(run: RunContextRecord): Promise<PersonalGrantResult> {
    if (!run.instructed_by_user_id) {
      return { personal_context_block: "", metadata: null };
    }
    const now = new Date().toISOString();
    const grantResult = await this.db.query<PersonalGrantRow>(
      `SELECT id, granting_user_id, personal_space_id, target_space_id,
              access_mode, memory_filter_json
         FROM personal_memory_grants
        WHERE target_run_id = $1
          AND granting_user_id = $2
          AND target_space_id = $3
          AND status = 'active'
          AND grant_scope = 'run'
          AND access_mode = 'summary_only'
          AND target_agent_id IS NULL
          AND read_expires_at > $4
        LIMIT 1`,
      [run.id, run.instructed_by_user_id, run.space_id, now],
    );
    const grant = grantResult.rows[0];
    if (!grant) return { personal_context_block: "", metadata: null };

    const claimed = await this.db.query(
      `UPDATE personal_memory_grants
          SET status = 'consuming',
              consume_started_at = $1,
              updated_at = $1
        WHERE id = $2
          AND status = 'active'
          AND read_expires_at > $1`,
      [now, grant.id],
    );
    if ((claimed.rowCount ?? 0) !== 1) {
      return { personal_context_block: "", metadata: null };
    }

    await this.insertGrantEvent({
      grantId: grant.id,
      eventType: "consuming",
      runId: run.id,
      sourceSpaceId: grant.personal_space_id,
      targetSpaceId: grant.target_space_id,
      metadata: {
        access_mode: grant.access_mode,
        raw_private_memory_included: false,
      },
    });

    let memories: ContextMemoryRow[];
    try {
      memories = await this.retrieveEligiblePersonalMemories(grant);
    } catch (error) {
      await this.markGrantFailed(grant, run.id, "memory_retrieval");
      return { personal_context_block: "", metadata: null };
    }

    const summary = generatePersonalSummary(memories);
    const usedAt = new Date().toISOString();
    await this.db.query(
      `UPDATE personal_memory_grants
          SET status = 'used',
              used_at = $1,
              updated_at = $1
        WHERE id = $2
          AND status = 'consuming'`,
      [usedAt, grant.id],
    );
    await this.insertGrantEvent({
      grantId: grant.id,
      eventType: "used",
      runId: run.id,
      sourceSpaceId: grant.personal_space_id,
      targetSpaceId: grant.target_space_id,
      metadata: {
        memory_count: memories.length,
        access_mode: "summary_only",
        raw_private_memory_included: false,
        personal_summary_persisted: false,
      },
    });

    return {
      personal_context_block: summary,
      metadata: {
        grant_id: grant.id,
        granting_user_id: grant.granting_user_id,
        personal_space_id: grant.personal_space_id,
        target_space_id: grant.target_space_id,
        access_mode: grant.access_mode,
        memory_count: memories.length,
        raw_private_memory_included: false,
        personal_summary_persisted: false,
      },
    };
  }

  async markRunPersonalGrantContext(input: {
    runId: string;
    spaceId: string;
    metadata: PersonalGrantMetadata;
  }): Promise<void> {
    await this.db.query(
      `UPDATE runs
          SET has_personal_grant_context = TRUE,
              personal_grant_context_json = $1::jsonb,
              updated_at = $2
        WHERE id = $3
          AND space_id = $4`,
      [
        JSON.stringify(input.metadata),
        new Date().toISOString(),
        input.runId,
        input.spaceId,
      ],
    );
  }

  async withTransaction<T>(fn: (repo: PgRunContextRepository) => Promise<T>): Promise<T> {
    if (!("connect" in this.db)) return fn(this);
    return withTransaction(this.db as Pool, async (client) =>
      fn(new PgRunContextRepository(client)),
    );
  }

  /**
   * Resolve the project cut for the per-run retriever. `undefined` projectId
   * means no project filtering. Otherwise only project-free memory plus the
   * caller's bound project survive, and the bound project is only admitted when
   * the instructing user can actually access it.
   */
  private async resolveProjectFilter(
    spaceId: string,
    userId: string,
    projectId: string | null | undefined,
  ): Promise<{ allowedProjectId: string | null } | undefined> {
    if (projectId === undefined) return undefined;
    if (projectId === null) return { allowedProjectId: null };
    const accessible = await canAccessProject(this.db, spaceId, projectId, userId);
    return { allowedProjectId: accessible ? projectId : null };
  }

  private async symbolMatch(input: {
    spaceId: string;
    userId: string;
    workspaceId: string | null;
    agentId: string | null;
    capabilityId?: string | null;
    readableScopes: ReadonlySet<string>;
    includeSystemScope: boolean;
    projectFilter?: { allowedProjectId: string | null };
  }): Promise<ContextMemoryRow[]> {
    if (input.readableScopes.size === 0) return [];
    const result = await this.db.query<ContextMemoryRow>(
      `SELECT ${contextMemoryColumns("me", "$3")}
         FROM memory_entries me
        WHERE space_id = $1
          AND deleted_at IS NULL
          AND status = 'active'
          AND scope_type = ANY($2)
          AND ${contentReadSql("memory", "me", "$3")}
          AND ${memorySensitivityReadSql("me", "$3")}
          AND (
            subject_user_id = $3
            OR owner_user_id = $3
            OR ($4::varchar IS NOT NULL AND workspace_id = $4)
            OR ($5::varchar IS NOT NULL AND agent_id = $5)
          )
        ORDER BY importance DESC, updated_at DESC
        LIMIT 50`,
      [
        input.spaceId,
        [...input.readableScopes],
        input.userId,
        input.workspaceId,
        input.agentId,
      ],
    );
    return result.rows;
  }

  private async graphExpand(input: {
    spaceId: string;
    userId: string;
    workspaceId: string | null;
    agentId: string | null;
    seedIds: Set<string>;
    readableScopes: ReadonlySet<string>;
    includeSystemScope: boolean;
    projectFilter?: { allowedProjectId: string | null };
  }): Promise<{ rows: ContextMemoryRow[]; hopsUsed: number }> {
    let frontier = new Set(input.seedIds);
    const allFound: ContextMemoryRow[] = [];
    let hopsUsed = 0;

    for (let hop = 1; hop <= MAX_HOPS; hop += 1) {
      if (frontier.size === 0) break;
      const edgeResult = await this.db.query<{ target_id: string }>(
        `SELECT target_id
           FROM memory_relations
          WHERE space_id = $1
            AND source_type = 'memory'
            AND target_type = 'memory'
            AND relation_type = ANY($2)
            AND source_id = ANY($3)`,
        [input.spaceId, ALLOWED_RELATION_TYPES, [...frontier]],
      );
      const candidateIds = [
        ...new Set(edgeResult.rows.map((row) => row.target_id)),
      ].filter((id) => !input.seedIds.has(id));
      if (candidateIds.length === 0) break;

      const rows = hardFilterRows(
        await this.loadMemoriesByIds(input.spaceId, input.userId, candidateIds),
        input,
      ).filter((row) => input.readableScopes.has(row.scope_type ?? ""));
      const newIds = new Set(rows.map((row) => row.id));
      for (const row of rows) allFound.push(row);
      for (const id of newIds) input.seedIds.add(id);
      frontier = newIds;
      hopsUsed = hop;
    }

    return { rows: allFound, hopsUsed };
  }

  private async keywordFallback(input: {
    spaceId: string;
    userId: string;
    workspaceId: string | null;
    agentId: string | null;
    query: string | null;
    readableScopes: ReadonlySet<string>;
    includeSystemScope: boolean;
    projectFilter?: { allowedProjectId: string | null };
  }): Promise<ContextMemoryRow[]> {
    if (!input.query?.trim() || input.readableScopes.size === 0) return [];
    const result = await this.db.query<ContextMemoryRow>(
      `SELECT ${contextMemoryColumns("me", "$4")}
         FROM memory_entries me
        WHERE space_id = $1
          AND deleted_at IS NULL
          AND status = 'active'
          AND scope_type = ANY($2)
          AND (title ILIKE $3 OR content ILIKE $3)
          AND ${contentReadSql("memory", "me", "$4")}
          AND ${memorySensitivityReadSql("me", "$4")}
        ORDER BY importance DESC, confidence DESC
        LIMIT 20`,
      [input.spaceId, [...input.readableScopes], `%${input.query}%`, input.userId],
    );
    return hardFilterRows(result.rows, input).filter((row) =>
      input.readableScopes.has(row.scope_type ?? ""),
    );
  }

  private async loadAndRank(input: {
    spaceId: string;
    userId: string;
    workspaceId: string | null;
    agentId: string | null;
    ids: string[];
    includeSystemScope: boolean;
    maxMemories: number;
    projectFilter?: { allowedProjectId: string | null };
  }): Promise<ContextMemoryRow[]> {
    if (input.ids.length === 0) return [];
    const rows = hardFilterRows(
      await this.loadMemoriesByIds(input.spaceId, input.userId, input.ids),
      input,
    );
    return rows
      .sort(
        (a, b) =>
          numeric(b.importance) - numeric(a.importance) ||
          numeric(b.confidence) - numeric(a.confidence),
      )
      .slice(0, input.maxMemories);
  }

  private async loadMemoriesByIds(
    spaceId: string,
    userId: string,
    ids: readonly string[],
  ): Promise<ContextMemoryRow[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query<ContextMemoryRow>(
      `SELECT ${contextMemoryColumns("me", "$3")}
         FROM memory_entries me
        WHERE space_id = $1
          AND deleted_at IS NULL
          AND status = 'active'
          AND id = ANY($2)
          AND ${contentReadSql("memory", "me", "$3")}
          AND ${memorySensitivityReadSql("me", "$3")}`,
      [spaceId, [...ids], userId],
    );
    return result.rows;
  }

  private async loadActivePolicies(spaceId: string): Promise<PolicyRow[]> {
    const result = await this.db.query<PolicyRow>(
      `SELECT id, name, domain, policy_key, enforcement_mode, priority, policy_json
         FROM policies
        WHERE space_id = $1
          AND enabled = TRUE
          AND status = 'active'
        ORDER BY priority DESC
        LIMIT 10`,
      [spaceId],
    );
    return result.rows;
  }

  private async loadActiveDigest(
    spaceId: string,
    scopeType: string,
    scopeId: string | null,
    digestType: "policy_bundle" | "workspace" | "agent",
  ): Promise<ContextDigestRow | null> {
    const result = await this.db.query<ContextDigestRow>(
      `SELECT id, digest_type, version, status, content,
              source_memory_ids_json, source_policy_ids_json,
              source_relation_ids_json, source_hash, content_hash
         FROM context_digests
        WHERE space_id = $1
          AND scope_type = $2
          AND (($3::varchar IS NULL AND scope_id IS NULL) OR scope_id = $3)
          AND digest_type = $4
          AND status IN ('active', 'dirty')
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                 version DESC
        LIMIT 1`,
      [spaceId, scopeType, scopeId, digestType],
    );
    return result.rows[0] ?? null;
  }

  private async retrieveEligiblePersonalMemories(
    grant: PersonalGrantRow,
  ): Promise<ContextMemoryRow[]> {
    const filter = recordValue(grant.memory_filter_json);
    const maxItems = clampMaxItems(filter.max_items);
    const where = [
      `space_id = $1`,
      contentOwnerFilterSql("memory", "memory_entries", "$2"),
      contentVisibilityFilterSql("memory_entries", ["private"]),
      `sensitivity_level = ANY($3)`,
      `status = 'active'`,
      `deleted_at IS NULL`,
    ];
    const params: unknown[] = [
      grant.personal_space_id,
      grant.granting_user_id,
      ["normal", "sensitive"],
    ];
    addArrayFilter(where, params, "memory_layer", filter.memory_layers);
    addArrayFilter(where, params, "memory_type", filter.memory_types);
    addArrayFilter(where, params, "namespace", filter.namespaces);
    const result = await this.db.query<ContextMemoryRow>(
      `SELECT ${CONTEXT_MEMORY_COLUMNS}
         FROM memory_entries
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ${maxItems}`,
      params,
    );
    return result.rows;
  }

  private async markGrantFailed(
    grant: PersonalGrantRow,
    runId: string,
    failureStage: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE personal_memory_grants
          SET status = 'failed',
              failed_at = $1,
              failure_stage = $2,
              updated_at = $1
        WHERE id = $3`,
      [now, failureStage, grant.id],
    );
    await this.insertGrantEvent({
      grantId: grant.id,
      eventType: "failed",
      runId,
      sourceSpaceId: grant.personal_space_id,
      targetSpaceId: grant.target_space_id,
      metadata: {
        failure_stage: failureStage,
        raw_private_memory_included: false,
      },
    });
  }

  private async insertGrantEvent(input: {
    grantId: string;
    eventType: "consuming" | "used" | "failed";
    runId: string;
    sourceSpaceId: string;
    targetSpaceId: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO personal_memory_grant_events (
          id, grant_id, event_type, run_id, source_space_id,
          target_space_id, metadata_json, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        randomUUID(),
        input.grantId,
        input.eventType,
        input.runId,
        input.sourceSpaceId,
        input.targetSpaceId,
        JSON.stringify(input.metadata),
        new Date().toISOString(),
      ],
    );
  }

  private async insertUsedInContextEvidenceLink(input: {
    spaceId: string;
    evidenceId: string;
    runId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO evidence_links (
          id, space_id, evidence_id, target_type, target_id,
          link_type, status, created_by_run_id, created_at, updated_at
       )
       VALUES ($1, $2, $3, 'run', $4, 'used_in_context', 'active', $4, $5, $5)
       ON CONFLICT (space_id, evidence_id, target_type, target_id, link_type)
        WHERE status = 'active'
        DO NOTHING`,
      [randomUUID(), input.spaceId, input.evidenceId, input.runId, now],
    );
  }
}

function normalizeContextArtifactIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const value = typeof id === "string" ? id.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_CONTEXT_ARTIFACT_ATTACHMENTS) break;
  }
  return out;
}

function normalizeArtifactRevocationIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const value = typeof id === "string" ? id.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 100) break;
  }
  return out;
}

function normalizeRevocationReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed ? trimmed.slice(0, 512) : null;
}

function revocationReason(revocation: ContextArtifactRevocationRecord): string {
  const base = `artifact is revoked for this ${revocation.scope_type} context`;
  return revocation.reason ? `${base}: ${revocation.reason}` : base;
}

function blockedArtifactAttachment(reason: string): ContextArtifactAttachmentSelection {
  return {
    item: {
      attachment_type: "artifact_evidence_pack",
      label: "Blocked artifact evidence pack",
      approved: false,
      rejection_reason: reason,
    },
    ref: {
      source_type: "artifact",
      source_id: null,
      section: "dynamic_tail",
      attachment_type: "artifact_evidence_pack",
      included: false,
      rejection_reason: reason,
    },
  };
}

function artifactAttachmentFromRow(
  row: ContextArtifactRow,
  attachmentSourcePolicySnapshot?: Record<string, unknown>,
): ContextArtifactAttachmentSelection {
  const metadata = recordValue(row.metadata_json);
  const rendered = renderArtifactEvidencePack(row, metadata);
  const domainLabel = artifactDomainLabel(row.artifact_type, metadata);
  const sourcePolicy = attachmentSourcePolicySnapshot ?? sourcePolicySnapshot(metadata);
  const ref = {
    source_type: "artifact",
    source_id: row.id,
    artifact_type: row.artifact_type,
    title: row.title,
    domain_label: domainLabel,
    visibility: row.visibility,
    owner_user_id: row.owner_user_id,
    project_id: row.project_id,
    workspace_id: row.workspace_id,
    section: "dynamic_tail",
    attachment_type: "artifact_evidence_pack",
    included: true,
    content_mode: "bounded_summary",
    raw_artifact_content_included: false,
    created_at: isoOrNull(row.created_at),
    egress_policy_snapshot: recordValue(metadata.egress_policy_snapshot),
    source_policy_snapshot: sourcePolicy,
  };
  return {
    item: {
      attachment_type: "artifact_evidence_pack",
      artifact_id: row.id,
      artifact_type: row.artifact_type,
      label: row.title,
      domain_label: domainLabel,
      approved: true,
      resolved_content: truncateText(rendered, MAX_ATTACHMENT_CONTENT_CHARS),
      policy_snapshot: {
        visibility: row.visibility,
        owner_user_id: row.owner_user_id,
        project_id: row.project_id,
        workspace_id: row.workspace_id,
        content_mode: "bounded_summary",
        raw_artifact_content_included: false,
      },
      source_policy_snapshot: sourcePolicy,
    },
    ref,
  };
}

function renderArtifactEvidencePack(row: ContextArtifactRow, metadata: Record<string, unknown>): string {
  const lines = [
    `Artifact: ${row.title}`,
    `Artifact ID: ${row.id}`,
    `Artifact type: ${row.artifact_type}`,
    `Domain: ${artifactDomainLabel(row.artifact_type, metadata)}`,
  ];

  if (row.artifact_type === "retrieval_brief") {
    appendLine(lines, "Surface", stringValue(metadata.surface));
    appendLine(lines, "Query", stringValue(metadata.query));
    appendLine(lines, "Answer", stringValue(metadata.answer));
    const citations = arrayValue(metadata.citations).slice(0, 8).map((item) => {
      const citation = recordValue(item);
      return `- ${stringValue(citation.title) ?? stringValue(citation.ref_id) ?? "citation"}`;
    });
    if (citations.length > 0) lines.push("Citations:", ...citations);
    const gaps = recordValue(metadata.gap_analysis);
    const gapCodes = [
      ...arrayValue(gaps.deterministic_signals).map((item) => stringValue(recordValue(item).kind)).filter(isString),
      ...arrayValue(gaps.llm_signals).map((item) => stringValue(recordValue(item).kind)).filter(isString),
    ];
    if (gapCodes.length > 0) lines.push(`Gap signals: ${gapCodes.slice(0, 12).join(", ")}`);
    return lines.join("\n");
  }

  if (row.artifact_type === "retrieval_eval_report") {
    appendLine(lines, "Source", stringValue(metadata.source));
    appendLine(lines, "Suite", stringValue(metadata.suite));
    lines.push(`Diagnostic codes: ${stringArray(metadata.diagnostic_codes).join(", ") || "none"}`);
    lines.push(`Metrics: ${JSON.stringify(recordValue(metadata.metrics))}`);
    lines.push(`Counts: ${JSON.stringify(recordValue(metadata.counts))}`);
    return lines.join("\n");
  }

  if (row.artifact_type === "retrieval_explain_report") {
    lines.push(`Diagnostic codes: ${stringArray(metadata.diagnostic_codes).join(", ") || "none"}`);
    appendRetrievalExplainSummary(lines, metadata);
    return lines.join("\n");
  }

  if (row.artifact_type === "retrieval_maintenance_report" || row.artifact_type === "memory_maintenance_report") {
    lines.push(`Counts: ${JSON.stringify(recordValue(metadata.counts))}`);
    const findings = arrayValue(metadata.findings).slice(0, 10).map((item) => {
      const finding = recordValue(item);
      return `- ${stringValue(finding.kind) ?? "finding"}: ${stringValue(finding.reason) ?? ""}`.trim();
    });
    if (findings.length > 0) lines.push("Findings:", ...findings);
    return lines.join("\n");
  }

  if (row.artifact_type === "literature_matrix") {
    const matrix = parseJsonObject(row.content);
    const matrixRows = arrayValue(matrix?.rows);
    const rows = matrixRows.slice(0, 40);
    lines.push(`Project: ${stringValue(matrix?.project_id) ?? row.project_id ?? "unknown"}`);
    lines.push(`Approved corpus rows: ${matrixRows.length}`);
    if (rows.length > 0) {
      lines.push("Corpus entries:");
      for (const item of rows) {
        const entry = recordValue(item);
        lines.push(JSON.stringify({
          title: stringValue(entry.title) ?? "Untitled source",
          triage_status: stringValue(entry.triage_status),
          relevance: stringValue(entry.relevance),
          confidence: numberValue(entry.confidence),
          reason: stringValue(entry.reason),
          evidence_excerpt: stringValue(entry.evidence_excerpt),
          references: arrayValue(entry.references),
        }));
      }
    }
    return lines.join("\n");
  }

  const parsedContent = parseJsonObject(row.content);
  if (parsedContent) lines.push(`Summary: ${JSON.stringify(parsedContent).slice(0, 2000)}`);
  return lines.join("\n");
}

function appendRetrievalExplainSummary(lines: string[], metadata: Record<string, unknown>): void {
  const target = recordValue(metadata.target);
  const match = recordValue(metadata.match);
  appendLine(lines, "Target type", stringValue(target.object_type) ?? stringValue(target.type));
  appendLine(lines, "Target visibility", stringValue(target.visibility));
  appendLine(lines, "Target status", stringValue(target.status));
  const returned = boolValue(target.returned);
  if (returned !== null) lines.push(`Target returned: ${returned ? "yes" : "no"}`);

  const rank = numberValue(match.rank);
  if (rank !== null) lines.push(`Match rank: ${rank}`);
  const score = numberValue(match.score);
  if (score !== null) lines.push(`Match score: ${Number(score.toFixed(4))}`);
  const sourceTypes = stringArray(match.source_types);
  if (sourceTypes.length > 0) lines.push(`Match source types: ${sourceTypes.slice(0, 8).join(", ")}`);
  const matchedFields = stringArray(match.matched_fields);
  if (matchedFields.length > 0) lines.push(`Matched fields: ${matchedFields.slice(0, 8).join(", ")}`);
  const reasons = stringArray(match.reasons);
  if (reasons.length > 0) lines.push("Match reasons:", ...reasons.slice(0, 6).map((reason) => `- ${reason}`));
}

function artifactDomainLabel(type: string, metadata: Record<string, unknown>): string {
  if (type === "memory_maintenance_report") return "memory.maintenance";
  if (type === "retrieval_maintenance_report") return "knowledge.retrieval.maintenance";
  if (type === "retrieval_eval_report") {
    return stringValue(metadata.suite) === "retrieval_quality_feedback_loop"
      ? "knowledge.retrieval.diagnostics"
      : "knowledge.retrieval.eval";
  }
  if (type === "retrieval_explain_report") return "knowledge.retrieval.explain";
  if (type === "retrieval_brief") return stringValue(metadata.surface) ?? "retrieval.brief";
  if (type === "literature_matrix") return "project_research.literature_matrix";
  return type;
}

function sourceConnectionIdsFromArtifactMetadata(metadataJson: unknown): string[] {
  const metadata = recordValue(metadataJson);
  const ids = new Set<string>();
  for (const value of arrayValue(metadata.source_connection_ids)) {
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
  }
  for (const sourceRef of arrayValue(metadata.source_refs)) {
    const id = recordValue(sourceRef).source_connection_id;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  // Fall back to per-item source refs for briefs that predate the aggregated list.
  for (const ref of arrayValue(metadata.item_refs)) {
    for (const sourceRef of arrayValue(recordValue(ref).source_refs)) {
      const id = recordValue(sourceRef).source_connection_id;
      if (typeof id === "string" && id.trim()) ids.add(id.trim());
    }
  }
  return [...ids];
}

function sourcePolicySnapshot(
  metadata: Record<string, unknown>,
  options: {
    sourceConnectionIds?: readonly string[];
    sourcePolicySnapshots?: Record<string, unknown>;
    readerGate?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const egress = recordValue(metadata.egress_policy_snapshot);
  const settings = recordValue(metadata.settings_snapshot);
  const sourceRefs = arrayValue(metadata.source_refs);
  const sourceConnectionIds = options.sourceConnectionIds
    ? [...options.sourceConnectionIds]
    : sourceConnectionIdsFromArtifactMetadata(metadata);
  return {
    egress_policy_snapshot: egress,
    settings_snapshot: settings,
    source_ref_count: sourceRefs.length,
    source_connection_ids: sourceConnectionIds,
    source_connection_count: sourceConnectionIds.length,
    source_policy_snapshots: options.sourcePolicySnapshots ?? {},
    current_reader_gate: options.readerGate ?? {
      evaluated: sourceConnectionIds.length > 0,
      enforced_for_attachment: false,
      allowed: true,
      allowed_count: 0,
      denied_count: 0,
      missing_count: 0,
    },
  };
}

function appendLine(lines: string[], label: string, value: string | null): void {
  if (value) lines.push(`${label}: ${value}`);
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return recordValue(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 32)}\n[truncated for context attachment]`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).filter(isString);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boolValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}
