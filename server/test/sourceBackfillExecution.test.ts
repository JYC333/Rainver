import { describe,expect,it } from "vitest";
import { sourceConnectorRegistry } from "../src/modules/sources/catalog/sourceConnectorRegistry.js";
import { SourceBackfillExecutionService } from "../src/modules/sources/sourceBackfillExecutionService.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { vi } from "vitest";

describe("source backfill extraction windows",()=>{
  it("adds the approved date window to arXiv scans",()=>{
    const url=sourceConnectorRegistry.get("arxiv_api").buildBackfillRequest({ endpoint_url: "https://export.arxiv.org/api/query?search_query=cat%3Acs.AI", compiled_query: { search_query: "cat:cs.AI", monitoring_field: "submittedDate" } }, { from: "2026-01-02T03:04:05.000Z", to: "2026-02-03T04:05:06.000Z", max_items: 17 }, {} ).url;
    const parsed=new URL(url);
    expect(parsed.searchParams.get("search_query")).toBe("(cat:cs.AI) AND submittedDate:[202601020304 TO 202602030405]");
    expect(parsed.searchParams.get("max_results")).toBe("17");
  });

  // The offset is counted in items. Deriving it as `cursor * 100` regardless of
  // the page actually requested skipped every result between the real position
  // and the assumed one — here, 150 papers that no page would ever return.
  it("resumes a cursor scan at the item the previous pages reached",()=>{
    const url=sourceConnectorRegistry.get("arxiv_api").buildBackfillRequest({ endpoint_url: "https://export.arxiv.org/api/query?search_query=cat%3Acs.AI", compiled_query: { search_query: "cat:cs.AI" } }, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", cursor: 2, max_items: 25 }, {} ).url;
    const parsed=new URL(url);
    expect(parsed.searchParams.get("start")).toBe("50");
    expect(parsed.searchParams.get("max_results")).toBe("25");
  });

  it("prefers a recorded item offset over the page index",()=>{
    const url=sourceConnectorRegistry.get("arxiv_api").buildBackfillRequest({ endpoint_url: "https://export.arxiv.org/api/query?search_query=cat%3Acs.AI", compiled_query: { search_query: "cat:cs.AI" } }, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", cursor: 3, offset: 130, max_items: 25 }, {} ).url;
    expect(new URL(url).searchParams.get("start")).toBe("130");
  });

  // Narrowing the page after a provider failure must not move the position:
  // the next request resumes at the same item, just asking for fewer of them.
  it("keeps the resume position when the page size is narrowed",()=>{
    const build=(pageSize:number)=>new URL(sourceConnectorRegistry.get("arxiv_api").buildBackfillRequest(
      { endpoint_url: "https://export.arxiv.org/api/query?search_query=cat%3Acs.AI", compiled_query: { search_query: "cat:cs.AI" } },
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", consumed_items: 60, max_items: pageSize, page_size: pageSize },
      {},
    ).url);
    expect(build(100).searchParams.get("start")).toBe("60");
    expect(build(25).searchParams.get("start")).toBe("60");
    expect(build(25).searchParams.get("max_results")).toBe("25");
  });

  it("uses lastUpdatedDate for historical windows when configured", () => {
    const url = sourceConnectorRegistry.get("arxiv_api").buildBackfillRequest({ endpoint_url: "https://export.arxiv.org/api/query?search_query=cat%3Acs.AI", compiled_query: { search_query: "cat:cs.AI", monitoring_field: "lastUpdatedDate" } }, {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
        max_items: 100,
        monitoring_field: "lastUpdatedDate",
      }, {} ).url;
    expect(new URL(url).searchParams.get("search_query")).toContain("lastUpdatedDate:[202601010000 TO 202601020000]");
  });

  it("keeps an overlap window for incremental arXiv scans", () => {
    const url = sourceConnectorRegistry.get("arxiv_api").buildScanRequest(
      { endpoint_url: "https://export.arxiv.org/api/query?search_query=cat%3Acs.AI", compiled_query: { search_query: "cat:cs.AI", monitoring_field: "submittedDate" } },
      { last_published_at: "2026-01-03T12:00:00.000Z" },
    ).url;
    const parsed = new URL(url);
    expect(parsed.searchParams.get("search_query")).toContain("submittedDate:[202601011200 TO ");
    expect(parsed.searchParams.get("start")).toBe("0");
    expect(parsed.searchParams.get("max_results")).toBe("100");
    expect(parsed.searchParams.get("sortOrder")).toBe("descending");
  });

  it("claims quota and creates a segment job in one transaction",async()=>{
    const query=vi.fn(async(sql:string)=>{
      if(sql.startsWith("SELECT p.project_operation_id"))return{rows:[{project_operation_id:null,project_operation_kind:null}],rowCount:1};
      if(sql.startsWith("SELECT p.*, o.kind AS project_operation_kind"))return{rows:[{status:"approved",source_channel_id:"channel-1",quota_policy_json:{window:"minute",limit_count:2},strategy_json:{max_items:25},items_ingested:0,project_operation_id:null,project_operation_kind:null,operation_max_items:null}],rowCount:1};
      if(sql.startsWith("SELECT source_connection_id FROM source_channels"))return{rows:[{source_connection_id:"connection-1"}],rowCount:1};
      if(sql.startsWith("SELECT * FROM source_backfill_segments"))return{rows:[{id:"segment-1",window_json:{cursor:0,max_items:25}}],rowCount:1};
      if(sql.startsWith("UPDATE source_quota_buckets SET used_count"))return{rows:[{reset_at:"2026-01-01T00:01:00.000Z"}],rowCount:1};
      return{rows:[],rowCount:0};
    });
    const release=vi.fn(),connect=vi.fn().mockResolvedValue({query,release});
    const result=await new SourceBackfillExecutionService({connect,query:vi.fn()} as unknown as Queryable).executeNext("space-1","plan-1");
    expect(result).toMatchObject({segment_id:"segment-1"});
    const statements=query.mock.calls.map(call=>String(call[0]));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.find(statement => statement.startsWith("INSERT INTO source_quota_buckets"))).toContain('"window"');
    expect(statements).toEqual(expect.arrayContaining([expect.stringContaining("INSERT INTO extraction_jobs"),"COMMIT"]));
    expect(release).toHaveBeenCalledOnce();
  });

  it("persists the actual quota reset on both segment and plan",async()=>{
    const reset="2026-01-01T00:01:00.000Z";
    const query=vi.fn(async(sql:string)=>{
      if(sql.startsWith("SELECT p.project_operation_id"))return{rows:[{project_operation_id:null,project_operation_kind:null}],rowCount:1};
      if(sql.startsWith("SELECT p.*, o.kind AS project_operation_kind"))return{rows:[{status:"running",source_channel_id:"channel-1",quota_policy_json:{window:"minute",limit_count:1},strategy_json:{max_items:25},items_ingested:0,project_operation_id:null,project_operation_kind:null,operation_max_items:null}],rowCount:1};
      if(sql.startsWith("SELECT source_connection_id FROM source_channels"))return{rows:[{source_connection_id:"connection-1"}],rowCount:1};
      if(sql.startsWith("SELECT * FROM source_backfill_segments"))return{rows:[{id:"segment-1",window_json:{cursor:1}}],rowCount:1};
      if(sql.startsWith("UPDATE source_quota_buckets SET used_count"))return{rows:[],rowCount:0};
      if(sql.startsWith("SELECT reset_at FROM source_quota_buckets"))return{rows:[{reset_at:reset}],rowCount:1};
      return{rows:[],rowCount:0};
    });
    const result=await new SourceBackfillExecutionService({query} as Queryable).executeNext("space-1","plan-1");
    expect(result).toEqual({paused:true,next_eligible_at:reset});
    expect(query.mock.calls.some(call=>String(call[0]).includes("scope_kind='source_connection'"))).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE source_backfill_segments SET next_eligible_at"),["segment-1","space-1",reset]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE source_backfill_plans SET status='paused'"),expect.arrayContaining(["plan-1","space-1",reset]));
  });

  it("defers a retryable extraction failure and preserves safe diagnostics", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.startsWith("SELECT s.id AS segment_id")) {
        return {
          rows: [{
            segment_id: "segment-1",
            extraction_job_id: "job-1",
            window_json: {},
            status: "failed",
            items_created: 0,
            items_updated: 0,
            error_code: "503",
            error_message: "arXiv history import failed after 2 attempts",
            metadata_json: {
              failure_diagnostics: {
                provider_key: "arxiv",
                provider_display_name: "arXiv",
                connector_key: "arxiv_api",
                upstream_status: 500,
                attempts: 2,
                retryable: true,
                failure_kind: "upstream_http",
              },
            },
            attempt_count: 1,
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("SELECT p.project_operation_id")) {
        return { rows: [{ project_operation_id: null, project_operation_kind: null }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT p.*, o.kind AS project_operation_kind")) {
        return { rows: [{ status: "failed" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await new SourceBackfillExecutionService({ query } as Queryable).reconcile("space-1", "plan-1");

    const failureWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("SET status='pending', extraction_job_id=NULL")
    );
    expect(failureWrite?.[1]?.[2]).toEqual(expect.any(String));
    expect(JSON.parse(String(failureWrite?.[1]?.[3]))).toMatchObject({
      code: "503",
      message: "arXiv history import failed after 2 attempts",
      extraction_job_id: "job-1",
      deferred_retry: true,
      next_retry_at: expect.any(String),
      diagnostics: {
        provider_key: "arxiv",
        provider_display_name: "arXiv",
        connector_key: "arxiv_api",
        upstream_status: 500,
        attempts: 2,
        retryable: true,
        failure_kind: "upstream_http",
      },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='paused', next_eligible_at=$3"),
      ["plan-1", "space-1", expect.any(String), expect.any(String)],
    );
  });

  it("keys the quota bucket by source connection so two plans on the same connection share one budget", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.startsWith("SELECT p.project_operation_id")) {
        return { rows: [{ project_operation_id: null, project_operation_kind: null }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT p.*, o.kind AS project_operation_kind")) {
        return {
          rows: [{
            status: "approved",
            source_channel_id: "channel-shared",
            quota_policy_json: { window: "minute", limit_count: 5 },
            strategy_json: { max_items: 25 },
            items_ingested: 0,
            project_operation_id: null,
            project_operation_kind: null,
            operation_max_items: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("SELECT source_connection_id FROM source_channels")) return { rows: [{ source_connection_id: "connection-shared" }], rowCount: 1 };
      if (sql.startsWith("SELECT * FROM source_backfill_segments")) return { rows: [{ id: "segment-1", window_json: { cursor: 0, max_items: 25 } }], rowCount: 1 };
      if (sql.startsWith("UPDATE source_quota_buckets SET used_count")) return { rows: [{ reset_at: "2026-01-01T00:01:00.000Z" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await new SourceBackfillExecutionService({ query } as Queryable).executeNext("space-1", "plan-a");
    const scopeKeyArgs = query.mock.calls
      .filter((call) => String(call[0]).includes("scope_kind='source_connection'") || String(call[0]).startsWith("INSERT INTO source_quota_buckets"))
      .map((call) => call[1] as unknown[]);
    for (const args of scopeKeyArgs) expect(args).toContain("connection-shared");
    expect(scopeKeyArgs.some((args) => args.includes("plan-a"))).toBe(false);
  });

  it("starts a Project Research plan from the user's start action without a proposal", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT id FROM project_operations")) {
        return { rows: [{ id: "operation-research" }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT status FROM source_backfill_plans")) {
        return { rows: [{ status: "draft" }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT p.project_operation_id")) {
        return { rows: [{ project_operation_id: "operation-research", project_operation_kind: "research" }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT p.*, o.kind AS project_operation_kind")) {
        return {
          rows: [{
            status: "approved",
            source_channel_id: "channel-research",
            quota_policy_json: { window: "minute", limit_count: 2 },
            strategy_json: {},
            items_ingested: 0,
            project_operation_id: "operation-research",
            project_operation_kind: "research",
            operation_max_items: 25,
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("SELECT * FROM source_backfill_segments")) {
        return { rows: [{ id: "segment-research", window_json: { cursor: 0, max_items: 25 } }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT source_connection_id FROM source_channels")) {
        return { rows: [{ source_connection_id: "connection-research" }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT COALESCE(SUM(items_ingested)")) {
        return { rows: [{ settled: "0" }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT COALESCE(SUM(COALESCE(NULLIF")) {
        return { rows: [{ reserved: "0" }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE source_quota_buckets SET used_count")) {
        return { rows: [{ reset_at: "2026-01-01T00:01:00.000Z" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await new SourceBackfillExecutionService({ query } as Queryable).startUserAuthorized(
      "space-1",
      "plan-research",
      "operation-research",
      "user-1",
    );

    expect(result).toMatchObject({ segment_id: "segment-research" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='approved', proposal_id=NULL"),
      ["plan-research", "space-1", "operation-research", "user-1"],
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO proposals"))).toBe(false);
  });
});
