import { describe, expect, it } from "vitest";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import { normalizeUsageObservation } from "../src/modules/usage/normalizer.js";
import {
  PgUsageRepository,
  type UsageEventRecord,
  type UsageQueryFilters,
} from "../src/modules/usage/repository.js";

class RecordingDb implements Queryable {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];

  constructor(
    private readonly handler: (
      sql: string,
      params?: readonly unknown[],
    ) => QueryResult<unknown>,
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql, params });
    return this.handler(sql, params) as QueryResult<Row>;
  }
}

const baseFilters: UsageQueryFilters = {
  activeSpaceId: "space-1",
  userId: "user-1",
  view: "mine",
  from: "2026-07-01T00:00:00.000Z",
  to: "2026-08-01T00:00:00.000Z",
};

const privateAttribution = {
  owner_user_id: "user-1",
  visibility: "private" as const,
  access_level: "full" as const,
  source_resource_type: null,
  source_resource_id: null,
  project_folder_id: null,
  project_id: null,
  grant_snapshots: [],
};

describe("usage repository", () => {
  it("sums production estimated cost by run for finalization", async () => {
    const db = new RecordingDb((sql, params) => {
      expect(sql).toContain("sum(estimated_cost_usd)");
      expect(sql).toContain("FROM token_usage_events");
      expect(params).toEqual(["space-1", "run-1"]);
      return { rows: [{ estimated_cost_usd: "1.25000000" }], rowCount: 1 };
    });

    await expect(new PgUsageRepository(db).getRunEstimatedCost("space-1", "run-1"))
      .resolves.toBe(1.25);
  });

  it("inserts selected-user grant snapshots in the same statement as the usage event", async () => {
    const grant = {
      id: "grant-snapshot-1",
      user_id: "member-2",
      granted_by_user_id: "user-1",
      access_level: "summary" as const,
      created_at: "2026-07-09T12:00:00.000Z",
    };
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        usage_details: { input: 4, output: 2 },
        idempotency_key: "usage-selected-1",
      },
      "instance-1",
      {
        ...privateAttribution,
        visibility: "selected_users",
        source_resource_type: "run",
        source_resource_id: "run-1",
        grant_snapshots: [grant],
      },
      new Date("2026-07-09T12:00:00.000Z"),
    );
    const db = new RecordingDb((sql) => {
      if (sql.includes("INSERT INTO token_usage_events")) {
        return { rows: [eventRow(event, "event-selected-1")], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await new PgUsageRepository(db).appendEvent(event);

    const insert = db.calls[0]!;
    expect(insert.sql).toContain("inserted_grants AS");
    expect(insert.sql).toContain("'token_usage_event'");
    expect(insert.params).toHaveLength(64);
    expect(insert.params?.slice(5, 13)).toEqual([
      event.owner_user_id,
      event.visibility,
      event.access_level,
      event.origin_space_id,
      event.event_type,
      event.source_type,
      event.source_resource_type,
      event.source_resource_id,
    ]);
    expect(insert.params?.[62]).toBe(0);
    expect(JSON.parse(String(insert.params?.[63]))).toEqual([grant]);
  });

  it("returns the existing event when append is deduped by idempotency key", async () => {
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        provider_type: "openai",
        provider_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        idempotency_key: "usage-key-1",
      },
      "instance-1",
      privateAttribution,
      new Date("2026-07-09T12:00:00.000Z"),
    );
    const existing = eventRow(event, "existing-event");
    const db = new RecordingDb((sql) => {
      if (sql.includes("INSERT INTO token_usage_events")) return { rows: [], rowCount: 0 };
      if (sql.includes("WHERE space_id = $1 AND idempotency_key = $2")) {
        return { rows: [existing], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await new PgUsageRepository(db).appendEvent(event);

    expect(result.id).toBe("existing-event");
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1].params).toEqual(["space-1", "usage-key-1"]);
  });

  it("aliases lateral dimension keys safely for dimensions read model queries", async () => {
    const db = new RecordingDb((sql) => {
      if (sql.includes("provider_id AS id")) {
        return { rows: [{ id: "provider-1", label: "OpenAI", total_tokens: 15 }], rowCount: 1 };
      }
      if (sql.includes("COALESCE(model, 'unknown') AS model")) {
        return { rows: [{ model: "gpt-4o", total_tokens: 15 }], rowCount: 1 };
      }
      if (sql.includes("COALESCE(task, 'unknown') AS task")) {
        return { rows: [{ task: "chat", total_tokens: 15 }], rowCount: 1 };
      }
      if (sql.includes("SELECT execution_channel")) {
        return { rows: [{ execution_channel: "managed_api", total_tokens: 15 }], rowCount: 1 };
      }
      if (sql.includes("SELECT usage_accuracy")) {
        return { rows: [{ usage_accuracy: "provider_reported", event_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("jsonb_object_keys")) {
        return { rows: [{ key: "workflow" }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await new PgUsageRepository(db).dimensions(baseFilters);

    expect(result.custom_dimension_keys).toEqual(["workflow"]);
    const dimensionSql = db.calls.at(-1)?.sql ?? "";
    expect(dimensionSql).toContain("AS dims(key)");
    expect(dimensionSql).toContain("ORDER BY dims.key");
  });

  it("filters visible events before aggregation and keeps summary access deidentified", async () => {
    const db = new RecordingDb((sql) => {
      if (sql.includes("GROUP BY 1, 2")) return { rows: [], rowCount: 0 };
      if (sql.includes("'all' AS group_key")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    });

    await new PgUsageRepository(db).aggregate({ ...baseFilters, view: "all_visible" });

    const sql = db.calls[0]!.sql;
    expect(sql).toContain("FROM space_memberships content_member");
    expect(sql).toContain("FROM content_access_grants content_grant");
    expect(sql).toContain("ELSE 'summary' END AS group_key");
    expect(sql.indexOf("FROM space_memberships content_member")).toBeLessThan(sql.indexOf("GROUP BY 1, 2"));
    expect(db.calls[0]!.params?.slice(0, 4)).toEqual([
      baseFilters.from,
      baseFilters.to,
      "space-1",
      "user-1",
    ]);
  });

  it("inherits Space oversight from the canonical content-access predicate, not a bespoke check", async () => {
    // Usage doesn't reimplement oversight — it just reuses contentAccessSql /
    // contentAccessLevelSql (already exhaustively verified against real
    // Postgres in contentAccessEquivalence.test.ts). This only guards against
    // usageRepository silently swapping in a hand-rolled predicate that drops
    // the oversight branch.
    const db = new RecordingDb((sql) => {
      if (sql.includes("GROUP BY 1, 2")) return { rows: [], rowCount: 0 };
      if (sql.includes("'all' AS group_key")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    });

    await new PgUsageRepository(db).aggregate({ ...baseFilters, view: "all_visible" });

    const sql = db.calls[0]!.sql;
    expect(sql).toContain("spaces content_oversight_space");
    expect(sql).toContain("content_oversight_space.oversight_mode <> 'none'");
    expect(sql).toContain("content_oversight_member.role IN ('owner', 'admin')");
  });

  it("parameterizes subject, session, and custom dimension filters", async () => {
    const db = new RecordingDb((sql) => {
      if (sql.includes("GROUP BY 1, 2")) return { rows: [], rowCount: 0 };
      if (sql.includes("'all' AS group_key")) {
        return {
          rows: [{
            group_key: "all",
            group_label: "All usage",
            event_count: 0,
            request_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 0,
            estimated_cost_usd: null,
            observed_events: 0,
            provider_reported: 0,
            proxy_observed: 0,
            transcript_lower_bound: 0,
            estimated: 0,
            quota_snapshot: 0,
            unknown: 0,
            last_seen_at: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await new PgUsageRepository(db).aggregate({
      ...baseFilters,
      subjectType: "agent",
      subjectId: "agent-1",
      sessionId: "session-1",
      dimensionKey: "workflow",
      dimensionValue: "daily_report",
    });

    const sql = db.calls[0].sql;
    expect(sql).toContain("e.owner_user_id = $4");
    expect(sql).toMatch(/END\) = 'full'/);
    expect(sql).toContain("e.meter_subject_type = $5");
    expect(sql).toContain("e.meter_subject_id = $6");
    expect(sql).toContain("e.session_id = $7");
    expect(sql).toContain("jsonb_extract_path_text(e.dimensions_json, $8::text) = $9");
    expect(db.calls[0].params).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "space-1",
      "user-1",
      "agent",
      "agent-1",
      "session-1",
      "workflow",
      "daily_report",
    ]);
  });

  it("persists an upstream cost without querying a local pricing engine", async () => {
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        provider_type: "openai",
        model: "gpt-4o",
        usage_details: {
          input: 1_000_000,
          output: 500_000,
          input_cache_creation: 50,
          input_cache_creation_1h: 40,
        },
        estimated_cost_usd: 5,
        cost_accuracy: "catalog",
        cost_details: {
          source: "pi_ai_catalog",
          input: 2,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          total: 5,
        },
        idempotency_key: "usage-key-priced",
      },
      "instance-1",
      privateAttribution,
      new Date("2026-07-09T12:00:00.000Z"),
    );
    const db = new RecordingDb((sql, params) => {
      if (sql.includes("INSERT INTO token_usage_events")) {
        return {
          rows: [{
            ...eventRow(event, "priced-event"),
            estimated_cost_usd: params?.[47] as number,
            cost_accuracy: params?.[48] as string,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await new PgUsageRepository(db).appendEvent(event);

    const insert = db.calls.find((call) => call.sql.includes("INSERT INTO token_usage_events"));
    expect(insert?.params?.[47]).toBe(5);
    expect(insert?.params?.[48]).toBe("catalog");
    expect(insert?.params?.[51]).toContain('"pi_ai_catalog"');
    expect(insert?.params?.[51]).not.toContain('"accuracy"');
    expect(insert?.params?.[62]).toBe(40);
    expect(insert?.sql).toContain("cache_creation_1h_input_tokens");
    expect(db.calls).toHaveLength(1);
  });

  it("projects read-only budget preview by subject", async () => {
    const db = new RecordingDb((sql) => {
      if (sql.includes("e.meter_subject_type") && sql.includes("costed_events")) {
        return {
          rows: [{
            meter_subject_type: "agent",
            meter_subject_id: "agent-1",
            group_key: "agent:agent-1",
            group_label: "agent agent-1",
            event_count: 4,
            costed_events: 2,
            request_count: 4,
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 150,
            estimated_cost_usd: "10",
            observed_events: 2,
            provider_reported: 2,
            proxy_observed: 0,
            transcript_lower_bound: 2,
            estimated: 0,
            quota_snapshot: 0,
            unknown: 0,
            last_seen_at: "2026-07-08T00:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await new PgUsageRepository(db).budgetPreview({
      ...baseFilters,
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-11T00:00:00.000Z",
    }, 30);

    expect(result.observed_days).toBe(10);
    expect(result.total_projected_estimated_cost_usd).toBe(30);
    expect(result.items[0]).toMatchObject({
      meter_subject_type: "agent",
      meter_subject_id: "agent-1",
      current_estimated_cost_usd: 10,
      projected_estimated_cost_usd: 30,
      costed_event_percentage: 50,
    });
  });

  it("returns instance operations as de-identified totals only", async () => {
    const db = new RecordingDb((sql) => {
      expect(sql).not.toMatch(/subject_user_id|run_id|session_id|source_resource_id/);
      return {
        rows: [{
          group_key: "all",
          group_label: "All usage",
          event_count: 2,
          request_count: 2,
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 15,
          estimated_cost_usd: "0.01",
          observed_events: 2,
          provider_reported: 2,
          proxy_observed: 0,
          transcript_lower_bound: 0,
          estimated: 0,
          quota_snapshot: 0,
          unknown: 0,
          last_seen_at: "2026-07-10T00:00:00.000Z",
        }],
        rowCount: 1,
      };
    });

    const result = await new PgUsageRepository(db).operationalTotals({
      from: baseFilters.from,
      to: baseFilters.to,
    });

    expect(result).toMatchObject({ event_count: 2, total_tokens: 15, estimated_cost_usd: 0.01 });
    expect(Object.keys(result)).not.toContain("items");
  });
});

function eventRow(event: ReturnType<typeof normalizeUsageObservation>, id: string): UsageEventRecord {
  return {
    id,
    space_id: event.space_id,
    owner_user_id: event.owner_user_id,
    visibility: event.visibility,
    access_level: event.access_level,
    event_type: event.event_type,
    source_type: event.source_type,
    source_resource_type: event.source_resource_type,
    source_resource_id: event.source_resource_id,
    execution_channel: event.execution_channel,
    meter_subject_type: event.meter_subject_type,
    meter_subject_id: event.meter_subject_id,
    provider_id: event.provider_id,
    provider_type: event.provider_type,
    provider_name_snapshot: event.provider_name_snapshot,
    vendor: event.vendor,
    model: event.model,
    task: event.task,
    run_id: event.run_id,
    session_id: event.session_id,
    external_session_id: event.external_session_id,
    session_path: event.session_path,
    session_name: event.session_name,
    agent_id: event.agent_id,
    project_id: event.project_id,
    project_folder_id: event.project_folder_id,
    occurred_at: event.occurred_at,
    recorded_at: event.recorded_at,
    input_tokens: event.input_tokens,
    output_tokens: event.output_tokens,
    total_tokens: event.total_tokens,
    cache_creation_input_tokens: event.cache_creation_input_tokens,
    cache_creation_1h_input_tokens: event.cache_creation_1h_input_tokens,
    cache_read_input_tokens: event.cache_read_input_tokens,
    reasoning_tokens: event.reasoning_tokens,
    request_count: event.request_count,
    estimated_cost_usd: event.estimated_cost_usd,
    cost_accuracy: event.cost_accuracy,
    usage_details_json: event.usage_details_json,
    total_tokens_source: event.total_tokens_source,
    usage_accuracy: event.usage_accuracy,
    dimensions_json: event.dimensions_json,
    metadata_json: event.metadata_json,
    created_at: event.created_at,
  };
}
