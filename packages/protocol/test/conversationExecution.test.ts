import { describe, expect, it } from "vitest";
import {
  ConversationAttachmentMutationSchema,
  ConversationExecutionInitializeRequestSchema,
  ConversationExecutionSummarySchema,
  ConversationPrimarySelectionSchema,
  ManagedWorkspaceContainerSchema,
  ManagedWorkspaceHeartbeatSchema,
} from "../src/index";

const now = "2026-08-31T12:00:00.000Z";

describe("Conversation execution contracts", () => {
  it("keeps Primary selection explicit and shape-safe", () => {
    expect(ConversationPrimarySelectionSchema.parse({ kind: "managed" })).toEqual({ kind: "managed" });
    expect(ConversationPrimarySelectionSchema.parse({ kind: "location", workspace_location_id: "location-1" })).toMatchObject({
      kind: "location",
      workspace_location_id: "location-1",
    });
    expect(ConversationPrimarySelectionSchema.safeParse({ kind: "location" }).success).toBe(false);
    expect(ConversationPrimarySelectionSchema.safeParse({ kind: "managed", workspace_location_id: "unexpected" }).success).toBe(false);
  });

  it("requires the runtime pin when initializing a Conversation", () => {
    const request = ConversationExecutionInitializeRequestSchema.parse({
      selection: { execution_host_id: "host-1", primary: { kind: "managed" } },
      runtime: {
        agent_id: "agent-1",
        runtime_profile_id: "profile-1",
        credential_profile_id: null,
        adapter_type: "claude_code",
        runtime_installation: "own",
      },
    });
    expect(request.selection.primary.kind).toBe("managed");
    expect(ConversationExecutionInitializeRequestSchema.parse({
      ...request,
      additional_runtimes: [{
        agent_id: "agent-2",
        runtime_profile_id: "profile-2",
        credential_profile_id: null,
        adapter_type: "claude_code",
        runtime_installation: "own",
      }],
    }).additional_runtimes).toHaveLength(1);
  });

  it("models attachment mutations and rejects secret-bearing summaries", () => {
    expect(ConversationAttachmentMutationSchema.parse({
      action: "attach",
      mutation_id: "mutation-1",
      project_folder_id: "folder-1",
      workspace_location_id: "location-1",
    })).toMatchObject({ action: "attach", access_mode: "read" });
    const summary = {
      session_id: "session-1",
      state: "initialized" as const,
      host: {
        host_id: "host-1",
        host_name: "Laptop",
        host_kind: "remote",
        online: true,
        managed_workspace_available: true,
        daemon_last_heartbeat_at: now,
      },
      runtime: {
        agent_id: "agent-1",
        runtime_profile_id: "profile-1",
        credential_profile_id: null,
        adapter_type: "claude_code",
        runtime_installation: "own",
      },
      primary: { kind: "managed" as const, managed_workspace_id: "session-1", display_path: null },
      attachments: [],
      dispatch_locked: false,
      queue_paused_at: null,
      can_send: true,
      blocked_reason: null,
    };
    expect(ConversationExecutionSummarySchema.parse(summary).can_send).toBe(true);
    expect(ConversationExecutionSummarySchema.safeParse({ ...summary, api_key: "must-not-cross-boundary" }).success).toBe(false);
  });

  it("exposes the Conversation managed-workspace identity", () => {
    expect(ManagedWorkspaceContainerSchema.parse({ kind: "conversation", conversation_id: "session-1" })).toEqual({
      kind: "conversation",
      conversation_id: "session-1",
    });
  });

  it("represents a shared Conversation heartbeat without an Agent identity", () => {
    expect(ManagedWorkspaceHeartbeatSchema.parse({
      container_kind: "conversation",
      container_id: "session-1",
      archived_available: false,
    })).toEqual({
      container_kind: "conversation",
      container_id: "session-1",
      archived_available: false,
    });
    expect(ManagedWorkspaceHeartbeatSchema.safeParse({
      container_kind: "conversation",
      container_id: "session-1",
      agent_id: "agent-1",
      archived_available: false,
    }).success).toBe(false);
  });
});
