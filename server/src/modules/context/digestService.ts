import { createHash, randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool, type Pool } from "../../db/pool";
import { HttpError, type Queryable } from "../routeUtils/common";
import { contentVisibilityFilterSql } from "../access/contentAccessSql";

export interface PolicyDigestResult {
  id: string;
  space_id: string;
  version: number;
  status: "generated" | "unchanged";
  source_hash: string;
  source_policy_count: number;
}

export interface MemoryDigestResult {
  id: string;
  space_id: string;
  scope_id: string;
  version: number;
  status: "generated" | "unchanged";
  source_hash: string;
  source_memory_count: number;
}

export interface ContextDigestRefreshResult {
  digest_type: "policy_bundle" | "project_folder" | "agent";
  scope_type: "space" | "project_folder" | "agent";
  scope_id: string | null;
  id: string;
  space_id: string;
  version: number;
  status: "generated" | "unchanged";
  source_hash: string;
  source_policy_count?: number;
  source_memory_count?: number;
}

interface PolicyRow {
  id: string;
  name: string;
  domain: string;
  policy_key: string | null;
  enforcement_mode: string | null;
  priority: number | string;
  policy_json: unknown;
  rule_json?: unknown;
  applies_to_json?: unknown;
  policy_version: number | string;
}

interface DirtyDigestRow {
  scope_type: "space" | "project_folder" | "agent";
  scope_id: string | null;
  digest_type: "policy_bundle" | "project_folder" | "agent";
}

interface DigestStatusRow {
  id: string;
  version: number | string;
  status: string;
  source_hash: string | null;
}

interface MemorySummaryRow {
  id: string;
  title: string | null;
  content: string | null;
  namespace: string | null;
  memory_layer: string | null;
  memory_type: string | null;
  visibility: string | null;
  sensitivity_level: string | null;
  version: number | string;
}

/**
 * Per-digest advisory lock keys. Generation and dirty-marking MUST use the same
 * key so they serialize: otherwise a refresh that read stale sources could flip a
 * concurrently-marked-dirty digest back to `active` (source_hash matches the
 * stale read), resurfacing a stale digest as injectable.
 */
export const digestLockKey = {
  policyBundle: (spaceId: string) => `policy_bundle:${spaceId}`,
  projectFolder: (spaceId: string, projectFolderId: string) => `project_folder:${spaceId}:${projectFolderId}`,
  agent: (spaceId: string, agentId: string) => `agent:${spaceId}:${agentId}`,
};

/**
 * Acquire the transaction-scoped advisory lock for a digest key. Held until the
 * caller's transaction commits/rolls back, so it must be called inside one.
 */
async function acquireDigestLock(db: Queryable, lockKey: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
}

/**
 * Mark the active policy_bundle digest as dirty.
 * Must run inside the caller's transaction: it takes the per-digest advisory lock
 * (so it serializes with refresh) and the mark is atomic with the policy change.
 * No-op if no active digest exists (the next job run will create the first one).
 */
export async function markPolicyBundleDirty(
  db: Queryable,
  spaceId: string,
  reason: Record<string, unknown>,
): Promise<void> {
  // Serialize against a concurrent refresh so it cannot flip this digest back to
  // active off a stale source read after we mark it dirty.
  await acquireDigestLock(db, digestLockKey.policyBundle(spaceId));
  const now = new Date().toISOString();
  await db.query(
    `UPDATE context_digests
        SET status = 'dirty',
            dirty_since = COALESCE(dirty_since, $1),
            dirty_count = dirty_count + 1,
            dirty_reason_json = $2::jsonb,
            updated_at = $1
      WHERE space_id = $3
        AND scope_type = 'space'
        AND scope_id IS NULL
        AND digest_type = 'policy_bundle'
        AND status IN ('active', 'dirty')`,
    [now, JSON.stringify(reason), spaceId],
  );
}

/**
 * Mark the active Project Folder digest as dirty.
 * Must run inside the caller's transaction: it takes the per-digest advisory lock
 * (so it serializes with refresh) and the mark is atomic with the memory change.
 * No-op if no active digest exists for this Folder.
 */
export async function markProjectFolderBundleDirty(
  db: Queryable,
  spaceId: string,
  projectFolderId: string,
  reason: Record<string, unknown>,
): Promise<void> {
  await acquireDigestLock(db, digestLockKey.projectFolder(spaceId, projectFolderId));
  const now = new Date().toISOString();
  await db.query(
    `UPDATE context_digests
        SET status = 'dirty',
            dirty_since = COALESCE(dirty_since, $1),
            dirty_count = dirty_count + 1,
            dirty_reason_json = $2::jsonb,
            updated_at = $1
      WHERE space_id = $3
        AND scope_type = 'project_folder'
        AND scope_id = $4
        AND digest_type = 'project_folder'
        AND status IN ('active', 'dirty')`,
    [now, JSON.stringify(reason), spaceId, projectFolderId],
  );
}

/**
 * Mark the active agent digest as dirty.
 * Must run inside the caller's transaction: it takes the per-digest advisory lock
 * (so it serializes with refresh) and the mark is atomic with the memory change.
 * No-op if no active digest exists for this agent.
 */
export async function markAgentBundleDirty(
  db: Queryable,
  spaceId: string,
  agentId: string,
  reason: Record<string, unknown>,
): Promise<void> {
  await acquireDigestLock(db, digestLockKey.agent(spaceId, agentId));
  const now = new Date().toISOString();
  await db.query(
    `UPDATE context_digests
        SET status = 'dirty',
            dirty_since = COALESCE(dirty_since, $1),
            dirty_count = dirty_count + 1,
            dirty_reason_json = $2::jsonb,
            updated_at = $1
      WHERE space_id = $3
        AND scope_type = 'agent'
        AND scope_id = $4
        AND digest_type = 'agent'
        AND status IN ('active', 'dirty')`,
    [now, JSON.stringify(reason), spaceId, agentId],
  );
}

/**
 * Disable any active/dirty digests for a scope that is being archived/deleted.
 *
 * Sets them to 'disabled' so they stop loading (loadActiveDigest only reads
 * active/dirty) and free the `uq_context_digests_current_scope` slot, avoiding
 * orphan rows that would otherwise survive the scope. No-op if none exist.
 */
export async function disableScopeDigests(
  db: Queryable,
  spaceId: string,
  scopeType: "project_folder" | "agent",
  scopeId: string,
): Promise<void> {
  await db.query(
    `UPDATE context_digests
        SET status = 'disabled', updated_at = $1
      WHERE space_id = $2
        AND scope_type = $3
        AND scope_id = $4
        AND status IN ('active', 'dirty')`,
    [new Date().toISOString(), spaceId, scopeType, scopeId],
  );
}

export class PgContextDigestService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgContextDigestService {
    if (!config.databaseUrl) {
      throw new Error("PgContextDigestService requires SERVER_DATABASE_URL");
    }
    return new PgContextDigestService(getDbPool(config.databaseUrl));
  }

  async generatePolicyBundle(spaceId: string): Promise<PolicyDigestResult> {
    return this.withDigestLock(digestLockKey.policyBundle(spaceId), (svc) =>
      svc.generatePolicyBundleUnlocked(spaceId),
    );
  }

  private async generatePolicyBundleUnlocked(spaceId: string): Promise<PolicyDigestResult> {
    const policies = await this.loadActivePolicies(spaceId);
    const sourceHash = computePolicySourceHash(spaceId, policies);
    const content = renderPolicyBundleContent(policies);

    const existing = await this.loadCurrentDigest(spaceId, "space", null, "policy_bundle");

    // Idempotent: same source → mark active (in case it was dirty) and return.
    if (existing && existing.source_hash === sourceHash) {
      if (existing.status === "dirty") {
        await this.db.query(
          `UPDATE context_digests
              SET status = 'active',
                  dirty_since = NULL,
                  dirty_reason_json = NULL,
                  updated_at = $1
            WHERE id = $2`,
          [new Date().toISOString(), existing.id],
        );
      }
      return {
        id: existing.id,
        space_id: spaceId,
        version: Number(existing.version),
        status: "unchanged",
        source_hash: sourceHash,
        source_policy_count: policies.length,
      };
    }

    const now = new Date().toISOString();
    const newId = randomUUID();
    const prevVersion = existing ? Number(existing.version) : 0;

    // Supersede the existing digest.
    if (existing) {
      await this.db.query(
        `UPDATE context_digests SET status = 'superseded', updated_at = $1 WHERE id = $2`,
        [now, existing.id],
      );
    }

    await this.db.query(
      `INSERT INTO context_digests
         (id, space_id, scope_type, scope_id, digest_type, version, status,
          content, source_policy_ids_json, source_hash, content_hash,
          generated_at, created_at, updated_at)
       VALUES ($1, $2, 'space', NULL, 'policy_bundle', $3, 'active',
               $4, $5::jsonb, $6, $7, $8, $8, $8)`,
      [
        newId,
        spaceId,
        prevVersion + 1,
        content || null,
        JSON.stringify(policies.map((p) => p.id)),
        sourceHash,
        sha256(content),
        now,
      ],
    );

    return {
      id: newId,
      space_id: spaceId,
      version: prevVersion + 1,
      status: "generated",
      source_hash: sourceHash,
      source_policy_count: policies.length,
    };
  }

  private async loadActivePolicies(spaceId: string): Promise<PolicyRow[]> {
    const result = await this.db.query<PolicyRow>(
      `SELECT id, name, domain, policy_key, enforcement_mode, priority,
              policy_json, rule_json, applies_to_json, policy_version
         FROM policies
        WHERE space_id = $1
          AND enabled = TRUE
          AND status = 'active'
        ORDER BY priority DESC, name ASC
        LIMIT 100`,
      [spaceId],
    );
    return result.rows;
  }

  async generateProjectFolderBundle(spaceId: string, projectFolderId: string): Promise<MemoryDigestResult> {
    return this.withDigestLock(digestLockKey.projectFolder(spaceId, projectFolderId), (svc) =>
      svc.generateScopeBundle(spaceId, "project_folder", projectFolderId, "project_folder_id"),
    );
  }

  async generateAgentBundle(spaceId: string, agentId: string): Promise<MemoryDigestResult> {
    return this.withDigestLock(digestLockKey.agent(spaceId, agentId), (svc) =>
      svc.generateScopeBundle(spaceId, "agent", agentId, "agent_id"),
    );
  }

  private async generateScopeBundle(
    spaceId: string,
    scopeType: "project_folder" | "agent",
    scopeId: string,
    idColumn: "project_folder_id" | "agent_id",
  ): Promise<MemoryDigestResult> {
    // Fail closed if the scope no longer exists or has been archived. The
    // context_digests table only FKs space_id, so without this gate an explicit
    // refresh/job could re-create an `active` digest for an archived Folder/
    // agent (whose prior digest was already disabled on archive).
    await this.assertScopeActive(spaceId, scopeType, scopeId);
    const memories = await this.loadScopeMemories(spaceId, scopeType, idColumn, scopeId);
    const sourceHash = computeMemorySourceHash(scopeType, spaceId, scopeId, memories);
    const content = renderMemoryBundleContent(memories);

    const existing = await this.loadCurrentDigest(spaceId, scopeType, scopeId, scopeType);

    if (existing && existing.source_hash === sourceHash) {
      if (existing.status === "dirty") {
        await this.db.query(
          `UPDATE context_digests
              SET status = 'active',
                  dirty_since = NULL,
                  dirty_reason_json = NULL,
                  updated_at = $1
            WHERE id = $2`,
          [new Date().toISOString(), existing.id],
        );
      }
      return {
        id: existing.id,
        space_id: spaceId,
        scope_id: scopeId,
        version: Number(existing.version),
        status: "unchanged",
        source_hash: sourceHash,
        source_memory_count: memories.length,
      };
    }

    const now = new Date().toISOString();
    const newId = randomUUID();
    const prevVersion = existing ? Number(existing.version) : 0;

    if (existing) {
      await this.db.query(
        `UPDATE context_digests SET status = 'superseded', updated_at = $1 WHERE id = $2`,
        [now, existing.id],
      );
    }

    await this.db.query(
      `INSERT INTO context_digests
         (id, space_id, scope_type, scope_id, digest_type, version, status,
          content, source_memory_ids_json, source_hash, content_hash,
          generated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $3, $5, 'active',
               $6, $7::jsonb, $8, $9, $10, $10, $10)`,
      [
        newId,
        spaceId,
        scopeType,
        scopeId,
        prevVersion + 1,
        content || null,
        JSON.stringify(memories.map((m) => m.id)),
        sourceHash,
        sha256(content),
        now,
      ],
    );

    return {
      id: newId,
      space_id: spaceId,
      scope_id: scopeId,
      version: prevVersion + 1,
      status: "generated",
      source_hash: sourceHash,
      source_memory_count: memories.length,
    };
  }

  /**
   * Verify the digest's target scope still exists and is active in this space.
   *
   * Locks the scope row `FOR UPDATE` so it cannot be archived between this check
   * and the digest INSERT in the same transaction: a concurrent archive (which
   * updates the project_folder/agent row, then disables its digests) must wait for
   * this generation to commit, or — if it commits first — this SELECT observes
   * the now-archived status and fails closed. Without the lock the two could
   * interleave and leave an archived scope with a fresh `active` digest.
   *
   * `scopeType` is internal (set by generateProjectFolderBundle/generateAgentBundle),
   * not request-derived, so the table name interpolation is safe.
   */
  private async assertScopeActive(
    spaceId: string,
    scopeType: "project_folder" | "agent",
    scopeId: string,
  ): Promise<void> {
    const table = scopeType === "project_folder" ? "project_folders" : "agents";
    const result = await this.db.query(
      `SELECT 1 FROM ${table}
        WHERE space_id = $1 AND id = $2 AND status = 'active'
        LIMIT 1
        FOR UPDATE`,
      [spaceId, scopeId],
    );
    if (result.rows.length === 0) {
      throw new HttpError(404, `${scopeType} not found or not active: ${scopeId}`);
    }
  }

  /**
   * Load the memories that belong in a project_folder/agent digest.
   *
   * The digest is a cache-SHARED bundle, so the visibility filter is a privacy
   * gate, not a scoping mechanism: only non-private memories (space_shared /
   * space-shared project_folder or agent memory, project-free memories, and
   * non-`highly_restricted` rows are eligible. Private / per-user-gated memory
   * and project-scoped memory are never folded into the shared digest — they are
   * rendered directly per run instead. Scoping is done separately by
   * `scope_type` + the matching id column, so a space-scoped memory
   * (`scope_type='space'`) is intentionally in no digest tier and relies on the
   * prepare-side fallback retriever.
   */
  private async loadScopeMemories(
    spaceId: string,
    scopeType: string,
    idColumn: "project_folder_id" | "agent_id",
    scopeId: string,
  ): Promise<MemorySummaryRow[]> {
    const result = await this.db.query<MemorySummaryRow>(
      `SELECT id, title, content, namespace, memory_layer, memory_type,
              visibility, sensitivity_level, version
         FROM memory_entries me
        WHERE me.space_id = $1
          AND me.scope_type = $2
          AND ${idColumn} = $3
          AND me.status = 'active'
          AND me.deleted_at IS NULL
          AND me.project_id IS NULL
          AND ${contentVisibilityFilterSql("me", ["space_shared"])}
          AND COALESCE(me.sensitivity_level, 'normal') <> 'highly_restricted'
        ORDER BY me.importance DESC, me.created_at ASC
        LIMIT 200`,
      [spaceId, scopeType, scopeId],
    );
    return result.rows;
  }

  private async withDigestLock<T>(
    lockKey: string,
    fn: (service: PgContextDigestService) => Promise<T>,
  ): Promise<T> {
    if (!isPool(this.db)) return fn(this);
    const client = await this.db.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      try {
        const result = await fn(new PgContextDigestService(client));
        await client.query("COMMIT");
        transactionOpen = false;
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        transactionOpen = false;
        throw error;
      }
    } finally {
      if (transactionOpen) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      client.release();
    }
  }

  private async loadCurrentDigest(
    spaceId: string,
    scopeType: string,
    scopeId: string | null,
    digestType: string,
  ): Promise<DigestStatusRow | null> {
    const result = await this.db.query<DigestStatusRow>(
      `SELECT id, version, status, source_hash
         FROM context_digests
        WHERE space_id = $1
          AND scope_type = $2
          AND (($3::varchar IS NULL AND scope_id IS NULL) OR scope_id = $3)
          AND digest_type = $4
          AND status IN ('active', 'dirty')
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, version DESC
        LIMIT 1`,
      [spaceId, scopeType, scopeId, digestType],
    );
    return result.rows[0] ?? null;
  }
}

export class ContextDigestRefreshService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): ContextDigestRefreshService {
    if (!config.databaseUrl) {
      throw new Error("ContextDigestRefreshService requires SERVER_DATABASE_URL");
    }
    return new ContextDigestRefreshService(getDbPool(config.databaseUrl));
  }

  async refresh(
    spaceId: string,
    scopeType: "space" | "project_folder" | "agent",
    scopeId: string | null,
    digestType: "policy_bundle" | "project_folder" | "agent",
  ): Promise<ContextDigestRefreshResult> {
    const service = new PgContextDigestService(this.db);
    if (digestType === "policy_bundle") {
      const result = await service.generatePolicyBundle(spaceId);
      return {
        digest_type: "policy_bundle",
        scope_type: "space",
        scope_id: null,
        ...result,
      };
    }
    if (digestType === "project_folder") {
      if (scopeType !== "project_folder" || !scopeId) {
        throw new Error("project_folder digest refresh requires scope_id");
      }
      const result = await service.generateProjectFolderBundle(spaceId, scopeId);
      return {
        ...result,
        digest_type: "project_folder",
        scope_type: "project_folder",
      };
    }
    if (scopeType !== "agent" || !scopeId) {
      throw new Error("agent digest refresh requires agent scope_id");
    }
    const result = await service.generateAgentBundle(spaceId, scopeId);
    return {
      ...result,
      digest_type: "agent",
      scope_type: "agent",
    };
  }

  async refreshAllDirty(spaceId: string): Promise<ContextDigestRefreshResult[]> {
    const dirty = await this.loadDirtyDigests(spaceId);
    const results: ContextDigestRefreshResult[] = [];
    for (const row of dirty) {
      results.push(
        await this.refresh(spaceId, row.scope_type, row.scope_id, row.digest_type),
      );
    }
    return results;
  }

  private async loadDirtyDigests(spaceId: string): Promise<DirtyDigestRow[]> {
    const result = await this.db.query<DirtyDigestRow>(
      `SELECT scope_type, scope_id, digest_type
         FROM context_digests
        WHERE space_id = $1
          AND status = 'dirty'
        ORDER BY digest_type ASC, scope_type ASC, scope_id ASC NULLS FIRST`,
      [spaceId],
    );
    return result.rows;
  }
}

function isPool(db: Queryable): db is Pool {
  return typeof (db as Partial<Pool>).connect === "function";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderPolicyBundleContent(policies: PolicyRow[]): string {
  if (policies.length === 0) return "";

  const byDomain = new Map<string, PolicyRow[]>();
  for (const p of policies) {
    const domain = p.domain || "general";
    const existing = byDomain.get(domain) ?? [];
    existing.push(p);
    byDomain.set(domain, existing);
  }

  const sections: string[] = [];
  for (const [domain, rows] of [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines: string[] = [`## ${domain}`];
    for (const p of rows) {
      const mode = p.enforcement_mode ? ` [\`${p.enforcement_mode}\`]` : "";
      const detail = extractPolicyDetail(p.policy_json);
      lines.push(`- **${p.name}**${mode}${detail ? `: ${detail}` : ""}`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

export function renderMemoryBundleContent(memories: MemorySummaryRow[]): string {
  if (memories.length === 0) return "";

  const byGroup = new Map<string, MemorySummaryRow[]>();
  for (const m of memories) {
    const group = m.memory_type ?? groupFromNamespace(m.namespace) ?? "general";
    const existing = byGroup.get(group) ?? [];
    existing.push(m);
    byGroup.set(group, existing);
  }

  const sections: string[] = [];
  for (const [group, rows] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines: string[] = [`## ${group}`];
    for (const m of rows) {
      const layer = m.memory_layer ? ` [\`${m.memory_layer}\`]` : "";
      const excerpt = m.content ? m.content.slice(0, 300).trim() : "";
      const title = m.title || "untitled";
      lines.push(`- **${title}**${layer}${excerpt ? `: ${excerpt}` : ""}`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

function groupFromNamespace(namespace: string | null): string | null {
  if (!namespace) return null;
  const parts = namespace.split(".");
  return parts[parts.length - 1] ?? null;
}

function computeMemorySourceHash(
  scopeType: string,
  spaceId: string,
  scopeId: string,
  memories: MemorySummaryRow[],
): string {
  const entries = memories
    .map((m) => `${m.id}:v${m.version}`)
    .sort()
    .join("|");
  return sha256(`${scopeType}_bundle:${spaceId}:${scopeId}:${entries}`);
}

function extractPolicyDetail(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const obj = raw as Record<string, unknown>;
  for (const key of ["rule", "description", "note", "message", "summary"]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

function computePolicySourceHash(spaceId: string, policies: PolicyRow[]): string {
  const entries = policies
    .map((p) => [
      p.id,
      `v${p.policy_version}`,
      p.domain,
      p.name,
      p.policy_key ?? "",
      p.enforcement_mode ?? "",
      String(p.priority),
      JSON.stringify(p.policy_json),
      JSON.stringify(p.rule_json ?? null),
      JSON.stringify(p.applies_to_json ?? null),
    ].join(":"))
    .sort()
    .join("|");
  return sha256(`policy_bundle:${spaceId}:${entries}`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
