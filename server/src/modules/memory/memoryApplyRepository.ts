/**
 * Memory proposal appliers.
 *
 * Durable apply logic for memory_create / memory_update / memory_archive
 * proposals. These run the durable active-memory
 * writes for accepted memory proposals: INSERT/UPDATE `memory_entries`, write
 * `provenance_links`, and record `memory_relations` supersedes edges.
 *
 * Scope: the per-type write business logic. The cross-cutting accept
 * orchestration, source-monitoring enforcement, personal-memory egress guard,
 * digest invalidation, and proposal accept state machine live in the proposal
 * apply service.
 */

import { randomUUID } from "node:crypto";
import {
  copyProvenanceToMemory,
  dominantSourceTrust,
  mergeDistinctProvenanceEntries,
  proposalProvenanceEntry,
  recordMemorySupersedesRelation,
  writeProvenanceLinks,
  TARGET_MEMORY,
  type Queryable,
} from "./memoryApplyProvenance.js";
import {
  evaluateMemoryProposal,
  monitoringSnapshot,
  provenanceEntriesFromPayload,
  type ProvenanceEntry,
} from "./sourceMonitoring.js";
import { RetrievalProjectionService } from "../retrieval/index.js";
import { memoryRetrievalRegistry } from "./retrievalAdapter.js";
import { assertProjectInSpace } from "../projects/access.js";
import { isContentAccessLevel, isContentVisibility } from "../access/contentAccessTypes.js";

// The memory retrieval projection is a derived index. A projection failure must
// not roll back an accepted canonical memory write, but the reindex runs inside
// the apply transaction, so a thrown query would otherwise abort it. We isolate
// the reindex in a SAVEPOINT: on failure we roll back only the projection work
// and let the canonical apply commit. Mirrors the Knowledge apply hook.
async function reindexMemoryWithinApply(
  db: Queryable,
  spaceId: string,
  memoryIds: readonly string[],
): Promise<void> {
  await db.query("SAVEPOINT memory_retrieval_reindex");
  try {
    const projection = new RetrievalProjectionService(db, memoryRetrievalRegistry);
    for (const memoryId of memoryIds) {
      await projection.reindex(spaceId, "memory_entry", memoryId);
    }
    await db.query("RELEASE SAVEPOINT memory_retrieval_reindex");
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT memory_retrieval_reindex").catch(() => undefined);
    await db.query("RELEASE SAVEPOINT memory_retrieval_reindex").catch(() => undefined);
    process.stderr.write(
      `[memory.retrieval] reindex failed during proposal apply: ${String((error as Error)?.message ?? error)}\n`,
    );
  }
}

export class MemoryApplyError extends Error {
  readonly statusCode = 422;
}

/** Raised when a memory proposal needs a grant-derived egress apply capability
 * the server authority does not serve. Fails closed so it is never applied by
 * the ordinary Memory path. */
export class MemoryApplyUnsupportedError extends Error {
  readonly statusCode = 409;
}

const MEMORY_APPLY_TYPES = new Set(["memory_create", "memory_update", "memory_archive"]);

const OWNER_SCOPED_VISIBILITIES = new Set(["private", "selected_users"]);

// Payload markers that make a proposal grant-derived, plus any run context
// that requires the separate egress-context apply path.
const GRANT_DERIVED_MARKERS = [
  "personal_context_derived",
  "egress_guard_required",
  "derived_from_personal_memory",
  "raw_private_memory_included",
  "personal_summary_persisted",
  "grant_id",
  "personal_memory_grant_ids",
] as const;

export interface ApplyProposal {
  id: string;
  space_id: string;
  proposal_type: string;
  status?: string;
  risk_level?: string | null;
  preview?: boolean;
  title: string | null;
  payload_json: Record<string, unknown> | null;
  project_folder_id: string | null;
  visibility?: string | null;
  created_by_user_id: string | null;
  owner_user_id?: string | null;
  created_by_agent_id?: string | null;
  created_by_run_id?: string | null;
  project_id: string | null;
  required_approver_role?: string | null;
}

export interface MemoryAcceptResult {
  memoryId: string;
  supersededMemoryId: string | null;
  payloadJson: Record<string, unknown>;
  scopeType: string;
  agentId: string | null;
}

export interface AppliedMemoryRow {
  id: string;
  space_id: string;
  scope_type: string;
  namespace: string | null;
  memory_type: string;
  title: string | null;
  content: string;
  status: string;
  visibility: string;
  access_level: string;
  sensitivity_level: string;
  owner_user_id: string | null;
  subject_user_id: string | null;
  project_id: string | null;
  source_trust: string | null;
  root_memory_id: string | null;
  supersedes_memory_id: string | null;
  memory_layer: string | null;
  version: number;
  agent_id: string | null;
}

export interface MemoryApplyResult {
  memory: AppliedMemoryRow;
  supersededMemoryId: string | null;
}

const INSERT_COLUMNS = `id, space_id, scope_type, memory_type, content, status,
  created_at, updated_at, subject_user_id, owner_user_id,
  sensitivity_level, access_level, last_confirmed_at, namespace,
  title, visibility, confidence, importance, source_id,
  created_by, approved_by, version, access_count, tags, memory_layer,
  created_from_proposal_id, root_memory_id, supersedes_memory_id, source_trust, agent_id,
  project_id`;

const RETURNING_COLUMNS = `id, space_id, scope_type, namespace, memory_type, title,
  content, status, visibility, access_level, sensitivity_level, owner_user_id, subject_user_id,
  project_id, source_trust,
  root_memory_id, supersedes_memory_id, memory_layer, version, agent_id`;

/** Columns + values needed for one new active memory version. */
interface NewMemoryFields {
  scope: string;
  memoryType: string;
  content: string;
  visibility: string;
  accessLevel: string;
  sensitivity: string;
  namespace: string;
  title: string;
  ownerUserId: string | null;
  subjectUserId: string | null;
  projectId: string | null;
  agentId: string | null;
  memoryLayer: string | null;
  sourceTrust: string | null;
  rootMemoryId: string | null;
  supersedesMemoryId: string | null;
  createdBy: string;
  approvedBy: string;
}

export class PgMemoryApplyRepository {
  constructor(private readonly db: Queryable) {}

  static supportsType(proposalType: string): boolean {
    return MEMORY_APPLY_TYPES.has(proposalType);
  }

  /**
   * Apply a memory proposal without marking it accepted.
   *
   * The caller (proposal apply service) owns the single proposal status update
   * so the accept state machine has one writer. Runs inside the caller's
   * BEGIN/COMMIT. accept_context is fixed to `explicit_user_accept`.
   *
   * Fails closed (`MemoryApplyUnsupportedError`) for grant-derived cross-space
   * egress context; same-space run proposals are allowed.
   */
  async applyOnly(
    proposal: ApplyProposal,
    userId: string,
  ): Promise<MemoryAcceptResult & { finalPayload: Record<string, unknown> }> {
    if (!MEMORY_APPLY_TYPES.has(proposal.proposal_type)) {
      throw new MemoryApplyError(`unsupported proposal type: ${proposal.proposal_type}`);
    }
    this.assertNoEgressContext(proposal);

    const acceptContext = "explicit_user_accept";
    let payload: Record<string, unknown> = { ...(proposal.payload_json ?? {}) };

    const outcome = evaluateMemoryProposal({
      proposalType: proposal.proposal_type,
      payload,
      acceptContext,
    });
    if (outcome.action === "reject") throw new MemoryApplyError(outcome.message);
    if (outcome.action === "require_review") {
      payload = {
        ...payload,
        source_monitoring_result: {
          ...monitoringSnapshot(outcome),
          explicit_approval_context: acceptContext,
        },
      };
    }

    const result = await this.applyByType({ ...proposal, payload_json: payload }, userId);

    // Best-effort derived retrieval reindex. Runs inside the caller's transaction;
    // SAVEPOINT-isolated so a projection failure never rolls back the canonical write.
    const reindexIds = result.supersededMemoryId
      ? [result.memory.id, result.supersededMemoryId]
      : [result.memory.id];
    await reindexMemoryWithinApply(this.db, proposal.space_id, reindexIds);

    const finalPayload: Record<string, unknown> = { ...payload, resulting_memory_id: result.memory.id };
    return {
      memoryId: result.memory.id,
      supersededMemoryId: result.supersededMemoryId,
      payloadJson: finalPayload,
      finalPayload,
      scopeType: result.memory.scope_type,
      agentId: result.memory.agent_id,
    };
  }

  private async applyByType(proposal: ApplyProposal, userId: string): Promise<MemoryApplyResult> {
    switch (proposal.proposal_type) {
      case "memory_create":
        return this.applyCreate(proposal, userId);
      case "memory_update":
        return this.applyUpdate(proposal, userId);
      case "memory_archive":
        return this.applyArchive(proposal, userId);
      default:
        throw new MemoryApplyError(`unsupported proposal type: ${proposal.proposal_type}`);
    }
  }

  private assertNoEgressContext(proposal: ApplyProposal): void {
    const payload = proposal.payload_json ?? {};
    // Same-space run proposals (created_by_run_id / source_run_id) are allowed.
    // Only reject proposals that carry grant-derived cross-space egress markers.
    for (const marker of GRANT_DERIVED_MARKERS) {
      if (payload[marker]) {
        throw new MemoryApplyUnsupportedError(
          "grant-derived memory proposals are not served by the server authority yet",
        );
      }
    }
  }


  /** Apply a memory_create proposal: one new active memory + provenance. */
  async applyCreate(proposal: ApplyProposal, userId: string): Promise<MemoryApplyResult> {
    const payload = proposal.payload_json ?? {};
    const explicitVisibility = strOr(payload.target_visibility) ?? strOr(payload.visibility);
    const vis = lower(explicitVisibility ?? "private");
    const accessLevel = lower(strOr(payload.target_access_level) ?? strOr(payload.access_level) ?? "full");
    const sens = lower(strOr(payload.sensitivity_level) ?? "normal");
    assertContentPolicyFields(vis, accessLevel, sens);
    const content = strOr(payload.proposed_content) ?? strOr(payload.content) ?? "";
    const memType = strOr(payload.memory_type) ?? "semantic";
    const scope = memoryScope(strOr(payload.target_scope) ?? strOr(payload.scope_type) ?? "user");
    const namespace = strOr(payload.target_namespace) ?? strOr(payload.namespace) ?? "user.default";

    const acting = String(proposal.created_by_user_id ?? userId);
    const entries = provenanceEntriesFromPayload(payload);
    const ownerUserId = this.resolveOwner(strOr(payload.owner_user_id), vis, acting);
    const projectId = await this.resolveProjectId(proposal, payload, null);
    assertMemoryPlacement(scope, vis, ownerUserId, projectId);

    const memId = await this.insertMemory(proposal, {
      scope,
      memoryType: memType,
      content,
      visibility: vis,
      accessLevel,
      sensitivity: sens,
      namespace,
      title: proposal.title ?? "",
      ownerUserId,
      subjectUserId: strOr(payload.subject_user_id),
      projectId,
      agentId: proposal.created_by_agent_id ?? null,
      memoryLayer: memoryLayer(payload),
      sourceTrust: dominantSourceTrust(entries),
      rootMemoryId: null,
      supersedesMemoryId: null,
      createdBy: String(proposal.created_by_user_id ?? userId),
      approvedBy: String(userId),
    });

    const linkEntries = [
      ...entries,
      proposalProvenanceEntry(proposal.id, { proposal_type: proposal.proposal_type }),
    ];
    await writeProvenanceLinks(this.db, {
      spaceId: proposal.space_id,
      targetType: TARGET_MEMORY,
      targetId: memId.id,
      entries: linkEntries,
    });
    return {
      memory: memId,
      supersededMemoryId: null,
    };
  }

  /** Apply a memory_update proposal: new version row, supersede the old. */
  async applyUpdate(proposal: ApplyProposal, userId: string): Promise<MemoryApplyResult> {
    const payload = proposal.payload_json ?? {};
    const targetId = strOr(payload.target_memory_id);
    if (!targetId) {
      throw new MemoryApplyError("memory_update proposal is missing target_memory_id in payload");
    }
    const old = await this.getActive(targetId, proposal.space_id);
    if (!old) {
      throw new MemoryApplyError(
        `target memory '${targetId}' not found or not active in space '${proposal.space_id}'`,
      );
    }

    const vis = lower(
      strOr(payload.target_visibility) ?? strOr(payload.visibility) ?? old.visibility,
    );
    const sens = lower(strOr(payload.sensitivity_level) ?? old.sensitivity_level ?? "normal");
    const accessLevel = lower(
      strOr(payload.target_access_level) ?? strOr(payload.access_level) ?? old.access_level ?? "full",
    );
    assertContentPolicyFields(vis, accessLevel, sens);
    const content = strOr(payload.proposed_content) ?? strOr(payload.content) ?? old.content;
    const title = strOr(payload.proposed_title) ?? strOr(payload.title) ?? old.title ?? "";
    const scope = memoryScope(strOr(payload.target_scope) ?? old.scope_type);
    const namespace = strOr(payload.target_namespace) ?? old.namespace ?? "user.default";
    const memType = strOr(payload.memory_type) ?? old.memory_type;
    const rootId = old.root_memory_id ?? old.id;

    const entries = provenanceEntriesFromPayload(payload);
    const ownerUserId = this.resolveOwner(
      strOr(payload.owner_user_id) ?? old.owner_user_id,
      vis,
      userId,
    );
    const projectId = await this.resolveProjectId(proposal, payload, old.project_id);
    assertMemoryPlacement(scope, vis, ownerUserId, projectId);

    const newMem = await this.insertMemory(proposal, {
      scope,
      memoryType: memType,
      content,
      visibility: vis,
      accessLevel,
      sensitivity: sens,
      namespace,
      title,
      ownerUserId,
      subjectUserId: strOr(payload.subject_user_id) ?? old.subject_user_id,
      projectId,
      agentId: proposal.created_by_agent_id ?? null,
      memoryLayer: memoryLayer(payload) ?? old.memory_layer,
      sourceTrust: dominantSourceTrust(entries) ?? old.source_trust,
      rootMemoryId: rootId,
      supersedesMemoryId: old.id,
      createdBy: String(proposal.created_by_user_id ?? userId),
      approvedBy: String(userId),
    });

    await this.markStatus(old.id, proposal.space_id, "superseded");
    await copyProvenanceToMemory(this.db, {
      spaceId: proposal.space_id,
      fromMemoryId: old.id,
      toMemoryId: newMem.id,
    });

    // Add payload provenance + the proposal entry, deduped against the copied set.
    const existing = await this.provenanceKeys(proposal.space_id, newMem.id);
    const toAdd: ProvenanceEntry[] = [];
    for (const e of provenanceEntriesFromPayload(payload)) {
      const k = provKey(e);
      if (k && !existing.has(k)) {
        toAdd.push(e);
        existing.add(k);
      }
    }
    const propEntry = proposalProvenanceEntry(proposal.id, { proposal_type: "memory_update" });
    const pk = provKey(propEntry);
    if (pk && !existing.has(pk)) toAdd.push(propEntry);
    if (toAdd.length > 0) {
      await writeProvenanceLinks(this.db, {
        spaceId: proposal.space_id,
        targetType: TARGET_MEMORY,
        targetId: newMem.id,
        entries: toAdd,
      });
    }

    await recordMemorySupersedesRelation(this.db, {
      spaceId: proposal.space_id,
      newMemoryId: newMem.id,
      oldMemoryId: old.id,
      proposalId: proposal.id,
    });
    return {
      memory: newMem,
      supersededMemoryId: old.id,
    };
  }

  /** Apply a memory_archive proposal: mark the target archived (soft delete). */
  async applyArchive(proposal: ApplyProposal, _userId: string): Promise<MemoryApplyResult> {
    const payload = proposal.payload_json ?? {};
    const targetId = strOr(payload.target_memory_id);
    if (!targetId) {
      throw new MemoryApplyError("memory_archive proposal is missing target_memory_id in payload");
    }
    const mem = await this.getActive(targetId, proposal.space_id);
    if (!mem) {
      throw new MemoryApplyError(
        `target memory '${targetId}' not found or not active in space '${proposal.space_id}'`,
      );
    }

    const archived = await this.markStatus(mem.id, proposal.space_id, "archived");

    const entries = mergeDistinctProvenanceEntries(provenanceEntriesFromPayload(payload), [
      proposalProvenanceEntry(proposal.id, {
        action: "memory_archive",
        proposal_type: "memory_archive",
      }),
    ]);
    if (entries.length > 0) {
      await writeProvenanceLinks(this.db, {
        spaceId: proposal.space_id,
        targetType: TARGET_MEMORY,
        targetId: mem.id,
        entries,
      });
    }
    return {
      memory: archived ?? mem,
      supersededMemoryId: null,
    };
  }

  // ------------------------------------------------------------------

  private resolveOwner(owner: string | null, visibility: string, actingUserId: string): string | null {
    let ownerUserId = owner;
    if (OWNER_SCOPED_VISIBILITIES.has(visibility) && ownerUserId == null) {
      ownerUserId = actingUserId;
    }
    if (visibility === "private" && ownerUserId == null) {
      throw new MemoryApplyError("owner_user_id is required for private visibility");
    }
    return ownerUserId;
  }

  private async insertMemory(
    proposal: ApplyProposal,
    f: NewMemoryFields,
  ): Promise<AppliedMemoryRow> {
    const now = new Date().toISOString();
    const result = await this.db.query<AppliedMemoryRow>(
      `INSERT INTO memory_entries (${INSERT_COLUMNS}) VALUES (
         $1, $2, $3, $4, $5, 'active',
         $6, $6, $7, $8,
         $9, $10, NULL, $11,
         $12, $13, 1.0, 0.5, NULL,
         $14, $15, 1, 0, NULL, $16,
         $17, $18, $19, $20, $21, $22
       )
       RETURNING ${RETURNING_COLUMNS}`,
      [
        randomUUID(), // $1 id
        proposal.space_id, // $2
        f.scope, // $3 scope_type
        f.memoryType, // $4
        f.content, // $5
        now, // $6 created_at + updated_at
        f.subjectUserId, // $7
        f.ownerUserId, // $8
        f.sensitivity, // $9
        f.accessLevel, // $10
        f.namespace, // $11
        f.title, // $12
        f.visibility, // $13
        f.createdBy, // $14
        f.approvedBy, // $15
        f.memoryLayer, // $16
        proposal.id, // $17 created_from_proposal_id
        f.rootMemoryId, // $18
        f.supersedesMemoryId, // $19
        f.sourceTrust, // $20
        f.agentId, // $21
        f.projectId, // $22
      ],
    );
    return result.rows[0]!;
  }

  private async resolveProjectId(
    proposal: ApplyProposal,
    payload: Record<string, unknown>,
    fallbackProjectId: string | null,
  ): Promise<string | null> {
    const projectId = proposal.project_id ?? strOr(payload.project_id) ?? fallbackProjectId;
    try {
      await assertProjectInSpace(this.db, proposal.space_id, projectId);
    } catch (error) {
      if (error instanceof Error) throw new MemoryApplyError(error.message);
      throw error;
    }
    return projectId;
  }

  private async getActive(memoryId: string, spaceId: string): Promise<AppliedMemoryRow | null> {
    const res = await this.db.query<AppliedMemoryRow>(
      `SELECT ${RETURNING_COLUMNS}
         FROM memory_entries
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [memoryId, spaceId],
    );
    return res.rows[0] ?? null;
  }

  private async markStatus(
    memoryId: string,
    spaceId: string,
    status: string,
  ): Promise<AppliedMemoryRow | null> {
    const res = await this.db.query<AppliedMemoryRow>(
      `UPDATE memory_entries
          SET status = $3, updated_at = $4
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL
        RETURNING ${RETURNING_COLUMNS}`,
      [memoryId, spaceId, status, new Date().toISOString()],
    );
    return res.rows[0] ?? null;
  }

  private async provenanceKeys(spaceId: string, memoryId: string): Promise<Set<string>> {
    const res = await this.db.query<{ source_type: string; source_id: string; source_trust: string | null }>(
      `SELECT source_type, source_id, source_trust
         FROM provenance_links
        WHERE space_id = $1 AND target_type = $2 AND target_id = $3`,
      [spaceId, TARGET_MEMORY, memoryId],
    );
    const keys = new Set<string>();
    for (const r of res.rows) keys.add(`${r.source_type} ${r.source_id} ${r.source_trust ?? ""}`);
    return keys;
  }
}

function strOr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function memoryScope(value: string): "user" | "project" {
  const scope = lower(value);
  if (scope !== "user" && scope !== "project") {
    throw new MemoryApplyError("memory scope must be user or project");
  }
  return scope;
}

function assertMemoryPlacement(
  scope: "user" | "project",
  visibility: string,
  ownerUserId: string | null,
  projectId: string | null,
): void {
  if (scope === "user") {
    if (projectId !== null) throw new MemoryApplyError("user memory cannot carry a project_id");
    if (ownerUserId === null) throw new MemoryApplyError("user memory requires owner_user_id");
    if (visibility === "space_shared") {
      throw new MemoryApplyError("space-shared learning belongs to project memory");
    }
    return;
  }
  if (projectId === null) throw new MemoryApplyError("project memory requires project_id");
  if (visibility !== "space_shared") {
    throw new MemoryApplyError("project memory must be space_shared");
  }
}

function assertContentPolicyFields(
  visibility: string,
  accessLevel: string,
  sensitivity: string,
): void {
  if (!isContentVisibility(visibility)) {
    throw new MemoryApplyError("invalid memory visibility");
  }
  if (!isContentAccessLevel(accessLevel)) {
    throw new MemoryApplyError("invalid memory access level");
  }
  if (sensitivity === "highly_restricted" && visibility !== "private") {
    throw new MemoryApplyError("highly restricted memory must be private");
  }
}

function memoryLayer(payload: Record<string, unknown>): string | null {
  const raw = strOr(payload.target_layer) ?? strOr(payload.memory_layer);
  return raw ? raw.toLowerCase() : null;
}

function provKey(e: ProvenanceEntry): string | null {
  if (typeof e.source_type !== "string" || typeof e.source_id !== "string") return null;
  const tr = typeof e.source_trust === "string" ? e.source_trust : "";
  return `${e.source_type} ${e.source_id} ${tr}`;
}
