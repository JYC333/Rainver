import { randomUUID } from "node:crypto";
import { SkillReviewProposalRequestSchema, type SkillBinding } from "@rainver/protocol";
import type {
  ProposalApplierRegistry,
  ProposalApplyContext,
  ProposalApplyResult,
} from "../proposals/applierRegistry.js";
import { HttpError, objectValue, optionalObject, optionalString } from "../routeUtils/common.js";
import {
  approveSkillImportInTransaction,
  convertSkillPackageToCapabilityInTransaction,
} from "./repository.js";
import { getBuiltInCapabilityDefinition } from "./registry.js";
import { applySkillBindingRequest, applySkillPackageBinding, lockSkillPackage } from "./skillBindings.js";

type JsonRecord = Record<string, unknown>;

/**
 * An imported Skill's version carries its reviewed package snapshot: the
 * `normalized_skill` and the `capability_definition` derived from it, tied to
 * the package by `skill_package_id`, the version's `content_ref` and its
 * `content_hash` (the package hash), with the proposal it was created from.
 * Delivery renders from these keys, so changing one would deliver content no
 * review saw under a hash that no longer describes it. New content arrives
 * only through a new import, which produces a new snapshot and hash.
 */
const IMPORTED_SKILL_SNAPSHOT_KEYS = [
  "capability_definition",
  "normalized_skill",
  "skill_package_id",
  "created_from_proposal_id",
] as const;

export function registerCapabilityProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("skill_import_approve", applySkillImportApproveProposal);
  registry.register("capability_install", applyCapabilityInstallProposal);
  registry.register("capability_update", applyCapabilityUpdateProposal);
  registry.register("capability_enable", applyCapabilityEnableProposal);
  registry.register("capability_disable", applyCapabilityDisableProposal);
  registry.register("runtime_skill_binding_update", applyRuntimeSkillBindingUpdateProposal);
}

/**
 * The scope a proposal's effect lands in must be the scope its approval was
 * judged on. Approval is role-by-scope: a proposal with a `project_id` is
 * decidable by that Project's owner, one without only by a Space owner. An
 * installation, a shared version, a shared runtime binding and a Space-wide
 * enablement all change the Space, so a `project_id` on such a proposal would
 * let a Project owner approve a Space-wide change; a Project-scoped
 * enablement's payload must name the same Project the proposal was filed
 * under, or a Space-wide one could be approved under a Project's authority.
 */
function assertSpaceEffectScope(context: ProposalApplyContext): void {
  if (context.proposal.project_id) {
    throw new HttpError(422, "This proposal changes the Space and cannot be scoped to a Project");
  }
}

function assertEnablementEffectScope(context: ProposalApplyContext, scope: EnablementScope): void {
  if ((scope.projectId ?? null) !== (context.proposal.project_id ?? null)) {
    throw new HttpError(422, "capability enablement project scope does not match the proposal's Project");
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
      result_type: "capability_overlay",
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
    result_type: "capability_overlay",
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

async function applyCapabilityInstallProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = objectValue(context.proposal.payload_json);
  ensureOperation(payload, "install_from_skill_package");
  assertSpaceEffectScope(context);
  const skillPackageId = requiredPayloadString(payload, "skill_package_id");
  const capabilityId = optionalString(payload.capability_id);
  if (capabilityId && getBuiltInCapabilityDefinition(capabilityId)) {
    throw new HttpError(409, "Imported capability id conflicts with a built-in capability");
  }
  const result = await convertSkillPackageToCapabilityInTransaction({
    db: context.db,
    identity: {
      spaceId: context.proposal.space_id,
      userId: context.userId,
    },
    skillPackageId,
    proposalId: context.proposal.id,
    body: {
      capability_id: capabilityId ?? undefined,
      namespace: optionalString(payload.namespace) ?? undefined,
      create_runtime_bindings: payload.create_runtime_bindings !== false,
    },
  });
  return {
    result_type: "capability_overlay",
    result: {
      action: "capability_install",
      skill_package: result.skill_package,
      capability_definition: result.capability_definition,
      capability_version_id: result.capability_version_id,
      runtime_bindings: result.runtime_bindings,
      enabled: false,
    },
    proposalPayloadPatch: {
      ...objectValue(context.proposal.payload_json),
      resulting_skill_package_id: result.skill_package.id,
      resulting_capability_key: result.capability_definition.id,
      resulting_capability_version_id: result.capability_version_id,
      runtime_binding_ids: result.runtime_bindings.map((binding) => binding.id),
    },
  };
}

async function applyCapabilityUpdateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = objectValue(context.proposal.payload_json);
  ensureOperation(payload, "capability_update");
  assertSpaceEffectScope(context);
  const versionId = requiredPayloadString(payload, "capability_version_id");
  const status = optionalString(payload.status);
  const metadataPatch = optionalObject(payload.metadata_json) ?? {};
  if (status && !["draft", "proposed", "testing", "available", "disabled", "archived"].includes(status)) {
    throw new HttpError(422, "capability_update status is invalid");
  }
  const now = new Date().toISOString();
  const target = await context.db.query<{ id: string; capability_key: string; source: string }>(
    `SELECT id, capability_key, source
       FROM capability_versions
      WHERE id = $1 AND space_id = $2
      FOR UPDATE`,
    [versionId, context.proposal.space_id],
  );
  if (!target.rows[0]) throw new HttpError(404, "Capability version not found");
  if (target.rows[0].source === "imported_skill") {
    const touched = IMPORTED_SKILL_SNAPSHOT_KEYS.filter((key) => Object.hasOwn(metadataPatch, key));
    if (touched.length > 0) {
      const detail = `An imported Skill's reviewed snapshot cannot be changed (${touched.join(", ")}); import the new package instead`;
      throw new HttpError(422, detail, { detail, code: "imported_skill_snapshot_immutable" });
    }
  }
  const updated = await context.db.query<{ id: string; capability_key: string; status: string }>(
    `UPDATE capability_versions
        SET status = COALESCE($3, status),
            metadata_json = metadata_json || $4::jsonb,
            updated_at = $5
      WHERE id = $1
        AND space_id = $2
      RETURNING id, capability_key, status`,
    [
      versionId,
      context.proposal.space_id,
      status ?? null,
      JSON.stringify(metadataPatch),
      now,
    ],
  );
  const row = updated.rows[0];
  if (!row) throw new HttpError(404, "Capability version not found");
  return {
    result_type: "capability_overlay",
    result: { action: "capability_update", capability_version: row },
    proposalPayloadPatch: {
      ...objectValue(context.proposal.payload_json),
      resulting_capability_version_id: row.id,
      resulting_capability_key: row.capability_key,
      resulting_status: row.status,
    },
  };
}

async function applyCapabilityEnableProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = objectValue(context.proposal.payload_json);
  ensureOperation(payload, "capability_enable");
  const capabilityKey = requiredPayloadString(payload, "capability_key");
  const capabilityVersionId = optionalString(payload.capability_version_id);
  const scope = parseEnablementScope(payload);
  assertEnablementEffectScope(context, scope);
  const config = optionalObject(payload.config_json) ?? {};
  await requireCapabilityTarget(context, capabilityKey, capabilityVersionId);
  const now = new Date().toISOString();
  const updated = await updateEnablement(context, {
    capabilityKey,
    capabilityVersionId,
    scope,
    enabled: true,
    config,
    now,
  });
  if (capabilityVersionId) {
    // Availability is a version lifecycle state, not a Space-wide "current"
    // pointer. Each enablement remains pinned to the version approved for its
    // own scope; enabling one scope must never rewrite another scope.
    await context.db.query(
      `UPDATE capability_versions
          SET status = 'available', updated_at = $3
        WHERE id = $1 AND space_id = $2`,
      [capabilityVersionId, context.proposal.space_id, now],
    );
  }
  return {
    result_type: "capability_overlay",
    result: { action: "capability_enable", capability_enablement: updated },
    proposalPayloadPatch: {
      ...objectValue(context.proposal.payload_json),
      capability_enablement_id: updated.id,
      resulting_capability_key: capabilityKey,
      resulting_enabled: true,
    },
  };
}

async function applyCapabilityDisableProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = objectValue(context.proposal.payload_json);
  ensureOperation(payload, "capability_disable");
  const capabilityKey = requiredPayloadString(payload, "capability_key");
  const capabilityVersionId = optionalString(payload.capability_version_id);
  await requireCapabilityTarget(context, capabilityKey, capabilityVersionId);
  const scope = parseEnablementScope(payload);
  assertEnablementEffectScope(context, scope);
  const now = new Date().toISOString();
  const updated = await updateEnablement(context, {
    capabilityKey,
    capabilityVersionId,
    scope,
    enabled: false,
    config: optionalObject(payload.config_json) ?? {},
    now,
  });
  return {
    result_type: "capability_overlay",
    result: { action: "capability_disable", capability_enablement: updated },
    proposalPayloadPatch: {
      ...objectValue(context.proposal.payload_json),
      capability_enablement_id: updated.id,
      resulting_capability_key: capabilityKey,
      resulting_enabled: false,
    },
  };
}

async function applyRuntimeSkillBindingUpdateProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  if (objectValue(context.proposal.payload_json).operation === "skill_package_binding_update") {
    return applySkillPackageBinding(context);
  }
  const payload = objectValue(context.proposal.payload_json);
  ensureOperation(payload, "runtime_skill_binding_update");
  assertSpaceEffectScope(context);
  const bindingId = requiredPayloadString(payload, "binding_id");
  const enabled = typeof payload.enabled === "boolean" ? payload.enabled : null;
  const bindingJson = optionalObject(payload.binding_json);
  if (enabled === null && bindingJson === null) {
    throw new HttpError(422, "runtime_skill_binding_update requires enabled or binding_json");
  }
  const now = new Date().toISOString();
  const bindingAuthority = await context.db.query<{ capability_key: string }>(
    `SELECT capability_key FROM capability_runtime_bindings
      WHERE id=$1 AND space_id=$2`,
    [bindingId, context.proposal.space_id],
  );
  if (!bindingAuthority.rows[0]) throw new HttpError(404, "Runtime skill binding not found");
  await context.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `runtime-skill-authority:${context.proposal.space_id}:${bindingAuthority.rows[0].capability_key}`,
  ]);
  const rows = await context.db.query<JsonRecord>(
    `UPDATE capability_runtime_bindings
        SET enabled = COALESCE($3, enabled),
            binding_json = COALESCE($4::jsonb, binding_json),
            updated_at = $5
      WHERE id = $1
        AND space_id = $2
      RETURNING id, space_id, capability_key, capability_version_id,
                runtime_key, render_mode, binding_json, enabled`,
    [
      bindingId,
      context.proposal.space_id,
      enabled,
      bindingJson ? JSON.stringify(bindingJson) : null,
      now,
    ],
  );
  const row = rows.rows[0];
  if (!row) throw new HttpError(404, "Runtime skill binding not found");
  return {
    result_type: "capability_overlay",
    result: { action: "runtime_skill_binding_update", runtime_skill_binding: row },
    proposalPayloadPatch: {
      ...objectValue(context.proposal.payload_json),
      runtime_skill_binding_id: bindingId,
      resulting_enabled: row.enabled,
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

interface EnablementScope {
  projectId: string | null;
  agentId: string | null;
  userId: string | null;
}

function parseEnablementScope(payload: JsonRecord): EnablementScope {
  const scope = {
    projectId: optionalString(payload.project_id),
    agentId: optionalString(payload.agent_id),
    userId: optionalString(payload.user_id),
  };
  const count = [scope.projectId, scope.agentId, scope.userId].filter(Boolean).length;
  if (count > 1) {
    throw new HttpError(422, "capability enablement scope must include at most one project_id, agent_id, or user_id");
  }
  return scope;
}

async function requireCapabilityVersion(
  context: ProposalApplyContext,
  capabilityVersionId: string,
  capabilityKey: string | null = null,
): Promise<void> {
  const rows = await context.db.query<{ id: string; capability_key: string }>(
    `SELECT id, capability_key
       FROM capability_versions
      WHERE id = $1
        AND space_id = $2
        AND status <> 'archived'`,
    [capabilityVersionId, context.proposal.space_id],
  );
  const row = rows.rows[0];
  if (!row) throw new HttpError(404, "Capability version not found");
  // The mutation boundary re-verifies the key/version pairing so a malformed
  // proposal cannot write enablement state against a mismatched capability.
  if (capabilityKey !== null && row.capability_key !== capabilityKey) {
    throw new HttpError(422, "capability_version_id does not match capability_key");
  }
}

async function requireCapabilityTarget(
  context: ProposalApplyContext,
  capabilityKey: string,
  capabilityVersionId: string | null,
): Promise<void> {
  if (capabilityVersionId) {
    await requireCapabilityVersion(context, capabilityVersionId, capabilityKey);
    return;
  }
  if (getBuiltInCapabilityDefinition(capabilityKey)) return;
  throw new HttpError(
    422,
    "capability_version_id is required for non-built-in capability enablement",
  );
}

async function updateEnablement(
  context: ProposalApplyContext,
  input: {
    capabilityKey: string;
    capabilityVersionId: string | null;
    scope: EnablementScope;
    enabled: boolean;
    config: JsonRecord;
    now: string;
  },
): Promise<JsonRecord> {
  await context.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `runtime-skill-authority:${context.proposal.space_id}:${input.capabilityKey}`,
  ]);
  const params = [
    context.proposal.space_id,
    input.scope.projectId,
    input.scope.agentId,
    input.scope.userId,
    input.capabilityKey,
    input.capabilityVersionId,
    input.enabled,
    JSON.stringify(input.config),
    input.now,
  ];
  const updated = await context.db.query<JsonRecord>(
    `UPDATE capability_enablements
        SET capability_version_id = $6,
            enabled = $7,
            config_json = $8::jsonb,
            updated_at = $9
      WHERE space_id = $1
        AND capability_key = $5
        AND project_id IS NOT DISTINCT FROM $2
        AND agent_id IS NOT DISTINCT FROM $3
        AND user_id IS NOT DISTINCT FROM $4
      RETURNING id, space_id, project_id, agent_id, user_id, capability_key,
                capability_version_id, enabled, config_json`,
    params,
  );
  if (updated.rows[0]) return updated.rows[0];
  const enablementId = randomUUID();
  const inserted = await context.db.query<JsonRecord>(
    `INSERT INTO capability_enablements (
       id, space_id, project_id, agent_id, user_id, capability_key,
       capability_version_id, enabled, config_json, created_at, updated_at
     ) VALUES (
       $10, $1, $2, $3, $4, $5,
       $6, $7, $8::jsonb, $9, $9
     )
     RETURNING id, space_id, project_id, agent_id, user_id, capability_key,
               capability_version_id, enabled, config_json`,
    [...params, enablementId],
  );
  return inserted.rows[0]!;
}
