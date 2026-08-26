import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPdfReaderContent } from "../src/modules/sources/pdfExtract.js";
import { simplePdfBytes } from "./fixtures/simplePdf.js";
import { loadConfig } from "../src/config.js";
import { SourceExtractionWorker } from "../src/modules/sources/extractionWorker.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { handleSourceRetrievalTestSql } from "./support/sourceRetrievalTestSql.js";

class FakeDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  private status = "running";

  constructor(
    private readonly jobType: "extract_text" | "snapshot",
    private readonly policyRetention: "metadata_only" | "full_text" | "full_snapshot" = "metadata_only",
    private readonly downloadBytesMax: number | null = null,
  ) {}

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    const retrievalResult = handleSourceRetrievalTestSql<Row>(sql, params);
    if (retrievalResult) return retrievalResult;
    if (sql.includes("SET status = 'running'")) {
      return { rows: [jobRow(this.jobType)], rowCount: 1 } as { rows: Row[]; rowCount: number };
    }
    if (sql.includes("SELECT id, space_id, connection_id, source_uri")) {
      return {
        rows: [{
          id: "item-1",
          space_id: "space-1",
          connection_id: "conn-1",
          source_uri: "https://example.test/private",
          title: "Private page",
          content_state: "content_queued",
        }],
        rowCount: 1,
      } as { rows: Row[]; rowCount: number };
    }
    if (sql.includes("FROM source_items si") && sql.includes("COALESCE(")) {
      return {
        rows: [{
          id: "item-1",
          space_id: "space-1",
          connection_id: "conn-1",
          source_uri: "https://example.test/private",
          title: "Private page",
          content_state: "content_queued",
        }],
        rowCount: 1,
      } as { rows: Row[]; rowCount: number };
    }
    if (sql.includes("FROM project_source_bindings psb")) {
      return { rows: [] as Row[], rowCount: 0 } as { rows: Row[]; rowCount: number };
    }
    if (sql.includes("SELECT EXISTS") && sql.includes("FROM project_source_item_links")) {
      return { rows: [{ exists: false }] as Row[], rowCount: 1 } as { rows: Row[]; rowCount: number };
    }
    if (sql.includes("SELECT DISTINCT link.project_id") && sql.includes("FROM project_source_item_links")) {
      return { rows: [] as Row[], rowCount: 0 } as { rows: Row[]; rowCount: number };
    }
    if (sql.includes("FROM projects project") && sql.includes("FOR UPDATE")) {
      return { rows: [] as Row[], rowCount: 0 } as { rows: Row[]; rowCount: number };
    }
    if (sql.includes("project_corpus_items") || sql.includes("project_corpus_item_sources")) {
      return { rows: [] as Row[], rowCount: 0 } as { rows: Row[]; rowCount: number };
    }
    if (sql.includes("FROM source_connections")) {
      return {
        rows: [{
          id: "conn-1",
          space_id: "space-1",
          connector_id: "connector-1",
          owner_user_id: "user-1",
          capture_policy: "reference_only",
          trust_level: "normal",
          consent_json: {},
          policy_json: { retention_policy: this.policyRetention },
        }],
        rowCount: 1,
      } as { rows: Row[]; rowCount: number };
    }
    if (sql.includes("FROM scheduler_tasks")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM settings")) {
      if (this.downloadBytesMax !== null && params.includes("source.custom_source.space_policy")) {
        return {
          rows: [{
            id: "settings-1",
            scope_type: "space",
            scope_id: "space-1",
            settings_key: "source.custom_source.space_policy",
            settings_json: { download_bytes_max: this.downloadBytesMax },
            updated_by_user_id: "user-1",
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-01T00:00:00.000Z",
          }],
          rowCount: 1,
        } as { rows: Row[]; rowCount: number };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO artifacts")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO source_snapshots")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE source_items")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT owner_user_id, access_level FROM source_items")) {
      return { rows: [{ owner_user_id: "user-1", access_level: "full" }] as Row[], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO extracted_evidence")) {
      return { rows: [{ id: String(params[0]) }] as Row[], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO evidence_links")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("UPDATE extraction_jobs SET source_snapshot_id")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = $3")) {
      this.status = String(params[2]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET content_state = 'extraction_failed'")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT") && sql.includes("FROM extraction_jobs")) {
      return { rows: [{ ...jobRow(this.jobType), status: this.status }], rowCount: 1 } as { rows: Row[]; rowCount: number };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SourceExtractionWorker source retention policy", () => {
  it("blocks extract_text jobs before fetching when source policy disallows full text", async () => {
    const db = new FakeDb("extract_text");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    const finish = db.calls.find((call) => call.sql.includes("SET status = $3"));
    expect(finish?.params[2]).toBe("failed");
    expect(finish?.params[4]).toBe("403");
    expect(finish?.params[5]).toBe("Source retention policy does not allow full_text");
  });

  it("blocks snapshot jobs before fetching when source policy disallows snapshots", async () => {
    const db = new FakeDb("snapshot");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    const finish = db.calls.find((call) => call.sql.includes("SET status = $3"));
    expect(finish?.params[4]).toBe("403");
    expect(finish?.params[5]).toBe("Source retention policy does not allow full_snapshot");
  });

  it("writes extract_text artifacts as structured reader documents", async () => {
    const db = new FakeDb("extract_text", "full_text");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<html><body><article><h1>Readable article</h1><p>Article text.</p><img src='/image.png'></article></body></html>",
      { status: 200 },
    ));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("succeeded");
    const artifactInsert = db.calls.find((call) => call.sql.includes("INSERT INTO artifacts"));
    expect(artifactInsert?.sql).toContain("'source_reader_document'");
    expect(artifactInsert?.sql).toContain("'application/json'");
    expect(artifactInsert?.sql).toContain("'reader_document_json'");
    expect(artifactInsert?.sql).toContain("export_formats_json");
    expect(artifactInsert?.params).toContain(JSON.stringify(["json"]));
    expect(String(artifactInsert?.params[3])).toContain("\"image_policy\":\"remote_reference\"");
    expect(String(artifactInsert?.params[3])).toContain("\"src\":\"https://example.test/image.png\"");
  });

  it("stores PDF extract_text responses as raw binary snapshots and pdf reader documents", async () => {
    const db = new FakeDb("extract_text", "full_text");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      simplePdfBytes("Project Research PDF"),
      { status: 200, headers: { "content-type": "text/plain" } },
    ));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("succeeded");
    const artifactInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO artifacts"));
    expect(artifactInserts).toHaveLength(2);
    const rawInsert = artifactInserts[0];
    expect(rawInsert?.sql).toContain("'source_raw_snapshot'");
    expect(rawInsert?.params[4]).toBe("application/pdf");
    expect(rawInsert?.params[5]).toBe(JSON.stringify(["pdf"]));
    expect(rawInsert?.params[6]).toBe("pdf");
    const readerInsert = artifactInserts[1];
    expect(readerInsert?.sql).toContain("'source_reader_document'");
    expect(String(readerInsert?.params[3])).toContain("\"extraction_method\":\"pdf_text_v1\"");
    expect(String(readerInsert?.params[3])).toContain("Project Research PDF");
    const evidenceInsert = db.calls.find((call) => call.sql.includes("INSERT INTO extracted_evidence"));
    expect(evidenceInsert?.params[22]).toBe("pdf_text_v1");
  });

  it("uses the space download limit when extracting source URLs", async () => {
    const db = new FakeDb("extract_text", "full_text", 1_024);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new Uint8Array(1_025),
      { status: 200, headers: { "content-type": "application/pdf" } },
    ));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("failed");
    const finish = db.calls.find((call) => call.sql.includes("SET status = $3"));
    expect(finish?.params[4]).toBe("413");
    expect(finish?.params[5]).toBe("Downloaded source exceeds max size (1 KiB)");
  });

  it("stores PDF snapshot jobs as raw binary snapshots and derived reader documents", async () => {
    const db = new FakeDb("snapshot", "full_snapshot");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      simplePdfBytes("Snapshot PDF Text"),
      { status: 200, headers: { "content-type": "application/pdf" } },
    ));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("succeeded");
    const artifactInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO artifacts"));
    expect(artifactInserts).toHaveLength(2);
    expect(artifactInserts[0]?.params[4]).toBe("application/pdf");
    expect(artifactInserts[0]?.params[6]).toBe("pdf");
    expect(String(artifactInserts[1]?.params[3])).toContain("\"extraction_method\":\"pdf_text_v1\"");
    expect(String(artifactInserts[1]?.params[3])).toContain("Snapshot PDF Text");
  });

  it("stores non-PDF binary snapshot jobs without deriving reader documents", async () => {
    const db = new FakeDb("snapshot", "full_snapshot");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new Uint8Array([0, 1, 2, 3]),
      { status: 200, headers: { "content-type": "application/octet-stream" } },
    ));

    const result = await new SourceExtractionWorker(db, config()).runPendingJob("job-1", "space-1");

    expect(result.status).toBe("succeeded");
    const artifactInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO artifacts"));
    expect(artifactInserts).toHaveLength(1);
    expect(artifactInserts[0]?.params[4]).toBe("application/octet-stream");
    expect(artifactInserts[0]?.params[6]).toBe("bin");
  });
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    ARTIFACT_STORAGE_ROOT: "/tmp/agent-space-test-artifacts",
  });
}

function jobRow(jobType: "extract_text" | "snapshot") {
  return {
    id: "job-1",
    space_id: "space-1",
    connection_id: "conn-1",
    source_item_id: "item-1",
    source_object_type: null,
    source_object_id: null,
    job_type: jobType,
    status: "running",
    metadata_json: {},
  };
}

describe("extractPdfReaderContent", () => {
  it("extracts PDF bytes into the canonical reader document shape", async () => {
    const result = await extractPdfReaderContent(
      simplePdfBytes("Project Research PDF"),
      "https://example.test/paper.pdf",
    );

    expect(result.kind).toBe("reader_document");
    expect(result.extraction_method).toBe("pdf_text_v1");
    expect(result.image_policy).toBe("none");
    expect(result.source_uri).toBe("https://example.test/paper.pdf");
    expect(result.plain_text).toContain("Project Research PDF");
    expect(result.content_json.type).toBe("doc");
    expect(result.content_json.content.length).toBeGreaterThan(0);
  });
});
