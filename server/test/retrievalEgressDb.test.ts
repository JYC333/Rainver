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
import { seedArxivSourceChain } from "./support/researchSeeds.js";

// The per-space switch round-trips through the settings store on real Postgres.
// When it is disabled, the embedding backfill sends nothing to a provider, so
// the vector arm has no data to use.

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
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "settings", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "users", "spaces"],
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
      retrieval_tool_mode: "manual_tool_only",
    });
    expect(updated.retrieval_tool_mode).toBe("manual_tool_only");

    const resolved = await readSpaceRetrievalSettings(db.pool, SPACE);
    expect(resolved.retrievalToolMode).toBe("manual_tool_only");
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

  it("sets aside chunks the source policy blocks, embeds the ones behind them, and takes them back when the policy changes", async () => {
    if (!db.available) return;
    const owner = "22222222-2222-4222-8222-222222222222";
    const connection = "33333333-3333-4333-8333-333333333333";
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1,'Owner','active',now(),now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
      [owner],
    );
    await seedArxivSourceChain(db.pool, {
      connector: "44444444-4444-4444-8444-444444444444", connection,
      channel: "55555555-5555-4555-8555-555555555555", space: SPACE, owner, now,
    });
    await db.pool.query(
      `UPDATE source_connections SET policy_json='{"schema_version":1,"source_egress_class":"internal_only"}'::jsonb WHERE id=$1`,
      [connection],
    );
    for (const id of ["blocked-1", "blocked-2", "open-1"]) await seed(id);
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
    // The two blocked documents are the oldest pending chunks: the head of the queue.
    await db.pool.query(
      `UPDATE retrieval_objects SET source_connection_ids_json=$2::jsonb
        WHERE space_id=$1 AND object_id IN ('blocked-1','blocked-2')`,
      [SPACE, JSON.stringify([connection])],
    );
    await db.pool.query(
      `UPDATE retrieval_chunks c SET created_at = now() - interval '1 day'
         FROM retrieval_objects o
        WHERE o.id=c.retrieval_object_id AND o.source_connection_ids_json @> $1::jsonb`,
      [JSON.stringify([connection])],
    );
    const service = new RetrievalEmbeddingBackfillService(db.pool, markerEmbedder());
    const run = () => service.backfillSpace(SPACE, { batchLimit: 2, embeddingDimensions: EMBED_DIMENSIONS, externalEgressEnabled: true });
    const embeddedCount = async () => Number((await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM retrieval_chunks WHERE space_id=$1 AND embedding IS NOT NULL`, [SPACE],
    )).rows[0]!.n);

    await expect(run()).resolves.toMatchObject({ scanned: 2, embedded: 0 });
    // The blocked chunks no longer hold the head of the queue.
    const second = await run();
    expect(second.embedded).toBeGreaterThan(0);
    while ((await run()).scanned > 0) { /* drain the open chunks */ }
    const openEmbedded = await embeddedCount();
    const blocked = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM retrieval_chunks WHERE space_id=$1 AND embedding IS NULL AND embedding_blocked_generation IS NOT NULL AND embedding_claim_id IS NULL`,
      [SPACE],
    );
    expect(Number(blocked.rows[0]!.n)).toBeGreaterThanOrEqual(2);
    await expect(run()).resolves.toMatchObject({ scanned: 0 });

    // Editing a connection these chunks do not depend on leaves them parked.
    const unrelated = "66666666-6666-4666-8666-666666666666";
    await db.pool.query(
      `INSERT INTO source_connections (id, space_id, provider_connector_id, owner_user_id, name, status, capture_policy, trust_level,
         consent_json, policy_json, config_json, created_at, updated_at)
       SELECT $2, space_id, provider_connector_id, owner_user_id, 'Unrelated', status, capture_policy, trust_level,
              consent_json, policy_json, config_json, now(), now()
         FROM source_connections WHERE id = $1`,
      [connection, unrelated],
    );
    await db.pool.query(
      `UPDATE source_connections SET policy_json='{"schema_version":1,"source_egress_class":"external_provider_allowed"}'::jsonb WHERE id=$1`,
      [unrelated],
    );
    await expect(run()).resolves.toMatchObject({ scanned: 0 });

    // The source now allows external model egress: the set-aside chunks come back.
    await db.pool.query(
      `UPDATE source_connections SET policy_json='{"schema_version":1,"source_egress_class":"external_provider_allowed"}'::jsonb WHERE id=$1`,
      [connection],
    );
    while ((await run()).scanned > 0) { /* drain */ }
    expect(await embeddedCount()).toBe(openEmbedded + Number(blocked.rows[0]!.n));
    const left = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM retrieval_chunks WHERE space_id=$1 AND (embedding IS NULL OR embedding_blocked_generation IS NOT NULL)`,
      [SPACE],
    );
    expect(left.rows[0]!.n).toBe("0");
  });
});
