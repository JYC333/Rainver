import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SourceExtractionWorker } from "../src/modules/sources/extractionWorker.js";
import { __setArxivThrottleForTests } from "../src/modules/sources/connectors/arxivThrottle.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { handleSourceRetrievalTestSql } from "./support/sourceRetrievalTestSql.js";

type ConnectorKey = "rss" | "atom" | "web_page" | "arxiv_api";
type CapturePolicy =
  | "reference_only"
  | "extract_text"
  | "archive_original";
type ChildJob = {
  id: string;
  connection_id: string | null;
  source_item_id: string | null;
  job_type: "extract_text" | "snapshot";
  status: string;
  metadata_json: Record<string, unknown>;
};

class ScanDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  private itemId = "item-new";
  private status = "running";
  private readonly childJobs: ChildJob[] = [];
  private schedulerTask: Record<string, unknown> | null;

  constructor(private readonly input: {
    connectorKey: ConnectorKey
    capturePolicy: CapturePolicy
    policyRetention: "metadata_only" | "summary_only" | "full_text" | "full_snapshot"
    configJson?: Record<string, unknown>
    existingItemId?: string
    existingContentState?: string
    existingFollowUpStatus?: "pending" | "running" | "failed"
    manualScan?: boolean
    runFollowUpJobs?: boolean
    linkedProjectId?: string
    compiledQuery?: Record<string, unknown>
    searchSpecMissing?: boolean
    backfill?: boolean
  }) {
    this.schedulerTask = {
      id: "task-1",
      task_type: "source_channel_scan",
      task_key: "conn-1",
      scope_type: "space",
      scope_id: "space-1",
      space_id: "space-1",
      user_id: "user-1",
      status: "active",
      next_run_at: null,
      last_run_at: null,
      state_json: {},
      metadata_json: { cursor: this.input.configJson?.scan_cursor ?? {} },
      created_at: "2026-06-30T00:00:00.000Z",
      updated_at: "2026-06-30T00:00:00.000Z",
    };
  }

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    const retrievalResult = handleSourceRetrievalTestSql<Row>(sql, params);
    if (retrievalResult) return retrievalResult;
    if (sql.includes("SET status = 'running'")) {
      const jobId = String(params[0]);
      const child = this.childJobs.find((entry) => entry.id === jobId);
      if (child) {
        child.status = "running";
        return { rows: [childJobRow(child)] as Row[], rowCount: 1 };
      }
      return { rows: [scanJob(this.input.manualScan ? "manual_scan" : "scheduler", this.input.backfill)] as Row[], rowCount: 1 };
    }
    if (sql.includes("JOIN source_connectors")) {
      return { rows: [this.connection()] as Row[], rowCount: 1 };
    }
    if (sql.includes("FROM scheduler_tasks")) {
      return {
        rows: this.schedulerTask ? [this.schedulerTask as Row] : [],
        rowCount: this.schedulerTask ? 1 : 0,
      };
    }
    if (sql.includes("SELECT window_json,status FROM source_backfill_segments")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("FROM settings")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO scheduler_tasks")) {
      this.schedulerTask = {
        id: this.schedulerTask?.id ?? params[0],
        task_type: params[1],
        task_key: params[2],
        scope_type: params[3],
        scope_id: params[4],
        space_id: params[5] ?? null,
        user_id: params[6] ?? null,
        status: params[7],
        next_run_at: params[8] ?? null,
        last_run_at: params[9] ?? this.schedulerTask?.last_run_at ?? null,
        state_json: JSON.parse(String(params[10] ?? "{}")),
        metadata_json: JSON.parse(String(params[11] ?? "{}")),
        created_at: this.schedulerTask?.created_at ?? params[11],
        updated_at: params[11],
      };
      return { rows: [this.schedulerTask as Row], rowCount: 1 };
    }
    if (sql.includes("FROM source_connections")) {
      return { rows: [this.connection()] as Row[], rowCount: 1 };
    }
    if (sql.includes("SELECT id, space_id, connection_id, source_uri") && sql.includes("FROM source_items")) {
      return { rows: [this.sourceItem()] as Row[], rowCount: 1 };
    }
    if (sql.includes("FROM source_items si") && sql.includes("COALESCE(")) {
      return { rows: [this.sourceItem()] as Row[], rowCount: 1 };
    }
    if (sql.includes("FROM project_source_bindings psb")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("SELECT EXISTS") && sql.includes("FROM project_source_item_links")) {
      return { rows: [{ exists: false }] as Row[], rowCount: 1 };
    }
    if (sql.includes("SELECT DISTINCT link.project_id") && sql.includes("FROM project_source_item_links")) {
      const rows = this.input.linkedProjectId ? [{ project_id: this.input.linkedProjectId }] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("FROM projects project") && sql.includes("FOR UPDATE")) {
      const rows = this.input.linkedProjectId ? [{ status: "active" }] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("SELECT status FROM projects") && sql.includes("FOR UPDATE")) {
      const rows = this.input.linkedProjectId ? [{ status: "active" }] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("FROM project_research_workflows")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("project_corpus_items") || sql.includes("project_corpus_item_sources")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("content_state = 'extraction_failed'") && sql.includes("FROM source_items")) {
      const rows = this.input.existingItemId && this.input.existingContentState === "extraction_failed"
        ? [{ id: this.input.existingItemId }]
        : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("SELECT id") && sql.includes("FROM source_items")) {
      const rows = this.input.existingItemId
        ? [{ id: this.input.existingItemId, content_state: this.input.existingContentState ?? "metadata_only" }]
        : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO source_items")) {
      this.itemId = String(params[0]);
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("UPDATE source_items") && sql.includes("SET title = $3")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("UPDATE source_items")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("SELECT owner_user_id, access_level FROM source_items")) {
      return { rows: [{ owner_user_id: "user-1", access_level: "full" }] as Row[], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO artifacts")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO source_snapshots")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO source_channel_item_links")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO extracted_evidence")) {
      return { rows: [{ id: String(params[0]) }] as Row[], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO evidence_links")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO extraction_jobs")) {
      this.childJobs.push({
        id: String(params[0]),
        connection_id: nullableString(params[2]),
        source_item_id: nullableString(params[3]),
        job_type: params[5] === "snapshot" ? "snapshot" : "extract_text",
        status: "pending",
        metadata_json: JSON.parse(String(params[6])) as Record<string, unknown>,
      });
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("UPDATE source_connections")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("UPDATE extraction_jobs") && sql.includes("items_seen")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("UPDATE extraction_jobs") && sql.includes("failure_diagnostics")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("SET status = $3")) {
      const jobId = String(params[0]);
      const child = this.childJobs.find((entry) => entry.id === jobId);
      if (child) {
        child.status = String(params[2]);
      } else {
        this.status = String(params[2]);
      }
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("UPDATE extraction_jobs SET source_snapshot_id")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("status IN ('pending', 'running')")) {
      const rows = this.input.existingFollowUpStatus === "pending" || this.input.existingFollowUpStatus === "running"
        ? [{ id: "job-existing-follow-up" }]
        : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("metadata_json->>'parent_job_id'")) {
      const rows = this.input.runFollowUpJobs
        ? this.childJobs
          .filter((child) => child.status === "pending" && child.metadata_json.parent_job_id === params[1])
          .map((child) => ({ id: child.id }))
        : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("FROM extraction_jobs")) {
      const jobId = String(params[0]);
      const child = this.childJobs.find((entry) => entry.id === jobId);
      if (child) return { rows: [childJobRow(child)] as Row[], rowCount: 1 };
      return {
        rows: [{
          ...scanJob(this.input.manualScan ? "manual_scan" : "scheduler", this.input.backfill),
          status: this.status,
          source_item_id: this.itemId,
        }] as Row[],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  private connection() {
    return {
      id: "conn-1",
      space_id: "space-1",
      connector_id: "connector-1",
      owner_user_id: "user-1",
      visibility: "private",
      access_level: "full",
      credential_id: null,
      name: "Source",
      endpoint_url: this.input.connectorKey === "arxiv_api" ? null : "https://example.test/feed.xml",
      status: "active",
      fetch_frequency: "hourly",
      capture_policy: this.input.capturePolicy,
      trust_level: "normal",
      topic_hints_json: null,
      consent_json: {},
      policy_json: {
        retention_policy: this.input.policyRetention,
        source_egress_class: "internal_only",
        derived_write_policy: "proposal_required",
      },
      config_json: this.input.configJson ?? {},
      last_checked_at: null,
      next_check_at: null,
      created_at: "2026-06-30T00:00:00.000Z",
      updated_at: "2026-06-30T00:00:00.000Z",
      connector_key: this.input.connectorKey,
      provider_key: this.input.connectorKey === "arxiv_api" ? "arxiv" : "rss",
      provider_display_name: this.input.connectorKey === "arxiv_api" ? "arXiv" : "RSS",
      channel_type: this.input.connectorKey === "arxiv_api" ? "search" : "feed",
      provider_query_json: this.input.connectorKey === "arxiv_api"
        ? this.input.searchSpecMissing
          ? null
          : this.input.compiledQuery ?? { search_query: "all:*", max_results: 100 }
        : {},
      channel_id: "conn-1",
      deleted_at: null,
    };
  }

  private sourceItem() {
    const sourceUri = this.input.connectorKey === "web_page"
      ? "https://example.test/feed.xml"
      : "https://example.test/item-1";
    return {
      id: this.input.existingItemId ?? this.itemId,
      space_id: "space-1",
      connection_id: "conn-1",
      source_uri: sourceUri,
      canonical_uri: sourceUri,
      source_external_id: "guid-1",
      title: "Feed item",
      excerpt: "Feed excerpt.",
      author: null,
      occurred_at: "2026-06-30T09:00:00.000Z",
      content_state: "content_queued",
      visibility: "private",
      access_level: "full",
    };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  __setArxivThrottleForTests(null);
});

describe("SourceExtractionWorker connection_scan", () => {
  it("fetches an RSS feed, writes item/snapshot metadata, and stores the new scan cursor", async () => {
    const db = new ScanDb({
      connectorKey: "rss",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(rssFeed(), {
      status: 200,
      headers: {
        etag: "\"feed-v1\"",
        "last-modified": "Tue, 30 Jun 2026 09:30:00 GMT",
      },
    }));

    await expect(new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1"))
      .resolves.toMatchObject({ status: "succeeded" });

    const dedupeLookup = db.calls.find(call => call.sql.includes("canonical_uri = $3::text"));
    expect(dedupeLookup?.params.slice(0, 11)).toEqual([
      "space-1",
      "https://example.test/item-1",
      "https://example.test/item-1",
      undefined,
      null,
      "guid-1",
      "conn-1",
      "guid-1",
      expect.any(String),
      "conn-1",
      expect.any(String),
    ]);
    expect(db.calls.some(call => call.sql.includes("INSERT INTO source_items"))).toBe(true);
    const snapshotInsert = db.calls.find(call => call.sql.includes("INSERT INTO source_snapshots"));
    expect(snapshotInsert?.sql).toContain("space_id = $15::varchar");
    expect(snapshotInsert?.params.slice(11, 26)).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "space-1",
      expect.any(String),
      "space-1",
      "conn-1",
      "space-1",
      expect.any(String),
      "space-1",
      "conn-1",
      "space-1",
      expect.any(String),
      "space-1",
      "conn-1",
    ]);
    expect(db.calls.some(call => call.sql.includes("INSERT INTO extracted_evidence"))).toBe(false);
    const schedulerUpdate = db.calls.find(call => call.sql.includes("INSERT INTO scheduler_tasks"));
    expect(JSON.parse(String(schedulerUpdate?.params[11])).cursor).toEqual({
      etag: "\"feed-v1\"",
      last_modified: "Tue, 30 Jun 2026 09:30:00 GMT",
      last_guid: "guid-1",
      last_published_at: "2026-06-30T09:00:00.000Z",
    });
    expect(JSON.parse(String(schedulerUpdate?.params[11])).watermark).toEqual({ value: "2026-06-30T09:00:00.000Z" });
    const stats = db.calls.find(call => call.sql.includes("items_seen"));
    expect(stats?.params.slice(2, 5)).toEqual([1, 1, 0]);
  });

  it("updates an existing feed item when canonical/sources/hash dedupe finds one", async () => {
    const db = new ScanDb({
      connectorKey: "rss",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
      existingItemId: "item-existing",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(rssFeed(), { status: 200 }));

    await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(db.calls.some(call => call.sql.includes("INSERT INTO source_items"))).toBe(false);
    expect(db.calls.some(call => call.sql.includes("UPDATE source_items") && call.sql.includes("SET title = $3"))).toBe(true);
    const stats = db.calls.find(call => call.sql.includes("items_seen"));
    expect(stats?.params.slice(2, 5)).toEqual([1, 0, 1]);
  });

  it("scans web pages with title, excerpt, and raw content hash", async () => {
    const raw = "<html><head><title>Hello page</title></head><body><p>Visible text.</p></body></html>";
    const db = new ScanDb({
      connectorKey: "web_page",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(raw, { status: 200 }));

    await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    const insert = db.calls.find(call => call.sql.includes("INSERT INTO source_items"));
    expect(insert?.params[3]).toBe("external_url");
    expect(insert?.params[4]).toBe("Hello page");
    expect(insert?.params[12]).toBe(sha256(["Hello page", "https://example.test/feed.xml", "Hello page", "Hello page Visible text.", ""].join("\n")));
    expect(insert?.params[13]).toContain("Visible text.");
  });

  it("sends conditional fetch headers and advances scan state on 304 responses", async () => {
    const db = new ScanDb({
      connectorKey: "rss",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
      configJson: {
        scan_cursor: {
          etag: "\"old\"",
          last_modified: "Tue, 30 Jun 2026 08:00:00 GMT",
          last_guid: "guid-old",
        },
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 304 }));

    await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://example.test/feed.xml");
    expect(request?.redirect).toBe("follow");
    const requestHeaders = new Headers(request?.headers);
    expect(requestHeaders.get("If-None-Match")).toBe("\"old\"");
    expect(requestHeaders.get("If-Modified-Since")).toBe("Tue, 30 Jun 2026 08:00:00 GMT");
    expect(requestHeaders.get("Accept-Encoding")).toBe("identity");
    expect(db.calls.some(call => call.sql.includes("INSERT INTO source_items"))).toBe(false);
    const stats = db.calls.find(call => call.sql.includes("items_seen"));
    expect(stats?.params.slice(2, 5)).toEqual([0, 0, 0]);
    expect(JSON.parse(String(stats?.params[5]))).toEqual({ not_modified: true });
  });

  it("queues extract_text follow-up jobs for extract_text scans", async () => {
    const db = new ScanDb({
      connectorKey: "rss",
      capturePolicy: "extract_text",
      policyRetention: "full_text",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(rssFeed(), { status: 200 }));

    await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    const followUp = db.calls.find(call =>
      call.sql.includes("INSERT INTO extraction_jobs") && call.params[5] === "extract_text"
    );
    expect(followUp?.params[2]).toBe("conn-1");
    expect(followUp?.params[3]).toEqual(expect.any(String));
    expect(db.calls.some(call => call.sql.includes("INSERT INTO extracted_evidence"))).toBe(false);
  });

  it("runs extract_text follow-up jobs after a successful full-text scan", async () => {
    const db = new ScanDb({
      connectorKey: "rss",
      capturePolicy: "extract_text",
      policyRetention: "full_text",
      runFollowUpJobs: true,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(rssFeed(), { status: 200 }))
      .mockResolvedValueOnce(new Response("<html><body><article>Full article text.</article></body></html>", { status: 200 }));

    await expect(new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1"))
      .resolves.toMatchObject({ status: "succeeded" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://example.test/item-1");
    const childClaim = db.calls.find((call) =>
      call.sql.includes("SET status = 'running'") && call.params[0] !== "job-1"
    );
    expect(childClaim).toBeTruthy();
    const childFinish = db.calls.find((call) =>
      call.sql.includes("SET status = $3") && call.params[0] !== "job-1"
    );
    expect(childFinish?.params[2]).toBe("succeeded");
    const artifactInsert = db.calls.find((call) => call.sql.includes("INSERT INTO artifacts"));
    expect(artifactInsert?.sql).toContain("'source_reader_document'");
    expect(artifactInsert?.params).toContain(JSON.stringify(["json"]));
    const evidenceInsert = db.calls.find(call => call.sql.includes("INSERT INTO extracted_evidence"));
    expect(evidenceInsert?.sql).toContain("RETURNING id");
    expect(evidenceInsert?.params.slice(1, 8)).toEqual([
      "space-1",
      null,
      "user-1",
      "private",
      "full",
      expect.any(String),
      null,
    ]);
  });

  it("queues extract_text when an existing shallow feed item is upgraded to full-text capture", async () => {
    const db = new ScanDb({
      connectorKey: "rss",
      capturePolicy: "extract_text",
      policyRetention: "full_text",
      existingItemId: "item-existing",
      existingContentState: "metadata_only",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(rssFeed(), { status: 200 }));

    await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(db.calls.some(call => call.sql.includes("INSERT INTO source_items"))).toBe(false);
    const followUp = db.calls.find(call =>
      call.sql.includes("INSERT INTO extraction_jobs") && call.params[5] === "extract_text"
    );
    expect(followUp?.params[3]).toBe("item-existing");
  });

  it("queues extract_text when an existing failed feed item is rescanned", async () => {
    const db = new ScanDb({
      connectorKey: "rss",
      capturePolicy: "extract_text",
      policyRetention: "full_text",
      existingItemId: "item-existing",
      existingContentState: "extraction_failed",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(rssFeed(), { status: 200 }));

    await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    const itemUpdate = db.calls.find(call =>
      call.sql.includes("UPDATE source_items") && call.sql.includes("SET title = $3")
    );
    expect(itemUpdate?.sql).toContain("extraction_failed");
    expect(itemUpdate?.params[12]).toBe("content_queued");
    const followUp = db.calls.find(call =>
      call.sql.includes("INSERT INTO extraction_jobs") && call.params[5] === "extract_text"
    );
    expect(followUp?.params[3]).toBe("item-existing");
  });

  it("does not queue a duplicate extract_text job when one is already active", async () => {
    const db = new ScanDb({
      connectorKey: "rss",
      capturePolicy: "extract_text",
      policyRetention: "full_text",
      existingItemId: "item-existing",
      existingContentState: "extraction_failed",
      existingFollowUpStatus: "pending",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(rssFeed(), { status: 200 }));

    await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(db.calls.some(call => call.sql.includes("INSERT INTO extraction_jobs"))).toBe(false);
  });

  it("scans arXiv connections into paper feed items with canonical abs URLs", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ScanDb({
      connectorKey: "arxiv_api",
      capturePolicy: "extract_text",
      policyRetention: "full_text",
      compiledQuery: { search_query: 'all:"agent memory"', max_results: 17 },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(arxivFeed(), { status: 200 }));

    await expect(new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1"))
      .resolves.toMatchObject({ status: "succeeded" });

    const [requestUrl] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const request = new URL(String(requestUrl));
    expect(request.searchParams.get("search_query")).toBe('all:"agent memory"');
    expect(request.searchParams.get("max_results")).toBe("17");

    const insert = db.calls.find(call => call.sql.includes("INSERT INTO source_items"));
    expect(insert?.params[3]).toBe("feed_entry");
    expect(insert?.params[4]).toBe("Agent Paper Title");
    expect(insert?.params[5]).toBe("https://arxiv.org/abs/2402.08954");
    expect(insert?.params[6]).toBe("https://arxiv.org/abs/2402.08954");
    expect(insert?.params[8]).toBe("2402.08954");
    expect(insert?.params[9]).toBe("Author One, Author Two");
    expect(insert?.params[10]).toBe("2024-02-14T05:19:17.000Z");
    expect(insert?.params[13]).toBe("Abstract text for the agent paper.");
    expect(JSON.parse(String(insert?.params[16]))).toMatchObject({
      arxiv_id: "2402.08954",
      arxiv_version: "v2",
      categories: ["cs.AI", "cs.LG"],
      primary_category: "cs.AI",
      doi: "10.1234/example",
      capture_method: "connection_scan",
      connector_key: "arxiv_api",
    });
    const followUp = db.calls.find(call =>
      call.sql.includes("INSERT INTO extraction_jobs") && call.params[5] === "extract_text"
    );
    expect(followUp).toBeTruthy();
    const schedulerUpdate = db.calls.find(call => call.sql.includes("INSERT INTO scheduler_tasks"));
    expect(JSON.parse(String(schedulerUpdate?.params[11])).cursor).toMatchObject({
      last_guid: "2402.08954",
      last_published_at: "2024-02-14T05:19:17.000Z",
    });
    const stats = db.calls.find(call => call.sql.includes("items_seen"));
    expect(stats?.params.slice(2, 5)).toEqual([1, 1, 0]);
  });

  it("retries a transient arXiv backfill 5xx once before succeeding", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ScanDb({
      connectorKey: "arxiv_api",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
      backfill: true,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(arxivFeed(), { status: 200 }));

    await expect(new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1"))
      .resolves.toMatchObject({ status: "succeeded" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records safe diagnostics after an arXiv backfill exhausts every page size", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ScanDb({
      connectorKey: "arxiv_api",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
      backfill: true,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 500 }));

    await expect(new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1"))
      .resolves.toMatchObject({ status: "failed" });

    // A provider 5xx is now worth a narrower ask before the segment is failed:
    // three rungs of the page ladder, each retried once inside the fetch.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const requestedPageSizes = fetchMock.mock.calls.map(call =>
      new URL(String(call[0])).searchParams.get("max_results"));
    expect(requestedPageSizes).toEqual(["100", "100", "25", "25", "10", "10"]);
    const diagnosticsWrite = db.calls.find(call =>
      call.sql.includes("failure_diagnostics")
    );
    expect(JSON.parse(String(diagnosticsWrite?.params[2]))).toEqual({
      provider_key: "arxiv",
      provider_display_name: "arXiv",
      connector_key: "arxiv_api",
      upstream_status: 500,
      attempts: 2,
      retryable: true,
      failure_kind: "upstream_http",
      error_name: null,
      error_code: null,
      elapsed_ms: expect.any(Number),
      timeout_ms: expect.any(Number),
      page_sizes_attempted: [100, 25, 10],
    });
    const failure = db.calls.find(call => call.sql.includes("SET status = $3"));
    expect(failure?.params.slice(2, 6)).toEqual([
      "failed",
      expect.any(String),
      "503",
      expect.stringContaining("failed after 2 attempts"),
    ]);
  });

  it("does not retry a permanent arXiv backfill 4xx", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ScanDb({
      connectorKey: "arxiv_api",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
      backfill: true,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 400 }));

    await expect(new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1"))
      .resolves.toMatchObject({ status: "failed" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed before fetch when a search channel has no executable Search Spec", async () => {
    const db = new ScanDb({
      connectorKey: "arxiv_api",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
      searchSpecMissing: true,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1"))
      .resolves.toMatchObject({ status: "failed" });

    expect(fetchMock).not.toHaveBeenCalled();
    const failure = db.calls.find((call) => call.sql.includes("SET status = $3"));
    expect(failure?.params.slice(2, 6)).toEqual([
      "failed",
      expect.any(String),
      "422",
      "Search channel is missing its executable Search Spec",
    ]);
  });

  it("truncates arXiv author and excerpt values to their source_items column widths", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ScanDb({
      connectorKey: "arxiv_api",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
    });
    const authors = Array.from({ length: 120 }, (_, index) => `<author><name>Author ${index}</name></author>`).join("");
    const longFeed = arxivFeed()
      .replace("<author><name>Author One</name></author>\n        <author><name>Author Two</name></author>", authors)
      .replace("Abstract text for the agent paper.", "A".repeat(3000));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(longFeed, { status: 200 }));

    await expect(new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1"))
      .resolves.toMatchObject({ status: "succeeded" });

    const insert = db.calls.find(call => call.sql.includes("INSERT INTO source_items"));
    expect(String(insert?.params[9]).length).toBeLessThanOrEqual(512);
    expect(String(insert?.params[13]).length).toBeLessThanOrEqual(2048);
  });

  it("relinks existing arXiv item evidence after another source scans the same paper", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ScanDb({
      connectorKey: "arxiv_api",
      capturePolicy: "reference_only",
      policyRetention: "metadata_only",
      existingItemId: "item-existing",
      existingContentState: "content_saved",
      linkedProjectId: "project-1",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(arxivFeed(), { status: 200 }));

    await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    const linkCall = db.calls.find(call => call.sql.includes("INSERT INTO evidence_links"));
    expect(linkCall?.sql).toContain("FROM extracted_evidence ev");
    expect(linkCall?.sql).toContain("JOIN project_source_item_links psil");
    expect(linkCall?.params.slice(0, 2)).toEqual(["space-1", "item-existing"]);
  });

  it("retries failed extract_text jobs on manual not-modified scans", async () => {
    const db = new ScanDb({
      connectorKey: "rss",
      capturePolicy: "extract_text",
      policyRetention: "full_text",
      existingItemId: "item-existing",
      existingContentState: "extraction_failed",
      manualScan: true,
      runFollowUpJobs: true,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response("<html><body><article>Retried full text.</article></body></html>", { status: 200 }));

    await expect(new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1"))
      .resolves.toMatchObject({ status: "succeeded" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://example.test/item-1");
    const followUp = db.calls.find(call =>
      call.sql.includes("INSERT INTO extraction_jobs") && call.params[5] === "extract_text"
    );
    expect(followUp?.params[3]).toBe("item-existing");
    expect(JSON.parse(String(followUp?.params[6]))).toMatchObject({
      created_by: "connection_scan_retry",
      retry_reason: "previous_extraction_failed",
    });
    const childFinish = db.calls.find((call) =>
      call.sql.includes("SET status = $3") && call.params[0] !== "job-1"
    );
    expect(childFinish?.params[2]).toBe("succeeded");
  });
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    ARTIFACT_STORAGE_ROOT: "/tmp/agent-space-test-artifacts",
  });
}

function scanJob(createdBy: "manual_scan" | "scheduler" = "scheduler", backfill = false) {
  return {
    id: "job-1",
    space_id: "space-1",
    connection_id: "conn-1",
    source_item_id: null,
    source_object_type: null,
    source_object_id: null,
    job_type: "connection_scan",
    status: "running",
    metadata_json: {
      created_by: createdBy,
      ...(backfill ? {
        source_backfill_plan_id: "plan-1",
        source_backfill_segment_id: "segment-1",
        source_channel_id: "conn-1",
        window: { from: "2024-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z", max_items: 100 },
      } : {}),
    },
  };
}

function childJobRow(job: ChildJob) {
  return {
    id: job.id,
    space_id: "space-1",
    connection_id: job.connection_id,
    source_item_id: job.source_item_id,
    source_object_type: null,
    source_object_id: null,
    job_type: job.job_type,
    status: job.status,
    metadata_json: job.metadata_json,
  };
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function rssFeed() {
  return `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>Feed item</title>
          <link>https://example.test/item-1</link>
          <guid>guid-1</guid>
          <pubDate>Tue, 30 Jun 2026 09:00:00 GMT</pubDate>
          <description>Feed excerpt.</description>
        </item>
      </channel>
    </rss>`;
}

function arxivFeed() {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry>
        <id>http://arxiv.org/abs/2402.08954v2</id>
        <updated>2024-02-15T05:19:17Z</updated>
        <published>2024-02-14T05:19:17Z</published>
        <title>Agent Paper Title</title>
        <summary>Abstract text for the agent paper.</summary>
        <author><name>Author One</name></author>
        <author><name>Author Two</name></author>
        <arxiv:doi>10.1234/example</arxiv:doi>
        <link href="http://arxiv.org/abs/2402.08954v2" rel="alternate" type="text/html"/>
        <link title="pdf" href="http://arxiv.org/pdf/2402.08954v2" rel="related" type="application/pdf"/>
        <arxiv:primary_category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
        <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
        <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
      </entry>
    </feed>`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
