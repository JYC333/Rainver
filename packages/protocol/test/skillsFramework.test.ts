import { describe, expect, it } from "vitest";
import {
  SKILL_LOCAL_OPERATION_SCHEMAS,SKILL_IO_OPERATION_SCHEMAS,
  NormalizedSkillSchema,
  SkillImportApprovalProposalResponseSchema,
  SkillImportPreviewRequestSchema,
  SkillImportPreviewResponseSchema,
  SkillImportRequestSchema,
  SkillPackageSchema,
  SkillReviewProposalRequestSchema,
  SkillSourceSchema,
} from "../src";

describe("Skill protocol schemas", () => {
  it('keeps operation inputs strict and retains binding/review scope refinements',()=>{
    const pkg='00000000-0000-4000-8000-000000000001';
    expect(SKILL_LOCAL_OPERATION_SCHEMAS['skill.binding.propose'].input.safeParse({skill_package_id:pkg,scope_type:'space',enabled:true}).success).toBe(true);
    expect(SKILL_LOCAL_OPERATION_SCHEMAS['skill.binding.propose'].input.safeParse({skill_package_id:pkg,scope_type:'space',scope_id:pkg,enabled:true}).success).toBe(false);
    expect(SKILL_LOCAL_OPERATION_SCHEMAS['skill.review.propose'].input.safeParse({skill_package_id:pkg,binding:{scope_type:'project',scope_id:pkg,enabled:true}}).success).toBe(false);
    expect(SKILL_LOCAL_OPERATION_SCHEMAS['skill.review.propose'].input.safeParse({skill_package_id:pkg,binding:{scope_type:'user',scope_id:pkg,enabled:false}}).success).toBe(false);
    expect(SKILL_IO_OPERATION_SCHEMAS['skill.source.scan'].input.safeParse({host_id:pkg,path:'/etc'}).success).toBe(false);
    expect(SKILL_IO_OPERATION_SCHEMAS['skill.source.import'].input.safeParse({source_type:'builtin',package_hash:'a'}).success).toBe(false);
    expect(SKILL_IO_OPERATION_SCHEMAS['skill.source.preview'].input.safeParse({source_type:'local_workspace',host_id:pkg,skill_id:'a'.repeat(64)}).success).toBe(true);
  });

  it("parses skill import contracts", () => {
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
      pending_proposal: { id: "proposal-1", operation: "skill_import_approve" },
    };
    expect(SkillPackageSchema.parse(skillPackage).status).toBe("reviewed");
    expect(SkillPackageSchema.safeParse({ ...skillPackage, status: "converted" }).success).toBe(false);
    expect(SkillPackageSchema.safeParse({ ...skillPackage, pending_proposal: undefined }).success).toBe(false);
    expect(SkillImportRequestSchema.safeParse({ url: "https://github.com/org/repo/blob/main/SKILL.md" }).success).toBe(false);
    expect(SkillImportRequestSchema.parse({ url: "https://github.com/org/repo/blob/main/SKILL.md", package_hash: "abc" }).package_hash).toBe("abc");

    expect(
      SkillImportPreviewRequestSchema.parse({
        url: "https://github.com/org/repo/blob/main/SKILL.md",
      }),
    ).toMatchObject({ url: "https://github.com/org/repo/blob/main/SKILL.md" });

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

  });

  it("lets a review enable only a non-Project scope", () => {
    expect(SkillReviewProposalRequestSchema.parse({})).toEqual({});
    expect(SkillReviewProposalRequestSchema.parse({ binding: { scope_type: "space", enabled: true } }).binding?.scope_type).toBe("space");
    expect(SkillReviewProposalRequestSchema.safeParse({ binding: { scope_type: "project", scope_id: "project-1", enabled: true } }).success).toBe(false);
    expect(SkillReviewProposalRequestSchema.safeParse({ binding: { scope_type: "space", enabled: false } }).success).toBe(false);
  });
});
