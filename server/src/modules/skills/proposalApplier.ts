import { SkillReviewProposalRequestSchema, type SkillBinding } from "@rainver/protocol";
import type {
  ProposalApplierRegistry,
  ProposalApplyContext,
  ProposalApplyResult,
} from "../proposals/applierRegistry.js";
import { HttpError, objectValue, optionalString } from "../routeUtils/common.js";
import {
  approveSkillImportInTransaction,
} from "./repository.js";
import { applySkillBindingRequest, applySkillPackageBinding, lockSkillPackage } from "./skillBindings.js";

type JsonRecord = Record<string, unknown>;

export function registerSkillProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("skill_import_approve", applySkillImportApproveProposal);
  registry.register("runtime_skill_binding_update", async context => {
    ensureOperation(objectValue(context.proposal.payload_json), "skill_package_binding_update");
    return applySkillPackageBinding(context);
  });
}

/** Review is a Space decision and cannot inherit a Project owner's authority. */
function assertSpaceEffectScope(context: ProposalApplyContext): void {
  if (context.proposal.project_id) {
    throw new HttpError(422, "This proposal changes the Space and cannot be scoped to a Project");
  }
}

async function applySkillImportApproveProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = objectValue(context.proposal.payload_json);
  ensureOperation(payload, "skill_import_approve");
  assertSpaceEffectScope(context);
  const skillPackageId = requiredPayloadString(payload, "skill_package_id");
  // Lock order: this proposal's row (taken by the apply entry), the package
  // lock, the package row, then only those other reviews no one else holds.
  // Two reviews of one package approved at once thus queue on the package
  // instead of waiting on each other's proposal rows; the one that comes
  // second finds the package reviewed and is superseded below.
  await lockSkillPackage(context.db, context.proposal.space_id, skillPackageId);
  const current = (await context.db.query<{ status: string; reviewed_from_proposal_id: string | null }>(
    `SELECT status, manifest_json->'review'->>'reviewed_from_proposal_id' AS reviewed_from_proposal_id
       FROM skill_packages WHERE id = $1 AND space_id = $2 FOR UPDATE`,
    [skillPackageId, context.proposal.space_id],
  )).rows[0];
  if (!current) throw new HttpError(404, "Skill package not found");
  const reviewedFrom = current.reviewed_from_proposal_id;
  if (current.status !== "imported" && reviewedFrom && reviewedFrom !== context.proposal.id) {
    // Another review of this package was approved first. This one no longer
    // applies, so approving it supersedes it rather than failing and leaving
    // it pending; its binding must be requested again as a binding proposal.
    return {
      result_type: "skill_overlay",
      result: { action: "skill_import_approve", superseded_by_proposal_id: reviewedFrom },
      finalStatus: "superseded",
      proposalPayloadPatch: { ...payload, superseded_by_proposal_id: reviewedFrom },
    };
  }
  const skillPackage = await approveSkillImportInTransaction({
    db: context.db,
    spaceId: context.proposal.space_id,
    userId: context.userId,
    proposalId: context.proposal.id,
    skillPackageId,
  });
  // Other people's pending reviews of this package can no longer apply (it is
  // no longer awaiting review); supersede them rather than leave them to fail
  // at apply. A review whose row another transaction holds (being approved or
  // rejected right now) is skipped, not waited on: waiting would deadlock
  // with its approver, who is queued on the package lock. Approving a skipped
  // review later supersedes it through the branch above.
  await context.db.query(
    `UPDATE proposals SET status = 'superseded', updated_at = $4
      WHERE id IN (
        SELECT id FROM proposals
         WHERE space_id = $1 AND proposal_type = 'skill_import_approve' AND status = 'pending'
           AND id <> $2 AND payload_json->>'skill_package_id' = $3
         FOR UPDATE SKIP LOCKED)`,
    [context.proposal.space_id, context.proposal.id, skillPackageId, new Date().toISOString()],
  );
  // A review filed with an enabling binding enables it in the same approval.
  let skillBinding: SkillBinding | undefined;
  if (payload.binding !== undefined) {
    const binding = SkillReviewProposalRequestSchema.safeParse({ binding: payload.binding });
    if (!binding.success || !binding.data.binding) throw new HttpError(422, "Invalid Skill review binding");
    skillBinding = await applySkillBindingRequest(context, skillPackageId, payload.package_hash, binding.data.binding);
  }
  return {
    result_type: "skill_overlay",
    result: {
      action: "skill_import_approve",
      skill_package: skillPackage,
      ...(skillBinding ? { skill_binding: skillBinding } : {}),
    },
    proposalPayloadPatch: {
      ...objectValue(context.proposal.payload_json),
      reviewed_skill_package_id: skillPackage.id,
      resulting_status: skillPackage.status,
      ...(skillBinding ? { skill_binding_id: skillBinding.id } : {}),
    },
  };
}

function ensureOperation(payload: JsonRecord, expected: string): void {
  const operation = requiredPayloadString(payload, "operation");
  if (operation !== expected) {
    throw new HttpError(422, `expected operation ${JSON.stringify(expected)}`);
  }
}

function requiredPayloadString(payload: JsonRecord, key: string): string {
  const value = optionalString(payload[key]);
  if (!value) throw new HttpError(422, `proposal payload missing ${key}`);
  return value;
}
