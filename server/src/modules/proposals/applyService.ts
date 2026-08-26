import { randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PoolClient } from "../../db/pool.js";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { roomRunReadAccessSql } from "../access/contentAccessSql.js";
import {
  enforceProposalApply,
  type EnforceResult,
} from "../policy/service.js";
import { ProposalRiskLevelError } from "../policy/gateway.js";
import {
  createDefaultProposalApplierRegistry,
  type ProposalApplierContributor,
  type ProposalApplierRegistry,
} from "./applierRegistry.js";
import {
  PgProposalRepository,
} from "./repository.js";
import { PgSnapshotStore } from "../projectFolders/snapshotStore.js";
import { resolvePreferredServerHostLocation, locationAbsoluteRoot } from "../projectFolders/workspaceLocations.js";
import { PgProjectFolderRepository } from "../projectFolders/repository.js";
import { validatePath } from "../projectFolders/pathPolicy.js";
import { HttpError } from "../routeUtils/common.js";
import type {
  ProposalAcceptOut,
  ProposalAcceptResultType,
  ProposalApprovalOut,
  ProposalOut,
} from "@rainver/protocol";
import { ActionApprovalGrantService } from "../policy/actionApprovalGrantService.js";
import { EvolutionSignalEmitter } from "../evolution/signalEmitters.js";

/**
 * The accept response is a union discriminated on `result_type`, and the
 * applier registry types its payload only as an object, so the boundary parses
 * rather than asserts. This is also the one place a protocol schema validates
 * a server response, which is what keeps the typed members honest: an applier
 * that stops returning what its contract declares fails here instead of
 * quietly reaching the client.
 */
async function acceptOut(
  proposal: ProposalOut,
  result: { result_type: ProposalAcceptResultType; result: Record<string, unknown> },
): Promise<ProposalAcceptOut> {
  return protocol.ProposalAcceptOutSchema.parse({
    proposal,
    result_type: result.result_type,
    result: result.result,
  }) as ProposalAcceptOut;
}

export class ProposalApplyHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : "proposal apply failed");
    this.name = "ProposalApplyHttpError";
  }
}

async function roomRunReadableForUser(
  client: PoolClient,
  proposal: Pick<ApplyProposalRow, "created_by_run_id" | "space_id">,
  userId: string,
): Promise<boolean> {
  // Ordinary proposals have no originating Run and therefore have no Room
  // membership boundary to re-check. Avoid an unnecessary SQL probe here and
  // keep the Room-specific predicate limited to inherited Run output.
  if (!proposal.created_by_run_id) return true;
  const result = await client.query<{ allowed: boolean }>(
    `SELECT ${roomRunReadAccessSql("$1", "$2", "$3")} AS allowed`,
    [proposal.created_by_run_id, proposal.space_id, userId],
  );
  return result.rows[0]?.allowed === true;
}

export interface ProposalAcceptOptions {
  confirmIncompletePatch?: boolean;
  /** Only the bundle coordinator may apply a proposal while it owns the member row. */
  allowBundleMemberDecision?: boolean;
}

type ProposalTransactionCallback = () => Promise<void>;

export interface ProposalTransactionResult<T> {
  outcome: T;
  /** Compensate external side effects if the owning transaction cannot commit. */
  rollback?: () => Promise<void>;
  /** Advisory work that runs only after a successful COMMIT. */
  postCommit?: () => Promise<void>;
}

interface ApplyProposalRow {
  id: string;
  space_id: string;
  proposal_type: string;
  status: string;
  risk_level: string | null;
  preview: boolean;
  payload_json: Record<string, unknown> | null;
  project_folder_id: string | null;
  visibility: string | null;
  created_by_user_id: string | null;
  owner_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_run_id: string | null;
  project_id: string | null;
  title: string | null;
  required_approver_role: string | null;
}

interface GrantRow {
  id: string;
  granting_user_id: string;
  target_space_id: string;
  target_run_id: string;
  status: string;
  egress_review_expires_at: unknown;
}

interface ApprovalRow {
  id: string;
  proposal_id: string;
  approval_type: string;
  approver_user_id: string;
  grant_id: string | null;
  target_space_id: string | null;
  status: string;
  metadata_json: Record<string, unknown> | null;
  created_at: unknown;
  revoked_at: unknown;
}

export class PgProposalApplyService {
  constructor(
    private readonly config: ServerConfig,
    private readonly registry: ProposalApplierRegistry = createDefaultProposalApplierRegistry(),
  ) {}

  static fromConfig(
    config: ServerConfig,
    contributor?: ProposalApplierContributor,
  ): PgProposalApplyService {
    return new PgProposalApplyService(config, createDefaultProposalApplierRegistry(contributor));
  }

  supportedProposalTypes(): ReadonlySet<string> {
    return this.registry.registeredTypes();
  }

  async accept(
    proposalId: string,
    identity: { spaceId: string; userId: string },
    options: ProposalAcceptOptions = {},
  ): Promise<ProposalAcceptOut | null> {
    const client = await this.connect();
    let transactionResult: ProposalTransactionResult<ProposalAcceptOut> | null = null;
    try {
      await client.query("BEGIN");
      transactionResult = await this.acceptInTransaction(client, proposalId, identity, options);
      await client.query("COMMIT");
      if (transactionResult?.postCommit) await transactionResult.postCommit().catch(() => undefined);
      return transactionResult?.outcome ?? null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (transactionResult?.rollback) await transactionResult.rollback().catch(() => undefined);
      throw normalizeApplyError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Apply a proposal without owning BEGIN/COMMIT. The caller may use the
   * callback to update a related domain row before this transaction commits.
   * This is the transaction boundary used by evolution bundles.
   */
  async acceptInTransaction(
    client: PoolClient,
    proposalId: string,
    identity: { spaceId: string; userId: string },
    options: ProposalAcceptOptions = {},
    afterApply?: ProposalTransactionCallback,
  ): Promise<ProposalTransactionResult<ProposalAcceptOut> | null> {
    let rollbackOnFailure: (() => Promise<void>) | null = null;
    try {
      const proposal = await this.getProposalForUpdate(client, proposalId);
      if (
        !proposal ||
        proposal.status !== "pending" ||
        proposal.preview ||
        proposal.space_id !== identity.spaceId ||
        (await contentDecisionFromDb(client, identity, "proposal", proposal.id)) === "deny"
      ) return null;
      if (!await roomRunReadableForUser(client, proposal, identity.userId)) return null;

      await this.assertBundleMemberMayBeDecided(client, proposal.id, options.allowBundleMemberDecision === true);
      assertIncompleteCodePatchConfirmation(
        proposal.proposal_type,
        proposal.payload_json,
        options.confirmIncompletePatch === true,
      );
      await this.assertRequiredContextOwnerApprovals(client, proposal);
      await this.enforceApplyPolicy(client, proposal, identity.userId);
      const result = await this.registry.apply({
        config: this.config,
        db: client,
        proposal: {
          id: proposal.id,
          space_id: proposal.space_id,
          proposal_type: proposal.proposal_type,
          title: proposal.title,
          payload_json: proposal.payload_json,
          project_folder_id: proposal.project_folder_id,
          visibility: proposal.visibility,
          created_by_user_id: proposal.created_by_user_id,
          owner_user_id: proposal.owner_user_id,
          created_by_agent_id: proposal.created_by_agent_id,
          created_by_run_id: proposal.created_by_run_id,
          project_id: proposal.project_id,
        },
        userId: identity.userId,
      });
      rollbackOnFailure = result.rollback ?? null;
      if (afterApply) await afterApply();
      await this.markProposalFinal(client, proposal, identity.userId, result.finalStatus ?? "accepted", result.proposalPayloadPatch);
      const accepted = await new PgProposalRepository(client).getVisible(
        identity.spaceId,
        identity.userId,
        proposalId,
      );
      if (!accepted) throw new Error("accepted proposal is not visible after apply");
      return {
        outcome: await acceptOut(accepted, result),
        rollback: rollbackOnFailure ?? undefined,
      };
    } catch (error) {
      if (rollbackOnFailure) await rollbackOnFailure().catch(() => undefined);
      rollbackOnFailure = null;
      throw normalizeApplyError(error);
    }
  }

  async acceptAgentProposalIfGranted(
    proposalId: string,
    action: { actionId: string; projectId?: string | null; resourceKind?: string | null; resourceId?: string | null },
  ): Promise<ProposalAcceptOut | null> {
    const client = await this.connect();
    let rollbackOnFailure: (() => Promise<void>) | null = null;
    try {
      await client.query("BEGIN");
      const proposal = await this.getProposalForUpdate(client, proposalId);
      if (!proposal || proposal.status !== "pending" || proposal.preview || !proposal.created_by_agent_id) {
        await client.query("ROLLBACK");
        return null;
      }
      await this.assertBundleMemberMayBeDecided(client, proposal.id, false);
      const { SYSTEM_ACTION_REGISTRY } = await import("@rainver/protocol");
      const definition = SYSTEM_ACTION_REGISTRY.find((item) => item.id === action.actionId);
      const payloadActionId = proposal.payload_json?.action_id;
      if (
        !definition
        || !definition.grantable
        || !definition.proposal_type
        || payloadActionId !== action.actionId
        || definition.proposal_type !== proposal.proposal_type
        || (action.projectId != null && action.projectId !== proposal.project_id)
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      const grant = await new ActionApprovalGrantService(client).consumeMatching({
        spaceId: proposal.space_id,
        agentId: proposal.created_by_agent_id,
        actionId: action.actionId,
        runId: proposal.created_by_run_id,
        projectId: action.projectId ?? proposal.project_id,
        resourceKind: action.resourceKind,
        resourceId: action.resourceId,
      });
      if (!grant) { await client.query("ROLLBACK"); return null; }
      const grantId = String(grant.id);
      const grantingUserId = String(grant.granted_by_user_id);
      await this.enforceApplyPolicy(client, proposal, grantingUserId);
      const result = await this.registry.apply({ config: this.config, db: client, proposal: {
        id: proposal.id, space_id: proposal.space_id, proposal_type: proposal.proposal_type,
        title: proposal.title, payload_json: proposal.payload_json, project_folder_id: proposal.project_folder_id,
        visibility: proposal.visibility, created_by_user_id: proposal.created_by_user_id,
        owner_user_id: proposal.owner_user_id,
        created_by_agent_id: proposal.created_by_agent_id,
        created_by_run_id: proposal.created_by_run_id, project_id: proposal.project_id,
      }, userId: grantingUserId });
      rollbackOnFailure = result.rollback ?? null;
      await client.query(
        `INSERT INTO proposal_approvals (id, proposal_id, approval_type, approver_user_id, action_grant_id, status, metadata_json, created_at)
         VALUES ($1,$2,'action_grant',$3,$4,'approved',$5::jsonb,$6)`,
        [randomUUID(), proposal.id, grantingUserId, grantId, JSON.stringify({ approval_source: `action_grant:${grantId}`, action_id: action.actionId }), new Date().toISOString()],
      );
      await this.markProposalFinal(client, proposal, grantingUserId, result.finalStatus ?? "accepted", result.proposalPayloadPatch);
      const accepted = await new PgProposalRepository(client).getVisible(proposal.space_id, grantingUserId, proposal.id);
      if (!accepted) throw new Error("accepted proposal is not visible after grant apply");
      await client.query("COMMIT");
      return await acceptOut(accepted, result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (rollbackOnFailure) await rollbackOnFailure().catch(() => undefined);
      throw error;
    }
    finally { client.release(); }
  }

  async reject(
    proposalId: string,
    identity: { spaceId: string; userId: string },
  ): Promise<ProposalOut | null> {
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      const rejected = await this.rejectTransaction(client, proposalId, identity);
      if (!rejected) {
        await client.query("COMMIT");
        return null;
      }
      await client.query("COMMIT");
      if (rejected.postCommit) await rejected.postCommit().catch(() => undefined);
      return rejected.outcome;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeApplyError(error);
    } finally {
      client.release();
    }
  }

  async rejectInTransaction(
    client: PoolClient,
    proposalId: string,
    identity: { spaceId: string; userId: string },
    afterReject?: ProposalTransactionCallback,
  ): Promise<ProposalTransactionResult<ProposalOut> | null> {
    const rejected = await this.rejectTransaction(client, proposalId, identity, afterReject, true);
    return rejected;
  }

  private async rejectTransaction(
    client: PoolClient,
    proposalId: string,
    identity: { spaceId: string; userId: string },
    afterReject?: ProposalTransactionCallback,
    allowBundleMemberDecision = false,
  ): Promise<ProposalTransactionResult<ProposalOut> | null> {
    const proposal = await this.getProposalForUpdate(client, proposalId);
    if (
      !proposal ||
      proposal.space_id !== identity.spaceId ||
      proposal.status !== "pending" ||
      (await contentDecisionFromDb(client, identity, "proposal", proposal.id)) === "deny" ||
      !(await roomRunReadableForUser(client, proposal, identity.userId)) ||
      !(await canRejectProposal(client, proposal, identity.userId))
    ) return null;
    await this.assertBundleMemberMayBeDecided(client, proposal.id, allowBundleMemberDecision);
    const updated = await client.query(
      `UPDATE proposals
          SET status = 'rejected', reviewed_at = $3, reviewed_by = $4, updated_at = $3
        WHERE id = $1 AND space_id = $2 AND status = 'pending'`,
      [proposalId, identity.spaceId, new Date().toISOString(), identity.userId],
    );
    if ((updated.rowCount ?? 0) === 0) return null;
    await releaseRejectedCustomSourceHandlerVersion(client, proposalId, identity.spaceId);
    await releaseRejectedSourceRecipeVersion(client, proposalId, identity.spaceId);
    await releaseRejectedSourceChannelDraft(client, proposal);
    await releaseRejectedSourceBackfillPlan(client, proposal);
    if (afterReject) await afterReject();
    const out = await new PgProposalRepository(client).getVisible(identity.spaceId, identity.userId, proposalId);
    if (!out) throw new Error("rejected proposal is not visible after reject");
    return {
      outcome: out,
      postCommit: () => this.emitDecisionSignalBestEffort({
        spaceId: identity.spaceId,
        proposalId,
        status: "rejected",
        proposalType: proposal.proposal_type,
        createdByRunId: proposal.created_by_run_id,
      }),
    };
  }

  async approveEgressGrantingUser(
    proposalId: string,
    identity: { spaceId: string; userId: string },
    grantIdInput: string | null,
  ): Promise<ProposalApprovalOut> {
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      const proposal = await this.getProposalForUpdate(client, proposalId);
      if (
        !proposal
        || proposal.status !== "pending"
        || proposal.space_id !== identity.spaceId
        || (await contentDecisionFromDb(client, identity, "proposal", proposal.id)) === "deny"
        || !(await roomRunReadableForUser(client, proposal, identity.userId))
      ) {
        throw new ProposalApplyHttpError(404, "Proposal not found");
      }
      const taintOwnerApprovers = requiredTaintOwnerApprovers(proposal.payload_json);
      if (taintOwnerApprovers.length > 0) {
        if (!taintOwnerApprovers.includes(identity.userId)) {
          throw new ProposalApplyHttpError(403, "only a required taint owner can approve this egress");
        }
        if (grantIdInput) {
          throw new ProposalApplyHttpError(422, "grant_id must be omitted for context-taint owner approval");
        }
        const approval = await this.upsertEgressApproval(client, proposal, identity.userId, null, {
          approval_type: "egress_granting_user",
          approval_source: "context_taint_owner",
          raw_private_memory_included: false,
          personal_summary_persisted: false,
        });
        await client.query("COMMIT");
        return approvalToOut(approval);
      }
      const grantId = grantIdInput ?? await this.inferGrantId(client, proposal);
      if (!grantId) throw new ProposalApplyHttpError(422, "grant_id is required");
      const grant = await this.getGrant(client, grantId);
      if (!grant) throw new ProposalApplyHttpError(403, "grant not found");
      this.validateGrantApproval(proposal, grant, identity.userId, grantId);

      const approval = await this.upsertEgressApproval(client, proposal, identity.userId, grantId, {
        approval_type: "egress_granting_user",
        raw_private_memory_included: false,
        personal_summary_persisted: false,
      }, grant.target_space_id);
      await client.query("COMMIT");
      return approvalToOut(approval);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertEgressApproval(
    client: PoolClient,
    proposal: ApplyProposalRow,
    userId: string,
    grantId: string | null,
    metadata: Record<string, unknown>,
    targetSpaceId: string = proposal.space_id,
  ): Promise<ApprovalRow> {
      const existing = await client.query<ApprovalRow>(
        `SELECT id, proposal_id, approval_type, approver_user_id, grant_id,
                target_space_id, status, metadata_json, created_at, revoked_at
           FROM proposal_approvals
          WHERE proposal_id = $1
            AND approval_type = 'egress_granting_user'
            AND approver_user_id = $2
            AND grant_id IS NOT DISTINCT FROM $3
            AND status = 'approved'
            AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [proposal.id, userId, grantId],
      );
      let approval = existing.rows[0];
      if (!approval) {
        const inserted = await client.query<ApprovalRow>(
          `INSERT INTO proposal_approvals
             (id, proposal_id, approval_type, approver_user_id, grant_id,
              target_space_id, status, metadata_json, created_at, revoked_at)
           VALUES ($1, $2, 'egress_granting_user', $3, $4, $5, 'approved',
                   $6::jsonb, $7, NULL)
           RETURNING id, proposal_id, approval_type, approver_user_id, grant_id,
                     target_space_id, status, metadata_json, created_at, revoked_at`,
          [
            randomUUID(),
            proposal.id,
            userId,
            grantId,
            targetSpaceId,
            JSON.stringify(metadata),
            new Date().toISOString(),
          ],
        );
        approval = inserted.rows[0]!;
      }
      return approval;
  }

  async rollback(
    proposalId: string,
    identity: { spaceId: string; userId: string },
  ): Promise<{ rolled_back_paths: string[] } | null> {
    const client = await this.connect();
    try {
      await client.query("BEGIN");

      const proposal = await client.query<ApplyProposalRow>(
      `SELECT id, space_id, proposal_type, status, risk_level, preview,
                payload_json, project_folder_id, created_by_user_id, created_by_run_id,
                visibility, project_id, title
           FROM proposals
          WHERE id = $1 AND space_id = $2 AND proposal_type = 'code_patch' AND status = 'accepted'
          FOR UPDATE`,
        [proposalId, identity.spaceId],
      );
      const p = proposal.rows[0];
      if (
        !p
        || (await contentDecisionFromDb(client, identity, "proposal", p.id)) === "deny"
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (!p.project_folder_id) {
        await client.query("ROLLBACK");
        throw new ProposalApplyHttpError(422, "code_patch proposal has no project_folder_id");
      }

      const snapshot = await new PgSnapshotStore(client).getByProposal(proposalId, identity.spaceId);
      if (!snapshot) {
        await client.query("ROLLBACK");
        throw new ProposalApplyHttpError(404, "No available snapshot found for this proposal — it may have expired or already been used");
      }

      const folder = await new PgProjectFolderRepository(client, this.config)
        .getFolder(identity.spaceId, p.project_folder_id, true);
      if (!folder) {
        await client.query("ROLLBACK");
        throw new ProposalApplyHttpError(404, "Project Folder not found");
      }
      let location;
      try {
        location = await resolvePreferredServerHostLocation(client, identity.spaceId, p.project_folder_id);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error instanceof HttpError ? new ProposalApplyHttpError(error.statusCode, error.message) : error;
      }
      const root = locationAbsoluteRoot(location, this.config.workspaceRoot);

      // Restore files to pre-apply state
      const restoredPaths: string[] = [];
      for (const file of snapshot.files) {
        const absPath = validatePath({
          path: resolve(root, file.path),
          allowedRoot: root,
          mode: "write",
          protectedFolder: folder.protected,
          forTrustedCodePatchApply: true,
        });
        if (file.existed && file.content !== null) {
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, file.content, "utf8");
        } else {
          await unlink(absPath).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
          });
        }
        restoredPaths.push(file.path);
      }

      await new PgSnapshotStore(client).markRolledBack(snapshot.id, identity.userId);

      const now = new Date().toISOString();
      await client.query(
        `INSERT INTO activity_records (
           id, space_id, source_run_id, user_id, project_folder_id, activity_type,
           title, content, payload_json, occurred_at, created_at, status, updated_at,
           source_kind, source_trust, visibility, owner_user_id
         ) VALUES (
           $1, $2, NULL, $3, $4, 'proposal.code_patch.rolled_back',
           $5, $6, $7::jsonb, $8, $8, 'processed', $8,
           'project_folder_event', 'internal_system', 'space_shared', $3
         )`,
        [
          randomUUID(),
          identity.spaceId,
          identity.userId,
          p.project_folder_id,
          p.title ?? "Code patch rolled back",
          `Rolled back code patch proposal ${proposalId}.`,
          JSON.stringify({ proposal_id: proposalId, restored_paths: restoredPaths, file_count: restoredPaths.length }),
          now,
        ],
      );

      await client.query("COMMIT");
      return { rolled_back_paths: restoredPaths };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof ProposalApplyHttpError) throw error;
      throw error;
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.config.databaseUrl) {
      throw new Error("Proposal apply requires SERVER_DATABASE_URL");
    }
    return getDbPool(this.config.databaseUrl).connect();
  }

  private async emitDecisionSignalBestEffort(input: {
    spaceId: string;
    proposalId: string;
    status: string;
    proposalType: string | null;
    createdByRunId: string | null;
  }): Promise<void> {
    if (!this.config.databaseUrl) return;
    try {
      await new EvolutionSignalEmitter(getDbPool(this.config.databaseUrl)).emitProposalDecision(input);
    } catch {
      // Evolution telemetry is advisory and must not change a committed
      // proposal decision into an API failure.
    }
  }

  private async getProposalForUpdate(
    client: PoolClient,
    proposalId: string,
  ): Promise<ApplyProposalRow | null> {
    const result = await client.query<ApplyProposalRow>(
      `SELECT proposal.id, proposal.space_id, proposal.proposal_type,
              proposal.status, proposal.risk_level, proposal.preview,
              proposal.payload_json, proposal.project_folder_id,
              proposal.created_by_user_id, proposal.owner_user_id, proposal.created_by_agent_id,
              proposal.created_by_run_id, proposal.visibility,
              proposal.project_id, proposal.title,
              proposal.required_approver_role
         FROM proposals proposal
        WHERE proposal.id = $1
        FOR UPDATE`,
      [proposalId],
    );
    return result.rows[0] ?? null;
  }

  private async markProposalFinal(
    client: PoolClient,
    proposal: ApplyProposalRow,
    userId: string,
    status: "accepted" | "superseded",
    payloadPatch?: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date().toISOString();
    if (payloadPatch) {
      await client.query(
        `UPDATE proposals
            SET status = $6,
                reviewed_at = COALESCE(reviewed_at, $3),
                reviewed_by = COALESCE(reviewed_by, $4),
                payload_json = $5::jsonb,
                updated_at = $3
          WHERE id = $1
            AND space_id = $2
            AND status = 'pending'`,
        [proposal.id, proposal.space_id, now, userId, JSON.stringify(payloadPatch), status],
      );
    } else {
      await client.query(
        `UPDATE proposals
            SET status = $5,
                reviewed_at = COALESCE(reviewed_at, $3),
                reviewed_by = COALESCE(reviewed_by, $4),
                updated_at = $3
          WHERE id = $1
            AND space_id = $2
            AND status = 'pending'`,
        [proposal.id, proposal.space_id, now, userId, status],
      );
    }
  }

  private async enforceApplyPolicy(
    client: PoolClient,
    proposal: ApplyProposalRow,
    userId: string,
  ): Promise<void> {
    const role = await getMembershipRole(client, userId, proposal.space_id);
    const result = await enforceProposalApply(
      this.config,
      {
        user_id: userId,
        space_id: proposal.space_id,
        proposal_id: proposal.id,
        proposal_type: proposal.proposal_type,
        declared_risk: proposal.risk_level,
        required_approver_role: proposal.required_approver_role,
        proposal_payload: proposal.payload_json,
        metadata_json: { server_apply: true },
      },
      role,
      this.registry.registeredTypes(),
    );
    if (result.status !== "allow") {
      throw policyResultToHttpError(result);
    }
  }

  private async assertBundleMemberMayBeDecided(
    client: PoolClient,
    proposalId: string,
    allowedByBundleCoordinator: boolean,
  ): Promise<void> {
    if (allowedByBundleCoordinator) return;
    const result = await client.query<{ bundle_id: string }>(
      `SELECT bm.bundle_id
         FROM evolution_bundle_members bm
         JOIN evolution_bundles b ON b.id = bm.bundle_id
        WHERE bm.proposal_id = $1
          AND bm.status = 'pending'
          AND b.status IN ('pending_review', 'partially_approved')
        LIMIT 1`,
      [proposalId],
    );
    if (result.rows[0]) {
      throw new ProposalApplyHttpError(409, {
        code: "proposal_bundled",
        bundle_id: result.rows[0].bundle_id,
        message: "This proposal is owned by an active evolution bundle; decide it from the bundle inbox.",
      });
    }
  }

  private async inferGrantId(
    client: PoolClient,
    proposal: ApplyProposalRow,
  ): Promise<string | null> {
    const payload = proposal.payload_json ?? {};
    const grantId = stringValue(payload.grant_id);
    if (grantId) return grantId;
    const grantIds = payload.personal_memory_grant_ids;
    if (Array.isArray(grantIds) && grantIds.length === 1 && typeof grantIds[0] === "string") {
      return grantIds[0];
    }
    const sourceRunId = stringValue(payload.source_run_id) ?? proposal.created_by_run_id;
    if (!sourceRunId) return null;
    const run = await client.query<{ grant_id: string | null }>(
      `SELECT context_taint_json->'personal_memory_grant_ids'->>0 AS grant_id
         FROM runs
        WHERE id = $1`,
      [sourceRunId],
    );
    return run.rows[0]?.grant_id ?? null;
  }

  private async assertRequiredContextOwnerApprovals(
    client: PoolClient,
    proposal: ApplyProposalRow,
  ): Promise<void> {
    const requiredOwners = requiredTaintOwnerApprovers(proposal.payload_json);
    if (requiredOwners.length === 0) return;
    const approved = await client.query<{ approver_user_id: string }>(
      `SELECT DISTINCT approver_user_id
         FROM proposal_approvals
        WHERE proposal_id = $1
          AND approval_type = 'egress_granting_user'
          AND approver_user_id = ANY($2::varchar[])
          AND grant_id IS NULL
          AND status = 'approved'
          AND revoked_at IS NULL`,
      [proposal.id, requiredOwners],
    );
    const approvedIds = new Set(approved.rows.map((row) => row.approver_user_id));
    const missing = requiredOwners.filter((userId) => !approvedIds.has(userId));
    if (missing.length > 0) {
      throw new ProposalApplyHttpError(409, {
        code: "content_owner_egress_approval_required",
        required_approver_user_ids: missing,
        message: "Publishing context-tainted output requires every contributing content owner's approval.",
      });
    }
  }

  private async getGrant(client: PoolClient, grantId: string): Promise<GrantRow | null> {
    const result = await client.query<GrantRow>(
      `SELECT id, granting_user_id, target_space_id, target_run_id, status,
              egress_review_expires_at
         FROM personal_memory_grants
        WHERE id = $1`,
      [grantId],
    );
    return result.rows[0] ?? null;
  }

  private validateGrantApproval(
    proposal: ApplyProposalRow,
    grant: GrantRow,
    userId: string,
    grantId: string,
  ): void {
    const payload = proposal.payload_json ?? {};
    if (grant.granting_user_id !== userId) {
      throw new ProposalApplyHttpError(
        403,
        "only granting_user_id can approve grant-derived egress",
      );
    }
    if (payload.raw_private_memory_included === true) {
      throw new ProposalApplyHttpError(403, "raw private memory cannot be approved for egress");
    }
    if (grant.status === "revoked" || grant.status === "expired" || grant.status === "failed") {
      throw new ProposalApplyHttpError(403, `grant status ${JSON.stringify(grant.status)} cannot approve egress`);
    }
    const payloadGrantId = stringValue(payload.grant_id);
    if (payloadGrantId && payloadGrantId !== grantId) {
      throw new ProposalApplyHttpError(403, "proposal grant_id does not match approval grant_id");
    }
    const payloadGrantIds = payload.personal_memory_grant_ids;
    if (Array.isArray(payloadGrantIds) && !payloadGrantIds.map(String).includes(grantId)) {
      throw new ProposalApplyHttpError(
        403,
        "proposal personal_memory_grant_ids does not include approval grant_id",
      );
    }
    if (stringValue(payload.target_space_id) && payload.target_space_id !== grant.target_space_id) {
      throw new ProposalApplyHttpError(403, "proposal target_space_id does not match grant target_space_id");
    }
    if (proposal.space_id !== grant.target_space_id) {
      throw new ProposalApplyHttpError(403, "proposal space_id does not match grant target_space_id");
    }
    const sourceRunId = stringValue(payload.source_run_id) ?? proposal.created_by_run_id;
    if (!sourceRunId) {
      throw new ProposalApplyHttpError(403, "grant-derived proposal is missing source_run_id");
    }
    if (sourceRunId !== grant.target_run_id) {
      throw new ProposalApplyHttpError(403, "proposal source_run_id does not match grant target_run_id");
    }
    const deadline = dateFrom(grant.egress_review_expires_at);
    if (deadline && deadline.getTime() <= Date.now()) {
      throw new ProposalApplyHttpError(403, "egress review deadline has passed");
    }
  }
}

async function releaseRejectedSourceChannelDraft(client: PoolClient, proposal: ApplyProposalRow): Promise<void> {
  if (proposal.proposal_type !== "source_channel_activation") return;
  const channelId = stringValue(proposal.payload_json?.source_channel_id);
  if (!channelId) return;
  const now = new Date().toISOString();
  await client.query(`UPDATE source_channels SET status='archived', updated_at=$3 WHERE id=$1 AND space_id=$2 AND status='paused'`, [channelId, proposal.space_id, now]);
  await client.query(`UPDATE source_connections SET status='archived', updated_at=$3 WHERE id=(SELECT source_connection_id FROM source_channels WHERE id=$1 AND space_id=$2) AND space_id=$2 AND status='paused'`, [channelId, proposal.space_id, now]);
  await client.query(`UPDATE proposals SET status='superseded',updated_at=$3 WHERE space_id=$1 AND status='pending' AND payload_json->>'depends_on_proposal_id'=$2`,[proposal.space_id,proposal.id,now]);
}

async function releaseRejectedSourceBackfillPlan(client: PoolClient,proposal:ApplyProposalRow):Promise<void>{
  if(proposal.proposal_type!=="source_backfill_start")return;
  const planId=stringValue(proposal.payload_json?.source_backfill_plan_id);
  if(!planId)return;
  await client.query(`UPDATE source_backfill_plans SET status='draft',proposal_id=NULL,updated_at=$3 WHERE id=$1 AND space_id=$2 AND proposal_id=$4 AND status='proposed'`,[planId,proposal.space_id,new Date().toISOString(),proposal.id]);
}

async function releaseRejectedCustomSourceHandlerVersion(
  client: PoolClient,
  proposalId: string,
  spaceId: string,
): Promise<void> {
  await client.query(
    `UPDATE source_handler_versions
        SET status = 'draft',
            proposal_id = NULL
      WHERE space_id = $1
        AND proposal_id = $2
        AND status = 'pending_approval'`,
    [spaceId, proposalId],
  );
}

async function releaseRejectedSourceRecipeVersion(
  client: PoolClient,
  proposalId: string,
  spaceId: string,
): Promise<void> {
  await client.query(
    `UPDATE source_recipe_versions
        SET status = 'draft',
            proposal_id = NULL
      WHERE space_id = $1
        AND proposal_id = $2
        AND status = 'pending_approval'`,
    [spaceId, proposalId],
  );
}

export function assertIncompleteCodePatchConfirmation(
  proposalType: string,
  payloadJson: Record<string, unknown> | null,
  confirmed: boolean,
): void {
  if (proposalType !== "code_patch") return;
  const payload = recordValue(payloadJson);
  if (payload.incomplete_patch !== true || confirmed) return;
  throw new ProposalApplyHttpError(422, {
    code: "incomplete_patch_requires_confirmation",
    message: (
      "This code_patch proposal has incomplete_patch=true: some agent file changes were skipped " +
      "and the patch is partial. Pass confirm_incomplete_patch=true to apply it anyway."
    ),
    skipped_changes: skippedChangesForDetail(payload),
  });
}

function skippedChangesForDetail(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.skipped_changes)) return payload.skipped_changes;
  if (Array.isArray(payload.skipped)) return payload.skipped;
  return [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function canRejectProposalWithRole(
  proposal: {
    created_by_user_id: string | null;
    owner_user_id: string | null;
    created_by_agent_id: string | null;
    required_approver_role: string | null;
  },
  userId: string,
  role: string | null,
): boolean {
  if (proposal.created_by_user_id === userId) return true;
  // Agent-authored proposals retain Agent attribution, while owner_user_id is
  // the trusted server-populated identity of the instructing human. Give that
  // human the same ability to decline their draft as a direct creator.
  if (proposal.created_by_agent_id && proposal.owner_user_id === userId) return true;
  const requiredRole = normalizeRequiredApproverRole(proposal.required_approver_role);
  return Boolean(requiredRole && role && roleSatisfiesRequiredApprover(role, requiredRole));
}

async function canRejectProposal(
  client: PoolClient,
  proposal: ApplyProposalRow,
  userId: string,
): Promise<boolean> {
  const role = await getMembershipRole(client, userId, proposal.space_id);
  return canRejectProposalWithRole(proposal, userId, role);
}

function normalizeRequiredApproverRole(role: string | null | undefined): "owner" | "admin" | "reviewer" | null {
  if (!role) return null;
  if (role === "owner" || role === "admin" || role === "reviewer") return role;
  return "owner";
}

function roleSatisfiesRequiredApprover(
  actorRole: string,
  requiredRole: "owner" | "admin" | "reviewer",
): boolean {
  return roleRank(actorRole) >= roleRank(requiredRole);
}

function roleRank(role: string): number {
  if (role === "owner") return 3;
  if (role === "admin") return 2;
  if (role === "reviewer") return 1;
  return 0;
}

async function getMembershipRole(
  client: PoolClient,
  userId: string,
  spaceId: string,
): Promise<string | null> {
  const result = await client.query<{ role: string }>(
    `SELECT role
       FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active'
      LIMIT 1`,
    [spaceId, userId],
  );
  return result.rows[0]?.role ?? null;
}

function policyResultToHttpError(result: EnforceResult): ProposalApplyHttpError {
  if (result.status === "error") {
    return new ProposalApplyHttpError(500, result.message ?? result.error_code ?? "Policy audit failed");
  }
  return new ProposalApplyHttpError(403, result.message ?? result.error_code ?? "Policy denied proposal apply");
}

function normalizeApplyError(error: unknown): unknown {
  if (error instanceof ProposalRiskLevelError) {
    return new ProposalApplyHttpError(422, {
      code: "invalid_proposal_risk_level",
      risk_value: error.riskValue,
      message: error.message,
    });
  }
  if (error instanceof ProposalApplyHttpError) return error;
  return error;
}

function approvalToOut(row: ApprovalRow): ProposalApprovalOut {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    approval_type: row.approval_type,
    approver_user_id: row.approver_user_id,
    grant_id: row.grant_id,
    target_space_id: row.target_space_id,
    status: row.status,
    metadata_json: row.metadata_json,
    created_at: dateValue(row.created_at) ?? new Date(0).toISOString(),
    revoked_at: dateValue(row.revoked_at),
  };
}

function requiredTaintOwnerApprovers(payload: Record<string, unknown> | null): string[] {
  if (payload?.requires_approval_type !== "egress_content_owner") return [];
  const value = payload?.required_egress_approver_user_ids;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].sort();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dateValue(value: unknown): string | null {
  const date = dateFrom(value);
  return date ? date.toISOString() : null;
}

function dateFrom(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
