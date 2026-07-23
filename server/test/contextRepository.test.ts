import { describe, expect, it } from "vitest";
import {
  PgRunContextRepository,
  type RunContextRecord,
} from "../src/modules/context/repository";
import type { Queryable } from "../src/modules/memory/repository";

class CapturingDb implements Queryable {
  queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  projectOwnerUserId: string | null = null;
  spaceType = "household";
  artifacts: Record<string, unknown>[] = [];
  contextArtifactRevocations: Record<string, unknown>[] = [];
  accessibleWorkspaceIds = new Set<string>();
  sourceSnapshotRows: Record<string, unknown>[] = [];
  evidenceRows: Record<string, unknown>[] = [];
  personalGrantRows: Record<string, unknown>[] = [];
  personalMemoryRows: Record<string, unknown>[] = [];
  viewerRole: string | null = "member";
  failUsedInContextInsert = false;

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.queries.push({ sql, params });
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.includes("FROM source_connections")) {
      return { rows: this.sourceSnapshotRows as Row[], rowCount: this.sourceSnapshotRows.length };
    }
    if (norm.includes("FROM extracted_evidence")) {
      return { rows: this.evidenceRows as Row[], rowCount: this.evidenceRows.length };
    }
    if (norm.includes("INSERT INTO evidence_links")) {
      if (this.failUsedInContextInsert) throw new Error("audit insert failed");
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (norm.includes("FROM personal_memory_grants")) {
      return { rows: this.personalGrantRows as Row[], rowCount: this.personalGrantRows.length };
    }
    if (norm.startsWith("UPDATE personal_memory_grants")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (norm.includes("INSERT INTO personal_memory_grant_events")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (norm.includes("FROM memory_entries") && norm.includes("owner_user_id = $2")) {
      const rows = this.filteredPersonalMemoryRows(norm, params);
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (norm.includes("FROM space_memberships") && !norm.includes("FROM artifacts")) {
      const rows = this.viewerRole ? [{ role: this.viewerRole }] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (norm.includes("FROM context_artifact_revocations")) {
      const artifactIds = Array.isArray(params[1]) ? new Set(params[1] as string[]) : null;
      const rows = this.contextArtifactRevocations.filter((revocation) => {
        if (revocation.deleted_at) return false;
        if (revocation.space_id !== params[0]) return false;
        if (artifactIds && !artifactIds.has(String(revocation.artifact_id))) return false;
        return true;
      });
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (norm.includes("FROM artifacts")) {
      const userId = params[2] as string | null;
      const workspaceId = params[3] as string | null;
      const projectId = params[4] as string | null;
      const artifactIds = Array.isArray(params[1]) ? new Set(params[1] as string[]) : null;
      const rows = this.artifacts.filter((artifact) => {
        if (!this.viewerRole) return false;
        if (artifactIds && !artifactIds.has(String(artifact.id))) return false;
        const visibility = String(artifact.visibility ?? "");
        const ownerUserId = typeof artifact.owner_user_id === "string" ? artifact.owner_user_id : null;
        if (artifact.workspace_id) {
          if (artifact.workspace_id !== workspaceId || !this.accessibleWorkspaceIds.has(workspaceId ?? "")) {
            return false;
          }
        }
        if (artifact.project_id) {
          if (artifact.project_id !== projectId || this.projectOwnerUserId !== userId) {
            return false;
          }
        }
        return ownerUserId === userId || visibility === "space_shared";
      });
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (norm.includes("FROM projects")) {
      const rows = this.projectOwnerUserId === null
        ? []
        : [{ owner_user_id: this.projectOwnerUserId }];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (norm.includes("FROM workspaces")) {
      const rows = this.accessibleWorkspaceIds.has(String(params[1])) ? [{ one: 1 }] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (norm.includes("FROM spaces")) {
      return { rows: [{ type: this.spaceType }] as Row[], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  private filteredPersonalMemoryRows(sql: string, params: readonly unknown[]): Record<string, unknown>[] {
    let rows = this.personalMemoryRows;
    const applyArrayFilter = (column: "memory_layer" | "memory_type" | "namespace") => {
      const match = sql.match(new RegExp(`${column} = ANY\\(\\$(\\d+)\\)`));
      if (!match) return;
      const values = params[Number(match[1]) - 1];
      if (!Array.isArray(values)) return;
      const allowed = new Set(values.map(String));
      rows = rows.filter((row) => allowed.has(String(row[column] ?? "")));
    };
    applyArrayFilter("memory_layer");
    applyArrayFilter("memory_type");
    applyArrayFilter("namespace");
    return rows;
  }
}

describe("PgRunContextRepository digest source revalidation", () => {
  it("excludes project-scoped memory from shared digest consumption", async () => {
    const db = new CapturingDb();
    await new PgRunContextRepository(db).filterEligibleDigestMemoryIds({
      spaceId: "space-1",
      scopeType: "workspace",
      scopeId: "ws-1",
      memoryIds: ["mem-1"],
    });

    const sql = db.queries[0]?.sql ?? "";
    expect(sql).toContain("project_id IS NULL");
  });

  it("does not select project-linked evidence when the viewer lacks project access", async () => {
    const db = new CapturingDb();
    db.projectOwnerUserId = "other-user";

    await new PgRunContextRepository(db).selectEvidenceForContext({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: null,
      projectId: "project-1",
      runId: null,
    });

    const evidenceQuery = db.queries.find((query) =>
      query.sql.includes("FROM extracted_evidence"),
    );
    expect(evidenceQuery?.params).not.toContain("project");
    expect(evidenceQuery?.params).not.toContain("project-1");
  });

  it("selects candidate or active evidence with active context-candidate links", async () => {
    const db = new CapturingDb();

    await new PgRunContextRepository(db).selectEvidenceForContext({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: null,
      projectId: null,
      runId: null,
    });

    const evidenceQuery = db.queries.find((query) =>
      query.sql.includes("FROM extracted_evidence"),
    );
    const sql = evidenceQuery?.sql.replace(/\s+/g, " ") ?? "";
    expect(sql).toContain("ev.status IN ('candidate', 'active')");
    expect(sql).toContain("el.status = 'active'");
    expect(evidenceQuery?.params[1]).toEqual(["context_candidate", "supports", "mentions"]);
  });

  it("filters context evidence by source read policy and treats used_in_context as best-effort audit", async () => {
    const db = new CapturingDb();
    db.failUsedInContextInsert = true;
    db.evidenceRows = [
      {
        id: "ev-denied",
        title: "Denied",
        content_excerpt: "secret",
        evidence_type: "source_excerpt",
        trust_level: "normal",
        source_item_id: "source-denied",
        source_snapshot_id: null,
        artifact_id: null,
        source_uri: null,
        source_connection_id: "source-denied",
        link_id: "link-denied",
        link_type: "context_candidate",
        target_type: "space",
        target_id: "space-1",
      },
      {
        id: "ev-allowed",
        title: "Allowed",
        content_excerpt: "usable",
        evidence_type: "source_excerpt",
        trust_level: "normal",
        source_item_id: "source-allowed",
        source_snapshot_id: null,
        artifact_id: null,
        source_uri: null,
        source_connection_id: "source-allowed",
        link_id: "link-allowed",
        link_type: "context_candidate",
        target_type: "space",
        target_id: "space-1",
      },
    ];
    db.sourceSnapshotRows = [
      {
        id: "source-denied",
        owner_user_id: "other-user",
        consent_json: {
          schema_version: 1,
          owner_user_id: "other-user",
          allowed_reader_user_ids: [],
          allowed_agent_ids: [],
          allow_space_admins: false,
          allow_local_provider_egress: true,
          allow_external_model_egress: false,
        },
        policy_json: {
          schema_version: 1,
          source_egress_class: "local_provider_allowed",
        },
      },
      {
        id: "source-allowed",
        owner_user_id: "user-1",
        consent_json: {
          schema_version: 1,
          owner_user_id: "user-1",
          allowed_reader_user_ids: [],
          allowed_agent_ids: [],
          allow_space_admins: false,
          allow_local_provider_egress: true,
          allow_external_model_egress: false,
        },
        policy_json: {
          schema_version: 1,
          source_egress_class: "local_provider_allowed",
        },
      },
    ];

    const selections = await new PgRunContextRepository(db).selectEvidenceForContext({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: null,
      projectId: null,
      runId: "run-1",
    });

    expect(selections.map((selection) => selection.item.id)).toEqual(["ev-allowed"]);
    const evidenceQuery = db.queries.find((query) =>
      query.sql.includes("FROM extracted_evidence"),
    );
    const usedInContextQuery = db.queries.find((query) =>
      query.sql.includes("link_type, status") && query.sql.includes("used_in_context"),
    );
    const usedInContextSql = usedInContextQuery?.sql.replace(/\s+/g, " ") ?? "";
    expect(evidenceQuery?.params[1]).toEqual(["context_candidate", "supports", "mentions"]);
    expect(usedInContextSql).toContain(
      "ON CONFLICT (space_id, evidence_id, target_type, target_id, link_type) WHERE status = 'active' DO NOTHING",
    );
  });

  it("applies personal memory grant filters before generating summary context", async () => {
    const db = new CapturingDb();
    db.personalGrantRows = [
      {
        id: "grant-1",
        granting_user_id: "user-1",
        personal_space_id: "personal-space-1",
        target_space_id: "space-1",
        access_mode: "summary_only",
        memory_filter_json: {
          memory_types: ["preference"],
          max_items: 5,
        },
      },
    ];
    db.personalMemoryRows = [
      {
        memory_type: "preference",
        memory_layer: "semantic",
        namespace: "user_profile",
        updated_at: "2026-06-25T00:00:00.000Z",
        created_at: "2026-06-24T00:00:00.000Z",
      },
      {
        memory_type: "profile",
        memory_layer: "semantic",
        namespace: "user_profile",
        updated_at: "2026-06-25T00:00:00.000Z",
        created_at: "2026-06-24T00:00:00.000Z",
      },
    ];
    const run: RunContextRecord = {
      id: "run-1",
      space_id: "space-1",
      agent_id: null,
      agent_version_id: null,
      context_snapshot_id: null,
      prompt: "hello",
      workspace_id: null,
      project_id: null,
      session_id: null,
      instructed_by_user_id: "user-1",
      capability_id: null,
      trigger_origin: null,
      data_exposure_level: null,
      trust_level: null,
      has_personal_grant_context: false,
      personal_grant_context_json: null,
      request_json: null,
      system_prompt: null,
      capabilities_json: null,
      memory_policy_json: null,
      model_config_json: null,
    };

    const result = await new PgRunContextRepository(db).resolvePersonalGrantForRun(run);

    expect(result.metadata?.memory_count).toBe(1);
    expect(result.personal_context_block).toContain("1 relevant personal memory entry");
    expect(result.personal_context_block).toContain("Categories: preference.");
    expect(result.personal_context_block).not.toContain("profile");
  });

  it("selects explicit artifact evidence packs as bounded context attachments", async () => {
    const db = new CapturingDb();
    db.projectOwnerUserId = "user-1";
    db.sourceSnapshotRows = [
      {
        id: "source-1",
        owner_user_id: "user-1",
        consent_json: {
          schema_version: 1,
          owner_user_id: "user-1",
          allowed_reader_user_ids: ["user-2"],
          allowed_agent_ids: [],
          allow_space_admins: true,
          allow_local_provider_egress: true,
          allow_external_model_egress: false,
        },
        policy_json: {
          schema_version: 1,
          source_egress_class: "local_provider_allowed",
        },
      },
    ];
    db.artifacts = [
      {
        id: "brief-1",
        artifact_type: "retrieval_brief",
        title: "Context Brief: alpha",
        content: JSON.stringify({ raw_secret: "should not be copied" }),
        metadata_json: {
          kind: "retrieval_brief",
          surface: "knowledge_brief",
          query: "alpha",
          answer: "Use the cited alpha plan.",
          citations: [{ title: "Alpha Plan" }],
          egress_policy_snapshot: { external_egress_enabled: false },
          settings_snapshot: { default_search_mode: "hybrid" },
          source_refs: [{ source_connection_id: "source-1" }],
        },
        visibility: "private",
        owner_user_id: "user-1",
        project_id: null,
        workspace_id: null,
        created_at: "2026-06-25T00:00:00.000Z",
      },
      {
        id: "generic-1",
        artifact_type: "generic_report",
        title: "Generic",
        content: "not attachable",
        metadata_json: {},
        visibility: "private",
        owner_user_id: "user-1",
        project_id: null,
        workspace_id: null,
        created_at: "2026-06-25T00:00:00.000Z",
      },
      {
        id: "explain-1",
        artifact_type: "retrieval_explain_report",
        title: "Explain",
        content: null,
        metadata_json: {
          kind: "retrieval_explain_report",
          diagnostic_codes: ["target_not_returned"],
          target: {
            id: "secret-target-id",
            object_id: "secret-object-id",
            object_type: "claim",
            title: "Target title should not be expanded into raw JSON",
            returned: false,
            visibility: "space_shared",
            status: "active",
          },
          match: {
            id: "secret-match-id",
            score: 0.812345,
            rank: 3,
            matched_fields: ["title", "summary"],
            reasons: ["lexical overlap"],
            nested_candidate_payload: { secret: "should not leak" },
          },
        },
        visibility: "private",
        owner_user_id: "user-1",
        project_id: null,
        workspace_id: null,
        created_at: "2026-06-25T00:00:00.000Z",
      },
      {
        id: "matrix-1",
        artifact_type: "literature_matrix",
        title: "Literature Matrix",
        content: JSON.stringify({
          project_id: "project-1",
          rows: [{
            title: "A relevant paper",
            triage_status: "relevant",
            relevance: "relevant",
            confidence: 0.9,
            reason: "Matches the agent-memory scope.",
            evidence_excerpt: "Evaluates memory over long-horizon tasks.",
            references: [{ source_item_id: "source-1" }],
          }],
        }),
        metadata_json: { schema_version: "literature_matrix.v1" },
        visibility: "private",
        owner_user_id: "user-1",
        project_id: "project-1",
        workspace_id: null,
        created_at: "2026-06-25T00:00:00.000Z",
      },
    ];

    const selections = await new PgRunContextRepository(db).selectArtifactAttachments({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: "ws-1",
      projectId: "project-1",
      artifactIds: ["brief-1", "missing-1", "generic-1", "explain-1", "matrix-1"],
    });

    expect(selections).toHaveLength(5);
    expect(selections[0].item).toMatchObject({
      attachment_type: "artifact_evidence_pack",
      artifact_id: "brief-1",
      artifact_type: "retrieval_brief",
      domain_label: "knowledge_brief",
      approved: true,
      policy_snapshot: {
        content_mode: "bounded_summary",
        raw_artifact_content_included: false,
      },
      source_policy_snapshot: {
        egress_policy_snapshot: { external_egress_enabled: false },
        settings_snapshot: { default_search_mode: "hybrid" },
        source_ref_count: 1,
        source_connection_ids: ["source-1"],
        source_connection_count: 1,
        source_policy_snapshots: {
          "source-1": expect.objectContaining({
            id: "source-1",
            ownerUserId: "user-1",
            allowSpaceAdmins: true,
            sourceEgressClass: "local_provider_allowed",
          }),
        },
        current_reader_gate: expect.objectContaining({
          evaluated: true,
          enforced_for_attachment: false,
          allowed: true,
        }),
      },
    });
    expect(String(selections[0].item.resolved_content)).toContain("Answer: Use the cited alpha plan.");
    expect(String(selections[0].item.resolved_content)).toContain("- Alpha Plan");
    expect(String(selections[0].item.resolved_content)).not.toContain("should not be copied");
    expect(selections[0].ref).toMatchObject({
      source_type: "artifact",
      source_id: "brief-1",
      included: true,
      content_mode: "bounded_summary",
      raw_artifact_content_included: false,
    });
    expect(selections[1].item).toMatchObject({
      approved: false,
      rejection_reason: "artifact not found or not visible",
    });
    expect(selections[2].item).toMatchObject({
      approved: false,
      rejection_reason: "artifact type is not attachable to context",
    });
    expect(selections[3].item).toMatchObject({
      approved: true,
      artifact_id: "explain-1",
      artifact_type: "retrieval_explain_report",
      domain_label: "knowledge.retrieval.explain",
    });
    const explainContent = String(selections[3].item.resolved_content);
    expect(explainContent).toContain("Target type: claim");
    expect(explainContent).toContain("Target returned: no");
    expect(explainContent).toContain("Match rank: 3");
    expect(explainContent).toContain("Matched fields: title, summary");
    expect(explainContent).not.toContain("secret-target-id");
    expect(explainContent).not.toContain("secret-match-id");
    expect(explainContent).not.toContain("nested_candidate_payload");
    expect(selections[4].item).toMatchObject({
      approved: true,
      artifact_id: "matrix-1",
      artifact_type: "literature_matrix",
      domain_label: "project_research.literature_matrix",
    });
    expect(String(selections[4].item.resolved_content)).toContain("A relevant paper");
    expect(String(selections[4].item.resolved_content)).toContain('"source_item_id":"source-1"');
    const artifactQuery = db.queries.find((query) => query.sql.includes("FROM artifacts"));
    expect(artifactQuery?.sql).toContain("visibility = 'space_shared'");
    expect(artifactQuery?.sql).toContain("content_access_grants");
    expect(artifactQuery?.sql).toContain("a.workspace_id = $4");
    expect(artifactQuery?.sql).toContain("a.project_id = $5");
    expect(artifactQuery?.sql).toContain("project_workspaces");
    expect(artifactQuery?.sql).toContain("project_members");
    expect(artifactQuery?.params).toContain("ws-1");
  });

  it("only attaches workspace-scoped shared artifacts with matching workspace context", async () => {
    const db = new CapturingDb();
    db.accessibleWorkspaceIds.add("ws-1");
    db.artifacts = [
      {
        id: "brief-1",
        artifact_type: "retrieval_brief",
        title: "Workspace Brief",
        content: null,
        metadata_json: {
          kind: "retrieval_brief",
          answer: "Workspace scoped answer.",
        },
        visibility: "space_shared",
        owner_user_id: "other-user",
        project_id: null,
        workspace_id: "ws-1",
        created_at: "2026-06-25T00:00:00.000Z",
      },
    ];
    const repository = new PgRunContextRepository(db);

    const withoutWorkspace = await repository.selectArtifactAttachments({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: null,
      artifactIds: ["brief-1"],
    });
    const withWorkspace = await repository.selectArtifactAttachments({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: "ws-1",
      artifactIds: ["brief-1"],
    });
    const withDifferentWorkspace = await repository.selectArtifactAttachments({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: "ws-2",
      artifactIds: ["brief-1"],
    });

    expect(withoutWorkspace[0].item).toMatchObject({
      approved: false,
      rejection_reason: "artifact not found or not visible",
    });
    expect(withWorkspace[0].item).toMatchObject({
      approved: true,
      artifact_id: "brief-1",
      artifact_type: "retrieval_brief",
    });
    expect(withDifferentWorkspace[0].item).toMatchObject({
      approved: false,
      rejection_reason: "artifact not found or not visible",
    });
  });

  it("blocks context artifact attachments revoked for the current workspace or project", async () => {
    const db = new CapturingDb();
    db.accessibleWorkspaceIds.add("ws-1");
    db.projectOwnerUserId = "user-1";
    db.artifacts = [
      {
        id: "brief-1",
        artifact_type: "retrieval_brief",
        title: "Context Brief",
        content: null,
        metadata_json: {
          kind: "retrieval_brief",
          answer: "Should not attach.",
        },
        visibility: "private",
        owner_user_id: "user-1",
        project_id: null,
        workspace_id: "ws-1",
        created_at: "2026-06-25T00:00:00.000Z",
      },
    ];
    db.contextArtifactRevocations = [
      {
        id: "revocation-1",
        space_id: "space-1",
        artifact_id: "brief-1",
        scope_type: "project",
        scope_id: "project-1",
        reason: "superseded by newer brief",
        created_by_user_id: "user-1",
        created_at: "2026-06-26T00:00:00.000Z",
        deleted_at: null,
      },
    ];

    const selections = await new PgRunContextRepository(db).selectArtifactAttachments({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: "ws-1",
      projectId: "project-1",
      artifactIds: ["brief-1"],
    });

    expect(selections[0].item).toMatchObject({
      approved: false,
      rejection_reason: "artifact is revoked for this project context: superseded by newer brief",
    });
  });

  it("re-gates a non-owner attaching a source-derived brief the viewer's source policy denies (G3)", async () => {
    const db = new CapturingDb();
    db.viewerRole = "member";
    db.sourceSnapshotRows = [
      {
        id: "src-denied",
        owner_user_id: "owner-2",
        consent_json: {
          schema_version: 1,
          owner_user_id: "owner-2",
          allowed_reader_user_ids: [],
          allowed_agent_ids: [],
          allow_space_admins: false,
          allow_local_provider_egress: true,
          allow_external_model_egress: false,
        },
        policy_json: { schema_version: 1, source_egress_class: "local_provider_allowed" },
      },
    ];
    db.artifacts = [
      {
        id: "brief-shared",
        artifact_type: "retrieval_brief",
        title: "Shared Brief",
        content: null,
        metadata_json: {
          kind: "retrieval_brief",
          answer: "Derived from a restricted source.",
          source_connection_ids: ["src-denied"],
        },
        visibility: "space_shared",
        owner_user_id: "other-user",
        project_id: null,
        workspace_id: null,
        created_at: "2026-06-25T00:00:00.000Z",
      },
    ];

    const selections = await new PgRunContextRepository(db).selectArtifactAttachments({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: null,
      artifactIds: ["brief-shared"],
    });

    expect(selections[0].item.approved).toBe(false);
    expect(String(selections[0].item.rejection_reason)).toContain("source policy");
  });

  it("re-gates workspace-scoped source-derived briefs after access passes (G3)", async () => {
    const db = new CapturingDb();
    db.viewerRole = "member";
    db.accessibleWorkspaceIds.add("ws-1");
    db.sourceSnapshotRows = [
      {
        id: "src-denied",
        owner_user_id: "owner-2",
        consent_json: {
          schema_version: 1,
          owner_user_id: "owner-2",
          allowed_reader_user_ids: [],
          allowed_agent_ids: [],
          allow_space_admins: false,
          allow_local_provider_egress: true,
          allow_external_model_egress: false,
        },
        policy_json: { schema_version: 1, source_egress_class: "local_provider_allowed" },
      },
    ];
    db.artifacts = [
      {
        id: "brief-workspace",
        artifact_type: "retrieval_brief",
        title: "Workspace Brief",
        content: null,
        metadata_json: {
          kind: "retrieval_brief",
          answer: "Derived from a restricted source.",
          source_connection_ids: ["src-denied"],
        },
        visibility: "space_shared",
        owner_user_id: "other-user",
        project_id: null,
        workspace_id: "ws-1",
        created_at: "2026-06-25T00:00:00.000Z",
      },
    ];

    const selections = await new PgRunContextRepository(db).selectArtifactAttachments({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: "ws-1",
      artifactIds: ["brief-workspace"],
    });

    expect(selections[0].item.approved).toBe(false);
    expect(String(selections[0].item.rejection_reason)).toContain("source policy");
  });

  it("does not re-gate the owner attaching their own source-derived brief (G3)", async () => {
    const db = new CapturingDb();
    db.artifacts = [
      {
        id: "brief-own",
        artifact_type: "retrieval_brief",
        title: "Own Brief",
        content: null,
        metadata_json: {
          kind: "retrieval_brief",
          answer: "My own answer.",
          source_connection_ids: ["src-denied"],
        },
        visibility: "private",
        owner_user_id: "user-1",
        project_id: null,
        workspace_id: null,
        created_at: "2026-06-25T00:00:00.000Z",
      },
    ];

    const selections = await new PgRunContextRepository(db).selectArtifactAttachments({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: null,
      artifactIds: ["brief-own"],
    });

    expect(selections[0].item.approved).toBe(true);
    expect(selections[0].item.source_policy_snapshot).toMatchObject({
      source_connection_ids: ["src-denied"],
      current_reader_gate: expect.objectContaining({
        enforced_for_attachment: false,
      }),
    });
  });

  it("blocks workspace-scoped artifact attachments without inherited project workspace access", async () => {
    const db = new CapturingDb();
    db.artifacts = [
      {
        id: "brief-1",
        artifact_type: "retrieval_brief",
        title: "Workspace Brief",
        content: null,
        metadata_json: {
          kind: "retrieval_brief",
          answer: "Workspace scoped answer.",
        },
        visibility: "space_shared",
        owner_user_id: "other-user",
        project_id: null,
        workspace_id: "ws-1",
        created_at: "2026-06-25T00:00:00.000Z",
      },
    ];

    const selections = await new PgRunContextRepository(db).selectArtifactAttachments({
      spaceId: "space-1",
      userId: "user-1",
      workspaceId: "ws-1",
      artifactIds: ["brief-1"],
    });

    expect(selections[0].item).toMatchObject({
      approved: false,
      rejection_reason: "artifact not found or not visible",
    });
  });
});
