import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildArxivQueryUrl,
  parseArxivFeed,
  parseArxivReference,
} from "../src/modules/sources/connectors/arxiv.js";
import {
  __setArxivThrottleForTests,
  acquireArxivRequestSlot,
} from "../src/modules/sources/connectors/arxivThrottle.js";
import { SourceExtractionWorker } from "../src/modules/sources/extractionWorker.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { HttpError } from "../src/modules/routeUtils/common.js";
import { simplePdfBytes } from "./fixtures/simplePdf.js";
import { handleSourceRetrievalTestSql } from "./support/sourceRetrievalTestSql.js";

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    ARTIFACT_STORAGE_ROOT: "/tmp/agent-space-test-artifacts",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  __setArxivThrottleForTests(null);
});

// ── arXiv id / URL parsing ────────────────────────────────────────────────────

describe("parseArxivReference", () => {
  it.each([
    ["https://arxiv.org/abs/2402.08954", "2402.08954", null],
    ["https://arxiv.org/abs/2402.08954v2", "2402.08954", "v2"],
    ["https://arxiv.org/pdf/2402.08954", "2402.08954", null],
    ["https://arxiv.org/pdf/2402.08954v1.pdf", "2402.08954", "v1"],
    ["https://arxiv.org/html/2402.08954v3", "2402.08954", "v3"],
    ["http://export.arxiv.org/abs/2402.08954v1", "2402.08954", "v1"],
    ["arXiv:2402.08954v2", "2402.08954", "v2"],
    ["2402.08954", "2402.08954", null],
    ["hep-th/9901001v2", "hep-th/9901001", "v2"],
    ["https://arxiv.org/abs/hep-th/9901001v2", "hep-th/9901001", "v2"],
    ["https://arxiv.org/pdf/math.GT/0309136", "math.GT/0309136", null],
    ["https://arxiv.org/abs/physics.comp-ph/9901001v2", "physics.comp-ph/9901001", "v2"],
  ])("parses %s", (input, baseId, version) => {
    expect(parseArxivReference(input)).toEqual({ baseId, version });
  });

  it.each([
    "https://example.com/abs/2402.08954",
    "https://arxiv.org/list/cs.AI/recent",
    "https://arxiv.org/abs/not-an-id",
    "not a reference",
    "",
    null,
  ])("returns null for %s", (input) => {
    expect(parseArxivReference(input)).toBeNull();
  });
});

describe("buildArxivQueryUrl", () => {
  it("builds an export.arxiv.org query URL from a normalized config", () => {
    const url = buildArxivQueryUrl({
      search_query: 'cat:cs.AI AND all:"agent"',
      max_results: 25,
      sort_by: "lastUpdatedDate",
      sort_order: "descending",
    });
    expect(url.startsWith("https://export.arxiv.org/api/query?")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("search_query")).toBe('cat:cs.AI AND all:"agent"');
    expect(parsed.searchParams.get("start")).toBe("0");
    expect(parsed.searchParams.get("max_results")).toBe("25");
    expect(parsed.searchParams.get("sortBy")).toBe("lastUpdatedDate");
    expect(parsed.searchParams.get("sortOrder")).toBe("descending");
  });
});

// ── arXiv Atom parsing ────────────────────────────────────────────────────────

describe("parseArxivFeed", () => {
  it("parses arXiv Atom entries into normalized paper records", () => {
    const papers = parseArxivFeed(arxivFeed());
    expect(papers).toHaveLength(1);
    expect(papers[0]).toEqual({
      arxiv_id: "2402.08954",
      arxiv_version: "v2",
      title: "Agent Paper Title",
      authors: ["Author One", "Author Two"],
      summary: "Abstract text for the agent paper.",
      published_at: "2024-02-14T05:19:17.000Z",
      updated_at: "2024-02-15T05:19:17.000Z",
      categories: ["cs.AI", "cs.LG"],
      primary_category: "cs.AI",
      doi: "10.1234/example",
      journal_ref: "Example Journal 2024",
      comment: "10 pages",
      abs_url: "https://arxiv.org/abs/2402.08954",
      html_url: "https://arxiv.org/html/2402.08954",
      pdf_url: "https://arxiv.org/pdf/2402.08954",
    });
  });

  it("fails closed on arXiv API error entries instead of returning no papers", () => {
    const errorFeed = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/api/errors#incorrect_field</id>
          <title>Error</title>
          <summary>malformed query: unknown field xyz</summary>
        </entry>
      </feed>`;
    expect(() => parseArxivFeed(errorFeed)).toThrow(/arXiv API error: malformed query/);
  });

  it("skips entries without a parseable arXiv id and rejects non-Atom bodies", () => {
    const feed = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry><id>http://example.com/other</id><title>Other</title></entry>
      </feed>`;
    expect(parseArxivFeed(feed)).toEqual([]);
    expect(() => parseArxivFeed("<html><body>error page</body></html>")).toThrow(HttpError);
  });
});

// ── Polite throttle ───────────────────────────────────────────────────────────

describe("arXiv polite throttle", () => {
  it("spaces consecutive requests by the minimum interval using the injected clock", async () => {
    const sleeps: number[] = [];
    let nowMs = 0;
    __setArxivThrottleForTests({
      minIntervalMs: 3_000,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    await acquireArxivRequestSlot();
    await acquireArxivRequestSlot();
    await acquireArxivRequestSlot();

    expect(sleeps).toEqual([3_000, 3_000]);
  });
});

// Source creation is owned by SourceChannelService; this fixture covers the
// arXiv protocol and extraction boundaries only.

// ── HTML-first extraction ─────────────────────────────────────────────────────

describe("SourceExtractionWorker arXiv HTML-first extraction", () => {
  it("extracts arXiv abs URLs from the HTML rendition first", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ExtractionDb("extract_text", "https://arxiv.org/abs/2402.08954");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<html><body><article><h1>Agent Paper</h1><p>Full paper text.</p></article></body></html>",
      { status: 200 },
    ));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://arxiv.org/html/2402.08954");
    const artifactInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO artifacts"));
    expect(artifactInserts).toHaveLength(1);
    expect(artifactInserts[0]?.sql).toContain("'source_reader_document'");
    expect(String(artifactInserts[0]?.params[3])).toContain("\"extraction_method\":\"structured_html_v1\"");
    const artifactMetadata = JSON.parse(String(artifactInserts[0]?.params[6]));
    expect(artifactMetadata).toMatchObject({
      content_source_format: "html",
      content_source_url: "https://arxiv.org/html/2402.08954",
      arxiv_id: "2402.08954",
    });
    const snapshotInsert = db.calls.find((call) => call.sql.includes("INSERT INTO source_snapshots"));
    expect(JSON.parse(String(snapshotInsert?.params[10]))).toMatchObject({
      content_source_format: "html",
      arxiv_id: "2402.08954",
    });
  });

  it("falls back to the PDF rendition when the HTML rendition is unavailable", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ExtractionDb("extract_text", "https://arxiv.org/abs/2402.08954");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(simplePdfBytes("Agent Paper PDF"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("succeeded");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://arxiv.org/html/2402.08954");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://arxiv.org/pdf/2402.08954");
    const artifactInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO artifacts"));
    expect(artifactInserts).toHaveLength(2);
    expect(artifactInserts[0]?.sql).toContain("'source_raw_snapshot'");
    expect(artifactInserts[0]?.sql).toContain("space_id = $10::varchar");
    expect(artifactInserts[0]?.params[4]).toBe("application/pdf");
    expect(artifactInserts[1]?.sql).toContain("'source_reader_document'");
    expect(artifactInserts[1]?.sql).toContain("space_id = $10::varchar");
    expect(String(artifactInserts[1]?.params[3])).toContain("\"extraction_method\":\"pdf_text_v1\"");
    const extractedSnapshot = db.calls.filter((call) => call.sql.includes("INSERT INTO source_snapshots")).at(-1);
    expect(JSON.parse(String(extractedSnapshot?.params[10]))).toMatchObject({
      content_source_format: "pdf",
      content_source_url: "https://arxiv.org/pdf/2402.08954",
      fallback_from: "html",
      fallback_reason: expect.stringContaining("404"),
      arxiv_id: "2402.08954",
    });
  });

  it("fails the job with the last meaningful error when every arXiv candidate fails", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ExtractionDb("extract_text", "https://arxiv.org/abs/2402.08954");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not found", { status: 404 }));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("failed");
    const finish = db.calls.find((call) => call.sql.includes("SET status = $3"));
    expect(finish?.params[2]).toBe("failed");
    expect(finish?.params[5]).toContain("404");
  });

  it("keeps single-fetch behavior for non-arXiv URLs", async () => {
    const db = new ExtractionDb("extract_text", "https://example.test/article");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<html><body><article><p>Regular article.</p></article></body></html>",
      { status: 200 },
    ));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.test/article");
    const snapshotInsert = db.calls.find((call) => call.sql.includes("INSERT INTO source_snapshots"));
    expect(JSON.parse(String(snapshotInsert?.params[10]))).not.toHaveProperty("content_source_format");
  });

  it("prefers the HTML raw snapshot for arXiv snapshot jobs", async () => {
    __setArxivThrottleForTests({ sleep: async () => {} });
    const db = new ExtractionDb("snapshot", "https://arxiv.org/abs/2402.08954", "full_snapshot");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<html><body><article><p>HTML rendition text.</p></article></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("succeeded");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://arxiv.org/html/2402.08954");
    const artifactInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO artifacts"));
    expect(artifactInserts[0]?.sql).toContain("'source_raw_snapshot'");
    expect(artifactInserts[0]?.params[4]).toBe("text/html");
    expect(artifactInserts[1]?.sql).toContain("'source_reader_document'");
  });
});

/** Fake Queryable for extraction jobs against a configurable item source_uri. */
class ExtractionDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  private status = "running";

  constructor(
    private readonly jobType: "extract_text" | "snapshot",
    private readonly sourceUri: string,
    private readonly policyRetention: "full_text" | "full_snapshot" = "full_text",
  ) {}

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    const retrievalResult = handleSourceRetrievalTestSql<Row>(sql, params);
    if (retrievalResult) return retrievalResult;
    if (sql.includes("SET status = 'running'")) {
      return { rows: [this.jobRow()] as Row[], rowCount: 1 };
    }
    if (sql.includes("SELECT id, space_id, connection_id, source_uri")) {
      return {
        rows: [{
          id: "item-1",
          space_id: "space-1",
          connection_id: "conn-1",
          source_uri: this.sourceUri,
          title: "arXiv paper",
          content_state: "content_queued",
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM source_items si") && sql.includes("COALESCE(")) {
      return {
        rows: [{
          id: "item-1",
          space_id: "space-1",
          connection_id: "conn-1",
          source_uri: this.sourceUri,
          title: "arXiv paper",
          content_state: "content_queued",
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM project_source_bindings psb")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("SELECT EXISTS") && sql.includes("FROM project_source_item_links")) {
      return { rows: [{ exists: false }] as Row[], rowCount: 1 };
    }
    if (sql.includes("SELECT DISTINCT link.project_id") && sql.includes("FROM project_source_item_links")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("FROM projects project") && sql.includes("FOR UPDATE")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("project_corpus_items") || sql.includes("project_corpus_item_sources")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("FROM source_connections")) {
      return {
        rows: [{
          id: "conn-1",
          space_id: "space-1",
          connector_id: "connector-1",
          owner_user_id: "user-1",
          capture_policy: "extract_text",
          trust_level: "normal",
          consent_json: {},
          policy_json: { retention_policy: this.policyRetention },
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM scheduler_tasks") || sql.includes("FROM settings")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO extracted_evidence")) {
      return { rows: [{ id: String(params[0]) }] as Row[], rowCount: 1 };
    }
    if (sql.includes("SELECT owner_user_id, access_level FROM source_items")) {
      return { rows: [{ owner_user_id: "user-1", access_level: "full" }] as Row[], rowCount: 1 };
    }
    if (
      sql.includes("INSERT INTO artifacts") ||
      sql.includes("INSERT INTO source_snapshots") ||
      sql.includes("UPDATE source_items") ||
      sql.includes("UPDATE extraction_jobs SET source_snapshot_id")
    ) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO evidence_links")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes("SET status = $3")) {
      this.status = String(params[2]);
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes("SELECT") && sql.includes("FROM extraction_jobs")) {
      return { rows: [{ ...this.jobRow(), status: this.status }] as Row[], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  private jobRow() {
    return {
      id: "job-1",
      space_id: "space-1",
      connection_id: "conn-1",
      source_item_id: "item-1",
      source_object_type: null,
      source_object_id: null,
      job_type: this.jobType,
      status: "running",
      metadata_json: {},
    };
  }
}

function arxivFeed() {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <title>ArXiv Query: search_query=cat:cs.AI</title>
      <entry>
        <id>http://arxiv.org/abs/2402.08954v2</id>
        <updated>2024-02-15T05:19:17Z</updated>
        <published>2024-02-14T05:19:17Z</published>
        <title>Agent  Paper
   Title</title>
        <summary>  Abstract text for
 the agent paper.
</summary>
        <author><name>Author One</name></author>
        <author><name>Author Two</name></author>
        <arxiv:doi>10.1234/example</arxiv:doi>
        <arxiv:comment>10 pages</arxiv:comment>
        <arxiv:journal_ref>Example Journal 2024</arxiv:journal_ref>
        <link href="http://arxiv.org/abs/2402.08954v2" rel="alternate" type="text/html"/>
        <link title="pdf" href="http://arxiv.org/pdf/2402.08954v2" rel="related" type="application/pdf"/>
        <arxiv:primary_category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
        <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
        <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
      </entry>
    </feed>`;
}
