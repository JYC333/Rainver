import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type {
  MemoryOut,
  MemoryPage,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  canReadMemory,
  shouldRedactMemoryContent,
  type MemoryAuthFields,
} from "./memoryReadAuth";
import { accessibleProjectIds, canAccessProject } from "./projectAccess";
import { contentResourceDefinition } from "../access/contentAccessRegistry";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql";
import { resolveOversightLevel } from "../access/oversightResolver";
import { memorySensitivityReadSql } from "./memorySensitivitySql";

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface MemoryListFilters {
  scope?: string | null;
  namespace?: string | null;
  memoryType?: string | null;
  status?: string | null;
  projectFolderId?: string | null;
  projectId?: string | null;
  includeSystem?: boolean;
  limit: number;
  offset: number;
}

export interface MemorySearchFilters {
  query: string;
  scope?: string | null;
  namespace?: string | null;
  memoryType?: string | null;
  projectFolderId?: string | null;
  includeSystem?: boolean;
  limit: number;
}

/**
 * Whether `scope=system` seed memories (system policy rows) should be visible.
 * The user-facing read surface hides them by default so they do not show up as
 * user memory hits; an explicit `scope=system` filter or `includeSystem` opts in.
 */
function includeSystemScopeFor(
  filters: { scope?: string | null; includeSystem?: boolean },
): boolean {
  return filters.includeSystem === true || filters.scope === "system";
}

/** Raised when a filter references a project that is not in the space. */
export class MemoryReadValidationError extends Error {}

// All columns the read model needs: the MemoryOut wire fields plus the columns
// canReadMemory inspects.
export const MEMORY_COLUMNS = `id, space_id, subject_user_id, owner_user_id, project_folder_id,
  scope_type, namespace, memory_type, title, content, status, visibility, access_level,
  sensitivity_level, last_confirmed_at, confidence, importance,
  source_id, created_by, created_at, updated_at, deleted_at, version, tags,
  memory_layer, source_trust, created_from_proposal_id,
  root_memory_id, supersedes_memory_id, project_id`;

export interface MemoryRow extends MemoryAuthFields {
  id: string;
  subject_user_id: string | null;
  namespace: string | null;
  memory_type: string;
  title: string | null;
  content: string | null;
  status: string;
  last_confirmed_at: unknown;
  confidence: number | string;
  importance: number | string;
  source_id: string | null;
  created_by: string | null;
  created_at: unknown;
  updated_at: unknown;
  version: number | string;
  tags: unknown;
  memory_layer: string | null;
  source_trust: string | null;
  created_from_proposal_id: string | null;
  root_memory_id: string | null;
  supersedes_memory_id: string | null;
  project_id: string | null;
}

const MEMORY_DEFINITION = contentResourceDefinition("memory")!;

/**
 * server memory **read** model. A scoped SQL query loads candidate rows, then
 * `canReadMemory` filters them in app code (so pagination is applied to the
 * readable set, not the raw rows), then rows are serialized with summary-only
 * redaction.
 *
 * Read-access logging: `get` writes one `explicit_read` trace and `search`
 * writes one `search_hit` trace per
 * returned row into `memory_access_logs`, and bumps the accessed memory's
 * `access_count` / `last_accessed_at` (column-scoped UPDATE; the read role never
 * gets table-wide `memory_entries` write). `list` is never logged.
 */
export class PgMemoryReadRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgMemoryReadRepository {
    if (!config.databaseUrl) {
      throw new Error("Memory read repository requires SERVER_DATABASE_URL");
    }
    return new PgMemoryReadRepository(getDbPool(config.databaseUrl));
  }

  async list(
    spaceId: string,
    userId: string,
    filters: MemoryListFilters,
  ): Promise<MemoryPage> {
    if (filters.projectId) {
      await this.assertProjectInSpace(spaceId, filters.projectId);
    }
    const where = [`space_id = $1`, `deleted_at IS NULL`];
    const params: unknown[] = [spaceId];
    const status = filters.status ?? "active";
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (filters.scope) {
      params.push(filters.scope);
      where.push(`scope_type = $${params.length}`);
    }
    if (filters.namespace) {
      params.push(filters.namespace);
      where.push(`namespace = $${params.length}`);
    }
    if (filters.memoryType) {
      params.push(filters.memoryType);
      where.push(`memory_type = $${params.length}`);
    }
    if (filters.projectId) {
      params.push(filters.projectId);
      where.push(`project_id = $${params.length}`);
    }
    params.push(userId);
    const userExpr = `$${params.length}`;
    where.push(contentReadSql("memory", "me", userExpr));
    where.push(memorySensitivityReadSql("me", userExpr));
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS},
              ${contentAccessLevelSql({ definition: MEMORY_DEFINITION, alias: "me", userExpr })} AS effective_access_level
         FROM memory_entries me
        WHERE ${where.join(" AND ")}
        ORDER BY importance DESC, updated_at DESC`,
      params,
    );
    // System-scope seed memories are hidden unless explicitly opted in.
    const includeSystem = includeSystemScopeFor(filters);
    const oversightLevel = await resolveOversightLevel(this.db, spaceId, userId);
    const readable = result.rows.filter((row) =>
      canReadMemory(row, {
        userId,
        spaceId,
        projectFolderId: filters.projectFolderId ?? null,
        includeSystemScope: includeSystem && row.scope_type === "system",
        oversightLevel,
      }),
    );
    // Project gating: a memory tied to a project is only visible to viewers who
    // can access that project. Applied to the readable set before pagination so
    // counts and pages reflect what the viewer may actually see.
    const visible = await this.filterByProjectAccess(readable, spaceId, userId);
    const items = visible
      .slice(filters.offset, filters.offset + filters.limit)
      .map((row) => this.serialize(row, userId));
    return {
      items,
      total: visible.length,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async get(
    spaceId: string,
    userId: string,
    memoryId: string,
    projectFolderId: string | null,
  ): Promise<MemoryOut | null> {
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS},
              ${contentAccessLevelSql({ definition: MEMORY_DEFINITION, alias: "me", userExpr: "$3" })} AS effective_access_level
         FROM memory_entries me
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL
          AND ${contentReadSql("memory", "me", "$3")}
          AND ${memorySensitivityReadSql("me", "$3")}`,
      [memoryId, spaceId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const includeSystemScope = row.scope_type === "system";
    const oversightLevel = await resolveOversightLevel(this.db, spaceId, userId);
    if (
      !canReadMemory(row, { userId, spaceId, projectFolderId, includeSystemScope, oversightLevel })
    ) {
      return null;
    }
    // Project gating: project-scoped memory requires project access. Checked
    // before logging the read so an inaccessible row is neither returned nor
    // traced. project_id IS NULL memory is not project-gated.
    if (row.project_id && !(await canAccessProject(this.db, spaceId, row.project_id, userId))) {
      return null;
    }
    await this.recordReads([row.id], spaceId, userId, "explicit_read", null);
    return this.serialize(row, userId);
  }

  async search(
    spaceId: string,
    userId: string,
    filters: MemorySearchFilters,
  ): Promise<MemoryOut[]> {
    const where = [
      `space_id = $1`,
      `status = 'active'`,
      `deleted_at IS NULL`,
      `(title ILIKE $2 OR content ILIKE $2)`,
    ];
    const params: unknown[] = [spaceId, `%${filters.query}%`];
    if (filters.scope) {
      params.push(filters.scope);
      where.push(`scope_type = $${params.length}`);
    }
    if (filters.namespace) {
      params.push(filters.namespace);
      where.push(`namespace = $${params.length}`);
    }
    if (filters.memoryType) {
      params.push(filters.memoryType);
      where.push(`memory_type = $${params.length}`);
    }
    params.push(userId);
    const userExpr = `$${params.length}`;
    where.push(contentReadSql("memory", "me", userExpr));
    where.push(memorySensitivityReadSql("me", userExpr));
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS},
              ${contentAccessLevelSql({ definition: MEMORY_DEFINITION, alias: "me", userExpr })} AS effective_access_level
         FROM memory_entries me
        WHERE ${where.join(" AND ")}
        ORDER BY importance DESC, confidence DESC`,
      params,
    );
    // System-scope seed memories are hidden from search unless explicitly
    // opted in (an `include_system` flag or an explicit `scope=system` filter).
    const includeSystem = includeSystemScopeFor(filters);
    const oversightLevel = await resolveOversightLevel(this.db, spaceId, userId);
    const readable = result.rows.filter((row) =>
      canReadMemory(row, {
        userId,
        spaceId,
        projectFolderId: filters.projectFolderId ?? null,
        includeSystemScope: includeSystem && row.scope_type === "system",
        oversightLevel,
      }),
    );
    const visible = await this.filterByProjectAccess(readable, spaceId, userId);
    const returned = visible.slice(0, filters.limit);
    await this.recordReads(
      returned.map((row) => row.id),
      spaceId,
      userId,
      "search_hit",
      "memory search",
    );
    return returned.map((row) => this.serialize(row, userId));
  }

  /**
   * Log the memories surfaced by a retrieval create-safety / duplicate check.
   * Create-safety only returns rows the viewer could already read, so it is a
   * read and must stay auditable like `search`. Only the final returned matches
   * are logged — never the candidates the engine over-fetched and then dropped
   * during revalidation (those can be cross-space/private rows the caller cannot
   * read, so logging their ids would leak existence).
   */
  async recordCreateSafetyReads(
    memoryIds: readonly string[],
    spaceId: string,
    userId: string,
  ): Promise<void> {
    await this.recordReads(memoryIds, spaceId, userId, "create_safety_hit", "memory create-safety");
  }

  /**
   * Log the memories returned by the retrieval-backed memory search. Like the
   * legacy `search`, this is a `search_hit`; only the final returned rows are
   * logged, never candidates dropped during revalidation.
   */
  async recordRetrievalSearchReads(
    memoryIds: readonly string[],
    spaceId: string,
    userId: string,
  ): Promise<void> {
    await this.recordReads(memoryIds, spaceId, userId, "search_hit", "memory retrieval search");
  }

  /**
   * Log the memory revalidated while recording retrieval feedback. Feedback is
   * positive-only ranking metadata, but the visibility check still reads the
   * memory row and must remain auditable.
   */
  async recordRetrievalFeedbackReads(
    memoryIds: readonly string[],
    spaceId: string,
    userId: string,
  ): Promise<void> {
    await this.recordReads(memoryIds, spaceId, userId, "explicit_read", "memory retrieval feedback");
  }

  /**
   * Log memories that contributed to a private Memory maintenance report. Only
   * final findings are logged; filtered-out candidates are never traced.
   */
  async recordMaintenanceReads(
    memoryIds: readonly string[],
    spaceId: string,
    userId: string,
    reportArtifactId: string | null,
  ): Promise<void> {
    await this.recordReads(
      memoryIds,
      spaceId,
      userId,
      "maintenance_scan",
      reportArtifactId ? `memory maintenance report ${reportArtifactId}` : "memory maintenance scan",
    );
  }

  /**
   * Append `memory_access_logs` traces for the returned rows and bump each
   * memory's `access_count` / `last_accessed_at`: one trace row per read,
   * viewer user only (no agent/run), and a column-scoped counter UPDATE.
   * `last_retrieved_at` is left untouched; context injection owns that field.
   */
  private async recordReads(
    memoryIds: readonly string[],
    spaceId: string,
    userId: string,
    accessType: "explicit_read" | "search_hit" | "create_safety_hit" | "maintenance_scan",
    reason: string | null,
  ): Promise<void> {
    if (memoryIds.length === 0) return;
    const now = new Date().toISOString();

    const logCols =
      "id, space_id, memory_id, user_id, agent_id, run_id, access_type, reason, accessed_at";
    const logGroups: string[] = [];
    const logParams: unknown[] = [];
    for (const memoryId of memoryIds) {
      const base = logParams.length;
      logGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, NULL, NULL, ` +
          `$${base + 5}, $${base + 6}, $${base + 7})`,
      );
      logParams.push(randomUUID(), spaceId, memoryId, userId, accessType, reason, now);
    }
    await this.db.query(
      `INSERT INTO memory_access_logs (${logCols}) VALUES ${logGroups.join(", ")}`,
      logParams,
    );

    const idPlaceholders = memoryIds.map((_, i) => `$${i + 3}`).join(", ");
    await this.db.query(
      `UPDATE memory_entries
          SET access_count = COALESCE(access_count, 0) + 1,
              last_accessed_at = $1
        WHERE space_id = $2 AND id IN (${idPlaceholders})`,
      [now, spaceId, ...memoryIds],
    );
  }

  /**
   * Drop rows whose `project_id` the viewer cannot access. Resolves accessible
   * projects in a fixed number of queries (see `accessibleProjectIds`); rows
   * with no `project_id` are kept.
   */
  private async filterByProjectAccess(
    rows: MemoryRow[],
    spaceId: string,
    userId: string,
  ): Promise<MemoryRow[]> {
    const accessible = await accessibleProjectIds(
      this.db,
      spaceId,
      userId,
      rows.map((row) => row.project_id),
    );
    return rows.filter((row) => !row.project_id || accessible.has(row.project_id));
  }

  private async assertProjectInSpace(spaceId: string, projectId: string): Promise<void> {
    const result = await this.db.query(
      `SELECT 1 FROM projects
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [projectId, spaceId],
    );
    if ((result.rowCount ?? result.rows.length) === 0) {
      throw new MemoryReadValidationError(
        `project_id '${projectId}' not found in space '${spaceId}' or has been deleted`,
      );
    }
  }

  private serialize(row: MemoryRow, viewerUserId: string): MemoryOut {
    return serializeMemoryRow(row, viewerUserId);
  }
}

/** Serialize a memory row to the `MemoryOut` wire shape with summary-only
 * redaction (shared by the read model and the apply accept-result builder). */
export function serializeMemoryRow(row: MemoryRow, viewerUserId: string): MemoryOut {
  const redact = shouldRedactMemoryContent(row, viewerUserId);
  return {
    id: row.id,
      space_id: row.space_id,
      subject_user_id: row.subject_user_id,
      owner_user_id: row.owner_user_id,
      project_folder_id: row.project_folder_id,
      scope: row.scope_type ?? "",
      namespace: row.namespace,
      type: row.memory_type,
      title: row.title,
      content: redact ? null : row.content,
      status: row.status,
      visibility: row.visibility ?? "private",
      access_level: row.access_level ?? "full",
      sensitivity_level: row.sensitivity_level ?? "normal",
      last_confirmed_at: isoOrNull(row.last_confirmed_at),
      confidence: numeric(row.confidence),
      importance: numeric(row.importance),
      created_by: row.created_by,
      created_at: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
      updated_at: isoOrNull(row.updated_at) ?? new Date(0).toISOString(),
      deleted_at: isoOrNull(row.deleted_at),
      version: Number(row.version),
      tags: normalizeArray(row.tags),
      memory_layer: row.memory_layer,
      source_trust: row.source_trust,
      created_from_proposal_id: row.created_from_proposal_id,
      root_memory_id: row.root_memory_id,
      supersedes_memory_id: row.supersedes_memory_id,
      project_id: row.project_id,
    };
}

function numeric(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function normalizeArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}
