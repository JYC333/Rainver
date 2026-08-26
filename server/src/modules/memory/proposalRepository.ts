import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { loadActionRegistry } from "../policy/actionRegistry.js";
import { enforce } from "../policy/service.js";
import { proposalToOut } from "../proposals/repository.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import { canReadMemory, type MemoryAuthFields } from "./memoryReadAuth.js";
import { canAccessProject } from "./projectAccess.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql.js";

import type {
  MemoryProposalArchiveCommand,
  MemoryProposalCreateCommand,
  MemoryProposalUpdateCommand,
  ProposalOut,
} from "@agent-space/protocol";
import type { PolicyCheckRequest } from "@agent-space/protocol";

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

export class MemoryProposalValidationError extends Error {
  readonly statusCode = 422;
}

export class MemoryProposalForbiddenError extends Error {
  readonly statusCode = 403;
}

export class MemoryProposalNotFoundError extends Error {
  readonly statusCode = 404;
}

export class MemoryProposalPolicyError extends Error {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;

  constructor(statusCode: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.detail ?? "Policy gate blocked"));
    this.statusCode = statusCode;
    this.body = body;
  }
}

interface TargetMemoryRow extends MemoryAuthFields {
  id: string;
  scope_type: string;
  namespace: string | null;
  memory_type: string;
  title: string | null;
  content: string | null;
  project_id: string | null;
}

const TARGET_MEMORY_COLUMNS = `id, space_id, owner_user_id,
  scope_type, namespace, memory_type, title, content, visibility,
  access_level, sensitivity_level, deleted_at, project_id`;

const SENSITIVITY_LEVELS = new Set([
  "normal",
  "sensitive",
  "restricted",
  "highly_restricted",
]);

const VISIBILITY_VALUES = new Set([
  "private",
  "space_shared",
  "selected_users",
]);
const MEMORY_DEFINITION = contentResourceDefinition("memory")!;

/**
 * server-owned public memory proposal creation. This repository writes pending
 * `proposals` rows only. It reads target memories for
 * update/archive authorization, but never mutates `memory_entries`; active
 * memory writes remain proposal-apply authority.
 */
export class PgMemoryProposalRepository {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  static fromConfig(config: ServerConfig): PgMemoryProposalRepository {
    if (!config.databaseUrl) {
      throw new Error("Memory proposal repository requires SERVER_DATABASE_URL");
    }
    return new PgMemoryProposalRepository(getDbPool(config.databaseUrl), config);
  }

  async createMemoryProposal(
    identitySpaceId: string,
    userId: string,
    command: MemoryProposalCreateCommand,
  ): Promise<ProposalOut> {
    const effectiveSpaceId = command.space_id ?? identitySpaceId;
    if (effectiveSpaceId !== identitySpaceId) {
      throw new MemoryProposalForbiddenError(
        "Cannot create memory proposal in another space",
      );
    }

    const scope = normalizeMemoryScope(command.scope ?? "user");
    const visibility = normalizeVisibility(
      command.visibility ?? "private",
    );
    const accessLevel = normalizeAccessLevel(command.access_level ?? "full");
    const sensitivity = normalizeSensitivity(command.sensitivity_level ?? "normal");
    validateCreateCommand(command, visibility, sensitivity);

    const subjectUserId = command.subject_user_id ?? (scope === "user" ? userId : null);
    const ownerUserId = command.owner_user_id ?? null;
    const payload: Record<string, unknown> = {
      operation: "create",
      proposed_content: command.content,
      memory_type: command.type,
      target_scope: scope,
      target_namespace: command.namespace ?? "user.default",
      target_visibility: visibility,
      target_access_level: accessLevel,
      sensitivity_level: sensitivity,
      provenance_entries: mergeDistinctProvenanceEntries([
        userConfirmationEntry(userId, { method: "POST", path: "/memory" }),
      ]),
    };
    if (subjectUserId !== null) payload.subject_user_id = subjectUserId;
    if (ownerUserId !== null) payload.owner_user_id = ownerUserId;
    if (command.source_id !== null && command.source_id !== undefined) {
      payload.source_id = command.source_id;
    }
    if (command.project_id !== null && command.project_id !== undefined) {
      payload.project_id = command.project_id;
    }

    await this.enforceProposalCreate({
      spaceId: effectiveSpaceId,
      userId,
      proposalType: "memory_create",
      projectFolderId: null,
      targetScope: scope,
      targetVisibility: visibility,
      targetMemoryId: null,
      sensitivityLevel: sensitivity,
    });

    return this.insertProposal({
      spaceId: effectiveSpaceId,
      userId,
      proposalType: "memory_create",
      title: command.title,
      payload,
      rationale: "Memory creation requested via public API.",
      projectFolderId: null,
      projectId: command.project_id ?? null,
      targetMemoryId: null,
      targetScope: scope,
      targetVisibility: visibility,
      sensitivityLevel: sensitivity,
    });
  }

  async updateMemoryProposal(
    spaceId: string,
    userId: string,
    memoryId: string,
    command: MemoryProposalUpdateCommand,
  ): Promise<ProposalOut> {
    if (
      command.visibility != null
      || command.access_level != null
      || command.owner_user_id != null
    ) {
      throw new MemoryProposalValidationError(
        "Use the content-access API to update Memory permissions",
      );
    }
    const target = await this.getVisibleTargetMemory(
      spaceId,
      userId,
      memoryId,
    );
    if (!target) throw new MemoryProposalNotFoundError("Memory not found");

    const changeData = compactCommand(command, [
      "operation",
      "actor_user_id",
      "target_memory_id",
      "provenance_entries",
      "memory_layer",
    ]);
    const payload: Record<string, unknown> = {
      operation: "update",
      target_memory_id: memoryId,
      target_scope: target.scope_type,
      target_namespace: target.namespace ?? "user.default",
      memory_type: target.memory_type,
      provenance_entries: mergeDistinctProvenanceEntries([
        userConfirmationEntry(userId, {
          method: "PATCH",
          path: `/memory/${memoryId}`,
        }),
      ]),
    };

    if (changeData.content !== undefined) {
      payload.proposed_content = changeData.content;
      payload.content = changeData.content;
    }
    if (changeData.title !== undefined) {
      payload.proposed_title = changeData.title;
      payload.title = changeData.title;
    }
    if (changeData.sensitivity_level !== undefined) {
      payload.sensitivity_level = normalizeSensitivity(
        String(changeData.sensitivity_level),
      );
    }
    if (changeData.subject_user_id !== undefined) {
      payload.subject_user_id = changeData.subject_user_id;
    }
    if (changeData.scope !== undefined) {
      payload.target_scope = changeData.scope;
    }
    if (changeData.namespace !== undefined) {
      payload.target_namespace = changeData.namespace;
    }
    if (changeData.type !== undefined) {
      payload.memory_type = changeData.type;
    }
    validateUpdatePayload(payload);

    const title =
      typeof changeData.title === "string" && changeData.title.length > 0
        ? changeData.title
        : target.title || `Update: ${memoryId.slice(0, 8)}`;
    const targetScope = stringValue(payload.target_scope);
    const targetVisibility =
      stringValue(payload.target_visibility) ?? stringValue(payload.visibility);
    const sensitivityLevel = stringValue(payload.sensitivity_level);

    await this.enforceProposalCreate({
      spaceId,
      userId,
      proposalType: "memory_update",
      projectFolderId: null,
      targetScope,
      targetVisibility,
      targetMemoryId: memoryId,
      sensitivityLevel,
    });

    return this.insertProposal({
      spaceId,
      userId,
      proposalType: "memory_update",
      title,
      payload,
      rationale: "Memory update requested via public API.",
      projectFolderId: null,
      projectId: target.project_id,
      targetMemoryId: memoryId,
      targetScope,
      targetVisibility,
      sensitivityLevel,
    });
  }

  async archiveMemoryProposal(
    spaceId: string,
    userId: string,
    memoryId: string,
    command: MemoryProposalArchiveCommand,
  ): Promise<ProposalOut> {
    const target = await this.getVisibleTargetMemory(
      spaceId,
      userId,
      memoryId,
    );
    if (!target) throw new MemoryProposalNotFoundError("Memory not found");

    const payload: Record<string, unknown> = {
      operation: "archive",
      target_memory_id: memoryId,
      target_scope: target.scope_type,
      target_namespace: target.namespace ?? "user.default",
      memory_type: target.memory_type,
      proposed_content: target.content ?? "",
      provenance_entries: mergeDistinctProvenanceEntries([
        userConfirmationEntry(userId, {
          method: "DELETE",
          path: `/memory/${memoryId}`,
        }),
      ]),
    };

    await this.enforceProposalCreate({
      spaceId,
      userId,
      proposalType: "memory_archive",
      projectFolderId: null,
      targetScope: target.scope_type,
      targetVisibility: target.visibility,
      targetMemoryId: memoryId,
      sensitivityLevel: null,
    });

    return this.insertProposal({
      spaceId,
      userId,
      proposalType: "memory_archive",
      title: `Archive: ${target.title || memoryId.slice(0, 8)}`,
      payload,
      rationale: "Memory archive requested via public API.",
      projectFolderId: null,
      projectId: target.project_id,
      targetMemoryId: memoryId,
      targetScope: target.scope_type,
      targetVisibility: target.visibility,
      sensitivityLevel: null,
    });
  }

  private async getVisibleTargetMemory(
    spaceId: string,
    userId: string,
    memoryId: string,
  ): Promise<TargetMemoryRow | null> {
    const result = await this.db.query<TargetMemoryRow>(
      `SELECT ${TARGET_MEMORY_COLUMNS},
              ${contentAccessLevelSql({ definition: MEMORY_DEFINITION, alias: "me", userExpr: "$3", includeOversight: false })} AS effective_access_level
         FROM memory_entries me
        WHERE id = $1
          AND space_id = $2
          AND deleted_at IS NULL
          AND ${contentReadSql("memory", "me", "$3", { includeOversight: false })}`,
      [memoryId, spaceId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!canReadMemory(row, { userId, spaceId })) return null;
    if (row.project_id && !(await canAccessProject(this.db, spaceId, row.project_id, userId))) return null;
    return row;
  }

  private async enforceProposalCreate(input: {
    spaceId: string;
    userId: string;
    proposalType: "memory_create" | "memory_update" | "memory_archive";
    projectFolderId: string | null;
    targetScope: string | null;
    targetVisibility: string | null;
    targetMemoryId: string | null;
    sensitivityLevel: string | null;
  }): Promise<void> {
    const registry = await loadActionRegistry();
    const req: PolicyCheckRequest = {
      action: "proposal.create",
      actor_type: "user",
      actor_id: input.userId,
      space_id: input.spaceId,
      resource_type: "proposal",
      resource_id: null,
      resource_space_id: input.spaceId,
      run_id: null,
      proposal_id: null,
      actor_ref: null,
      payload: null,
      force_record: false,
      context: {
        target_visibility: input.targetVisibility,
        target_scope: input.targetScope,
      },
      metadata_json: {
        proposal_type: input.proposalType,
        project_folder_id: input.projectFolderId,
        target_memory_id: input.targetMemoryId,
        sensitivity_level: input.sensitivityLevel,
        urgency: "normal",
      },
    };
    const result = await enforce(this.config, registry, req);
    if (result.status === "allow") return;
    if (result.status === "error") {
      throw new MemoryProposalPolicyError(500, {
        error: result.error_code ?? "policy_audit_persist_failed",
        message:
          result.message ??
          "Policy decision audit could not be persisted; sensitive action was blocked.",
        audit_code: "policy_decision_record_persist_failed",
      });
    }
    const decision = result.decision;
    throw new MemoryProposalPolicyError(403, {
      error: result.error_code ?? "policy_denied",
      message: result.message ?? decision?.message ?? "Policy gate blocked",
      reason_code: decision?.reason_code,
      audit_code: decision?.audit_code,
      action: "proposal.create",
      risk_level: decision?.risk_level,
    });
  }

  private async insertProposal(input: {
    spaceId: string;
    userId: string;
    proposalType: "memory_create" | "memory_update" | "memory_archive";
    title: string;
    payload: Record<string, unknown>;
    rationale: string;
    projectFolderId: string | null;
    projectId: string | null;
    targetMemoryId: string | null;
    targetScope: string | null;
    targetVisibility: string | null;
    sensitivityLevel: string | null;
  }): Promise<ProposalOut> {
    const now = new Date();
    const row = await insertProposalRow(this.db, {
      spaceId: input.spaceId,
      proposalType: input.proposalType,
      title: input.title,
      payload: input.payload,
      rationale: input.rationale,
      projectFolderId: input.projectFolderId,
      projectId: input.projectId,
      createdByUserId: input.userId,
      visibility: input.targetVisibility ?? "private",
      riskLevel: "low",
    });
    return proposalToOut(row, now);
  }
}

function normalizeSensitivity(value: string): string {
  const normalized = value.toLowerCase();
  if (!SENSITIVITY_LEVELS.has(normalized)) {
    throw new MemoryProposalValidationError(`invalid sensitivity_level: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizeVisibility(value: string): string {
  const normalized = value.toLowerCase();
  if (!VISIBILITY_VALUES.has(normalized)) {
    throw new MemoryProposalValidationError(`invalid visibility: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizeAccessLevel(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized !== "full" && normalized !== "summary") {
    throw new MemoryProposalValidationError(`invalid access_level: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function validateCreateCommand(
  command: MemoryProposalCreateCommand,
  visibility: string,
  sensitivity: string,
): void {
  const layer = command.memory_layer?.toLowerCase();
  if (layer !== undefined && layer !== null && layer !== "episodic" && layer !== "semantic") {
    throw new MemoryProposalValidationError(
      `invalid memory_layer: ${JSON.stringify(command.memory_layer)}`,
    );
  }
  if (sensitivity === "highly_restricted" && visibility !== "private") {
    throw new MemoryProposalValidationError(
      "highly_restricted memories must use private visibility",
    );
  }
  if (sensitivity === "highly_restricted" && !command.owner_user_id) {
    throw new MemoryProposalValidationError(
      "owner_user_id is required when sensitivity_level is highly_restricted",
    );
  }
}

function normalizeMemoryScope(value: string): "user" | "project" {
  const scope = value.toLowerCase();
  if (scope !== "user" && scope !== "project") {
    throw new MemoryProposalValidationError("memory scope must be user or project");
  }
  return scope;
}

function validateUpdatePayload(payload: Record<string, unknown>): void {
  const sensitivity = stringValue(payload.sensitivity_level);
  const visibility =
    stringValue(payload.target_visibility) ?? stringValue(payload.visibility);
  if (sensitivity === "highly_restricted" && visibility !== "private") {
    throw new MemoryProposalValidationError(
      "highly_restricted memories must use private visibility",
    );
  }
}

function userConfirmationEntry(
  userId: string,
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source_type: "user_confirmation",
    source_id: userId,
    source_trust: "user_confirmed",
    evidence_json: { ...evidence, channel: "explicit_user_action" },
  };
}

function mergeDistinctProvenanceEntries(
  rawEntries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const entry of rawEntries) {
    const sourceType = stringValue(entry.source_type);
    const sourceId = stringValue(entry.source_id);
    if (!sourceType || !sourceId) continue;
    const sourceTrust = stringValue(entry.source_trust);
    const key = `${sourceType}:${sourceId}:${sourceTrust ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function compactCommand(
  command: Record<string, unknown>,
  skip: readonly string[],
): Record<string, unknown> {
  const skipSet = new Set(skip);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(command)) {
    if (skipSet.has(key)) continue;
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
