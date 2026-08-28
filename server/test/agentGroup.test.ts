import { describe, expect, it } from "vitest";
import { AgentGroupRuntimeDelegationMaterializer } from "../src/modules/agentGroups/runtimeDelegationMaterializer.js";
import { type AgentRunGroupRecord, PgAgentGroupRepository, type RunDelegationRecord } from "../src/modules/agentGroups/repository.js";
import { PgAgentChatRepository, PgAgentRepository } from "../src/modules/agents/repository.js";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import type { RunEventInput } from "../src/modules/runs/runRepositoryTypes.js";

describe("agentAssistantSettingsRepository", () => {
  function assistantRecord() {
    return {
      id: "assistant-1",
      space_id: "space-1",
      owner_user_id: null,
      name: "Space Assistant",
      description: null,
      visibility: "space_shared",
      role_instruction: null,
      status: "active",
      agent_kind: "system_assistant",
      current_version_id: "version-1",
      model_provider_id: null,
      model_name: null,
      provider_name: null,
      provider_type: null,
      system_prompt: "You are the space assistant.",
      runtime_adapter_type: "model_api",
      runtime_policy_json: { default_adapter_type: "model_api" },
      created_at: "2026-06-26T00:00:00.000Z",
      updated_at: "2026-06-26T00:00:00.000Z",
    };
  }

  function settingsRecord(id: string, settingsJson: Record<string, unknown>) {
    return {
      id,
      scope_type: "space",
      scope_id: "space-1",
      settings_key: "agent.default_assistant.settings",
      settings_json: settingsJson,
      updated_by_user_id: null,
      created_at: "2026-06-26T00:00:00.000Z",
      updated_at: "2026-06-26T00:01:00.000Z",
    };
  }

  class FakeAgentSettingsDb {
    calls: string[] = [];
    settingsJson: Record<string, unknown> | null = null;
    legacyTableName = ["space", "assistant", "settings"].join("_");

    async query<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: Row[]; rowCount: number | null }> {
      const norm = sql.replace(/\s+/g, " ").trim();
      this.calls.push(norm);
      if (norm.includes(this.legacyTableName)) {
        throw new Error("assistant settings must use scoped settings");
      }
      if (norm.includes("FROM settings")) {
        return {
          rows: this.settingsJson ? [settingsRecord("settings-1", this.settingsJson) as Row] : [],
          rowCount: this.settingsJson ? 1 : 0,
        };
      }
      if (norm.includes("FROM agents a")) {
        // Honour the scope predicate rather than answering every agents read.
        // `getDefaultAssistant` names the *Space's* Assistant; a fake that
        // returns one for any query would keep passing if that pin were
        // dropped and the pointer started naming a Project's instance.
        return /project_id IS NULL/i.test(norm)
          ? { rows: [assistantRecord() as Row], rowCount: 1 }
          : { rows: [] as Row[], rowCount: 0 };
      }
      if (norm.startsWith("INSERT INTO settings")) {
        this.settingsJson = JSON.parse(String(params[4] ?? "{}")) as Record<string, unknown>;
        return norm.includes("RETURNING")
          ? { rows: [settingsRecord(String(params[0]), this.settingsJson) as Row], rowCount: 1 }
          : { rows: [] as Row[], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }
  }

  describe("assistant settings repository", () => {
    it("stores assistant preferences in the scoped settings table", async () => {
      const db = new FakeAgentSettingsDb();
      const repo = new PgAgentRepository(db as never);

      const created = await repo.getAssistantSettings("space-1");
      expect(created.assistant_agent_id).toBe("assistant-1");
      expect(db.settingsJson).toMatchObject({
        assistant_agent_id: "assistant-1",
        default_context_toggles_json: {},
        model_preferences_json: {},
      });

      const updated = await repo.updateAssistantSettings("space-1", {
        response_style: "direct",
        verbosity: "concise",
        default_context_toggles_json: { memory: true },
        proposal_style: "balanced",
        model_preferences_json: { model: "system-default" },
      });

      expect(updated).toMatchObject({
        assistant_agent_id: "assistant-1",
        response_style: "direct",
        verbosity: "concise",
        proposal_style: "balanced",
      });
      expect(updated.default_context_toggles_json).toEqual({ memory: true });
      expect(updated.model_preferences_json).toEqual({ model: "system-default" });
      expect(db.calls.some((sql) => sql.includes(db.legacyTableName))).toBe(false);
    });

    it("keeps assistant preference enum validation after moving out of table constraints", async () => {
      const db = new FakeAgentSettingsDb();
      const repo = new PgAgentRepository(db as never);

      await repo.getAssistantSettings("space-1");
      await expect(repo.updateAssistantSettings("space-1", {
        response_style: "casual",
      })).rejects.toMatchObject({ statusCode: 422 });
    });
  });
});

describe("agentChatRepository", () => {
  describe("PgAgentChatRepository", () => {
    it("applies user visibility and active status to Chat Agent lookup", async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      const repository = new PgAgentChatRepository({
        async query(sql: string, params?: unknown[]) {
          calls.push({ sql, params });
          return { rows: [], rowCount: 0 };
        },
      });

      await repository.getAgentForChat("space-1", "user-2", "agent-private");

      expect(calls[0]?.params).toEqual([
        "space-1",
        "agent-private",
        "user-2",
      ]);
      expect(calls[0]?.sql).toContain("a.status = 'active'");
      expect(calls[0]?.sql).toContain("a.agent_kind <> 'system_assistant'");
      expect(calls[0]?.sql).toContain("content_access_grants");
    });
  });
});

describe("agentGroupsRepositorySqlShape", () => {
  class DelegationUpdateSqlShapeDb implements Queryable {
    readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

    async query<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      this.calls.push({ sql, params });
      if (sql.includes("UPDATE agent_run_groups")) {
        return {
          rows: [group({
            status: String(params[2]),
            updated_at: String(params[3]),
            ended_at: params[2] === "cancelled" ? String(params[3]) : null,
          }) as Row],
          rowCount: 1,
        };
      }
      return {
        rows: [delegation({
          status: String(params[2]),
          child_run_id: params[3] ? String(params[3]) : null,
          policy_decision_record_id: params[4] ? String(params[4]) : null,
          updated_at: String(params[5]),
          completed_at: params[2] === "policy_denied" ? String(params[5]) : null,
        }) as Row],
        rowCount: 1,
      };
    }
  }

  function group(overrides: Partial<AgentRunGroupRecord> = {}): AgentRunGroupRecord {
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
      title: "Room",
      goal: "Coordinate the work.",
      status: "active",
      budget_json: {},
      policy_snapshot_json: {},
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
      ended_at: null,
      ...overrides,
    };
  }

  function delegation(overrides: Partial<RunDelegationRecord> = {}): RunDelegationRecord {
    return {
      id: "delegation-1",
      space_id: "space-1",
      group_id: "group-1",
      parent_run_id: "run-parent",
      child_run_id: null,
      request_message_id: null,
      requesting_agent_id: "agent-manager",
      target_agent_id: "agent-worker",
      requested_by_user_id: "user-1",
      policy_decision_record_id: null,
      status: "requested",
      instruction: "Summarize the packet.",
      reason: null,
      budget_json: {},
      context_policy_json: {},
      result_summary: null,
      tool_call_id: null,
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
      completed_at: null,
      ...overrides,
    };
  }

  describe("PgAgentGroupRepository SQL shape", () => {
    it("casts group status parameters used in UPDATE comparisons", async () => {
      const db = new DelegationUpdateSqlShapeDb();
      await new PgAgentGroupRepository(db).updateGroupStatus({
        space_id: "space-1",
        group_id: "group-1",
        status: "cancelled",
        now: "2026-07-05T00:01:00.000Z",
      });

      const update = db.calls.find((call) => call.sql.includes("UPDATE agent_run_groups"));
      expect(update).toBeTruthy();
      expect(update!.sql).toContain("status = $3::varchar(32)");
      expect(update!.sql).toContain("CASE WHEN $3::varchar(32) = 'cancelled'");
      expect(update!.params.slice(0, 4)).toEqual([
        "space-1",
        "group-1",
        "cancelled",
        "2026-07-05T00:01:00.000Z",
      ]);
    });

    it("casts delegation status parameters used in UPDATE comparisons", async () => {
      const db = new DelegationUpdateSqlShapeDb();
      await new PgAgentGroupRepository(db).updateDelegationAfterPolicy({
        space_id: "space-1",
        delegation_id: "delegation-1",
        status: "policy_denied",
        child_run_id: null,
        policy_decision_record_id: "policy-1",
        now: "2026-07-05T00:01:00.000Z",
      });

      const update = db.calls.find((call) => call.sql.includes("UPDATE run_delegations"));
      expect(update).toBeTruthy();
      expect(update!.sql).toContain("status = $3::varchar(32)");
      expect(update!.sql).toContain("CASE WHEN $3::varchar(32) = 'policy_denied'");
      expect(update!.params.slice(0, 6)).toEqual([
        "space-1",
        "delegation-1",
        "policy_denied",
        null,
        "policy-1",
        "2026-07-05T00:01:00.000Z",
      ]);
    });
  });
});

describe("agentGroupsRuntimeDelegationMaterializer", () => {
  function run(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      id: "run-parent",
      space_id: "space-1",
      agent_id: "agent-manager",
      agent_version_id: "agent-version-1",
      status: "running",
      mode: "live",
      prompt: null,
      instruction: null,
      project_folder_id: null,
      session_id: null,
      project_id: null,
      adapter_type: "model_api",
      model_provider_id: null,
      required_sandbox_level: "none",
      trigger_origin: "manual",
      instructed_by_user_id: "user-1",
      started_at: null,
      ended_at: null,
      run_group_id: "group-1",
      root_run_id: "run-root",
      // Path A's own grant check (`SystemActionDispatcher`) and Path B's
      // (this materializer, D8) read the same snapshot — a run granted
      // `agent.delegate` here is what most of these tests exercise; the
      // "not granted" test below overrides this to an empty grant list.
      permission_snapshot_json: { tool_grants: [{ action_id: "agent.delegate" }] },
      ...overrides,
    } as RunRecord;
  }

  function recordingRunEvents(): { events: RunEventInput[]; appendRunEvent: (input: RunEventInput) => Promise<never> } {
    const events: RunEventInput[] = [];
    return {
      events,
      appendRunEvent: async (input: RunEventInput) => {
        events.push(input);
        return {} as never;
      },
    };
  }

  describe("AgentGroupRuntimeDelegationMaterializer", () => {
    it("uses a stable runtime-output idempotency key across physical retries", async () => {
      const keys: Array<string | null | undefined> = [];
      const materializer = new AgentGroupRuntimeDelegationMaterializer({
        async spawnChildRun(_identity, input) {
          keys.push(input.tool_call_id);
          return {
            delegation: {
              id: "delegation-1",
              child_run_id: "run-child",
              status: "queued",
            } as never,
            child_run_id: "run-child",
            policy_decision_record_id: "policy-1",
          };
        },
      }, recordingRunEvents());
      const output = {
        delegations: [{
          target_agent_id: "agent-reader",
          instruction: "Summarize the evidence.",
          budget: { max_cost: 2, max_steps: 4 },
        }],
      };

      await materializer.materialize({ run: run(), output_json: output });
      await materializer.materialize({
        run: run(),
        output_json: {
          delegations: [{
            ...output.delegations[0],
            budget: { max_steps: 4, max_cost: 2 },
          }],
        },
      });

      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/^runtime_output:[a-f0-9]{64}$/);
      expect(keys[1]).toBe(keys[0]);
    });

    it("spawns child runs from structured runtime delegation output and audits it like the tool call would", async () => {
      const calls: unknown[] = [];
      const runEvents = recordingRunEvents();
      const materializer = new AgentGroupRuntimeDelegationMaterializer({
        async spawnChildRun(identity, input) {
          calls.push({ identity, input });
          return {
            delegation: {
              id: "delegation-1",
              space_id: input.space_id,
              group_id: input.group_id,
              parent_run_id: input.parent_run_id,
              child_run_id: "run-child",
              request_message_id: null,
              requesting_agent_id: input.requesting_agent_id,
              target_agent_id: input.target_agent_id,
              requested_by_user_id: identity.userId,
              policy_decision_record_id: "policy-1",
              status: "queued",
              instruction: input.instruction,
              reason: input.reason ?? null,
              budget_json: input.budget_json ?? null,
              context_policy_json: input.context_policy_json ?? null,
              result_summary: null,
              tool_call_id: null,
              created_at: "2026-07-05T00:00:00.000Z",
              updated_at: "2026-07-05T00:00:00.000Z",
              completed_at: null,
            },
            child_run_id: "run-child",
            policy_decision_record_id: "policy-1",
          };
        },
      }, runEvents);

      const result = await materializer.materialize({
        run: run(),
        output_json: {
          delegations: [
            {
              target_agent_id: "agent-reader",
              instruction: "Summarize the evidence.",
              reason: "Specialist review",
              budget: { max_steps: 4 },
              context: { artifact_ids: ["artifact-1"] },
            },
          ],
        },
      });

      expect(calls).toEqual([
        {
          identity: { spaceId: "space-1", userId: "user-1" },
          input: expect.objectContaining({
            parent_run_id: "run-parent",
            requesting_agent_id: "agent-manager",
            target_agent_id: "agent-reader",
            instruction: "Summarize the evidence.",
            budget_json: { max_steps: 4 },
            context_policy_json: { artifact_ids: ["artifact-1"] },
          }),
        },
      ]);
      expect(result.errors).toEqual([]);
      expect(result.items[0]).toMatchObject({
        kind: "delegation",
        status: "succeeded",
        metadata_json: {
          operation: "run.spawn_child",
          delegation_id: "delegation-1",
          child_run_id: "run-child",
          delegation_status: "queued",
        },
      });
      // D8: Path B now emits the same action_invoked/action_completed pair
      // the agent.delegate tool call's gateway hooks would, keyed on the same
      // action_id and the materializer's own idempotency key.
      expect(runEvents.events).toHaveLength(2);
      expect(runEvents.events[0]).toMatchObject({
        run_id: "run-parent",
        event_type: "action_invoked",
        status: "running",
        metadata_json: expect.objectContaining({ action_id: "agent.delegate", tool_name: "agent.delegate" }),
      });
      expect(runEvents.events[1]).toMatchObject({
        run_id: "run-parent",
        event_type: "action_completed",
        status: "succeeded",
        metadata_json: expect.objectContaining({
          action_id: "agent.delegate",
          ok: true,
          delegation_id: "delegation-1",
          child_run_id: "run-child",
          policy_decision_record_id: "policy-1",
        }),
      });
    });

    it("rejects unsafe delegation output before spawning", async () => {
      const materializer = new AgentGroupRuntimeDelegationMaterializer({
        async spawnChildRun() {
          throw new Error("spawn should not be called");
        },
      }, recordingRunEvents());

      const result = await materializer.materialize({
        run: run(),
        output_json: {
          delegations: [
            {
              target_agent_id: "agent-reader",
              instruction: "Use raw context.",
              context: { rendered_context: "raw prompt" },
            },
          ],
        },
      });

      expect(result.items[0]).toMatchObject({
        kind: "delegation",
        status: "failed",
        error_code: "invalid_runtime_delegations",
      });
      expect(result.errors[0]).toContain("invalid_runtime_delegations");
    });

    it("reports policy-denied delegations as warnings with service-written evidence", async () => {
      const runEvents = recordingRunEvents();
      const materializer = new AgentGroupRuntimeDelegationMaterializer({
        async spawnChildRun(identity, input) {
          return {
            delegation: {
              id: "delegation-denied",
              space_id: input.space_id,
              group_id: input.group_id,
              parent_run_id: input.parent_run_id,
              child_run_id: null,
              request_message_id: null,
              requesting_agent_id: input.requesting_agent_id,
              target_agent_id: input.target_agent_id,
              requested_by_user_id: identity.userId,
              policy_decision_record_id: "policy-denied",
              status: "policy_denied",
              instruction: input.instruction,
              reason: input.reason ?? null,
              budget_json: input.budget_json ?? null,
              context_policy_json: input.context_policy_json ?? null,
              result_summary: null,
              tool_call_id: null,
              created_at: "2026-07-05T00:00:00.000Z",
              updated_at: "2026-07-05T00:00:00.000Z",
              completed_at: "2026-07-05T00:00:00.000Z",
            },
            child_run_id: null,
            policy_decision_record_id: "policy-denied",
          };
        },
      }, runEvents);

      const result = await materializer.materialize({
        run: run(),
        output_json: {
          delegations: [
            {
              target_agent_id: "agent-reader",
              instruction: "Summarize the evidence.",
            },
          ],
        },
      });

      expect(result.errors).toEqual([]);
      expect(result.items[0]).toMatchObject({
        kind: "delegation",
        status: "warning",
        error_code: "delegation_policy_denied",
        metadata_json: {
          delegation_id: "delegation-denied",
          policy_decision_record_id: "policy-denied",
          service_event_written: true,
        },
      });
      expect(runEvents.events[1]).toMatchObject({
        event_type: "action_completed",
        status: "failed",
        metadata_json: expect.objectContaining({ ok: false, error_code: "delegation_policy_denied" }),
      });
    });

    it("refuses to spawn when the Run is not granted agent.delegate, matching the tool call's own grant check (D8)", async () => {
      const runEvents = recordingRunEvents();
      let spawnCalled = false;
      const materializer = new AgentGroupRuntimeDelegationMaterializer({
        async spawnChildRun() {
          spawnCalled = true;
          throw new Error("spawn should not be called when agent.delegate is not granted");
        },
      }, runEvents);

      const result = await materializer.materialize({
        run: run({ permission_snapshot_json: { tool_grants: [] } }),
        output_json: {
          delegations: [
            {
              target_agent_id: "agent-reader",
              instruction: "Summarize the evidence.",
            },
          ],
        },
      });

      expect(spawnCalled).toBe(false);
      expect(result.errors).toEqual([]);
      expect(result.items[0]).toMatchObject({
        kind: "delegation",
        status: "warning",
        error_code: "delegation_not_granted",
      });
      // Path B is post-terminal and has no model response channel, so a grant
      // refusal is represented by a completed denial audit event rather than a
      // dropped result (there is still no invocation event because no execution
      // was admitted).
      expect(runEvents.events).toHaveLength(1);
      expect(runEvents.events[0]).toMatchObject({
        event_type: "action_completed",
        status: "failed",
        metadata_json: expect.objectContaining({
          action_id: "agent.delegate",
          ok: false,
          error_code: "delegation_not_granted",
          target_agent_id: "agent-reader",
        }),
      });
    });
  });
});
