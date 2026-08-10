import { randomUUID } from "node:crypto";
import type {
  ProposalApplierRegistry,
  ProposalApplyContext,
  ProposalApplyResult,
} from "../proposals/applierRegistry";
import { HttpError, objectValue, optionalObject, optionalString } from "../routeUtils/common";
import {
  approveSkillImportInTransaction,
  convertSkillPackageToCapabilityInTransaction,
} from "./repository";
import { getBuiltInCapabilityDefinition } from "./registry";

type JsonRecord = Record<string, unknown>;

export function registerCapabilityProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("skill_import_approve", applySkillImportApproveProposal);
  registry.register("capability_install", applyCapabilityInstallProposal);
  registry.register("capability_update", applyCapabilityUpdateProposal);
  registry.register("capability_enable", applyCapabilityEnableProposal);
  registry.register("capability_disable", applyCapabilityDisableProposal);
  registry.register("runtime_skill_binding_update", applyRuntimeSkillBindingUpdateProposal);
}

async function applySkillImportApproveProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = objectValue(context.proposal.payload_json);
  ensureOperation(payload, "skill_import_approve");
  const skillPackageId = requiredPayloadString(payload, "skill_package_id");
  const skillPackage = await approveSkillImportInTransaction({
    db: context.db,
    spaceId: context.proposal.space_id,
    userId: context.userId,
    proposalId: context.proposal.id,
    skillPackageId,
  });
  return {
    result_type: "capability_overlay",
    result: {
      action: "skill_import_approve",
      skill_package: skillPackage,
    },
    proposalPayloadPatch: {
      ...objectValue(context.proposal.payload_json),
      reviewed_skill_package_id: skillPackage.id,
      resulting_status: skillPackage.status,
    },
  };
}

async function applyCapabilityInstallProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = objectValue(context.proposal.payload_json);
  ensureOperation(payload, "install_from_skill_package");
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
  const versionId = requiredPayloadString(payload, "capability_version_id");
  const status = optionalString(payload.status);
  const metadataPatch = optionalObject(payload.metadata_json) ?? {};
  if (status && !["draft", "proposed", "testing", "available", "disabled", "archived"].includes(status)) {
    throw new HttpError(422, "capability_update status is invalid");
  }
  const now = new Date().toISOString();
  const target = await context.db.query<{ id: string; capability_key: string }>(
    `SELECT id, capability_key
       FROM capability_versions
      WHERE id = $1 AND space_id = $2`,
    [versionId, context.proposal.space_id],
  );
  if (!target.rows[0]) throw new HttpError(404, "Capability version not found");
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
  const payload = objectValue(context.proposal.payload_json);
  ensureOperation(payload, "runtime_skill_binding_update");
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
                runtime_adapter_type, render_mode, binding_json, enabled`,
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
