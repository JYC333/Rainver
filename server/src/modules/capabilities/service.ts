import { HttpError, optionalObject, optionalString, requiredString, type SpaceUserIdentity } from "../routeUtils/common";
import { loadProtocol } from "../providers/protocolRuntime";
import { getBuiltInCapabilityPack, listBuiltInCapabilityPacks } from "./packRegistry";
import { getBuiltInCapabilityDefinition, listBuiltInCapabilityDefinitions } from "./registry";
import { previewSkillImport, type SkillFetcher, type SkillImportOptions } from "./skillImporter";
import { getBuiltInWorkflowTemplate, listBuiltInWorkflowTemplates } from "./workflowRegistry";
import type { PgCapabilitiesRepository } from "./repository";
import type {
  CapabilityDefinition,
  ProjectWorkflowProfile,
  WorkflowRunDraft,
  WorkflowTemplate,
} from "./types";
import {
  workflowRunPromptResolver,
  type ResolvedWorkflowRunPrompt,
  type WorkflowRunPromptResolver,
} from "./workflowPrompts";

export class CapabilitiesService {
  constructor(
    private readonly repository: PgCapabilitiesRepository,
    private readonly importOptions?: SkillFetcher | SkillImportOptions,
    private readonly runPromptResolver?: WorkflowRunPromptResolver,
  ) {}

  async listCapabilityDefinitions(identity: SpaceUserIdentity): Promise<CapabilityDefinition[]> {
    const imported = await this.repository.listConvertedCapabilityDefinitions(identity);
    return [...listBuiltInCapabilityDefinitions(), ...imported].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  async getCapabilityDefinition(
    identity: SpaceUserIdentity,
    capabilityId: string,
  ): Promise<CapabilityDefinition | null> {
    return (
      getBuiltInCapabilityDefinition(capabilityId) ??
      (await this.repository.listConvertedCapabilityDefinitions(identity)).find(
        (capability) => capability.id === capabilityId,
      ) ??
      null
    );
  }

  listCapabilityPacks() {
    return listBuiltInCapabilityPacks();
  }

  getCapabilityPack(packId: string) {
    return getBuiltInCapabilityPack(packId);
  }

  listWorkflowTemplates(): WorkflowTemplate[] {
    return listBuiltInWorkflowTemplates();
  }

  getWorkflowTemplate(workflowTemplateId: string): WorkflowTemplate | null {
    return getBuiltInWorkflowTemplate(workflowTemplateId);
  }

  async previewSkillImport(body: Record<string, unknown>) {
    return previewSkillImport(
      {
        url: requiredString(body.url, "url"),
        source_type: optionalString(body.source_type) as never,
      },
      this.importOptions,
    );
  }

  async importSkill(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const preview = await this.previewSkillImport(body);
    return this.repository.saveImportedSkill(identity, preview);
  }

  async createSkillReviewProposal(
    identity: SpaceUserIdentity,
    skillPackageId: string,
  ) {
    return this.repository.createSkillImportApprovalProposal({
      identity,
      skillPackageId,
    });
  }

  async convertSkillToCapability(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    body: Record<string, unknown>,
  ) {
    // Enablement mutates active runtime behavior and must go through proposal
    // review (ADR 0009). Conversion only ever produces a disabled draft.
    if (optionalString(body.enable_for_project_id)) {
      throw new HttpError(422, "capability_enablement_requires_proposal_review");
    }
    return this.repository.createSkillConversionProposal({
      identity,
      skillPackageId,
      body,
    });
  }

  async createCapabilityEnableProposal(
    identity: SpaceUserIdentity,
    capabilityId: string,
    body: Record<string, unknown>,
  ) {
    return this.repository.createCapabilityEnablementProposal({
      identity,
      capabilityKey: capabilityId,
      enabled: true,
      body,
    });
  }

  async createCapabilityDisableProposal(
    identity: SpaceUserIdentity,
    capabilityId: string,
    body: Record<string, unknown>,
  ) {
    return this.repository.createCapabilityEnablementProposal({
      identity,
      capabilityKey: capabilityId,
      enabled: false,
      body,
    });
  }

  listSkillPackages(identity: SpaceUserIdentity, filters: { limit: number; offset: number }) {
    return this.repository.listSkillPackages(identity, filters);
  }

  getSkillPackage(identity: SpaceUserIdentity, skillPackageId: string) {
    return this.repository.getSkillPackage(identity, skillPackageId);
  }

  listSkillLibraryIndex(identity: SpaceUserIdentity) {
    return this.repository.listSkillLibraryIndex(identity);
  }

  getSkillLocalOverlay(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    query: Record<string, unknown>,
  ) {
    return this.repository.getSkillLocalOverlay(identity, skillPackageId, {
      scope_type: optionalString(query.scope_type),
      scope_id: optionalString(query.scope_id),
    });
  }

  upsertSkillLocalOverlay(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    body: Record<string, unknown>,
  ) {
    assertNoEmbeddedOverlaySecrets(body.overlay_json);
    return this.repository.upsertSkillLocalOverlay(identity, skillPackageId, body as never);
  }

  async listWorkflowProfiles(identity: SpaceUserIdentity, projectId: string) {
    return this.repository.listWorkflowProfiles(identity, projectId);
  }

  async createWorkflowProfile(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ) {
    this.requireWorkflowTemplate(body.workflow_template_id);
    return this.repository.createWorkflowProfile(identity, projectId, {
      ...body,
      config_json: normalizeWorkflowProfileConfig(body.config_json),
    });
  }

  async updateWorkflowProfile(
    identity: SpaceUserIdentity,
    projectId: string,
    profileId: string,
    body: Record<string, unknown>,
  ) {
    return this.repository.updateWorkflowProfile(identity, projectId, profileId, {
      ...body,
      config_json:
        body.config_json === undefined ? undefined : normalizeWorkflowProfileConfig(body.config_json),
    });
  }

  async disableWorkflowProfile(
    identity: SpaceUserIdentity,
    projectId: string,
    profileId: string,
  ) {
    return this.repository.disableWorkflowProfile(identity, projectId, profileId);
  }

  async buildWorkflowRunInputDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    profileId: string,
    body: Record<string, unknown> = {},
  ): Promise<WorkflowRunDraft> {
    const request = await parseWorkflowRunDraftRequest(body);
    const profile = await this.repository.getWorkflowProfile(identity, projectId, profileId);
    if (!profile) throw new HttpError(404, "Workflow profile not found");
    if (!profile.enabled) throw new HttpError(409, "Workflow profile is disabled");
    const template = this.getWorkflowTemplate(profile.workflow_template_id);
    if (!template) throw new HttpError(422, "invalid workflow_template_id");
    const requestConfig =
      request.config_json === undefined ? {} : normalizeWorkflowProfileConfig(request.config_json);
    return buildWorkflowRunDraft({
      identity,
      projectId,
      template,
      profile,
      request,
      requestConfig,
      runPromptResolver: this.resolveWorkflowRunPrompt(),
    });
  }

  async buildWorkflowTemplateRunInputDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowTemplateId: string,
    body: Record<string, unknown> = {},
  ): Promise<WorkflowRunDraft> {
    const request = await parseWorkflowRunDraftRequest(body);
    await this.repository.requireWorkflowProject(identity, projectId);
    const template = this.getWorkflowTemplate(workflowTemplateId);
    if (!template) throw new HttpError(404, "Workflow template not found");
    const requestConfig =
      request.config_json === undefined ? {} : normalizeWorkflowProfileConfig(request.config_json);
    return buildWorkflowRunDraft({
      identity,
      projectId,
      template,
      profile: null,
      request,
      requestConfig,
      runPromptResolver: this.resolveWorkflowRunPrompt(),
    });
  }

  private requireWorkflowTemplate(value: unknown): void {
    const id = requiredString(value, "workflow_template_id");
    if (!getBuiltInWorkflowTemplate(id)) throw new HttpError(422, "invalid workflow_template_id");
  }

  private resolveWorkflowRunPrompt(): WorkflowRunPromptResolver {
    return this.runPromptResolver ?? workflowRunPromptResolver(this.repository.queryable());
  }
}

async function parseWorkflowRunDraftRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Enforce the declared strict request contract so unknown fields are
  // rejected instead of silently ignored.
  const protocol = await loadProtocol();
  const validation = protocol.WorkflowRunDraftRequestSchema.safeParse(body);
  if (!validation.success) {
    throw new HttpError(422, validation.error.issues[0]?.message ?? "invalid run-draft request body");
  }
  return validation.data as Record<string, unknown>;
}

async function buildWorkflowRunDraft(input: {
  identity: SpaceUserIdentity;
  projectId: string;
  template: WorkflowTemplate;
  profile: ProjectWorkflowProfile | null;
  request: Record<string, unknown>;
  requestConfig: Record<string, unknown>;
  runPromptResolver: WorkflowRunPromptResolver;
}): Promise<WorkflowRunDraft> {
  const { identity, projectId, template, profile, request, requestConfig } = input;
  const config = {
    ...template.default_config_json,
    ...(profile?.config_json ?? {}),
    ...requestConfig,
  };
  const outputArtifactTypes = arrayOfStrings(config.output_artifact_types);
  validateOutputArtifactTypes(template, outputArtifactTypes);
  const effectiveOutputArtifactTypes =
    outputArtifactTypes.length > 0 ? outputArtifactTypes : template.output_artifact_types;
  const capabilityId = template.capability_ids[0] ?? null;
  const agentId = optionalString(request.agent_id);
  const runtimeProfileId = optionalString(request.runtime_profile_id);
  const warnings: string[] = [];
  if (template.capability_ids.length > 1) {
    warnings.push("workflow_has_multiple_capabilities_run_create_body_sets_primary_capability_id");
  }
  if (!agentId) {
    // A workflow preset does not bind an agent. Without one the draft is not
    // directly executable: the caller must pick an agent and POST to
    // /api/v1/agents/:agentId/runs.
    warnings.push("agent_required_to_execute_run_draft");
  }
  if (!optionalString(request.prompt) && !optionalString(config.query)) {
    warnings.push("workflow_query_missing");
  }
  const requestPrompt = optionalString(request.prompt);
  const resolvedPrompt = requestPrompt
    ? null
    : await input.runPromptResolver({
        identity,
        projectId,
        template,
        profile,
        config,
        outputArtifactTypes: effectiveOutputArtifactTypes,
      });
  if (!requestPrompt && !resolvedPrompt) {
    throw new HttpError(500, "Workflow run prompt is not resolvable");
  }
  const prompt = requestPrompt ?? resolvedPrompt!.prompt;
  const promptRef = promptReference(resolvedPrompt);
  return {
    workflow_template: template,
    workflow_profile: profile,
    capability_ids: template.capability_ids,
    config_json: config,
    output_artifact_types: effectiveOutputArtifactTypes,
    run_create_body: {
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      project_id: projectId,
      workflow_template_id: template.id,
      workflow_config_json: config,
      agent_id: agentId ?? null,
      runtime_profile_id: runtimeProfileId,
      project_folder_id: optionalString(request.project_folder_id),
      session_id: optionalString(request.session_id),
      prompt,
      instruction: optionalString(request.instruction),
      adapter_type: null,
      capability_id: capabilityId,
      capabilities_json: template.capability_ids,
      model_provider_id: null,
      model: null,
      prompt_asset_key: promptRef.assetKey,
      prompt_version_id: promptRef.versionId,
      prompt_content_hash: promptRef.contentHash,
    },
    warnings,
  };
}

function normalizeWorkflowProfileConfig(value: unknown): Record<string, unknown> {
  const config = optionalObject(value) ?? {};
  const sourceMode = optionalString(config.source_mode);
  if (sourceMode && !["runtime_native", "project_sources", "manual_urls"].includes(sourceMode)) {
    throw new HttpError(422, "source_mode is invalid");
  }
  const outputArtifactTypes = config.output_artifact_types;
  if (
    outputArtifactTypes !== undefined &&
    (!Array.isArray(outputArtifactTypes) ||
      outputArtifactTypes.some((item) => typeof item !== "string"))
  ) {
    throw new HttpError(422, "output_artifact_types must be strings");
  }
  return config;
}

function assertNoEmbeddedOverlaySecrets(value: unknown): void {
  const record = optionalObject(value);
  if (!record) return;
  const stack: Record<string, unknown>[] = [record];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const [key, item] of Object.entries(current)) {
      if (/^(api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token)$/i.test(key)) {
        throw new HttpError(422, "skill overlay must reference credentials instead of embedding secrets");
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        stack.push(item as Record<string, unknown>);
      }
    }
  }
}

function validateOutputArtifactTypes(
  template: WorkflowTemplate,
  outputArtifactTypes: string[],
): void {
  const allowed = new Set(template.output_artifact_types);
  const invalid = outputArtifactTypes.find((artifactType) => !allowed.has(artifactType));
  if (invalid) {
    throw new HttpError(
      422,
      `output_artifact_types contains unsupported type ${JSON.stringify(invalid)}`,
    );
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function promptReference(
  resolvedPrompt: ResolvedWorkflowRunPrompt | null,
): { assetKey: string | null; versionId: string | null; contentHash: string | null } {
  if (!resolvedPrompt) return { assetKey: null, versionId: null, contentHash: null };
  return {
    assetKey: resolvedPrompt.resolveResult.asset_key,
    versionId: resolvedPrompt.resolveResult.version_id,
    contentHash: resolvedPrompt.resolveResult.content_hash,
  };
}
