import { describe, expect, it } from "vitest";
import {
  ContextBuildRequestSchema,
  ContextBuildResultSchema,
  ContextArtifactRevocationCreateRequestSchema,
  ContextArtifactRevocationListResponseSchema,
  ContextCompileRequestSchema,
  ContextCompileResultSchema,
  ContextEngineEventSchema,
  ContextPackageSchema,
  ContextSnapshotAuditSchema,
  ContextSnapshotItemAuditSchema,
  ChatContextCandidateItemSchema,
  ChatContextCandidatesRequestSchema,
  ChatContextCandidatesResultSchema,
  ChatRunCreateRequestSchema,
  ChatRunCreateResultSchema,
  ChatTurnPrepareRunRequestSchema,
  ChatTurnPrepareRunResultSchema,
  ChatTurnAcceptedSchema,
  ChatTurnCompletionSchema,
  ChatTurnRequestSchema,
  ConversationBackendCatalogSchema,
  MemorySearchRequestSchema,
  MemoryPageSchema,
  MemoryOutSchema,
  MemoryAccessLogListResponseSchema,
  MemoryMaintenanceReportSchema,
  MemoryMaintenanceScanRequestSchema,
  MemoryProposalCommandSchema,
  MemoryProposalCreateResultSchema,
  MemoryReadRequestSchema,
  MemoryReadTraceSchema,
  MessageCreateRequestSchema,
  MessageOutSchema,
  SessionCreateRequestSchema,
  SessionOutSchema,
  SessionPageSchema,
  SessionSummaryForContextSchema,
  SessionSummaryGetLatestRequestSchema,
  SessionSummaryGetLatestResultSchema,
} from "../src/index";

describe("memory + sessions contracts", () => {
  const memory = {
    id: "memory-1",
    space_id: "space-1",
    subject_user_id: null,
    owner_user_id: "user-1",
    workspace_id: null,
    scope: "user",
    namespace: "default",
    type: "fact",
    title: "Remember",
    content: "content",
    status: "active",
    visibility: "private",
    sensitivity_level: "normal",
    access_level: "full",
    last_confirmed_at: null,
    confidence: 0.9,
    importance: 0.8,
    source_id: null,
    created_by: "user-1",
    created_at: "2026-06-14T10:00:00.000Z",
    updated_at: "2026-06-14T10:00:00.000Z",
    deleted_at: null,
    version: 1,
    tags: [],
    memory_layer: "semantic",
    source_trust: "user_confirmed",
    created_from_proposal_id: "proposal-1",
    root_memory_id: null,
    supersedes_memory_id: null,
    project_id: null,
  };

  it("parses current session and message DTOs", () => {
    const session = SessionOutSchema.parse({
      id: "session-1",
      space_id: "space-1",
      user_id: "user-1",
      workspace_id: null,
      title: "Assistant chat",
      status: "active",
      created_at: "2026-06-14T10:00:00.000Z",
      updated_at: "2026-06-14T10:01:00.000Z",
    });
    expect(session.id).toBe("session-1");
    expect(
      SessionPageSchema.parse({
        items: [session],
        total: 1,
        limit: 50,
        offset: 0,
      }).items,
    ).toHaveLength(1);

    expect(
      MessageOutSchema.parse({
        id: "message-1",
        session_id: "session-1",
        space_id: "space-1",
        user_id: "user-1",
        role: "user",
        content: "hello",
        metadata_json: null,
        created_at: "2026-06-14T10:00:01.000Z",
      }).content,
    ).toBe("hello");
  });

  it("parses current session and message write requests", () => {
    expect(
      SessionCreateRequestSchema.parse({
        title: "New chat",
        metadata: { source: "ui" },
      }).title,
    ).toBe("New chat");
    expect(
      MessageCreateRequestSchema.parse({
        content: "hello",
      }).content,
    ).toBe("hello");
    expect(
      MessageCreateRequestSchema.safeParse({
        role: "assistant",
        content: "forged",
        metadata: { run_id: "run-1" },
      }).success,
    ).toBe(false);
  });

  it("parses explicit context artifact attachments without raw secret fields", () => {
    const request = ContextBuildRequestSchema.parse({
      space_id: "space-1",
      query: "alpha",
      context_artifact_ids: ["artifact-1"],
    });
    expect(request.context_artifact_ids).toEqual(["artifact-1"]);

    const pkg = ContextPackageSchema.parse({
      user_memory: [],
      workspace_memory: [],
      capability_memory: [],
      agent_memory: [],
      system_policy: [],
      relevant_episodes: [],
      recent_session_summary: [],
      attachments: [
        {
          attachment_type: "artifact_evidence_pack",
          artifact_id: "artifact-1",
          artifact_type: "retrieval_brief",
          label: "Context Brief",
          domain_label: "knowledge_brief",
          approved: true,
          resolved_content: "bounded summary",
          policy_snapshot: {
            content_mode: "bounded_summary",
            raw_artifact_content_included: false,
          },
          source_policy_snapshot: {
            source_ref_count: 1,
          },
        },
      ],
    });
    expect(pkg.attachments[0]).toMatchObject({
      attachment_type: "artifact_evidence_pack",
      approved: true,
    });
  });

  it("parses context artifact revocation contracts", () => {
    const request = ContextArtifactRevocationCreateRequestSchema.parse({
      artifact_id: "artifact-1",
      scope_type: "project",
      scope_id: "project-1",
      reason: "superseded",
    });
    expect(request.scope_type).toBe("project");

    const response = ContextArtifactRevocationListResponseSchema.parse({
      items: [
        {
          id: "revocation-1",
          space_id: "space-1",
          artifact_id: "artifact-1",
          scope_type: "project_folder",
          scope_id: "project-folder-1",
          reason: null,
          created_by_user_id: "user-1",
          created_at: "2026-06-26T10:00:00.000Z",
        },
      ],
    });
    expect(response.items[0]?.artifact_id).toBe("artifact-1");
  });

  it("parses memory DTOs without exposing secret response fields", () => {
    expect(MemoryOutSchema.parse(memory).id).toBe("memory-1");

    expect(() =>
      MemoryOutSchema.parse({
        id: "memory-1",
        space_id: "space-1",
        scope: "user",
        type: "fact",
        status: "active",
        visibility: "private",
        sensitivity_level: "normal",
        confidence: 1,
        importance: 1,
        created_at: "2026-06-14T10:00:00.000Z",
        updated_at: "2026-06-14T10:00:00.000Z",
        deleted_at: null,
        version: 1,
        secret_ref: "must-not-leak",
      }),
    ).toThrow();
  });

  it("parses the session summary context DTO", () => {
    const parsed = SessionSummaryForContextSchema.parse({
      id: "summary-1",
      session_id: "session-1",
      version: 1,
      summary_text: "Session with one message.",
      source_message_count: 1,
      source_first_message_id: "message-1",
      source_last_message_id: "message-1",
      condenser_version: "pattern.v1",
    });
    expect(parsed.version).toBe(1);
    expect(parsed.source_last_message_id).toBe("message-1");
  });

  it("parses session-summary lookup request and result bodies", () => {
    expect(
      SessionSummaryGetLatestRequestSchema.parse({
        session_id: "session-1",
        space_id: "space-1",
      }).session_id,
    ).toBe("session-1");
    expect(
      SessionSummaryGetLatestResultSchema.parse({
        summary: {
          id: "summary-1",
          session_id: "session-1",
          version: 1,
          summary_text: "Session summary.",
          source_message_count: 0,
          source_first_message_id: null,
          source_last_message_id: null,
          condenser_version: "pattern.v1",
        },
      }).summary?.id,
    ).toBe("summary-1");
  });

  it("parses asynchronous chat-turn contracts", () => {
    expect(
      ChatTurnRequestSchema.parse({
        message: "  hello  ",
        session_id: "session-1",
      }).message,
    ).toBe("hello");
    expect(
      ChatTurnAcceptedSchema.parse({
        schema_version: "chat_turn_accepted.v1",
        session_id: "session-1",
        run_id: "run-1",
        user_message_id: "message-1",
        status: "queued",
        event_stream_url: "/api/v1/runs/run-1/events/stream",
        backend: {
          runtime_profile_id: "runtime-profile-1",
          adapter_type: "model_api",
          credential_profile_id: null,
        },
      }).status,
    ).toBe("queued");
    expect(
      ConversationBackendCatalogSchema.parse({
        options: [{
          runtime_profile_id: "runtime-profile-1",
          name: "Subscription",
          adapter_type: "claude_code",
          model_name: null,
          requires_cli_credential: true,
          credential_profiles: [{
            id: "credential-1",
            name: "Personal",
            is_default: true,
          }],
        }],
        binding: {
          runtime_profile_id: "runtime-profile-1",
          adapter_type: "claude_code",
          credential_profile_id: "credential-1",
        },
      }).binding?.credential_profile_id,
    ).toBe("credential-1");
    expect(
      ChatTurnCompletionSchema.parse({
        schema_version: "chat_turn_completion.v1",
        session_id: "session-1",
        run_id: "run-1",
        ok: true,
        reply: "hi",
        assistant_message: {
          schema_version: "assistant_message.v1",
          id: "message-2",
          session_id: "session-1",
          run_id: "run-1",
          content: "hi",
          artifact_refs: ["artifact-1"],
          tool_call_refs: ["tool-call-1"],
          created_at: "2026-06-14T10:00:01.000Z",
        },
      }).reply,
    ).toBe("hi");
    expect(() =>
      ChatTurnCompletionSchema.parse({
        schema_version: "chat_turn_completion.v1",
        session_id: "session-1",
        run_id: "run-1",
        ok: true,
        assistant_message: {
          schema_version: "assistant_message.v1",
          id: "message-2",
          session_id: "session-1",
          run_id: "run-1",
          content: "hi",
          artifact_refs: [],
          tool_call_refs: [],
          created_at: "2026-06-14T10:00:01.000Z",
          secret_ref: "must-not-leak",
        },
      }),
    ).toThrow();
    expect(
      ChatTurnPrepareRunRequestSchema.parse({
        agent_id: "agent-1",
        space_id: "space-1",
        user_id: "user-1",
        session_id: "session-1",
        message: "hello",
      }).agent_id,
    ).toBe("agent-1");
    expect(
      ChatTurnPrepareRunResultSchema.parse({
        session_id: "session-1",
        run_id: "run-1",
      }).run_id,
    ).toBe("run-1");
  });

  it("parses memory proposal commands and proposal-create result bodies", () => {
    expect(
      MemoryProposalCommandSchema.parse({
        operation: "create",
        title: "Remember this",
        content: "The user prefers concise summaries.",
        type: "preference",
        scope: "user",
        namespace: "user.default",
        visibility: "private",
        sensitivity_level: "normal",
        actor_user_id: "user-1",
        provenance_entries: [
          {
            source_type: "user_confirmation",
            evidence: { method: "POST", path: "/memory" },
          },
        ],
      }).operation,
    ).toBe("create");
    expect(
      MemoryProposalCommandSchema.parse({
        operation: "update",
        target_memory_id: "memory-1",
        title: "Updated title",
      }).operation,
    ).toBe("update");
    expect(
      MemoryProposalCommandSchema.parse({
        operation: "archive",
        target_memory_id: "memory-1",
      }).operation,
    ).toBe("archive");
    expect(
      MemoryProposalCreateResultSchema.parse({
        proposal_id: "proposal-1",
        proposal_type: "memory_create",
        status: "pending",
      }).proposal_type,
    ).toBe("memory_create");
  });

  it("parses memory read requests, pages, and access-log audit rows", () => {
    expect(
      MemoryReadRequestSchema.parse({
        space_id: "space-1",
        user_id: "user-1",
        query: "preference",
      }).limit,
    ).toBe(50);
    expect(
      MemoryPageSchema.parse({
        items: [memory],
        total: 1,
        limit: 50,
        offset: 0,
      }).items[0].id,
    ).toBe("memory-1");
    expect(
      MemoryReadTraceSchema.parse({
        id: "trace-1",
        space_id: "space-1",
        memory_id: "memory-1",
        user_id: "user-1",
        agent_id: null,
        run_id: "run-1",
        access_type: "context_injection",
        reason: "context.build",
        accessed_at: "2026-06-14T10:00:00.000Z",
      }).access_type,
    ).toBe("context_injection");
  });

  it("parses context build and package contracts", () => {
    const contextPackage = ContextPackageSchema.parse({
      user_memory: [memory],
      recent_session_summary: [
        {
          id: "summary-1",
          session_id: "session-1",
          version: 1,
          summary_text: "Summary.",
          condenser_version: "pattern.v1",
        },
      ],
      evidence_items: [
        {
          id: "evidence-1",
          title: "Evidence",
          trust_level: "high",
        },
      ],
      source_refs: [
        {
          source_type: "memory",
          source_id: "memory-1",
          section: "dynamic_tail",
        },
      ],
      retrieval_trace: { memory_count: 1 },
      token_budget: { max_tokens: 4000 },
    });
    expect(contextPackage.user_memory).toHaveLength(1);

    expect(
      ContextBuildRequestSchema.parse({
        space_id: "space-1",
        user_id: "user-1",
        session_id: "session-1",
        query: "What matters now?",
      }).space_id,
    ).toBe("space-1");
    expect(
      ContextBuildResultSchema.parse({
        package: contextPackage,
        context_snapshot_id: "snapshot-1",
        memory_read_traces: [
          {
            id: "trace-1",
            space_id: "space-1",
            memory_id: "memory-1",
            user_id: "user-1",
            agent_id: null,
            run_id: "run-1",
            access_type: "context_injection",
            reason: null,
            accessed_at: "2026-06-14T10:00:00.000Z",
          },
        ],
      }).context_snapshot_id,
    ).toBe("snapshot-1");
  });

  it("parses context compile request and result contracts", () => {
    const contextPackage = ContextPackageSchema.parse({
      user_memory: [memory],
    });
    expect(
      ContextCompileRequestSchema.parse({
        space_id: "space-1",
        target: "codex_cli",
        task_goal: "Help with the migration.",
        context_package: contextPackage,
        budget_chars: 12000,
      }).target,
    ).toBe("codex_cli");
    expect(
      ContextCompileResultSchema.parse({
        target: "codex_cli",
        task_prompt: "Help with the migration.",
        instruction_file_path: "AGENTS.md",
        total_chars: 1200,
        budget_chars: 12000,
        dropped_sections: [],
        budget_trace: { mandatory_chars: 1200 },
      }).total_chars,
    ).toBe(1200);
  });

  it("parses context snapshot/item audit rows without raw rendered context", () => {
    expect(
      ContextSnapshotAuditSchema.parse({
        id: "snapshot-1",
        space_id: "space-1",
        source_refs_json: [
          {
            source_type: "session_summary",
            source_id: "summary-1",
          },
        ],
        token_estimate: 123,
        relevant_period_start: null,
        relevant_period_end: null,
        prefix_hash: "prefix",
        tail_hash: "tail",
        compiler_version: "context_compiler.v1",
        retrieval_trace_json: [{ stage: "memory" }],
        token_budget_json: { max_tokens: 4000 },
        redactions_json: { count: 0 },
        data_exposure_level: "model_provider",
        rendered_context_uri: null,
        has_compiled_prefix_text: true,
        has_compiled_tail_text: true,
        has_rendered_context_text: false,
        created_at: "2026-06-14T10:00:00.000Z",
      }).has_compiled_prefix_text,
    ).toBe(true);

    expect(
      ContextSnapshotItemAuditSchema.parse({
        id: "item-1",
        context_snapshot_id: "snapshot-1",
        item_type: "memory",
        item_id: "memory-1",
        title: "Remember",
        excerpt: "short excerpt",
        score: 0.9,
        reason: "semantic match",
        token_count: 12,
        metadata_json: { section: "dynamic_tail" },
        created_at: "2026-06-14T10:00:00.000Z",
      }).item_type,
    ).toBe("memory");

    expect(() =>
      ContextSnapshotAuditSchema.parse({
        id: "snapshot-1",
        space_id: "space-1",
        source_refs_json: [],
        rendered_context_text: "raw prompt must not be part of audit DTO",
        created_at: "2026-06-14T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("parses context engine events and rejects unsafe event metadata", () => {
    expect(
      ContextEngineEventSchema.parse({
        event_type: "context.memory_selected",
        space_id: "space-1",
        session_id: "session-1",
        run_id: "run-1",
        context_snapshot_id: "snapshot-1",
        status: "succeeded",
        metadata_json: { selected_count: 2 },
        created_at: "2026-06-14T10:00:00.000Z",
      }).event_type,
    ).toBe("context.memory_selected");

    expect(() =>
      ContextEngineEventSchema.parse({
        event_type: "context.build_completed",
        space_id: "space-1",
        status: "succeeded",
        metadata_json: { rendered_context: "raw context must not be logged" },
        created_at: "2026-06-14T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("parses chat context-candidate port request and result", () => {
    ChatContextCandidatesRequestSchema.parse({
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      message: "hello",
    });
    const result = ChatContextCandidatesResultSchema.parse({
      allowed_sources: ["memory", "knowledge_item"],
      max_tokens: 4000,
      max_items: 20,
      context_policy_applied: true,
      items: [
        {
          item_type: "memory",
          item_id: "memory-1",
          title: "A memory",
          excerpt: "excerpt text",
          score: 0.8,
          reason: "approved_memory",
          token_count: 3,
        },
      ],
    });
    expect(result.items[0].metadata).toEqual({});
    expect(result.context_policy_applied).toBe(true);
  });

  it("rejects secret-bearing chat candidate metadata", () => {
    expect(() =>
      ChatContextCandidateItemSchema.parse({
        item_type: "manual_context",
        reason: "explicit_selection",
        metadata: { secret_ref: "ref-1" },
      }),
    ).toThrow();
  });

  it("parses the memory search request with defaults", () => {
    const req = MemorySearchRequestSchema.parse({ query: "ts migration" });
    expect(req.limit).toBe(10);
    expect(req.query).toBe("ts migration");
    const full = MemorySearchRequestSchema.parse({
      query: "x",
      scope: "user",
      type: "fact",
      limit: 5,
      workspace_id: "ws-1",
    });
    expect(full.type).toBe("fact");
    // The surface is identity-scoped: no space_id / user_id fields exist.
    expect("space_id" in full).toBe(false);
    expect("user_id" in full).toBe(false);
  });

  it("parses memory maintenance scan requests and reports", () => {
    const req = MemoryMaintenanceScanRequestSchema.parse({ create_packet: true, project_id: "project-1" });
    expect(req).toMatchObject({
      persist_report: true,
      create_packet: true,
      limit: 500,
      stale_after_days: 180,
      thin_content_chars: 80,
      max_findings: 100,
      review_scope: "private",
      project_id: "project-1",
    });

    const report = MemoryMaintenanceReportSchema.parse({
      findings: [
        {
          kind: "duplicate",
          objects: [
            { object_type: "memory_entry", object_id: "memory-1", title: "A" },
            { object_type: "memory_entry", object_id: "memory-2", title: "A" },
          ],
          reason: "same normalized title",
        },
      ],
      counts: {
        duplicate: 1,
        stale: 0,
        thin: 0,
        lifecycle_drift: 0,
      },
      candidate_limit: 500,
      candidates_examined: 2,
      scanned: 2,
      truncated: false,
      artifact_id: "artifact-1",
      proposal_id: "proposal-1",
      access_safety: {
        owner_private: true,
        raw_content_included: false,
      },
    });
    expect(report.findings[0]?.objects.map((object) => object.object_id)).toEqual([
      "memory-1",
      "memory-2",
    ]);
    expect(() =>
      MemoryMaintenanceReportSchema.parse({
        ...report,
        findings: [
          {
            kind: "duplicate",
            objects: [{ object_type: "memory_entry", object_id: "memory-1", title: "A" }],
            reason: "bad",
            raw_content: "must not be part of the wire shape",
          },
        ],
      }),
    ).toThrow();
  });

  it("parses memory access-log inspector responses", () => {
    const parsed = MemoryAccessLogListResponseSchema.parse({
      items: [
        {
          id: "access-log-1",
          space_id: "space-1",
          memory_id: "memory-1",
          user_id: "user-1",
          agent_id: null,
          run_id: null,
          access_type: "maintenance_scan",
          reason: "memory maintenance scan",
          accessed_at: "2026-06-26T10:00:00.000Z",
          memory_title: "Visible memory",
          memory_scope: "user",
          memory_visibility: "private",
          project_id: null,
        },
      ],
      limit: 50,
      offset: 0,
      returned: 1,
      has_more: false,
    });
    expect(parsed.items[0]?.access_type).toBe("maintenance_scan");
  });

  it("parses chat run-create port request and result", () => {
    ChatRunCreateRequestSchema.parse({
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      prompt: "context preamble\n\nhello",
    });
    const result = ChatRunCreateResultSchema.parse({
      run_id: "run-1",
      context_snapshot_id: "snapshot-1",
    });
    expect(result.run_id).toBe("run-1");
  });
});
