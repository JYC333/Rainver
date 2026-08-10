import { describe, expect, it } from "vitest";
import {
  CapabilityDefinitionSchema,
  CapabilityPackDescriptorSchema,
  CapabilityRuntimeBindingSchema,
  NormalizedSkillSchema,
  ProjectWorkflowProfileSchema,
  SkillConvertToCapabilityResponseSchema,
  SkillImportApprovalProposalResponseSchema,
  SkillImportPreviewRequestSchema,
  SkillImportPreviewResponseSchema,
  SkillPackageSchema,
  SkillSourceSchema,
  WorkflowTemplateSchema,
} from "../src";

describe("capability/workflow/open-skill protocol schemas", () => {
  it("parses capability definitions, packs, bindings, and workflow templates", () => {
    const binding = CapabilityRuntimeBindingSchema.parse({
      id: "bind-1",
      capability_id: "research.source_collect",
      runtime_adapter_type: "model_api",
      render_mode: "inline_prompt",
      binding_json: {},
      enabled: true,
    });
    expect(binding.render_mode).toBe("inline_prompt");

    const capability = CapabilityDefinitionSchema.parse({
      id: "research.source_collect",
      namespace: "research",
      name: "Source Collection",
      description: "Collect sources.",
      version: "0.1.0",
      source_kind: "builtin",
      input_schema_json: {},
      output_artifact_types: ["research_report.archive.v1"],
      permissions: {},
      supported_execution_modes: ["project_sources"],
      default_runtime_bindings: [binding],
      status: "available",
    });
    expect(capability.id).toBe("research.source_collect");

    expect(
      CapabilityPackDescriptorSchema.parse({
        id: "research",
        name: "Research Skills",
        description: "Research pack.",
        version: "0.1.0",
        capability_ids: [capability.id],
        workflow_template_ids: ["test.research_workflow"],
        artifact_types: ["research_report.archive.v1"],
        source_kind: "builtin",
        status: "available",
      }).id,
    ).toBe("research");

    expect(
      WorkflowTemplateSchema.parse({
        id: "test.research_workflow",
        name: "Technical Survey",
        description: "Survey technical sources.",
        category: "research",
        capability_ids: [capability.id],
        input_schema_json: {},
        default_config_json: {},
        output_artifact_types: ["research_report.archive.v1"],
        proposal_policy: {},
        recommended_runtime_adapters: ["model_api"],
      }).category,
    ).toBe("research");
  });

  it("parses project workflow profile and skill import contracts", () => {
    expect(
      ProjectWorkflowProfileSchema.parse({
        id: "profile-1",
        space_id: "space-1",
        project_id: "project-1",
        workflow_template_id: "test.research_workflow",
        name: "Survey",
        enabled: true,
        config_json: { source_mode: "project_sources" },
        created_by_user_id: "user-1",
        created_at: "2026-06-20T00:00:00.000Z",
        updated_at: "2026-06-20T00:00:00.000Z",
      }).enabled,
    ).toBe(true);

    const normalized = NormalizedSkillSchema.parse({
      name: "Skill",
      description: "Useful skill.",
      version: "0.1.0",
      license: null,
      instructions_markdown: "Do work.",
      resources: [],
      requested_permissions: [],
      execution_profile: {},
      vendor_extensions: {},
      trust_analysis: {},
    });
    expect(normalized.name).toBe("Skill");

    expect(
      SkillSourceSchema.parse({
        id: "source-1",
        source_type: "github",
        url: "https://github.com/org/repo/blob/main/SKILL.md",
        repo: "org/repo",
        path: "SKILL.md",
        ref: "main",
        commit_sha: null,
        content_hash: "abc",
        fetched_at: "2026-06-20T00:00:00.000Z",
        metadata_json: {},
      }).source_type,
    ).toBe("github");

    const skillPackage = {
      id: "package-1",
      source_id: "source-1",
      package_name: "Skill",
      version: "0.1.0",
      license: null,
      raw_storage_ref: null,
      manifest_json: {},
      normalized_json: normalized,
      risk_level: "low",
      status: "reviewed",
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:00:00.000Z",
    };
    expect(SkillPackageSchema.parse(skillPackage).status).toBe("reviewed");

    expect(
      SkillImportPreviewRequestSchema.parse({
        url: "https://github.com/org/repo/blob/main/SKILL.md",
      }).url,
    ).toContain("SKILL.md");

    expect(
      SkillImportPreviewResponseSchema.parse({
        source: {
          source_type: "github",
          url: "https://raw.githubusercontent.com/org/repo/main/SKILL.md",
          repo: "org/repo",
          path: "SKILL.md",
          ref: "main",
          commit_sha: null,
          content_hash: "abc",
          metadata_json: {},
        },
        normalized_skill: normalized,
        package_root: ".",
        package_hash: "abc123",
        package_files: [
          {
            path: "SKILL.md",
            kind: "skill_markdown",
            content_hash: "abc",
            content_type: "text/markdown",
            byte_length: 42,
            included: true,
            executable: false,
            risk_flags_json: {},
          },
        ],
        risk_level: "low",
        requested_permissions: [],
        files_detected: ["SKILL.md"],
        warnings: [],
        persistable: true,
      }).persistable,
    ).toBe(true);

    const proposal = {
      id: "proposal-1",
      space_id: "space-1",
      user_id: "user-1",
      workspace_id: null,
      source_session_id: null,
      source_task_id: null,
      source_run_id: null,
      created_by_run_id: null,
      proposal_type: "skill_import_approve",
      target_scope: "space",
      target_namespace: "capabilities",
      memory_type: "system",
      proposed_title: "Review skill",
      proposed_content: "",
      rationale: "Review imported source.",
      status: "pending",
      risk_level: "medium",
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
    expect(SkillImportApprovalProposalResponseSchema.parse(proposal).proposal_type).toBe(
      "skill_import_approve",
    );
    expect(
      SkillConvertToCapabilityResponseSchema.parse({
        ...proposal,
        id: "proposal-2",
        proposal_type: "capability_install",
      }).proposal_type,
    ).toBe("capability_install");
  });
});
