import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDbPool } from "../src/db/pool.js";
import { loadConfig } from "../src/config.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { knowledgeModule } from "../src/modules/knowledge/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

vi.mock("../src/db/pool.js", () => ({
  getDbPool: vi.fn(),
}));

// G2: a visible claim can carry evidence sourced from a connection that restricts
// the viewer. `claimSources` must drop those evidence rows (and their quotes) via
// the same source read policy as retrieval, while keeping unrestricted evidence.
const VIEWER = "user-1";
let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  vi.mocked(getDbPool).mockReset();
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

class ClaimSourcesFakeDb implements Queryable {
  async query<Row = Record<string, unknown>>(
    sql: string,
    _params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    const norm = sql.replace(/\s+/g, " ").trim();

    if (/FROM claims c/.test(norm) || /FROM claims\b/.test(norm) && /c\.object_id = \$1/.test(norm)) {
      // getVisibleClaimRow → a space_shared (readable) claim.
      return {
        rows: [{
          id: "claim-1",
          space_id: "space-1",
          claim_kind: "fact",
          claim_text: "The widget ships Friday.",
          status: "active",
          visibility: "space_shared",
          title: "Widget ship date",
          owner_user_id: "owner-2",
          created_by_user_id: "owner-2",
        }] as Row[],
        rowCount: 1,
      };
    }

    if (/FROM claim_sources/.test(norm)) {
      return {
        rows: [
          claimSourceRow("cs-allowed", "src-allowed", "allowed evidence quote"),
          claimSourceRow("cs-denied", "src-denied", "SECRET restricted evidence quote"),
          claimSourceRow("cs-nosource", null, "public evidence quote"),
        ] as Row[],
        rowCount: 3,
      };
    }

    if (/FROM source_connections/.test(norm)) {
      return {
        rows: [
          // viewer owns src-allowed ⇒ readable
          snapshotRow("src-allowed", VIEWER),
          // owned by someone else, no allowed readers, admins denied ⇒ unreadable
          snapshotRow("src-denied", "owner-2"),
        ] as Row[],
        rowCount: 2,
      };
    }

    if (/FROM space_memberships/.test(norm)) {
      return { rows: [{ role: "member" }] as Row[], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

function claimSourceRow(id: string, sourceConnectionId: string | null, quote: string): Record<string, unknown> {
  return {
    id,
    space_id: "space-1",
    claim_id: "claim-1",
    source_object_id: null,
    source_ref_type: null,
    source_ref_id: null,
    source_connection_id: sourceConnectionId,
    source_policy_snapshot_json: null,
    locator: null,
    quote_excerpt: quote,
    evidence_role: "primary",
    source_trust: "normal",
    confidence: 0.9,
    metadata_json: null,
    created_by_user_id: "owner-2",
    created_at: "2026-06-20T00:00:00.000Z",
  };
}

function snapshotRow(id: string, ownerUserId: string): Record<string, unknown> {
  return {
    id,
    owner_user_id: ownerUserId,
    consent_json: {
      schema_version: 1,
      owner_user_id: ownerUserId,
      allowed_reader_user_ids: [],
      allowed_agent_ids: [],
      allow_space_admins: false,
      allow_local_provider_egress: true,
      allow_external_model_egress: false,
    },
    policy_json: { schema_version: 1, source_egress_class: "local_provider_allowed" },
  };
}

describe("claim sources source policy gate (G2)", () => {
  it("drops evidence rows whose source connection denies the viewer", async () => {
    const rows = await new PgKnowledgeRepository(new ClaimSourcesFakeDb()).claimSources(
      { spaceId: "space-1", userId: VIEWER },
      "claim-1",
    );

    const ids = rows.map((row) => row.id);
    expect(ids).toEqual(["cs-allowed", "cs-nosource"]);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
  });

  it("applies the same source gate through the claim sources HTTP route", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: VIEWER });
    vi.mocked(getDbPool).mockReturnValue(new ClaimSourcesFakeDb() as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/knowledge/claims/claim-1/sources",
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(["cs-allowed", "cs-nosource"]);
    expect(res.body).not.toContain("SECRET");
  });
});
