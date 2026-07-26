import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { HttpError, type SpaceUserIdentity } from "../src/modules/routeUtils/common";
import {
  __setCapabilitiesIdentityForTests,
  __setCapabilitiesRepositoryFactoryForTests,
  __setCapabilitiesSkillFetcherForTests,
  __setCapabilitiesWorkflowRunPromptResolverForTests,
} from "../src/modules/capabilities";
import type {
  CapabilityDefinition,
  ProjectWorkflowProfile,
  SkillImportPreview,
} from "../src/modules/capabilities";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setCapabilitiesIdentityForTests(null);
  __setCapabilitiesRepositoryFactoryForTests(null);
  __setCapabilitiesSkillFetcherForTests(null);
  __setCapabilitiesWorkflowRunPromptResolverForTests(null);
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

describe("capabilities routes", () => {
  it("serves built-in packs and workflow templates", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesRepositoryFactoryForTests(() => fakeRepository());
    app = buildServer(config(), { logger: false });

    const packs = await app.inject({ method: "GET", url: "/api/v1/capability-packs" });
    const workflows = await app.inject({ method: "GET", url: "/api/v1/workflow-templates" });

    expect(packs.statusCode).toBe(200);
    expect(packs.json()).toEqual([expect.objectContaining({ id: "research" })]);
    expect(workflows.statusCode).toBe(200);
    expect((workflows.json() as Array<{ id: string }>).map((item) => item.id)).toContain(
      "research.technical_survey",
    );
  });

  it("previews imports without touching persistence", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesRepositoryFactoryForTests(() => {
      throw new Error("repository should not be constructed for preview");
    });
    __setCapabilitiesSkillFetcherForTests(async () => ({
      body: "---\nname: Preview Skill\ndescription: Preview only.\n---\n\nRead sources.",
    }));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/skill-sources/import-preview",
      payload: { url: "https://github.com/org/repo/blob/main/SKILL.md" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      normalized_skill: { name: "Preview Skill" },
      risk_level: "low",
      persistable: true,
    });
    expect(JSON.stringify(res.json())).not.toContain("raw_content");
  });

  it("previews GitHub tree package imports through the route", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesRepositoryFactoryForTests(() => {
      throw new Error("repository should not be constructed for preview");
    });
    const commit = "b".repeat(40);
    __setCapabilitiesSkillFetcherForTests({
      commitResolver: async () => commit,
      packageLister: async () => [
        { path: "skills/demo/SKILL.md", type: "blob", size: 80, sha: "skill-sha" },
        { path: "skills/demo/scripts/check.py", type: "blob", size: 16, sha: "script-sha", mode: "100755" },
      ],
      fetcher: async (url) => {
        if (url.endsWith("/skills/demo/SKILL.md")) {
          return {
            contentType: "text/markdown",
            body: "---\nname: Route Package Skill\ndescription: Preview package.\n---\n\nRead package files.",
          };
        }
        if (url.endsWith("/skills/demo/scripts/check.py")) {
          return { contentType: "text/x-python", body: "print('review')\n" };
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/skill-sources/import-preview",
      payload: { url: "https://github.com/org/repo/tree/main/skills/demo" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      package_root: "skills/demo",
      normalized_skill: { name: "Route Package Skill" },
      package_files: [
        { path: "skills/demo/SKILL.md", kind: "skill_markdown" },
        { path: "skills/demo/scripts/check.py", kind: "script", executable: true },
      ],
    });
    expect(JSON.stringify(res.json())).not.toContain("raw_content");
  });

  it("persists imported skill packages and creates review proposals", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const repo = fakeRepository();
    __setCapabilitiesRepositoryFactoryForTests(() => repo);
    __setCapabilitiesSkillFetcherForTests(async () => ({
      body: "---\nname: Imported Skill\ndescription: Imported safely.\n---\n\nSummarize input.",
    }));
    app = buildServer(config(), { logger: false });

    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/skill-sources/import",
      payload: { url: "https://github.com/org/repo/blob/main/SKILL.md" },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ package_name: "Imported Skill", status: "imported" });

    const review = await app.inject({
      method: "POST",
      url: "/api/v1/skill-packages/package-1/review-proposal",
      payload: {},
    });
    expect(review.statusCode).toBe(201);
    expect(review.json()).toMatchObject({
      proposal_type: "skill_import_approve",
      status: "pending",
    });
  });

  it("creates conversion proposals for reviewed skill packages", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesRepositoryFactoryForTests(() => fakeRepository({ skillStatus: "reviewed" }));
    app = buildServer(config(), { logger: false });

    const converted = await app.inject({
      method: "POST",
      url: "/api/v1/skill-packages/package-1/convert-to-capability",
      payload: {},
    });
    expect(converted.statusCode).toBe(201);
    expect(converted.json()).toMatchObject({
      proposal_type: "capability_install",
      status: "pending",
    });
  });

  it("rejects converting with direct enablement (proposal review required)", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesRepositoryFactoryForTests(() => fakeRepository());
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/skill-packages/package-1/convert-to-capability",
      payload: { enable_for_project_id: "project-1" },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain("capability_enablement_requires_proposal_review");
  });

  it("creates enable and disable proposals for a capability", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesRepositoryFactoryForTests(() => fakeRepository());
    app = buildServer(config(), { logger: false });

    const enable = await app.inject({
      method: "POST",
      url: "/api/v1/capability-definitions/research.source_collect/enable-proposal",
      payload: { project_id: "project-1" },
    });
    expect(enable.statusCode).toBe(201);
    expect(enable.json()).toMatchObject({ proposal_type: "capability_enable", status: "pending" });

    const disable = await app.inject({
      method: "POST",
      url: "/api/v1/capability-definitions/research.source_collect/disable-proposal",
      payload: {},
    });
    expect(disable.statusCode).toBe(201);
    expect(disable.json()).toMatchObject({ proposal_type: "capability_disable", status: "pending" });
  });

  it("creates, lists, updates, and disables project workflow profiles", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const repo = fakeRepository();
    __setCapabilitiesRepositoryFactoryForTests(() => repo);
    app = buildServer(config(), { logger: false });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-profiles",
      payload: {
        workflow_template_id: "research.technical_survey",
        name: "Technical survey",
        config_json: { source_mode: "project_sources" },
      },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-1/workflow-profiles",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const update = await app.inject({
      method: "PATCH",
      url: "/api/v1/projects/project-1/workflow-profiles/profile-1",
      payload: { enabled: false, config_json: { source_mode: "manual_urls" } },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ enabled: false, config_json: { source_mode: "manual_urls" } });

    const disable = await app.inject({
      method: "DELETE",
      url: "/api/v1/projects/project-1/workflow-profiles/profile-1",
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toMatchObject({ enabled: false });
  });

  it("builds a run draft from an enabled project workflow profile", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesWorkflowRunPromptResolverForTests(workflowPromptResolverForTests);
    const repo = fakeRepository();
    __setCapabilitiesRepositoryFactoryForTests(() => repo);
    app = buildServer(config(), { logger: false });

    await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-profiles",
      payload: {
        workflow_template_id: "research.technical_survey",
        name: "Technical survey",
        config_json: { source_mode: "project_sources", query: "LLM eval harnesses" },
      },
    });

    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-profiles/profile-1/run-draft",
      payload: { runtime_profile_id: "runtime-profile-1", project_folder_id: "workspace-1" },
    });

    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({
      workflow_template: { id: "research.technical_survey" },
      workflow_profile: { id: "profile-1" },
      config_json: {
        source_mode: "project_sources",
        query: "LLM eval harnesses",
      },
      run_create_body: {
        mode: "live",
        run_type: "agent",
        trigger_origin: "manual",
        project_id: "project-1",
        project_folder_id: "workspace-1",
        runtime_profile_id: "runtime-profile-1",
        adapter_type: null,
        capability_id: "research.source_collect",
        prompt_asset_key: "workflow.research.technical_survey.run",
        prompt_version_id: "workflow-prompt-version",
        prompt_content_hash: "workflow-prompt-hash",
        capabilities_json: [
          "research.source_collect",
          "research.source_summarize",
          "research.evidence_extract",
          "research.brief_synthesize",
          "research.idea_generate",
        ],
      },
    });
    expect(draft.json().run_create_body.prompt).toContain("LLM eval harnesses");
    expect(draft.json().run_create_body.agent_id).toBeNull();
    expect(draft.json().warnings).toContain(
      "workflow_has_multiple_capabilities_run_create_body_sets_primary_capability_id",
    );
    expect(draft.json().warnings).toContain("agent_required_to_execute_run_draft");

    const narrowedOutputs = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-profiles/profile-1/run-draft",
      payload: {
        runtime_profile_id: "runtime-profile-1",
        config_json: { output_artifact_types: ["research_report.archive.v1"] },
      },
    });

    expect(narrowedOutputs.statusCode).toBe(200);
    expect(narrowedOutputs.json().output_artifact_types).toEqual([
      "research_report.archive.v1",
    ]);
    expect(narrowedOutputs.json().run_create_body.prompt).toContain(
      "- research_report.archive.v1",
    );
  });

  it("builds a run draft directly from a workflow template without saving a preset", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesWorkflowRunPromptResolverForTests(workflowPromptResolverForTests);
    __setCapabilitiesRepositoryFactoryForTests(() => fakeRepository());
    app = buildServer(config(), { logger: false });

    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-templates/research.technical_survey/run-draft",
      payload: {
        agent_id: "agent-1",
        runtime_profile_id: "runtime-profile-1",
        config_json: {
          source_mode: "project_sources",
          query: "LLM eval harnesses",
          output_artifact_types: ["research_report.archive.v1"],
        },
      },
    });

    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({
      workflow_template: { id: "research.technical_survey" },
      workflow_profile: null,
      run_create_body: {
        project_id: "project-1",
        agent_id: "agent-1",
        runtime_profile_id: "runtime-profile-1",
        adapter_type: null,
        capability_id: "research.source_collect",
        capabilities_json: [
          "research.source_collect",
          "research.source_summarize",
          "research.evidence_extract",
          "research.brief_synthesize",
          "research.idea_generate",
        ],
      },
    });
    expect(draft.json().run_create_body.prompt).toContain("Workflow preset: Unsaved run");
    expect(draft.json().run_create_body.prompt).toContain("LLM eval harnesses");
    expect(draft.json().run_create_body.prompt_asset_key).toBe("workflow.research.technical_survey.run");
    expect(draft.json().warnings).not.toContain("agent_required_to_execute_run_draft");
  });

  it("rejects workflow draft output types outside the selected template", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesWorkflowRunPromptResolverForTests(workflowPromptResolverForTests);
    __setCapabilitiesRepositoryFactoryForTests(() => fakeRepository());
    app = buildServer(config(), { logger: false });

    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-templates/research.technical_survey/run-draft",
      payload: {
        config_json: {
          query: "LLM eval harnesses",
          output_artifact_types: ["not_a_research_artifact.v1"],
        },
      },
    });

    expect(draft.statusCode).toBe(422);
    expect(JSON.stringify(draft.json())).toContain("unsupported type");
  });

  it("carries a selected agent into the run draft and rejects unknown fields", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesWorkflowRunPromptResolverForTests(workflowPromptResolverForTests);
    const repo = fakeRepository();
    __setCapabilitiesRepositoryFactoryForTests(() => repo);
    app = buildServer(config(), { logger: false });

    await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-profiles",
      payload: {
        workflow_template_id: "research.technical_survey",
        name: "Technical survey",
        config_json: { source_mode: "project_sources", query: "vector index recall" },
      },
    });

    const withAgent = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-profiles/profile-1/run-draft",
      payload: { agent_id: "agent-1", runtime_profile_id: "runtime-profile-1" },
    });
    expect(withAgent.statusCode).toBe(200);
    expect(withAgent.json().run_create_body.agent_id).toBe("agent-1");
    expect(withAgent.json().run_create_body.runtime_profile_id).toBe("runtime-profile-1");
    expect(withAgent.json().warnings).not.toContain("agent_required_to_execute_run_draft");

    const unknownField = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-profiles/profile-1/run-draft",
      payload: { not_a_real_field: true },
    });
    expect(unknownField.statusCode).toBe(422);

    const invalidOverride = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-profiles/profile-1/run-draft",
      payload: { config_json: { source_mode: "not_a_source_mode" } },
    });
    expect(invalidOverride.statusCode).toBe(422);
  });

  it("rejects invalid workflow templates and hides cross-space profiles", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-2", userId: "user-1" });
    __setCapabilitiesRepositoryFactoryForTests(() => fakeRepository());
    app = buildServer(config(), { logger: false });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/workflow-profiles",
      payload: { workflow_template_id: "nope", name: "Bad" },
    });
    expect(invalid.statusCode).toBe(422);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-1/workflow-profiles",
    });
    expect(list.statusCode).toBe(404);
  });
});

async function workflowPromptResolverForTests(input: {
  template: { id: string; name: string; description: string; capability_ids: string[] };
  profile: ProjectWorkflowProfile | null;
  config: Record<string, unknown>;
  outputArtifactTypes: readonly string[];
}) {
  const query = typeof input.config.query === "string" && input.config.query.trim()
    ? input.config.query.trim()
    : null;
  const sourceMode = typeof input.config.source_mode === "string" && input.config.source_mode.trim()
    ? input.config.source_mode.trim()
    : null;
  const lines = [
    `Workflow: ${input.template.name}`,
    `Workflow template: ${input.template.id}`,
    `Workflow preset: ${input.profile?.name ?? "Unsaved run"}`,
    "",
    input.template.description,
  ];
  if (query) lines.push("", "Research question:", query);
  if (sourceMode) lines.push("", `Source mode: ${sourceMode}`);
  lines.push(
    "",
    "Capabilities:",
    ...input.template.capability_ids.map((id) => `- ${id}`),
    "",
    "Expected outputs:",
    ...input.outputArtifactTypes.map((artifactType) => `- ${artifactType}`),
    "",
    "Use the workflow template and saved preset/request configuration as the run contract. Persist durable memory changes through proposals only.",
  );
  const prompt = lines.join("\n");
  return {
    prompt,
    resolveResult: {
      asset_key: `workflow.${input.template.id}.run`,
      version_id: "workflow-prompt-version",
      content_hash: "workflow-prompt-hash",
      scope_type: "system",
      scope_id: null,
      resolution_trace: ["system_baseline"],
      fallback_reason: null,
      rendered_messages: null,
      rendered_text: prompt,
      rendered_hash: "rendered-hash",
      validation_warnings: [],
      validation_errors: [],
    },
  } as never;
}

function proposalOut(id: string, identity: SpaceUserIdentity, proposalType: string) {
  return {
    id,
    space_id: identity.spaceId,
    user_id: identity.userId,
    project_folder_id: null,
    source_session_id: null,
    source_task_id: null,
    source_run_id: null,
    created_by_run_id: null,
    proposal_type: proposalType,
    target_scope: "space",
    target_namespace: "capabilities",
    memory_type: "system",
    proposed_title: proposalType,
    proposed_content: "",
    rationale: "test proposal",
    status: "pending",
    risk_level: proposalType === "skill_import_approve" ? "medium" : "high",
    urgency: "normal",
    visibility: "space_shared",
    preview: false,
    review_deadline: null,
    expires_at: null,
    expired: false,
    created_at: "2026-06-20T00:00:00.000Z",
    decided_at: null,
    resulting_memory_id: null,
    owner_user_id: null,
    subject_user_id: null,
    sensitivity_level: null,
    access_level: "full",
    provenance_entries: null,
    source_activity_id: null,
    grant_id: null,
    required_approver_user_id: null,
    requires_approval_type: null,
    egress_approval_status: null,
    egress_approval_id: null,
    project_id: null,
  };
}

function optionalEnablement(body: Record<string, unknown>): boolean {
  return typeof body.enable_for_project_id === "string" && body.enable_for_project_id.length > 0;
}

function fakeRepository(options: { skillStatus?: string } = {}) {
  const profiles: ProjectWorkflowProfile[] = [];
  const importedPackage = {
    id: "package-1",
    source_id: "source-1",
    package_name: "Imported Skill",
    version: "0.1.0",
    license: null,
    raw_storage_ref: null,
    manifest_json: {},
    normalized_json: {
      name: "Imported Skill",
      description: "Imported safely.",
      version: "0.1.0",
      license: null,
      instructions_markdown: "Summarize input.",
      resources: [],
      requested_permissions: [],
      execution_profile: {},
      vendor_extensions: {},
      trust_analysis: {},
    },
    risk_level: "low",
    status: options.skillStatus ?? "imported",
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
  };

  function requireSpace(identity: SpaceUserIdentity) {
    if (identity.spaceId !== "space-1") throw new HttpError(404, "Project not found");
  }

  return {
    async listConvertedCapabilityDefinitions() {
      return [] satisfies CapabilityDefinition[];
    },
    async listSkillPackages() {
      return { items: [importedPackage], total: 1, limit: 50, offset: 0 };
    },
    async getSkillPackage() {
      return importedPackage;
    },
    async saveImportedSkill(_identity: SpaceUserIdentity, preview: SkillImportPreview) {
      return { ...importedPackage, package_name: preview.normalized_skill.name };
    },
    async createSkillImportApprovalProposal(input: {
      identity: SpaceUserIdentity;
      skillPackageId: string;
    }) {
      requireSpace(input.identity);
      return proposalOut("review-proposal-1", input.identity, "skill_import_approve");
    },
    async createSkillConversionProposal(input: {
      identity: SpaceUserIdentity;
      skillPackageId: string;
      body: Record<string, unknown>;
    }) {
      requireSpace(input.identity);
      if (optionalEnablement(input.body)) {
        throw new HttpError(422, "capability_enablement_requires_proposal_review");
      }
      if (importedPackage.status !== "reviewed") {
        throw new HttpError(409, "Skill package must be reviewed before conversion");
      }
      return proposalOut("convert-proposal-1", input.identity, "capability_install");
    },
    async createCapabilityEnablementProposal(input: {
      identity: SpaceUserIdentity;
      capabilityKey: string;
      enabled: boolean;
      body: Record<string, unknown>;
    }) {
      requireSpace(input.identity);
      const proposalType = input.enabled ? "capability_enable" : "capability_disable";
      return proposalOut(`${proposalType}-proposal-1`, input.identity, proposalType);
    },
    async listWorkflowProfiles(identity: SpaceUserIdentity) {
      requireSpace(identity);
      return profiles;
    },
    async requireWorkflowProject(identity: SpaceUserIdentity) {
      requireSpace(identity);
    },
    async getWorkflowProfile(
      identity: SpaceUserIdentity,
      _projectId: string,
      profileId: string,
    ) {
      requireSpace(identity);
      return profiles.find((profile) => profile.id === profileId) ?? null;
    },
    async createWorkflowProfile(
      identity: SpaceUserIdentity,
      projectId: string,
      body: Record<string, unknown>,
    ) {
      requireSpace(identity);
      const profile: ProjectWorkflowProfile = {
        id: "profile-1",
        space_id: identity.spaceId,
        project_id: projectId,
        workflow_template_id: String(body.workflow_template_id),
        name: String(body.name),
        enabled: true,
        config_json: (body.config_json as Record<string, unknown>) ?? {},
        created_by_user_id: identity.userId,
        created_at: "2026-06-20T00:00:00.000Z",
        updated_at: "2026-06-20T00:00:00.000Z",
      };
      profiles.splice(0, profiles.length, profile);
      return profile;
    },
    async updateWorkflowProfile(
      identity: SpaceUserIdentity,
      _projectId: string,
      _profileId: string,
      body: Record<string, unknown>,
    ) {
      requireSpace(identity);
      const current = profiles[0]!;
      const updated = {
        ...current,
        enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
        config_json: (body.config_json as Record<string, unknown>) ?? current.config_json,
        updated_at: "2026-06-20T00:01:00.000Z",
      };
      profiles.splice(0, profiles.length, updated);
      return updated;
    },
    async disableWorkflowProfile(identity: SpaceUserIdentity) {
      requireSpace(identity);
      const current = profiles[0]!;
      const updated = { ...current, enabled: false };
      profiles.splice(0, profiles.length, updated);
      return updated;
    },
  } as never;
}
