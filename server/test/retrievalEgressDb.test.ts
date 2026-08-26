import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import {
  getOrCreateSpaceRetrievalSettings,
  readSpaceRetrievalSettings,
  updateSpaceRetrievalSettings,
} from "../src/modules/retrieval/settings.js";
import {
  RetrievalEmbeddingBackfillService,
  type RetrievalEmbedder,
} from "../src/modules/retrieval/embedding/service.js";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

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


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "settings", "spaces"],
    { cascade: true },
  );
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Egress', 'personal', now(), now())`, [SPACE]);
});

async function seed(id: string): Promise<void> {
  await insertKnowledgeItem(db.pool, {
    id,
    spaceId: SPACE,
    title: `Title ${id}`,
    content: `Content for ${id} with enough words to embed.`,
    slug: id,
  });
}

describe("Retrieval egress governance (real Postgres)", () => {
  it("round-trips the external_egress_enabled switch through the settings store", async () => {
    if (!db.available) return;
    const created = await getOrCreateSpaceRetrievalSettings(db.pool, SPACE);
    expect(created.external_egress_enabled).toBe(true); // default

    const updated = await updateSpaceRetrievalSettings(db.pool, SPACE, { external_egress_enabled: false });
    expect(updated.external_egress_enabled).toBe(false);

    const resolved = await readSpaceRetrievalSettings(db.pool, SPACE);
    expect(resolved.externalEgressEnabled).toBe(false);
  });

  it("round-trips the managed-run retrieval_tool_mode through the settings store", async () => {
    if (!db.available) return;
    const created = await getOrCreateSpaceRetrievalSettings(db.pool, SPACE);
    expect(created.retrieval_tool_mode).toBe("off"); // default

    const updated = await updateSpaceRetrievalSettings(db.pool, SPACE, {
      retrieval_tool_mode: "preflight_brief",
    });
    expect(updated.retrieval_tool_mode).toBe("preflight_brief");

    const resolved = await readSpaceRetrievalSettings(db.pool, SPACE);
    expect(resolved.retrievalToolMode).toBe("preflight_brief");

    const searchMode = await updateSpaceRetrievalSettings(db.pool, SPACE, {
      retrieval_tool_mode: "preflight_search",
    });
    expect(searchMode.retrieval_tool_mode).toBe("preflight_search");
  });

  it("skips the embedding backfill entirely when external egress is disabled", async () => {
    if (!db.available) return;
    await seed("doc-1");
    await seed("doc-2");
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
    await updateSpaceRetrievalSettings(db.pool, SPACE, { external_egress_enabled: false });

    // The job handler resolves the space switch and passes it; here we pass the
    // resolved value the same way (read it back to prove the wiring).
    const resolved = await readSpaceRetrievalSettings(db.pool, SPACE);
    const result = await new RetrievalEmbeddingBackfillService(db.pool, markerEmbedder()).backfillSpace(SPACE, {
      embeddingDimensions: EMBED_DIMENSIONS,
      externalEgressEnabled: resolved.externalEgressEnabled,
    });
    // Nothing claimed, nothing embedded, no provider model used.
    expect(result).toEqual({ scanned: 0, embedded: 0, skipped: 0, model: null });
    const embedded = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM retrieval_chunks WHERE embedding IS NOT NULL`,
    );
    expect(embedded.rows[0]!.n).toBe("0");
  });

  it("embeds normally once external egress is re-enabled (capability is reversible)", async () => {
    if (!db.available) return;
    await seed("doc-1");
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
    await updateSpaceRetrievalSettings(db.pool, SPACE, { external_egress_enabled: false });
    const disabled = await readSpaceRetrievalSettings(db.pool, SPACE);
    const skipped = await new RetrievalEmbeddingBackfillService(db.pool, markerEmbedder()).backfillSpace(SPACE, {
      embeddingDimensions: EMBED_DIMENSIONS,
      externalEgressEnabled: disabled.externalEgressEnabled,
    });
    expect(skipped.embedded).toBe(0);

    await updateSpaceRetrievalSettings(db.pool, SPACE, { external_egress_enabled: true });
    const reenabled = await readSpaceRetrievalSettings(db.pool, SPACE);
    const result = await new RetrievalEmbeddingBackfillService(db.pool, markerEmbedder()).backfillSpace(SPACE, {
      embeddingDimensions: EMBED_DIMENSIONS,
      externalEgressEnabled: reenabled.externalEgressEnabled,
    });
    expect(result.embedded).toBeGreaterThan(0);
    expect(result.model).toBe("marker-embed");
  });
});
