import { describe, expect, it } from "vitest";
import {
  ChatTurnPrepareRunRequestSchema,
  ChatTurnPrepareRunResultSchema,
  ChatTurnAcceptedSchema,
  ChatTurnCompletionSchema,
  ChatTurnRequestSchema,
  ConversationBackendCatalogSchema,
  MemorySearchRequestSchema,
  MemoryPageSchema,
  MemoryOutSchema,
  MemoryMaintenanceReportSchema,
  MemoryMaintenanceScanRequestSchema,
  MemoryProposalCommandSchema,
  MemoryProposalCreateResultSchema,
  MemoryReadRequestSchema,
  ContentReadTraceSchema,
  MessageCreateRequestSchema,
  MessageOutSchema,
  SessionCreateRequestSchema,
  SessionOutSchema,
  SessionPageSchema,
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
      ContentReadTraceSchema.parse({
        id: "trace-1",
        space_id: "space-1",
        resource_type: "memory",
        resource_id: "memory-1",
        owner_user_id: "user-2",
        viewer_user_id: "user-1",
        agent_id: null,
        run_id: "run-1",
        access_type: "context_injection",
        reason: "runtime_context.delivery",
        accessed_at: "2026-06-14T10:00:00.000Z",
      }).access_type,
    ).toBe("context_injection");
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

});
