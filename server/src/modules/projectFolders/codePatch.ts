import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import {
  PgSnapshotStore,
  type SnapshotFile,
} from "./snapshotStore";
import type { RunMaterializationItemSummary } from "@agent-space/protocol" with {
  "resolution-mode": "import",
};
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { loadActionRegistry } from "../policy/actionRegistry";
import { enforce } from "../policy/service";
import { HttpError, type Queryable } from "../routeUtils/common";
import type { RunRecord } from "../runs/repository";
import type {
  ProposalApplyContext,
  ProposalApplyResult,
  ProposalApplierRegistry,
} from "../proposals/applierRegistry";
import { runGit, gitOutput } from "./git";
import { validatePath } from "./pathPolicy";
import { PgProjectFolderRepository, projectFolderAbsoluteRoot } from "./repository";
import { insertProposalRow } from "../proposals/reviewPackets";

const MAX_PATCH_FILE_BYTES = 2 * 1024 * 1024;

interface CodePatchOperation {
  type: "replace_file";
  path: string;
  content: string;
  preimage_sha256: string | null;
  preimage_exists: boolean;
}

interface SkippedChange {
  path: string;
  reason: string;
  status?: string;
}

interface CodePatchPayload {
  patch: {
    operations: CodePatchOperation[];
  };
  source_run_id: string;
  worktree_collected: boolean;
  file_count: number;
  skipped: SkippedChange[];
  incomplete_patch: boolean;
  skipped_changes: SkippedChange[];
  skipped_count: number;
  base_commit_sha: string | null;
  validation: {
    status: "passed" | "failed";
    verifier_type: "code_patch";
    verifier_version: "verification_engine.v1";
    check_types: string[];
    structural_issue_count: number;
  };
}

export interface CodePatchCollectionResult {
  item: RunMaterializationItemSummary;
  errors: string[];
}

export class PgCodePatchCollector {
  constructor(
    private readonly config: ServerConfig,
    private readonly db: Queryable,
  ) {}

  static fromConfig(config: ServerConfig): PgCodePatchCollector {
    if (!config.databaseUrl) {
      throw new HttpError(502, "Code patch collector requires SERVER_DATABASE_URL");
    }
    return new PgCodePatchCollector(config, getDbPool(config.databaseUrl));
  }

  collect(input: {
    run: RunRecord;
    worktreePath: string | null;
    baseCommitSha: string | null;
    proposalStatus?: "pending" | "staged";
  }): Promise<CodePatchCollectionResult | null> {
    return collectAndCreateCodePatchProposal({
      config: this.config,
      db: this.db,
      run: input.run,
      worktreePath: input.worktreePath,
      baseCommitSha: input.baseCommitSha,
      proposalStatus: input.proposalStatus,
    });
  }
}

export function registerProjectFolderProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("code_patch", applyCodePatchProposal);
}

export async function collectAndCreateCodePatchProposal(input: {
  config: ServerConfig;
  db: Queryable;
  run: RunRecord;
  worktreePath: string | null;
  baseCommitSha: string | null;
  proposalStatus?: "pending" | "staged";
}): Promise<CodePatchCollectionResult | null> {
  if (!input.run.project_folder_id || !input.worktreePath) return null;
  const collected = await collectWorktreeChanges(input.worktreePath, input.baseCommitSha);
  if (collected.operations.length === 0) {
    return {
      item: {
        kind: "code_patch",
        status: collected.skipped.length > 0 ? "warning" : "skipped",
        error_code: collected.skipped.length > 0 ? "code_patch_collection_error" : "no_code_patch_changes",
        error_message: collected.skipped.length > 0
          ? "Project Folder changes were skipped because no safe text file replacements could be collected."
          : "No Project Folder changes were detected.",
        metadata_json: {
          operation: "code_patch.collect",
          file_count: 0,
          skipped_count: collected.skipped.length,
          incomplete_patch: collected.skipped.length > 0,
        },
      },
      errors: collected.skipped.length > 0 ? ["code_patch:code_patch_collection_error:all changes skipped"] : [],
    };
  }

  const policy = await enforce(input.config, await loadActionRegistry(), {
    action: "proposal.create",
    actor_type: "run",
    actor_id: input.run.id,
    space_id: input.run.space_id,
    resource_type: "proposal",
    resource_space_id: input.run.space_id,
    run_id: input.run.id,
    context: {
      proposal_type: "code_patch",
      project_folder_id: input.run.project_folder_id,
      file_count: collected.operations.length,
      skipped_count: collected.skipped.length,
    },
    metadata_json: {
      proposal_type: "code_patch",
      project_folder_id: input.run.project_folder_id,
      file_count: collected.operations.length,
      skipped_count: collected.skipped.length,
    },
    force_record: true,
  });
  if (policy.status !== "allow") {
    return {
      item: {
        kind: "code_patch",
        status: policy.status === "error" ? "failed" : "skipped",
        error_code: policy.error_code ?? "proposal_create_failed",
        error_message: policy.message ?? "code_patch proposal creation denied by policy.",
        metadata_json: {
          operation: "code_patch.collect",
          file_count: collected.operations.length,
          skipped_count: collected.skipped.length,
        },
      },
      errors: [`code_patch:${policy.error_code ?? policy.status}:${policy.message ?? ""}`],
    };
  }

  const now = new Date().toISOString();
  const payload: CodePatchPayload = {
    patch: { operations: collected.operations },
    source_run_id: input.run.id,
    worktree_collected: true,
    file_count: collected.operations.length,
    skipped: collected.skipped,
    incomplete_patch: collected.skipped.length > 0,
    skipped_changes: collected.skipped,
    skipped_count: collected.skipped.length,
    base_commit_sha: input.baseCommitSha,
    validation: {
      status: collected.skipped.length > 0 ? "failed" : "passed",
      verifier_type: "code_patch",
      verifier_version: "verification_engine.v1",
      check_types: ["file_changed", "no_forbidden_change"],
      structural_issue_count: collected.skipped.length,
    },
  };
  const proposalRow = await insertProposalRow(input.db, {
    spaceId: input.run.space_id,
    createdByRunId: input.run.id,
    createdByUserId: input.run.instructed_by_user_id ?? null,
    proposalType: "code_patch",
    title: "Review Project Folder code patch",
    summary: `Run ${input.run.id} changed ${collected.operations.length} Project Folder file(s).`,
    payload,
    rationale: "Project Folder code changes collected from run worktree.",
    riskLevel: collected.skipped.length > 0 ? "high" : "medium",
    projectFolderId: input.run.project_folder_id,
    visibility: "space_shared",
    createdAt: now,
    status: input.proposalStatus ?? "pending",
  });
  const proposalId = proposalRow.id;
  await linkTaskProposal(input.db, input.run.space_id, input.run.id, proposalId, now);

  const item: RunMaterializationItemSummary = {
    kind: "code_patch",
    status: collected.skipped.length > 0 ? "warning" : "succeeded",
    proposal_id: proposalId,
    error_code: collected.skipped.length > 0 ? "code_patch_collection_error" : null,
    error_message: collected.skipped.length > 0
      ? "Some Project Folder changes were skipped while collecting the code patch."
      : null,
    metadata_json: {
      operation: "code_patch.collect",
      proposal_created: true,
      file_count: collected.operations.length,
      skipped_count: collected.skipped.length,
      incomplete_patch: collected.skipped.length > 0,
    },
  };
  return {
    item,
    errors: collected.skipped.length > 0
      ? ["code_patch:code_patch_collection_error:some changes skipped"]
      : [],
  };
}

export async function collectWorktreeChanges(
  worktreePath: string,
  baseCommitSha: string | null,
): Promise<{ operations: CodePatchOperation[]; skipped: SkippedChange[] }> {
  const nameStatus = await runGit(["diff", "--name-status", "HEAD"], worktreePath, 30_000);
  if (nameStatus.code !== 0) {
    return {
      operations: [],
      skipped: [gitFailureSkipped("git_diff_failed", nameStatus.code, nameStatus.stderr)],
    };
  }
  const status = await runGit(["status", "--porcelain"], worktreePath, 30_000);
  if (status.code !== 0) {
    return {
      operations: [],
      skipped: [gitFailureSkipped("git_status_failed", status.code, status.stderr)],
    };
  }
  const candidates = new Map<string, string>();
  const skipped: SkippedChange[] = [];
  for (const line of nameStatus.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(/\t+/);
    const code = parts[0] ?? "";
    const path = parts[parts.length - 1] ?? "";
    if (!path) continue;
    if (code.startsWith("D")) skipped.push({ path, status: code, reason: "deleted" });
    else if (code.startsWith("R")) skipped.push({ path, status: code, reason: "renamed" });
    else candidates.set(path, code);
  }
  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path) continue;
    if (code === "??") candidates.set(path, "??");
  }

  const operations: CodePatchOperation[] = [];
  for (const [path, code] of candidates) {
    if (path.includes("\0") || isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
      skipped.push({ path, status: code, reason: "unsafe_path" });
      continue;
    }
    const abs = resolve(worktreePath, path);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) {
      skipped.push({ path, status: code, reason: "not_file" });
      continue;
    }
    if (info.size > MAX_PATCH_FILE_BYTES) {
      skipped.push({ path, status: code, reason: "too_large" });
      continue;
    }
    const buffer = await readFile(abs).catch(() => null);
    if (!buffer) {
      skipped.push({ path, status: code, reason: "unreadable" });
      continue;
    }
    if (buffer.includes(0)) {
      skipped.push({ path, status: code, reason: "binary" });
      continue;
    }
    const content = buffer.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(buffer)) {
      skipped.push({ path, status: code, reason: "not_utf8" });
      continue;
    }
    const preimage = await preimageForPath(worktreePath, path, baseCommitSha);
    operations.push({
      type: "replace_file",
      path,
      content,
      preimage_sha256: preimage.exists ? sha256(preimage.content) : null,
      preimage_exists: preimage.exists,
    });
  }
  return { operations, skipped };
}

async function preimageForPath(
  worktreePath: string,
  path: string,
  baseCommitSha: string | null,
): Promise<{ exists: boolean; content: Buffer }> {
  const rev = baseCommitSha ? `${baseCommitSha}:${path}` : `HEAD:${path}`;
  try {
    return { exists: true, content: Buffer.from(await gitOutput(["show", rev], worktreePath, 30_000), "utf8") };
  } catch {
    return { exists: false, content: Buffer.alloc(0) };
  }
}

async function applyCodePatchProposal(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const proposal = context.proposal;
  if (!proposal.project_folder_id) throw new HttpError(422, "code_patch proposal requires project_folder_id");
  const folder = await new PgProjectFolderRepository(context.db, context.config)
    .getFolder(proposal.space_id, proposal.project_folder_id, true);
  if (!folder) throw new HttpError(404, "Project Folder not found");
  const root = projectFolderAbsoluteRoot(folder, context.config.workspaceRoot);
  const payload = recordValue(proposal.payload_json);
  const patch = recordValue(payload.patch);
  const operations = arrayValue(patch.operations).map(parseOperation);
  if (operations.length === 0) throw new HttpError(422, "code_patch payload requires operations");

  const policy = await enforce(context.config, await loadActionRegistry(), {
    action: "project_folder.write_patch",
    actor_type: "user",
    actor_id: context.userId,
    space_id: proposal.space_id,
    resource_type: "project_folder",
    resource_id: proposal.project_folder_id,
    resource_space_id: proposal.space_id,
    proposal_id: proposal.id,
    context: {
      proposal_type: "code_patch",
      proposal_apply_allowed: true,
      project_folder_id: proposal.project_folder_id,
      file_count: operations.length,
    },
    metadata_json: {
      proposal_type: "code_patch",
      proposal_id: proposal.id,
      project_folder_id: proposal.project_folder_id,
      file_count: operations.length,
    },
    force_record: true,
  });
  if (policy.status !== "allow") {
    throw new HttpError(
      policy.status === "error" ? 500 : 403,
      policy.message ?? "project_folder.write_patch denied by policy",
    );
  }

  const tx = new CodePatchFileTransaction(root, folder.protected);
  let applied: Array<{ path: string; sha256: string }> = [];
  let proposalPayloadPatch: Record<string, unknown>;
  try {
    applied = await tx.apply(operations);
    const now = new Date().toISOString();
    proposalPayloadPatch = {
      ...payload,
      applied_paths: applied.map((file) => file.path),
      applied_files: applied,
      applied_at: now,
    };
    await context.db.query(
      `INSERT INTO activity_records (
         id, space_id, source_run_id, user_id, project_folder_id, activity_type,
         title, content, payload_json, occurred_at, created_at, status, updated_at,
         source_kind, source_trust, visibility, owner_user_id
       ) VALUES (
         $1, $2, $3, $4, $5, 'proposal.code_patch.applied',
         $6, $7, $8::jsonb, $9, $9, 'processed', $9,
         'project_folder_event', 'internal_system', 'space_shared', $4
       )`,
      [
        randomUUID(),
        proposal.space_id,
        proposal.created_by_run_id ?? null,
        context.userId,
        proposal.project_folder_id,
        proposal.title ?? "Code patch applied",
        `Applied code patch proposal ${proposal.id}.`,
        JSON.stringify({
          proposal_id: proposal.id,
          updated_paths: applied.map((file) => file.path),
          file_count: applied.length,
        }),
        now,
      ],
    );
    // Persist pre-apply snapshot so the user can roll back after accept
    await new PgSnapshotStore(context.db).create({
      proposalId: proposal.id,
      spaceId: proposal.space_id,
      projectFolderId: proposal.project_folder_id,
      files: tx.capturedPreimages(),
      retentionDays: folder.snapshot_retention_days,
      maxCount: folder.snapshot_max_count,
    });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  return {
    result_type: "code_patch_apply",
    result: {
      updated_paths: applied.map((file) => file.path),
      code_patch_files: applied,
    },
    rollback: () => tx.rollback(),
    proposalPayloadPatch,
  };
}

class CodePatchFileTransaction {
  private readonly preimages: Array<{ path: string; absolutePath: string; existed: boolean; content: Buffer | null }> = [];

  constructor(
    private readonly root: string,
    private readonly protectedFolder: boolean,
  ) {}

  capturedPreimages(): SnapshotFile[] {
    return this.preimages.map((p) => ({
      path: p.path,
      existed: p.existed,
      content: p.existed && p.content !== null ? p.content.toString("utf8") : null,
    }));
  }

  async apply(operations: CodePatchOperation[]): Promise<Array<{ path: string; sha256: string }>> {
    const updated: Array<{ path: string; sha256: string }> = [];
    for (const operation of operations) {
      const target = this.validateOperation(operation);
      const existing = await readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (operation.preimage_exists && existing === null) {
        throw new HttpError(409, `stale_code_patch: ${operation.path} no longer exists`);
      }
      if (!operation.preimage_exists && existing !== null) {
        throw new HttpError(409, `stale_code_patch: ${operation.path} already exists`);
      }
      if (operation.preimage_exists && sha256(existing ?? Buffer.alloc(0)) !== operation.preimage_sha256) {
        throw new HttpError(409, `stale_code_patch: ${operation.path} preimage mismatch`);
      }
      this.preimages.push({
        path: operation.path,
        absolutePath: target,
        existed: existing !== null,
        content: existing,
      });
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${randomUUID()}`;
      await writeFile(tmp, operation.content, "utf8");
      await rename(tmp, target);
      updated.push({ path: operation.path, sha256: sha256(Buffer.from(operation.content, "utf8")) });
    }
    return updated;
  }

  async rollback(): Promise<void> {
    for (const preimage of [...this.preimages].reverse()) {
      if (preimage.existed && preimage.content) {
        await mkdir(dirname(preimage.absolutePath), { recursive: true });
        await writeFile(preimage.absolutePath, preimage.content);
      } else {
        await unlink(preimage.absolutePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }

  private validateOperation(operation: CodePatchOperation): string {
    if (operation.type !== "replace_file") {
      throw new HttpError(422, `Unsupported code_patch operation ${JSON.stringify(operation.type)}`);
    }
    if (isAbsolute(operation.path) || operation.path.split(/[\\/]+/).includes("..")) {
      throw new HttpError(422, `Unsafe code_patch path ${JSON.stringify(operation.path)}`);
    }
    if (operation.preimage_exists && !operation.preimage_sha256) {
      throw new HttpError(422, `preimage_sha256 is required for ${operation.path}`);
    }
    if (!operation.preimage_exists && operation.preimage_sha256 !== null) {
      throw new HttpError(422, `preimage_sha256 must be null for new file ${operation.path}`);
    }
    return validatePath({
      path: resolve(this.root, operation.path),
      allowedRoot: this.root,
      mode: "write",
      protectedFolder: this.protectedFolder,
      forTrustedCodePatchApply: true,
    });
  }
}

export const __codePatchTestHooks = {
  CodePatchFileTransaction,
};

function gitFailureSkipped(reason: string, code: number, stderr: string): SkippedChange {
  const detail = stderr.trim().slice(0, 400);
  return {
    path: ".",
    status: String(code),
    reason: detail ? `${reason}: ${detail}` : reason,
  };
}

async function linkTaskProposal(
  db: Queryable,
  spaceId: string,
  runId: string,
  proposalId: string,
  now: string,
): Promise<void> {
  const task = await db.query<{ task_id: string }>(
    `SELECT task_id FROM task_runs WHERE space_id = $1 AND run_id = $2 LIMIT 1`,
    [spaceId, runId],
  );
  const taskId = task.rows[0]?.task_id;
  if (!taskId) return;
  await db.query(
    `INSERT INTO task_proposals (id, space_id, task_id, proposal_id, role, created_at)
     VALUES ($1, $2, $3, $4, 'code_patch', $5)
     ON CONFLICT (task_id, proposal_id) DO NOTHING`,
    [randomUUID(), spaceId, taskId, proposalId, now],
  );
}

function parseOperation(value: unknown): CodePatchOperation {
  const op = recordValue(value);
  const type = op.type === "replace_file" ? "replace_file" : null;
  const path = typeof op.path === "string" ? op.path : null;
  const content = typeof op.content === "string" ? op.content : null;
  const preimageExists = typeof op.preimage_exists === "boolean" ? op.preimage_exists : null;
  const preimageSha = op.preimage_sha256 === null || typeof op.preimage_sha256 === "string"
    ? op.preimage_sha256
    : undefined;
  if (!type || !path || content === null || preimageExists === null || preimageSha === undefined) {
    throw new HttpError(422, "Invalid code_patch operation");
  }
  return {
    type,
    path,
    content,
    preimage_exists: preimageExists,
    preimage_sha256: preimageSha,
  };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
