import { describe, expect, it } from "vitest";
import {
  PgAgentGroupRepository,
  type AgentRunGroupRecord,
  type RunDelegationRecord,
} from "../src/modules/agentGroups/repository";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common";

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
