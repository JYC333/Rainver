import { describe, expect, it } from "vitest";
import {
  ContextOpsPacketReviewError,
  assertCanReviewContextOpsPacket,
  canInitiateContextOpsScan,
} from "../src/modules/contextOps/reviewPolicy.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

function fakeDb(input: {
  mode: "private_only" | "admins" | "members";
  scanMode?: "admins" | "members";
  role: "owner" | "admin" | "reviewer" | "member" | "guest";
}): Queryable {
  return {
    async query<Row = Record<string, unknown>>(sql: string): Promise<{ rows: Row[]; rowCount: number | null }> {
      if (sql.includes("FROM settings")) {
        return {
          rows: [{
            settings_json: {
              default_search_mode: "hybrid",
              rerank_enabled: false,
              query_rewrite_enabled: false,
              query_rewrite_default: false,
              use_query_cache: true,
              include_trace: false,
              external_egress_enabled: true,
              retrieval_tool_mode: "off",
              context_ops_review_mode: input.mode,
              context_ops_scan_mode: input.scanMode ?? "admins",
              embedding_dimensions: 2560,
              max_results_default: 50,
            },
            created_at: "2026-06-26T00:00:00.000Z",
            updated_at: "2026-06-26T00:00:00.000Z",
          }] as Row[],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM space_memberships")) {
        return { rows: [{ role: input.role }] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
  };
}

describe("Context Ops packet review policy", () => {
  it("keeps private packets creator-only", async () => {
    await expect(
      assertCanReviewContextOpsPacket(
        fakeDb({ mode: "members", role: "admin" }),
        {
          space_id: "space-1",
          visibility: "private",
          created_by_user_id: "creator-1",
          payload_json: { operation: "memory_maintenance_packet" },
        },
        "admin-1",
        "private packet",
      ),
    ).rejects.toMatchObject({
      name: "ContextOpsPacketReviewError",
      statusCode: 403,
      message: "private packet",
    });
  });

  it("allows shared space_ops packets when member review is enabled", async () => {
    await expect(
      assertCanReviewContextOpsPacket(
        fakeDb({ mode: "members", role: "member" }),
        {
          space_id: "space-1",
          visibility: "space_shared",
          created_by_user_id: "creator-1",
          payload_json: { review_scope: "space_ops" },
        },
        "member-1",
        "private packet",
      ),
    ).resolves.toBeUndefined();
  });

  it("allows reviewers to review shared space_ops packets when member review is enabled", async () => {
    await expect(
      assertCanReviewContextOpsPacket(
        fakeDb({ mode: "members", role: "reviewer" }),
        {
          space_id: "space-1",
          visibility: "space_shared",
          created_by_user_id: "creator-1",
          payload_json: { review_scope: "space_ops" },
        },
        "reviewer-1",
        "private packet",
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps guests out when member review is enabled", async () => {
    await expect(
      assertCanReviewContextOpsPacket(
        fakeDb({ mode: "members", role: "guest" }),
        {
          space_id: "space-1",
          visibility: "space_shared",
          created_by_user_id: "creator-1",
          payload_json: { review_scope: "space_ops" },
        },
        "guest-1",
        "private packet",
      ),
    ).rejects.toBeInstanceOf(ContextOpsPacketReviewError);
  });

  it("allows admins and rejects members in admins-only mode", async () => {
    const packet = {
      space_id: "space-1",
      visibility: "space_shared",
      created_by_user_id: "creator-1",
      payload_json: { review_scope: "space_ops" },
    };
    await expect(
      assertCanReviewContextOpsPacket(fakeDb({ mode: "admins", role: "admin" }), packet, "admin-1", "private packet"),
    ).resolves.toBeUndefined();
    await expect(
      assertCanReviewContextOpsPacket(fakeDb({ mode: "admins", role: "member" }), packet, "member-1", "private packet"),
    ).rejects.toBeInstanceOf(ContextOpsPacketReviewError);
  });

  it("rejects shared space_ops packets when space-wide review is disabled", async () => {
    await expect(
      assertCanReviewContextOpsPacket(
        fakeDb({ mode: "private_only", role: "admin" }),
        {
          space_id: "space-1",
          visibility: "space_shared",
          created_by_user_id: "creator-1",
          payload_json: { review_scope: "space_ops" },
        },
        "admin-1",
        "private packet",
      ),
    ).rejects.toBeInstanceOf(ContextOpsPacketReviewError);
  });

  it("allows member scan initiation only when scan mode permits it", async () => {
    await expect(
      canInitiateContextOpsScan(fakeDb({ mode: "private_only", scanMode: "admins", role: "admin" }), "space-1", "admin-1"),
    ).resolves.toBe(true);
    await expect(
      canInitiateContextOpsScan(fakeDb({ mode: "private_only", scanMode: "admins", role: "member" }), "space-1", "member-1"),
    ).resolves.toBe(false);
    await expect(
      canInitiateContextOpsScan(fakeDb({ mode: "private_only", scanMode: "members", role: "member" }), "space-1", "member-1"),
    ).resolves.toBe(true);
    await expect(
      canInitiateContextOpsScan(fakeDb({ mode: "private_only", scanMode: "members", role: "reviewer" }), "space-1", "reviewer-1"),
    ).resolves.toBe(true);
    await expect(
      canInitiateContextOpsScan(fakeDb({ mode: "private_only", scanMode: "members", role: "guest" }), "space-1", "guest-1"),
    ).resolves.toBe(false);
  });
});
