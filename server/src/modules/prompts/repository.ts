import { randomUUID } from "node:crypto";
import * as protocol from "@agent-space/protocol";
import { PROMPT_TYPES, PromptAssetContentSchema } from "@agent-space/protocol";
import type { PromptAssetContent, PromptType } from "@agent-space/protocol";
import {
  assertAssetAllowsTargetScope,
  assertCanWriteAssetOwnerScope,
  canReadAssetOwnerScope,
  canViewScopedRef,
  normalizeVersionScopeForWrite,
} from "../evolution/assetAccess.js";
import { EvolvableAssetEvaluationRepository } from "../evolution/assetEvaluationRepository.js";
import { EvolvableAssetRepository } from "../evolution/assetRepository.js";
import { HttpError, objectValue, optionalObject, optionalString, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { sha256Json } from "./hash.js";
import { missingRequiredVariables, renderPromptMessages, renderPromptTemplate } from "./renderer.js";

// Prompt assets are a prompt-specific view over the generic evolvable-asset
// system (asset_type 'prompt_template'). Not every 'prompt_template' asset
// belongs to this view: the generic /api/v1/evolution/assets API lets any
// caller create a 'prompt_template' asset with arbitrary content_json, so an
// asset is only surfaced here once it carries a valid `metadata_json.prompt_type`
// marker (set by the built-in prompt sync or prompt version creation).
const PROMPT_ASSET_TYPE = "prompt_template";

export interface PromptAssetLookupRow extends Record<string, unknown> {
  id: string;
  asset_key: string;
  space_id: string | null;
  owner_scope_type: string;
  owner_scope_id: string | null;
  status: string;
  metadata_json: unknown;
}

export class PromptRepository {
  private readonly assets: EvolvableAssetRepository;
  private readonly evaluations: EvolvableAssetEvaluationRepository;

  constructor(private readonly db: Queryable) {
    this.assets = new EvolvableAssetRepository(db);
    this.evaluations = new EvolvableAssetEvaluationRepository(db);
  }

  async listAssets(
    identity: SpaceUserIdentity,
    filters: { promptType?: string | null },
  ): Promise<Record<string, unknown>[]> {
    const promptTypeFilter = optionalString(filters.promptType);
    if (promptTypeFilter && !isPromptType(PROMPT_TYPES, promptTypeFilter)) {
      throw new HttpError(422, "prompt_type is invalid");
    }
    const rows = (await this.assets.listAssets(identity, { assetType: PROMPT_ASSET_TYPE })) as PromptAssetLookupRow[];
    // Built-in prompt assets are canonical for their key. Space/project/user
    // customization belongs in scoped versions or pins on that asset, not in
    // a same-key asset row. A generic prompt_template row without a valid
    // metadata_json.prompt_type marker must not hide a built-in prompt.
    const byKey = new Map<string, { row: PromptAssetLookupRow; promptType: PromptType }>();
    for (const row of rows) {
      if (row.status !== "active") continue;
      const promptType = promptTypeOf(row, PROMPT_TYPES);
      if (!promptType) continue;
      const existing = byKey.get(row.asset_key);
      if (!existing || (existing.row.space_id !== null && row.space_id === null)) {
        byKey.set(row.asset_key, { row, promptType });
      }
    }
    const out: Record<string, unknown>[] = [];
    for (const { row, promptType } of byKey.values()) {
      if (promptTypeFilter && promptType !== promptTypeFilter) continue;
      out.push(promptAssetSummaryOut(row, promptType));
    }
    out.sort((a, b) => String(a.asset_key).localeCompare(String(b.asset_key)));
    return out;
  }

  async getAsset(identity: SpaceUserIdentity, assetKey: string): Promise<Record<string, unknown>> {
    const { row, promptType } = await this.requirePromptAssetRow(identity, assetKey);
    return promptAssetDetailOut(row, promptType);
  }

  async listVersions(identity: SpaceUserIdentity, assetKey: string): Promise<Record<string, unknown>[]> {
    const { row } = await this.requirePromptAssetRow(identity, assetKey);
    const versions = await this.assets.listVersions(identity, row.id);
    return versions.map(promptVersionOut);
  }

  async createVersion(
    identity: SpaceUserIdentity,
    assetKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { row, promptType } = await this.requireWritablePromptAssetRow(identity, assetKey);
    const content = await this.validatedPromptContent(promptType, body.content_json);
    return this.assets.createVersion(identity, row.id, {
      ...body,
      content_json: content,
      content_hash: optionalString(body.content_hash) ?? sha256Json(content),
    });
  }

  async renderPreview(
    identity: SpaceUserIdentity,
    assetKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { row, promptType } = await this.requirePromptAssetRow(identity, assetKey);
    const versionId = optionalString(body.version_id);
    const content = body.content_json !== undefined
      ? await this.validatedPromptContent(promptType, body.content_json)
      : await this.promptVersionContent(row.id, versionId, promptType);
    const variables = objectValue(body.variables);
    const errors = missingRequiredVariables(content.variables_schema, variables).map((name) => `Missing required variable '${name}'`);
    const warnings: string[] = [];
    let renderedMessages: unknown = null;
    let renderedText: string | null = null;

    if (content.messages && content.messages.length > 0) {
      const rendered = renderPromptMessages(content.messages, variables);
      renderedMessages = rendered.messages;
      for (const name of rendered.missingVariables) {
        if (!errors.includes(`Missing required variable '${name}'`)) warnings.push(`Unresolved variable placeholder '${name}'`);
      }
    } else if (content.template) {
      const rendered = renderPromptTemplate(content.template, variables);
      renderedText = rendered.rendered;
      for (const name of rendered.missingVariables) {
        if (!errors.includes(`Missing required variable '${name}'`)) warnings.push(`Unresolved variable placeholder '${name}'`);
      }
    }

    return {
      asset_key: assetKey,
      version_id: versionId ?? null,
      rendered_messages: renderedMessages,
      rendered_text: renderedText,
      validation_errors: errors,
      validation_warnings: warnings,
    };
  }

  async recordEvaluation(
    identity: SpaceUserIdentity,
    assetKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { row } = await this.requireWritablePromptAssetRow(identity, assetKey);
    const versionId = optionalString(body.version_id);
    if (!versionId) throw new HttpError(422, "version_id is required");
    return this.evaluations.recordEvaluationRun(identity, row.id, versionId, body);
  }

  async createPromotionProposal(
    identity: SpaceUserIdentity,
    assetKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { row } = await this.requireWritablePromptAssetRow(identity, assetKey);
    const versionId = optionalString(body.version_id);
    if (!versionId) throw new HttpError(422, "version_id is required");
    const label = normalizedLabel(optionalString(body.label) ?? "production");
    if (label !== "production") throw new HttpError(422, "Only production promotion requires a proposal; use deployments/:label for staging");
    const scope = await this.normalizedDeploymentScope(identity, row, body);
    return this.evaluations.createPromotionProposal(identity, row.id, versionId, {
      target_scope_type: scope.scopeType,
      target_scope_id: scope.scopeId,
      pin_after_approval: false,
      deprecate_previous: body.deprecate_previous === true,
      evaluation_run_ids: Array.isArray(body.evaluation_run_ids) ? body.evaluation_run_ids : [],
      reason: optionalString(body.reason),
      deployment_label: label,
    });
  }

  async listDeployments(
    identity: SpaceUserIdentity,
    assetKey: string,
    options: { includeHistory?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    const { row } = await this.requirePromptAssetRow(identity, assetKey);
    const statusClause = options.includeHistory ? "" : " AND d.status = 'active'";
    const result = await this.db.query<DeploymentRefRow>(
      `SELECT ${DEPLOYMENT_REF_COLUMNS}
         FROM prompt_deployment_refs d
        WHERE d.asset_id = $1 AND (d.space_id = $2 OR d.space_id IS NULL)${statusClause}
        ORDER BY d.status ASC, d.label ASC, d.scope_type ASC, d.scope_id ASC NULLS FIRST, d.updated_at DESC`,
      [row.id, identity.spaceId],
    );
    const out: Record<string, unknown>[] = [];
    for (const ref of result.rows) {
      if (await canViewScopedRef(this.db, identity, ref.scope_type, ref.scope_id)) out.push(deploymentRefOut(ref));
    }
    return out;
  }

  async setDeployment(
    identity: SpaceUserIdentity,
    assetKey: string,
    label: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { row } = await this.requireWritablePromptAssetRow(identity, assetKey);
    const normalized = normalizedLabel(label);
    const scope = await this.normalizedDeploymentScope(identity, row, body);
    const versionId = optionalString(body.version_id);
    if (!versionId) throw new HttpError(422, "version_id is required");
    const version = await this.versionRow(row.id, versionId);
    if (!version) throw new HttpError(422, "version_id does not reference a version of this prompt asset");
    validateVersionForDeployment(identity, normalized, scope.scopeType, scope.scopeId, version);
    const proposalId = optionalString(body.promoted_from_proposal_id);
    if (normalized === "production") {
      await this.assertAcceptedPromotionProposal(identity, row.id, versionId, scope.scopeType, scope.scopeId, normalized, proposalId);
    }
    return this.insertDeploymentRef(identity, row.id, scope.scopeType, scope.scopeId, normalized, versionId, proposalId);
  }

  async rollbackDeployment(
    identity: SpaceUserIdentity,
    assetKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { row } = await this.requireWritablePromptAssetRow(identity, assetKey);
    const label = normalizedLabel(optionalString(body.label) ?? "production");
    const scope = await this.normalizedDeploymentScope(identity, row, body);
    const explicitVersionId = optionalString(body.version_id);
    const targetVersionId = explicitVersionId
      ?? await this.previousDeploymentVersionId(identity, row.id, scope.scopeType, scope.scopeId, label);
    if (!targetVersionId) throw new HttpError(404, "No previous deployment ref is available for rollback");
    const version = await this.versionRow(row.id, targetVersionId);
    if (!version) throw new HttpError(422, "rollback target version does not reference this prompt asset");
    validateVersionForDeployment(identity, label, scope.scopeType, scope.scopeId, version);
    if (label === "production" && explicitVersionId) {
      await this.assertVersionHasPassedEvaluation(identity, row.id, targetVersionId);
    }
    return this.insertDeploymentRef(identity, row.id, scope.scopeType, scope.scopeId, label, targetVersionId, null);
  }

  private async requirePromptAssetRow(
    identity: SpaceUserIdentity,
    assetKey: string,
  ): Promise<{ row: PromptAssetLookupRow; promptType: PromptType }> {
    const found = await findPromptAssetForKey(this.db, identity, assetKey);
    if (!found) throw new HttpError(404, "Prompt asset not found");
    const row = (await this.assets.getAsset(identity, found.row.id)) as PromptAssetLookupRow;
    const promptType = promptTypeOf(row, protocol.PROMPT_TYPES);
    if (!promptType) throw new HttpError(404, "Prompt asset not found");
    return { row, promptType };
  }

  private async requireWritablePromptAssetRow(
    identity: SpaceUserIdentity,
    assetKey: string,
  ): Promise<{ row: PromptAssetLookupRow; promptType: PromptType }> {
    const found = await findPromptAssetForKey(this.db, identity, assetKey);
    if (!found) throw new HttpError(404, "Prompt asset not found");
    await assertCanWriteAssetOwnerScope(this.db, identity, found.row, "Requires permission to manage this prompt asset");
    return found;
  }

  private async validatedPromptContent(promptType: PromptType, value: unknown): Promise<PromptAssetContent> {
    const content = optionalObject(value);
    if (!content) throw new HttpError(422, "content_json is required");
    const parsed = PromptAssetContentSchema.safeParse(content);
    if (!parsed.success) throw new HttpError(422, "content_json does not match prompt_asset.v1");
    if (parsed.data.prompt_type !== promptType) {
      throw new HttpError(422, `content_json.prompt_type must match asset prompt_type '${promptType}'`);
    }
    return parsed.data;
  }

  private async promptVersionContent(assetId: string, versionId: string | null, promptType: PromptType): Promise<PromptAssetContent> {
    const result = await this.db.query<{ content_json: unknown }>(
      versionId
        ? `SELECT content_json FROM evolvable_asset_versions WHERE asset_id = $1 AND id = $2 LIMIT 1`
        : `SELECT content_json FROM evolvable_asset_versions WHERE asset_id = $1 ORDER BY version DESC LIMIT 1`,
      versionId ? [assetId, versionId] : [assetId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new HttpError(404, versionId ? "Prompt version not found for this asset" : "Prompt asset has no versions");
    }
    return this.validatedPromptContent(promptType, row.content_json);
  }

  private async normalizedDeploymentScope(
    identity: SpaceUserIdentity,
    asset: PromptAssetLookupRow,
    body: Record<string, unknown>,
  ): Promise<{ scopeType: string; scopeId: string | null }> {
    const scopeType = optionalString(body.scope_type) ?? "space";
    const scopeId = await normalizeVersionScopeForWrite(this.db, identity, scopeType, optionalString(body.scope_id));
    assertAssetAllowsTargetScope(asset, identity, scopeType, scopeId);
    return { scopeType, scopeId };
  }

  private async insertDeploymentRef(
    identity: SpaceUserIdentity,
    assetId: string,
    scopeType: string,
    scopeId: string | null,
    label: string,
    versionId: string,
    proposalId: string | null,
  ): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const spaceId = scopeType === "system" ? null : identity.spaceId;
    const existing = await this.db.query<DeploymentRefRow>(
      `SELECT ${DEPLOYMENT_REF_COLUMNS}
         FROM prompt_deployment_refs
        WHERE asset_id = $1
          AND scope_type = $2
          AND scope_id IS NOT DISTINCT FROM $3
          AND label = $4
          AND status = 'active'
          AND space_id IS NOT DISTINCT FROM $5
          AND version_id = $6
        LIMIT 1`,
      [assetId, scopeType, scopeId, label, spaceId, versionId],
    );
    if (existing.rows[0]) return deploymentRefOut(existing.rows[0]);

    await this.db.query(
      `UPDATE prompt_deployment_refs
          SET status = 'archived', updated_at = $6
        WHERE asset_id = $1
          AND scope_type = $2
          AND scope_id IS NOT DISTINCT FROM $3
          AND label = $4
          AND status = 'active'
          AND space_id IS NOT DISTINCT FROM $5`,
      [assetId, scopeType, scopeId, label, spaceId, now],
    );
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO prompt_deployment_refs (
         id, space_id, asset_id, scope_type, scope_id, label, version_id, status,
         promoted_by_user_id, promoted_from_proposal_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $10)`,
      [id, spaceId, assetId, scopeType, scopeId, label, versionId, identity.userId, proposalId, now],
    );
    const result = await this.db.query<DeploymentRefRow>(`SELECT ${DEPLOYMENT_REF_COLUMNS} FROM prompt_deployment_refs WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row) throw new HttpError(500, "Failed to set prompt deployment ref");
    return deploymentRefOut(row);
  }

  private async previousDeploymentVersionId(
    identity: SpaceUserIdentity,
    assetId: string,
    scopeType: string,
    scopeId: string | null,
    label: string,
  ): Promise<string | null> {
    const result = await this.db.query<{ version_id: string }>(
      `SELECT version_id
         FROM prompt_deployment_refs
        WHERE asset_id = $1
          AND scope_type = $2
          AND scope_id IS NOT DISTINCT FROM $3
          AND label = $4
          AND status = 'archived'
          AND space_id IS NOT DISTINCT FROM $5
        ORDER BY updated_at DESC
        LIMIT 1`,
      [assetId, scopeType, scopeId, label, scopeType === "system" ? null : identity.spaceId],
    );
    return result.rows[0]?.version_id ?? null;
  }

  private async versionRow(assetId: string, versionId: string): Promise<PromptVersionRow | null> {
    const result = await this.db.query<PromptVersionRow>(
      `SELECT id, asset_id, space_id, scope_type, scope_id, status FROM evolvable_asset_versions WHERE asset_id = $1 AND id = $2 LIMIT 1`,
      [assetId, versionId],
    );
    return result.rows[0] ?? null;
  }

  private async assertAcceptedPromotionProposal(
    identity: SpaceUserIdentity,
    assetId: string,
    versionId: string,
    scopeType: string,
    scopeId: string | null,
    label: string,
    proposalId: string | null,
  ): Promise<void> {
    if (!proposalId) throw new HttpError(422, "production deployment requires promoted_from_proposal_id");
    const result = await this.db.query<{ payload_json: unknown; status: string }>(
      `SELECT payload_json, status
         FROM proposals
        WHERE id = $1
          AND space_id = $2
          AND proposal_type = 'evolvable_asset_version_promote'
        LIMIT 1`,
      [proposalId, identity.spaceId],
    );
    const proposal = result.rows[0];
    if (!proposal || proposal.status !== "accepted") throw new HttpError(422, "promoted_from_proposal_id must reference an accepted promotion proposal");
    const payload = objectValue(proposal.payload_json);
    if (
      payload.asset_id !== assetId ||
      payload.candidate_version_id !== versionId ||
      payload.target_scope_type !== scopeType ||
      (payload.target_scope_id ?? null) !== scopeId ||
      (payload.deployment_label ?? "production") !== label
    ) {
      throw new HttpError(422, "promoted_from_proposal_id does not match the requested deployment");
    }
  }

  private async assertVersionHasPassedEvaluation(identity: SpaceUserIdentity, assetId: string, versionId: string): Promise<void> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM evolvable_asset_evaluation_runs
        WHERE asset_id = $1 AND candidate_version_id = $2 AND space_id = $3 AND status = 'passed'
        LIMIT 1`,
      [assetId, versionId, identity.spaceId],
    );
    if (!result.rows[0]) throw new HttpError(422, "production rollback requires a passed evaluation for the target version");
  }
}

interface DeploymentRefRow {
  id: string;
  space_id: string | null;
  asset_id: string;
  scope_type: string;
  scope_id: string | null;
  label: string;
  version_id: string;
  status: string;
  promoted_by_user_id: string | null;
  promoted_from_proposal_id: string | null;
  created_at: string;
  updated_at: string;
}

const DEPLOYMENT_REF_COLUMNS = `
  id, space_id, asset_id, scope_type, scope_id, label, version_id, status,
  promoted_by_user_id, promoted_from_proposal_id, created_at, updated_at
`;

interface PromptVersionRow {
  id: string;
  asset_id: string;
  space_id: string | null;
  scope_type: string;
  scope_id: string | null;
  status: string;
}

export async function findPromptAssetForKey(
  db: Queryable,
  identity: SpaceUserIdentity,
  assetKey: string,
): Promise<{ row: PromptAssetLookupRow; promptType: PromptType } | null> {
  const result = await db.query<PromptAssetLookupRow>(
    `SELECT id, space_id, asset_type, asset_key, display_name, description, owner_scope_type, owner_scope_id,
            status, current_system_version_id, default_eval_suite_ref_json, metadata_json, created_at, updated_at
       FROM evolvable_assets
      WHERE asset_key = $1 AND asset_type = $2 AND (space_id = $3 OR space_id IS NULL) AND status = 'active'
      ORDER BY space_id NULLS FIRST`,
    [assetKey, PROMPT_ASSET_TYPE, identity.spaceId],
  );

  for (const row of result.rows) {
    if (!(await canReadAssetOwnerScope(db, identity, row))) continue;
    const promptType = promptTypeOf(row, PROMPT_TYPES);
    if (promptType) return { row, promptType };
  }
  return null;
}

function isPromptType(promptTypes: readonly string[], value: string): value is PromptType {
  return (promptTypes as readonly string[]).includes(value);
}

function promptTypeOf(row: PromptAssetLookupRow, promptTypes: readonly string[]): PromptType | null {
  const metadata = objectValue(row.metadata_json);
  const value = optionalString(metadata.prompt_type);
  return value && isPromptType(promptTypes, value) ? (value as PromptType) : null;
}

function promptAssetSummaryOut(row: PromptAssetLookupRow, promptType: PromptType): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    asset_key: row.asset_key,
    display_name: row.display_name,
    description: row.description,
    prompt_type: promptType,
    status: row.status,
    owner_scope_type: row.owner_scope_type,
    owner_scope_id: row.owner_scope_id,
    current_system_version_id: row.current_system_version_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function promptAssetDetailOut(row: PromptAssetLookupRow, promptType: PromptType): Record<string, unknown> {
  return {
    ...promptAssetSummaryOut(row, promptType),
    metadata_json: objectValue(row.metadata_json),
  };
}

function promptVersionOut(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    asset_id: row.asset_id,
    space_id: row.space_id ?? null,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    parent_version_id: row.parent_version_id,
    version: row.version,
    status: row.status,
    source: row.source,
    content: row.content_json ?? null,
    content_hash: row.content_hash ?? null,
    eval_summary_json: row.eval_summary_json ?? null,
    promotion_proposal_id: row.promotion_proposal_id ?? null,
    created_by_user_id: row.created_by_user_id ?? null,
    approved_by_user_id: row.approved_by_user_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stale_parent: row.stale_parent,
  };
}

function normalizedLabel(label: string | null): string {
  const value = label?.trim();
  if (!value) throw new HttpError(422, "deployment label is required");
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) throw new HttpError(422, "deployment label is invalid");
  return value;
}

function deploymentRefOut(row: DeploymentRefRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    asset_id: row.asset_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    label: row.label,
    version_id: row.version_id,
    status: row.status,
    promoted_by_user_id: row.promoted_by_user_id,
    promoted_from_proposal_id: row.promoted_from_proposal_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateVersionForDeployment(
  identity: SpaceUserIdentity,
  label: string,
  targetScopeType: string,
  targetScopeId: string | null,
  version: PromptVersionRow,
): void {
  const allowedStatuses = label === "production"
    ? new Set(["approved"])
    : new Set(["candidate", "testing", "approved"]);
  if (!allowedStatuses.has(version.status)) {
    throw new HttpError(
      422,
      label === "production"
        ? "production deployment requires an approved version"
        : "staging deployment requires a candidate, testing, or approved version",
    );
  }
  if (version.space_id === null) {
    if (version.scope_type !== "system") throw new HttpError(422, "version_id is not deployable to this scope");
    return;
  }
  if (version.space_id !== identity.spaceId) throw new HttpError(422, "version_id is not visible to this space");
  if (version.scope_type === "system") return;
  if (version.scope_type === "space") {
    if (version.scope_id !== identity.spaceId) throw new HttpError(422, "space-scoped version must belong to the active space");
    return;
  }
  if (version.scope_type === "project" && targetScopeType === "project" && version.scope_id === targetScopeId) return;
  if (version.scope_type === "agent" && targetScopeType === "agent" && version.scope_id === targetScopeId) return;
  if (version.scope_type === "user" && targetScopeType === "user" && version.scope_id === identity.userId && targetScopeId === identity.userId) return;
  throw new HttpError(422, "version_id is not deployable to the requested scope");
}
