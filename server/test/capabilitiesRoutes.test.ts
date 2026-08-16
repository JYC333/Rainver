import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { HttpError, type SpaceUserIdentity } from "../src/modules/routeUtils/common";
import {
  __setCapabilitiesIdentityForTests,
  __setCapabilitiesRepositoryFactoryForTests,
  __setCapabilitiesSkillFetcherForTests,
} from "../src/modules/capabilities";
import type {
  CapabilityDefinition,
  SkillImportPreview,
} from "../src/modules/capabilities";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setCapabilitiesIdentityForTests(null);
  __setCapabilitiesRepositoryFactoryForTests(null);
  __setCapabilitiesSkillFetcherForTests(null);
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

describe("capabilities routes", () => {
  it("serves the built-in pack", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setCapabilitiesRepositoryFactoryForTests(() => fakeRepository());
    app = buildServer(config(), { logger: false });

    const packs = await app.inject({ method: "GET", url: "/api/v1/capability-packs" });

    expect(packs.statusCode).toBe(200);
    expect(packs.json()).toEqual([expect.objectContaining({ id: "research" })]);
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
});

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
  } as never;
}
