import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { buildModuleServer } from "./support/moduleServer";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { __setAgentGroupsServiceFactoryForTests, authorityWidening, agentGroupsModule } from "../src/modules/agentGroups";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setAgentGroupsServiceFactoryForTests(null);
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

function group(overrides: Record<string, unknown> = {}) {
  return {
    id: "group-1",
    space_id: "space-1",
    root_run_id: "run-root",
    manager_user_id: "user-1",
    manager_agent_id: "agent-manager",
    room_id: null,
    session_id: null,
    trigger_message_id: null,
    project_id: null,
    project_folder_id: null,
    title: "Research room",
    goal: "Answer the question",
    status: "active",
    budget_json: {},
    policy_snapshot_json: { action: "run.spawn_child" },
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    ended_at: null,
    ...overrides,
  };
}

describe("agent group routes", () => {
  it("creates an agent group through the registered route", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let seenIdentity: unknown = null;
    let seenInput: unknown = null;
    __setAgentGroupsServiceFactoryForTests(() => ({
      async createGroup(identity, input) {
        seenIdentity = identity;
        seenInput = input;
        return {
          group: group(),
          members: [],
        };
      },
      async listGroups() {
        throw new Error("not used");
      },
      async getGroup() {
        throw new Error("not used");
      },
      async updateGroup() {
        throw new Error("not used");
      },
      async sendUserMessage() {
        throw new Error("not used");
      },
      async getTimeline() {
        throw new Error("not used");
      },
      async getTrace() {
        throw new Error("not used");
      },
      async changeStatus() {
        throw new Error("not used");
      },
    }));
    app = buildModuleServer(config(), [agentGroupsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent-groups",
      payload: {
        space_id: "space-1",
        title: "Research room",
        manager_agent_id: "agent-manager",
        member_agent_ids: ["agent-reader"],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ group: { id: "group-1" }, members: [] });
    expect(seenIdentity).toEqual({ spaceId: "space-1", userId: "user-1" });
    expect(seenInput).toMatchObject({
      manager_agent_id: "agent-manager",
      member_agent_ids: ["agent-reader"],
      goal: "",
    });
  });

  it("updates agent group details through the registered route", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let seenIdentity: unknown = null;
    let seenInput: unknown = null;
    __setAgentGroupsServiceFactoryForTests(() => ({
      async createGroup() {
        throw new Error("not used");
      },
      async listGroups() {
        throw new Error("not used");
      },
      async getGroup() {
        throw new Error("not used");
      },
      async updateGroup(identity, input) {
        seenIdentity = identity;
        seenInput = input;
        return { group: group({ title: input.title, goal: input.goal }) };
      },
      async sendUserMessage() {
        throw new Error("not used");
      },
      async getTimeline() {
        throw new Error("not used");
      },
      async getTrace() {
        throw new Error("not used");
      },
      async changeStatus() {
        throw new Error("not used");
      },
    }));
    app = buildModuleServer(config(), [agentGroupsModule]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agent-groups/group-1",
      payload: {
        space_id: "space-1",
        title: "Updated room",
        goal: "",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ group: { title: "Updated room", goal: "" } });
    expect(seenIdentity).toEqual({ spaceId: "space-1", userId: "user-1" });
    expect(seenInput).toMatchObject({
      space_id: "space-1",
      group_id: "group-1",
      title: "Updated room",
      goal: "",
    });
  });

  it("rejects body group_id that does not match the route", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setAgentGroupsServiceFactoryForTests(() => {
      throw new Error("service should not be constructed");
    });
    app = buildModuleServer(config(), [agentGroupsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent-groups/group-route/messages",
      payload: {
        space_id: "space-1",
        group_id: "group-body",
        content: "Please handle this",
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("group_id must match");
  });

  it("routes room messages with an explicit recipient agent", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let seenIdentity: unknown = null;
    let seenInput: unknown = null;
    __setAgentGroupsServiceFactoryForTests(() => ({
      async createGroup() {
        throw new Error("not used");
      },
      async listGroups() {
        throw new Error("not used");
      },
      async getGroup() {
        throw new Error("not used");
      },
      async updateGroup() {
        throw new Error("not used");
      },
      async sendUserMessage(identity, input) {
        seenIdentity = identity;
        seenInput = input;
        const mentionIds = input.recipient_segments?.flatMap((segment) => segment.recipient_agent_ids) ?? [];
        return {
          message: {
            id: "message-1",
            space_id: "space-1",
            group_id: "group-1",
            run_id: "run-recipient",
            parent_message_id: null,
            sender_actor_ref_json: { actor_type: "user", user_id: "user-1" },
            sender_user_id: "user-1",
            sender_agent_id: null,
            message_type: "user_instruction",
            content: input.content,
            mentions_json: mentionIds.map((agent_id) => ({ agent_id })),
            metadata_json: {
              routing_mode: input.routing_mode,
              recipient_segments: input.recipient_segments,
            },
            created_at: "2026-07-05T00:00:00.000Z",
          },
        };
      },
      async getTimeline() {
        throw new Error("not used");
      },
      async getTrace() {
        throw new Error("not used");
      },
      async changeStatus() {
        throw new Error("not used");
      },
    }));
    app = buildModuleServer(config(), [agentGroupsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent-groups/group-1/messages",
      payload: {
        space_id: "space-1",
        group_id: "group-1",
        content: "@Planner @Reviewer inspect this",
        routing_mode: "direct",
        recipient_segments: [{
          recipient_agent_ids: ["agent-planner", "agent-reviewer"],
          content: "inspect this",
        }],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(seenIdentity).toEqual({ spaceId: "space-1", userId: "user-1" });
    expect(seenInput).toMatchObject({
      content: "@Planner @Reviewer inspect this",
      routing_mode: "direct",
      recipient_segments: [{
        recipient_agent_ids: ["agent-planner", "agent-reviewer"],
        content: "inspect this",
      }],
    });
  });

  it("does not expose direct public child-run spawning", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setAgentGroupsServiceFactoryForTests(() => {
      throw new Error("service should not be constructed");
    });
    app = buildModuleServer(config(), [agentGroupsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent-groups/group-1/spawn-child-run",
      payload: {
        space_id: "space-1",
        group_id: "group-1",
        parent_run_id: "run-parent",
        root_run_id: "run-root",
        requesting_agent_id: "agent-a",
        target_agent_id: "agent-b",
        manager_user_id: "user-1",
        instruction: "Do this",
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("routes pause, resume, and cancel through managed status changes", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const calls: unknown[] = [];
    __setAgentGroupsServiceFactoryForTests(() => ({
      async createGroup() {
        throw new Error("not used");
      },
      async listGroups() {
        throw new Error("not used");
      },
      async getGroup() {
        throw new Error("not used");
      },
      async updateGroup() {
        throw new Error("not used");
      },
      async sendUserMessage() {
        throw new Error("not used");
      },
      async getTimeline() {
        throw new Error("not used");
      },
      async getTrace() {
        throw new Error("not used");
      },
      async changeStatus(identity, groupId, status) {
        calls.push({ identity, groupId, status });
        return group({ status });
      },
    }));
    app = buildModuleServer(config(), [agentGroupsModule]);

    for (const action of ["pause", "resume", "cancel"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agent-groups/group-1/${action}`,
      });
      expect(res.statusCode).toBe(200);
    }

    expect(calls).toEqual([
      { identity: { spaceId: "space-1", userId: "user-1" }, groupId: "group-1", status: "paused" },
      { identity: { spaceId: "space-1", userId: "user-1" }, groupId: "group-1", status: "active" },
      {
        identity: { spaceId: "space-1", userId: "user-1" },
        groupId: "group-1",
        status: "cancelled",
      },
    ]);
  });

  it("detects delegated context authority widening", () => {
    expect(
      authorityWidening(
        { project_folder_id: "workspace-1", project_id: "project-1", model_provider_id: "provider-1" },
        {
          project_folder_id: "workspace-1",
          project_id: "project-1",
          model_provider_id: "provider-1",
          memory_scope: "project",
        },
      ).context_widens_authority,
    ).toBe(false);
    const widened = authorityWidening(
      { project_folder_id: "workspace-1", project_id: "project-1", model_provider_id: "provider-1" },
      {
        nested: {
          project_folder_id: "workspace-2",
          project_id: "project-2",
          model_provider_id: "provider-2",
          credential_profile_id: "credential-1",
        },
      },
    );
    expect(widened.workspace_scope_widens).toBe(true);
    expect(widened.project_scope_widens).toBe(true);
    expect(widened.credential_scope_widens).toBe(true);
    expect(widened.context_widens_authority).toBe(true);

    const directDurableWrite = authorityWidening(
      { project_folder_id: "workspace-1", project_id: "project-1", model_provider_id: "provider-1" },
      {
        memory_policy_json: { writable_scopes: ["semantic"], requires_proposal: false },
        output_policy_json: { proposal_only: false },
      },
    );
    expect(directDurableWrite.durable_write_scope_widens).toBe(true);
    expect(directDurableWrite.context_widens_authority).toBe(true);
  });
});
