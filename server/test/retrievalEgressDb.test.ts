import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { RetrievalProjectionService } from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import {
  getOrCreateSpaceRetrievalSettings,
  readSpaceRetrievalSettings,
  updateSpaceRetrievalSettings,
} from "../src/modules/retrieval/settings";
import {
  RetrievalEmbeddingBackfillService,
  type RetrievalEmbedder,
} from "../src/modules/retrieval/embedding/service";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// W9 egress governance on real Postgres: the per-space switch round-trips through
// the settings store, and when disabled the embedding backfill sends NOTHING to a
// provider (no chunk is embedded), so the vector arm has no data to use.

const SPACE = "11111111-1111-4111-8111-111111111111";

function markerEmbedder(): RetrievalEmbedder {
  return {
    async embed(_spaceId, texts) {
      const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
      v[0] = 1;
      return { model: "marker-embed", vectors: texts.map(() => [...v]) };
    },
  };
}

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[retrieval-egress-db] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "settings", "spaces"],
    { cascade: true },
  );
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Egress', 'personal', now(), now())`, [SPACE]);
});

async function seed(id: string): Promise<void> {
  await insertKnowledgeItem(pool!, {
    id,
    spaceId: SPACE,
    title: `Title ${id}`,
    content: `Content for ${id} with enough words to embed.`,
    slug: id,
  });
}

describe("Retrieval egress governance (real Postgres)", () => {
  it("round-trips the external_egress_enabled switch through the settings store", async () => {
    if (!available || !pool) return;
    const created = await getOrCreateSpaceRetrievalSettings(pool, SPACE);
    expect(created.external_egress_enabled).toBe(true); // default

    const updated = await updateSpaceRetrievalSettings(pool, SPACE, { external_egress_enabled: false });
    expect(updated.external_egress_enabled).toBe(false);

    const resolved = await readSpaceRetrievalSettings(pool, SPACE);
    expect(resolved.externalEgressEnabled).toBe(false);
  });

  it("round-trips the managed-run retrieval_tool_mode through the settings store", async () => {
    if (!available || !pool) return;
    const created = await getOrCreateSpaceRetrievalSettings(pool, SPACE);
    expect(created.retrieval_tool_mode).toBe("off"); // default

    const updated = await updateSpaceRetrievalSettings(pool, SPACE, {
      retrieval_tool_mode: "preflight_brief",
    });
    expect(updated.retrieval_tool_mode).toBe("preflight_brief");

    const resolved = await readSpaceRetrievalSettings(pool, SPACE);
    expect(resolved.retrievalToolMode).toBe("preflight_brief");

    const searchMode = await updateSpaceRetrievalSettings(pool, SPACE, {
      retrieval_tool_mode: "preflight_search",
    });
    expect(searchMode.retrieval_tool_mode).toBe("preflight_search");
  });

  it("skips the embedding backfill entirely when external egress is disabled", async () => {
    if (!available || !pool) return;
    await seed("doc-1");
    await seed("doc-2");
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
    await updateSpaceRetrievalSettings(pool, SPACE, { external_egress_enabled: false });

    // The job handler resolves the space switch and passes it; here we pass the
    // resolved value the same way (read it back to prove the wiring).
    const resolved = await readSpaceRetrievalSettings(pool, SPACE);
    const result = await new RetrievalEmbeddingBackfillService(pool, markerEmbedder()).backfillSpace(SPACE, {
      embeddingDimensions: EMBED_DIMENSIONS,
      externalEgressEnabled: resolved.externalEgressEnabled,
    });
    // Nothing claimed, nothing embedded, no provider model used.
    expect(result).toEqual({ scanned: 0, embedded: 0, skipped: 0, model: null });
    const embedded = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM retrieval_chunks WHERE embedding IS NOT NULL`,
    );
    expect(embedded.rows[0]!.n).toBe("0");
  });

  it("embeds normally once external egress is re-enabled (capability is reversible)", async () => {
    if (!available || !pool) return;
    await seed("doc-1");
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
    await updateSpaceRetrievalSettings(pool, SPACE, { external_egress_enabled: false });
    const disabled = await readSpaceRetrievalSettings(pool, SPACE);
    const skipped = await new RetrievalEmbeddingBackfillService(pool, markerEmbedder()).backfillSpace(SPACE, {
      embeddingDimensions: EMBED_DIMENSIONS,
      externalEgressEnabled: disabled.externalEgressEnabled,
    });
    expect(skipped.embedded).toBe(0);

    await updateSpaceRetrievalSettings(pool, SPACE, { external_egress_enabled: true });
    const reenabled = await readSpaceRetrievalSettings(pool, SPACE);
    const result = await new RetrievalEmbeddingBackfillService(pool, markerEmbedder()).backfillSpace(SPACE, {
      embeddingDimensions: EMBED_DIMENSIONS,
      externalEgressEnabled: reenabled.externalEgressEnabled,
    });
    expect(result.embedded).toBeGreaterThan(0);
    expect(result.model).toBe("marker-embed");
  });
});
