import type { PromptResolveResult } from "@rainver/protocol";
import { PromptAssetContentSchema } from "@rainver/protocol";
import { assetAllowsUserScope } from "../evolution/assetAccess.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { sha256, sha256Json } from "./hash.js";
import { missingRequiredVariables, renderPromptMessages, renderPromptTemplate } from "./renderer.js";
import { findPromptAssetForKey } from "./repository.js";

export interface ResolvePromptInput {
  spaceId: string;
  assetKey: string;
  projectId?: string | null;
  userId: string;
  agentId?: string | null;
  explicitVersionId?: string | null;
  allowUserPin?: boolean;
  label?: string | null;
  variables?: Record<string, unknown>;
}

/**
 * The single runtime prompt resolver: explicit version first, then labeled
 * prompt deployment refs in project -> agent -> user (opt-in) -> space ->
 * system order. Runtime calls default to the production label.
 */
export async function resolvePrompt(db: Queryable, input: ResolvePromptInput): Promise<PromptResolveResult> {
  const promptAsset = await findPromptAssetForKey(db, { spaceId: input.spaceId, userId: input.userId }, input.assetKey);
  if (!promptAsset) throw new HttpError(404, `No active prompt asset registered for asset_key '${input.assetKey}'`);
  const label = normalizedLabel(input.label ?? "production");
  if (input.allowUserPin && !input.userId) throw new HttpError(422, "allowUserPin requires userId");
  const allowUserDeployment = Boolean(input.allowUserPin && input.userId && assetAllowsUserScope(promptAsset.row, input.userId));
  if (input.allowUserPin && input.userId && !allowUserDeployment) {
    throw new HttpError(403, "User-scoped prompt deployments are not allowed for this asset");
  }

  const resolved = input.explicitVersionId
    ? await resolveExplicitVersion(db, promptAsset.row.id, input.explicitVersionId, input)
    : await resolveViaDeploymentRefs(db, promptAsset.row.id, label, input, allowUserDeployment);

  const { scopeType, scopeId } = resolved;
  const variables = input.variables ?? {};
  const validationErrors: string[] = [];
  const validationWarnings: string[] = [];
  let renderedMessages: PromptResolveResult["rendered_messages"] = null;
  let renderedText: PromptResolveResult["rendered_text"] = null;
  let renderedHash: string | null = null;

  const parsedContent = PromptAssetContentSchema.safeParse(resolved.contentJson);
  if (!parsedContent.success) {
    validationErrors.push("Resolved prompt version content does not match the prompt_asset.v1 schema");
  } else {
    const content = parsedContent.data;
    if (content.prompt_type !== promptAsset.promptType) {
      validationErrors.push(
        `Resolved prompt version prompt_type '${content.prompt_type}' does not match asset prompt_type '${promptAsset.promptType}'`,
      );
    }
    const missingRequired = new Set(missingRequiredVariables(content.variables_schema, variables));
    for (const name of missingRequired) validationErrors.push(`Missing required variable '${name}'`);

    if (content.messages && content.messages.length > 0) {
      const rendered = renderPromptMessages(content.messages, variables);
      renderedMessages = rendered.messages;
      renderedHash = sha256Json(rendered.messages);
      for (const name of rendered.missingVariables) {
        if (!missingRequired.has(name)) validationWarnings.push(`Unresolved variable placeholder '${name}'`);
      }
    } else if (content.template) {
      const rendered = renderPromptTemplate(content.template, variables);
      renderedText = rendered.rendered;
      renderedHash = sha256(rendered.rendered);
      for (const name of rendered.missingVariables) {
        if (!missingRequired.has(name)) validationWarnings.push(`Unresolved variable placeholder '${name}'`);
      }
    } else {
      validationWarnings.push("Prompt version content has neither messages nor a template to render");
    }
  }

  return {
    asset_key: input.assetKey,
    version_id: resolved.versionId,
    content_hash: resolved.contentHash,
    scope_type: scopeType,
    scope_id: scopeId,
    resolution_trace: resolved.resolutionTrace,
    fallback_reason: resolved.fallbackReason,
    rendered_messages: renderedMessages,
    rendered_text: renderedText,
    rendered_hash: renderedHash,
    validation_warnings: validationWarnings,
    validation_errors: validationErrors,
  };
}

interface ResolvedPromptVersionRow {
  versionId: string;
  contentHash: string | null;
  contentJson: unknown;
  scopeType: PromptResolveResult["scope_type"];
  scopeId: string | null;
  resolutionTrace: string[];
  fallbackReason: string | null;
}

interface VersionContentRow {
  id: string;
  space_id: string | null;
  scope_type: string;
  scope_id: string | null;
  content_hash: string | null;
  content_json: unknown;
  status: string;
}

async function resolveExplicitVersion(
  db: Queryable,
  assetId: string,
  versionId: string,
  input: ResolvePromptInput,
): Promise<ResolvedPromptVersionRow> {
  const version = await versionContent(db, assetId, versionId, { approvedOnly: true });
  if (!version) throw new HttpError(422, "explicit_version_id must reference an approved version of this prompt asset");
  if (!canUseVersionForResolution(version, input, Boolean(input.allowUserPin))) {
    throw new HttpError(422, "explicit_version_id must reference an approved version visible to this resolution scope");
  }
  return resolved(version, [`explicit_override:${version.id}`], null);
}

async function resolveViaDeploymentRefs(
  db: Queryable,
  assetId: string,
  label: string,
  input: ResolvePromptInput,
  allowUserDeployment: boolean,
): Promise<ResolvedPromptVersionRow> {
  const attempts: Array<{ scopeType: "project" | "agent" | "user" | "space" | "system"; scopeId: string | null }> = [];
  if (input.projectId) attempts.push({ scopeType: "project", scopeId: input.projectId });
  if (input.agentId) attempts.push({ scopeType: "agent", scopeId: input.agentId });
  if (allowUserDeployment && input.userId) attempts.push({ scopeType: "user", scopeId: input.userId });
  attempts.push({ scopeType: "space", scopeId: input.spaceId });
  attempts.push({ scopeType: "system", scopeId: null });

  for (const attempt of attempts) {
    const ref = await db.query<{ version_id: string }>(
      `SELECT version_id
         FROM prompt_deployment_refs
        WHERE asset_id = $1
          AND label = $2
          AND scope_type = $3
          AND scope_id IS NOT DISTINCT FROM $4
          AND status = 'active'
          AND (space_id = $5 OR space_id IS NULL)
        ORDER BY updated_at DESC
        LIMIT 1`,
      [assetId, label, attempt.scopeType, attempt.scopeId, input.spaceId],
    );
    const versionId = ref.rows[0]?.version_id;
    if (!versionId) continue;
    const version = await versionContent(db, assetId, versionId, { approvedOnly: label === "production" });
    if (!version || !canUseVersionForResolution(version, input, allowUserDeployment)) {
      throw new HttpError(422, `Active ${label} ${attempt.scopeType} deployment references a missing, non-approved, or non-visible prompt version`);
    }
    return resolved(version, [`${label}:${attempt.scopeType}:${version.id}`], null);
  }

  throw new HttpError(404, `No '${label}' deployment ref is visible for prompt asset '${input.assetKey}'`);
}

async function versionContent(
  db: Queryable,
  assetId: string,
  versionId: string,
  options: { approvedOnly?: boolean } = {},
): Promise<VersionContentRow | null> {
  const approvedClause = options.approvedOnly ? " AND status = 'approved'" : "";
  const result = await db.query<VersionContentRow>(
    `SELECT id, space_id, scope_type, scope_id, content_hash, content_json, status
       FROM evolvable_asset_versions
      WHERE asset_id = $1 AND id = $2${approvedClause}
      LIMIT 1`,
    [assetId, versionId],
  );
  return result.rows[0] ?? null;
}

function canUseVersionForResolution(
  version: VersionContentRow,
  input: ResolvePromptInput,
  allowUserDeployment: boolean,
): boolean {
  if (version.space_id === null) return version.scope_type === "system";
  if (version.space_id !== input.spaceId) return false;
  if (version.scope_type === "system") return true;
  if (version.scope_type === "space") return version.scope_id === input.spaceId;
  if (version.scope_type === "project") return Boolean(input.projectId && version.scope_id === input.projectId);
  if (version.scope_type === "agent") return Boolean(input.agentId && version.scope_id === input.agentId);
  if (version.scope_type === "user") return Boolean(allowUserDeployment && input.userId && version.scope_id === input.userId);
  return false;
}

function resolved(
  version: VersionContentRow,
  trace: string[],
  fallbackReason: string | null,
): ResolvedPromptVersionRow {
  return {
    versionId: version.id,
    contentHash: version.content_hash,
    contentJson: version.content_json ?? null,
    scopeType: version.scope_type as PromptResolveResult["scope_type"],
    scopeId: version.scope_id,
    resolutionTrace: trace,
    fallbackReason,
  };
}

function normalizedLabel(label: string): string {
  const value = label.trim();
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) throw new HttpError(422, "prompt deployment label is invalid");
  return value;
}
