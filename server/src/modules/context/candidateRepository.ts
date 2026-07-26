import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import {
  MEMORY_COLUMNS,
  type MemoryRow,
  type Queryable,
} from "../memory/repository";
import { shouldRedactMemoryContent } from "../memory/memoryReadAuth";
import { memorySensitivityReadSql } from "../memory/memorySensitivitySql";
import { contentResourceDefinition } from "../access/contentAccessRegistry";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql";
import {
  loadSourceConnectionIdsForTargets,
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourceConnectionIdsFromMetadata,
  sourceConnectionIdsFromSourceRefs,
  type SourcePolicySnapshot,
} from "../retrieval/sourcePolicy";
import { readSpaceRetrievalSettings } from "../retrieval/settings";

/**
 * Native server reads for chat context candidate sources.
 *
 * Each source is fetched at its natural per-source cap, in priority order,
 * without the cumulative budget —
 * the `buildChatContext` loop applies `max_items` / `max_tokens` / dedup over
 * the ordered prefix.
 *
 * The chat request carries no `project_folder_id` / `project_id` / `manual_context`,
 * so only the memory / knowledge / source / activity selectors fire in this
 * path.
 *
 * Memory candidates are intentionally **not** access-logged here. The final
 * selected chat bundle is logged by `PgContextSnapshotRepository` after
 * `buildChatContext` applies budget/dedup, using `context_injection`.
 * `canReadMemory` plus the project-level ACL is the read-authorization
 * boundary.
 *
 * Fidelity note: memory selection here ranks readable active memories by
 * `importance DESC, confidence DESC`. Graph expansion and keyword-fallback
 * union are handled by the full-run context repository.
 */

/** Per-item excerpt truncation limit. */
const MAX_EXCERPT_CHARS = 800;

/** Cap on candidate memory rows fetched before the read-auth filter. */
const MEMORY_FETCH_CAP = 200;
const MEMORY_DEFINITION = contentResourceDefinition("memory")!;

/** Knowledge `knowledge_kind` values selected when `knowledge_item` is allowed. */
const KNOWLEDGE_KINDS = [
  "concept",
  "lesson",
  "procedure",
  "decision",
  "question",
  "answer",
  "summary",
];

export interface CandidateRow {
  item_id: string;
  title: string | null;
  /** null when content is withheld by summary access for a non-owner. */
  text: string | null;
  source_connection_ids: string[];
}

export interface ContextPolicy {
  /** Raw `agent_versions.context_policy_json` (may be `{}`). */
  policy: Record<string, unknown>;
  /** True when a current agent version backed this policy load. */
  resolved: boolean;
}

export function excerpt(text: string | null): string | null {
  if (!text) return null;
  return text.slice(0, MAX_EXCERPT_CHARS);
}

export function tokenCount(text: string | null): number {
  return Math.floor((text ?? "").length / 4);
}

export class PgChatCandidateRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgChatCandidateRepository {
    if (!config.databaseUrl) {
      throw new Error(
        "Chat candidate repository requires SERVER_DATABASE_URL",
      );
    }
    return new PgChatCandidateRepository(getDbPool(config.databaseUrl));
  }

  /**
   * Load `context_policy_json` from the agent's current version. A missing
   * agent/version yields `{}` (conservative-permissive
   * — the collector then allows all sources).
   */
  async loadContextPolicy(
    spaceId: string,
    agentId: string,
  ): Promise<ContextPolicy> {
    const result = await this.db.query<{ context_policy_json: unknown }>(
      `SELECT av.context_policy_json
         FROM agents a
         JOIN agent_versions av ON av.id = a.current_version_id
        WHERE a.space_id = $1 AND a.id = $2
        LIMIT 1`,
      [spaceId, agentId],
    );
    const row = result.rows[0];
    if (!row) return { policy: {}, resolved: false };
    const policy =
      row.context_policy_json && typeof row.context_policy_json === "object"
        ? (row.context_policy_json as Record<string, unknown>)
        : {};
    return { policy, resolved: true };
  }

  /**
   * Readable active memories ranked `importance DESC, confidence DESC`. The
   * canonical SQL predicate, including the `highly_restricted` gate, runs
   * before the cap. No access logging (see module note).
   */
  async selectMemories(
    spaceId: string,
    userId: string,
    limit: number,
  ): Promise<CandidateRow[]> {
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS},
              ${contentAccessLevelSql({ definition: MEMORY_DEFINITION, alias: "me", userExpr: "$2" })} AS effective_access_level
         FROM memory_entries me
        WHERE space_id = $1 AND status = 'active' AND deleted_at IS NULL
          AND scope_type <> 'system'
          AND ${contentReadSql("memory", "me", "$2")}
          AND ${memorySensitivityReadSql("me", "$2")}
        ORDER BY importance DESC, confidence DESC
        LIMIT ${MEMORY_FETCH_CAP}`,
      [spaceId, userId],
    );
    return result.rows.slice(0, limit).map((row) => ({
      item_id: row.id,
      title: row.title,
      text: shouldRedactMemoryContent(row, userId) ? null : (row.content ?? ""),
      source_connection_ids: [],
    }));
  }

  /**
   * Active knowledge items of the recognised types, recent-first, optionally
   * keyword-filtered by the message prefix.
   */
  async selectKnowledgeItems(
    spaceId: string,
    userId: string,
    message: string,
    limit: number,
  ): Promise<CandidateRow[]> {
    const where = [
      `ki.space_id = $1`,
      `so.status = 'active'`,
      `ki.knowledge_kind = ANY($2)`,
    ];
    const params: unknown[] = [spaceId, KNOWLEDGE_KINDS];
    if (message) {
      params.push(`%${message.slice(0, 40)}%`);
      where.push(`(so.title ILIKE $${params.length} OR ki.content ILIKE $${params.length})`);
    }
    params.push(userId);
    where.push(contentReadSql("space_object", "so", `$${params.length}`));
    const result = await this.db.query<{
      id: string;
      title: string | null;
      content: string | null;
      visibility: string | null;
      owner_user_id: string | null;
      created_by_user_id: string | null;
    }>(
      `SELECT ki.object_id AS id, so.title, ki.content,
              so.visibility, so.owner_user_id, so.created_by_user_id
         FROM knowledge_items ki
         JOIN space_objects so ON so.id = ki.object_id AND so.space_id = ki.space_id
        WHERE ${where.join(" AND ")}
          AND so.object_type = 'knowledge_item'
        ORDER BY so.updated_at DESC
        LIMIT ${clampLimit(limit)}`,
      params,
    );
    const sourceIdsByTarget = await loadSourceConnectionIdsForTargets(
      this.db,
      spaceId,
      "knowledge",
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) => ({
      item_id: row.id,
      title: row.title,
      text: row.content ?? "",
      source_connection_ids: sourceIdsByTarget.get(row.id) ?? [],
    }));
  }

  /** Processed sources, recent-first. */
  async selectSources(spaceId: string, limit: number): Promise<CandidateRow[]> {
    const result = await this.db.query<{
      id: string;
      title: string | null;
      summary: string | null;
      raw_text: string | null;
      metadata_json: unknown;
    }>(
      `SELECT s.object_id AS id, so.title, s.summary, s.raw_text, s.metadata_json
         FROM sources s
         JOIN space_objects so ON so.id = s.object_id AND so.space_id = s.space_id
        WHERE s.space_id = $1 AND so.object_type = 'source' AND so.status = 'processed'
        ORDER BY so.created_at DESC
        LIMIT ${clampLimit(limit)}`,
      [spaceId],
    );
    return result.rows.map((row) => ({
      item_id: row.id,
      title: row.title,
      text: row.summary ?? row.raw_text ?? "",
      source_connection_ids: sourceConnectionIdsFromMetadata(row.metadata_json),
    }));
  }

  /**
   * Approved project public summaries in the space. These are the deliberately
   * sanitized, space-public discovery layer (not concrete project memory), so
   * they need no per-user/project-member gate — they let the shared assistant
   * surface cross-project inspiration. Optionally keyword-filtered by the
   * message prefix against name / summary / topics.
   */
  async selectProjectPublicSummaries(
    spaceId: string,
    message: string,
    limit: number,
    projectId:string|null=null,
  ): Promise<CandidateRow[]> {
    const where = [
      `ps.space_id = $1`,
      `ps.review_status = 'approved'`,
      `p.status = 'active'`,
      `p.deleted_at IS NULL`,
    ];
    const params: unknown[] = [spaceId];
    if(projectId){params.push(projectId);where.push(`ps.project_id = $${params.length}`);}
    if (message) {
      params.push(`%${message.slice(0, 40)}%`);
      const p = `$${params.length}`;
      where.push(`(p.name ILIKE ${p} OR ps.summary_text ILIKE ${p} OR ps.topics_json::text ILIKE ${p})`);
    }
    const result = await this.db.query<{
      project_id: string;
      title: string | null;
      summary_text: string | null;
      source_refs_json: unknown;
    }>(
      `SELECT ps.project_id, p.name AS title, ps.summary_text, ps.source_refs_json
         FROM project_public_summaries ps
         JOIN projects p ON p.id = ps.project_id AND p.space_id = ps.space_id
        WHERE ${where.join(" AND ")}
        ORDER BY ps.updated_at DESC
        LIMIT ${clampLimit(limit)}`,
      params,
    );
    return result.rows.map((row) => ({
      item_id: row.project_id,
      title: row.title,
      text: row.summary_text ?? "",
      source_connection_ids: sourceConnectionIdsFromSourceRefs(row.source_refs_json),
    }));
  }

  /**
   * A project's notes (its auto-created Knowledge Notes folder, see
   * areaService.ts), most recently updated first. Scoped by
   * `primary_project_id` at the SQL level — this is what
   * ChatContextCandidateCollector relies on to keep project-scoped conversation isolated
   * to the requesting project's own notes (never another project's, never
   * space-wide notes).
   */
  async selectProjectNotes(spaceId: string, projectId: string, limit: number): Promise<CandidateRow[]> {
    const result = await this.db.query<{ id: string; title: string | null; plain_text: string | null }>(
      `SELECT n.object_id AS id, so.title, n.plain_text
         FROM notes n JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
        WHERE so.space_id = $1 AND so.primary_project_id = $2 AND so.status = 'active' AND COALESCE(n.plain_text, '') <> ''
        ORDER BY so.updated_at DESC
        LIMIT ${clampLimit(limit)}`,
      [spaceId, projectId],
    );
    return result.rows.map((row) => ({ item_id: row.id, title: row.title, text: row.plain_text ?? "", source_connection_ids: [] }));
  }

  /** Space-wide notes (Knowledge > Notes), most recently updated first, optionally keyword-filtered. */
  async selectNotes(spaceId: string, userId: string, message: string, limit: number): Promise<CandidateRow[]> {
    const where = [`n.space_id = $1`, `so.status = 'active'`];
    const params: unknown[] = [spaceId];
    if (message) {
      params.push(`%${message.slice(0, 40)}%`);
      where.push(`(so.title ILIKE $${params.length} OR n.plain_text ILIKE $${params.length})`);
    }
    params.push(userId);
    where.push(contentReadSql("space_object", "so", `$${params.length}`));
    const result = await this.db.query<{ id: string; title: string | null; plain_text: string | null }>(
      `SELECT n.object_id AS id, so.title, n.plain_text
         FROM notes n JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
        WHERE ${where.join(" AND ")}
        ORDER BY so.updated_at DESC
        LIMIT ${clampLimit(limit)}`,
      params,
    );
    return result.rows.map((row) => ({ item_id: row.id, title: row.title, text: row.plain_text ?? "", source_connection_ids: [] }));
  }

  /** Recent activity records readable by the given user. */
  async selectActivityRecords(
    spaceId: string,
    userId: string,
    limit: number,
  ): Promise<CandidateRow[]> {
    const result = await this.db.query<{
      id: string;
      title: string | null;
      content: string | null;
      visibility: string;
      owner_user_id: string | null;
    }>(
      `SELECT ar.id, ar.title, ar.content, ar.visibility, ar.owner_user_id
         FROM activity_records ar
        WHERE ar.space_id = $1
          AND status NOT IN ('archived', 'failed')
          AND ${contentReadSql("activity", "ar", "$2")}
        ORDER BY occurred_at DESC
        LIMIT ${clampLimit(limit)}`,
      [spaceId, userId],
    );
    return result.rows.map((row) => ({
        item_id: row.id,
        title: row.title,
        text: row.content ?? "",
        source_connection_ids: [],
      }));
  }

  async loadSourcePolicySnapshots(
    spaceId: string,
    sourceConnectionIds: readonly string[],
  ): Promise<Map<string, SourcePolicySnapshot>> {
    return loadSourcePolicySnapshots(this.db, spaceId, sourceConnectionIds);
  }

  async loadViewerSpaceRole(spaceId: string, userId: string): Promise<string | null> {
    return loadViewerSpaceRole(this.db, spaceId, userId);
  }

  async loadExternalEgressEnabled(spaceId: string): Promise<boolean> {
    return (await readSpaceRetrievalSettings(this.db, spaceId)).externalEgressEnabled;
  }
}

/** Guard the inlined LIMIT against non-positive / non-integer values. */
function clampLimit(limit: number): number {
  const n = Math.floor(limit);
  return n > 0 ? n : 1;
}
