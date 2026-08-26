import { randomUUID } from "node:crypto";
import * as protocol from "@agent-space/protocol";
import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import { HttpError } from "../routeUtils/common.js";
import { normalizeAssetOwnerScopeForCreate } from "./assetAccess.js";

interface WorkflowSavePayload {
  asset_key: string;
  display_name: string;
  description: string;
  content_json: Record<string, unknown>;
  content_hash: string;
}

export function registerWorkflowSaveProposalApplier(registry: ProposalApplierRegistry): void {
  registry.register("workflow_save", applyWorkflowSaveProposal);
}

async function applyWorkflowSaveProposal(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json as unknown as WorkflowSavePayload;
  const definition = protocol.WorkflowDefinitionSchema.parse(payload.content_json);
  const existing = await context.db.query<{ id: string }>(
    `SELECT id FROM evolvable_assets WHERE space_id = $1 AND asset_key = $2 LIMIT 1`,
    [context.proposal.space_id, payload.asset_key],
  );
  if (existing.rows[0]) throw new HttpError(409, "asset_key is already in use in this space");
  const owner = await normalizeAssetOwnerScopeForCreate(
    context.db,
    { spaceId: context.proposal.space_id, userId: context.userId },
    "space",
    null,
  );
  const now = new Date().toISOString();
  const assetId = randomUUID();
  const versionId = randomUUID();
  await context.db.query(
    `INSERT INTO evolvable_assets (
       id, space_id, asset_type, asset_key, display_name, description,
       owner_scope_type, owner_scope_id, status, metadata_json, created_at, updated_at
     ) VALUES ($1, $2, 'workflow_template', $3, $4, $5, $6, $7, 'active', $8::jsonb, $9, $9)`,
    [assetId, context.proposal.space_id, payload.asset_key, payload.display_name, payload.description, owner.ownerScopeType, owner.ownerScopeId, JSON.stringify({ source: "run_extraction", proposal_id: context.proposal.id }), now],
  );
  await context.db.query(
    `INSERT INTO evolvable_asset_versions (
       id, asset_id, space_id, scope_type, scope_id, version, status, source,
       content_hash, content_json, created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 'space', $3, 1, 'draft', 'generated', $4, $5::jsonb, $6, $7, $7)`,
    [versionId, assetId, context.proposal.space_id, payload.content_hash, JSON.stringify(definition), context.userId, now],
  );
  return {
    result_type: "evolvable_asset_version",
    result: { asset_id: assetId, version_id: versionId, status: "draft", asset_key: payload.asset_key },
    proposalPayloadPatch: { asset_id: assetId, version_id: versionId, applied_by_user_id: context.userId },
  };
}
