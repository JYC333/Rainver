import { describe, expect, it } from "vitest";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { sourceRetrievalAdapter } from "../src/modules/sources/retrievalAdapter.js";

class SourceRetrievalDb implements Queryable {
  calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row>(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    if (sql.includes("FROM source_items") && !sql.includes("FROM extracted_evidence")) {
      const rows = [{
        id: "item-1",
        owner_user_id: "owner-1",
        visibility: "selected_users",
        access_level: "full",
        connection_id: "connection-1",
        item_type: "document",
        title: "Readable source",
        source_uri: null,
        canonical_uri: null,
        source_domain: null,
        source_external_id: null,
        author: null,
        occurred_at: null,
        excerpt: "Excerpt",
        content_state: "content_saved",
        retention_policy: "full_text",
        metadata_json: {},
        updated_at: "2026-01-01T00:00:00.000Z",
        last_seen_at: "2026-01-01T00:00:00.000Z",
      }];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("FROM extracted_evidence")) {
      const rows = [{
        id: "evidence-1",
        owner_user_id: "owner-1",
        visibility: "selected_users",
        access_level: "summary",
        source_item_id: "item-1",
        source_snapshot_connection_id: null,
        item_connection_id: "connection-1",
        evidence_type: "excerpt",
        title: "Readable evidence",
        content_excerpt: "Excerpt",
        source_uri: null,
        source_title: null,
        source_author: null,
        occurred_at: null,
        trust_level: "normal",
        extraction_method: "manual",
        confidence: 0.8,
        status: "active",
        metadata_json: {},
        updated_at: "2026-01-01T00:00:00.000Z",
      }];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

describe("source retrieval access revalidation", () => {
  it("filters source items through canonical access and the subscription gate", async () => {
    const db = new SourceRetrievalDb();
    const result = await sourceRetrievalAdapter.revalidateMany!(
      db,
      "space-1",
      "source_item",
      ["item-1"],
      "viewer-1",
    );

    expect(result.get("item-1")?.title).toBe("Readable source");
    expect(db.calls[0]?.params).toEqual(["space-1", ["item-1"], "viewer-1"]);
    expect(db.calls[0]?.sql).toContain("content_access_grants");
    expect(db.calls[0]?.sql).toContain("source_channel_user_subscriptions");
    expect(db.calls[0]?.sql).toContain("space_memberships");
    expect(db.calls[0]?.sql).toContain("= 'full'");
  });

});
