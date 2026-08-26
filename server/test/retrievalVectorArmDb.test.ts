import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import { type QueryEmbedder } from "../src/modules/retrieval/types.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import {
  RetrievalEmbeddingBackfillService,
  type RetrievalEmbedder,
} from "../src/modules/retrieval/embedding/service.js";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

// Vector recall arm end-to-end on pgvector: a query that matches NOTHING
// lexically still surfaces a semantically-near object via the embedding arm, and
// the arm's hits go through the SAME revalidate gate (an embedded-but-unreadable
// object is never returned).

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Embeds a chunk into a one-hot direction chosen by a marker in its text. */
function markerEmbedder(dim = EMBED_DIMENSIONS): RetrievalEmbedder {
  const slotFor = (t: string): number =>
    t.includes("aaa") ? 0 : t.includes("bbb") ? 1 : t.includes("ccc") ? 2 : 3;
  return {
    async embed(_spaceId, texts) {
      return {
        model: "marker-embed",
        vectors: texts.map((t) => oneHot(slotFor(t), dim)),
      };
    },
  };
}

/** Query embedder fixed to one direction (graceful-degrade returns are not used here). */
function querySlot(slot: number, dim = EMBED_DIMENSIONS): QueryEmbedder {
  return { async embedQuery() { return oneHot(slot, dim); } };
}

function oneHot(slot: number, dim = EMBED_DIMENSIONS): number[] {
  const v = new Array<number>(dim).fill(0);
  v[slot] = 1;
  return v;
}


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Vec', 'personal', now(), now())`,
    [SPACE],
  );
  for (const id of [VIEWER, OTHER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'U', 'active', now(), now())`,
      [id],
    );
  }
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('vector-viewer', $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
});

async function seedKnowledge(doc: {
  id: string;
  title: string;
  content: string;
  visibility?: string;
  owner?: string | null;
}): Promise<void> {
  await insertKnowledgeItem(db.pool, {
    id: doc.id,
    spaceId: SPACE,
    title: doc.title,
    content: doc.content,
    slug: doc.id,
    visibility: doc.visibility ?? "space_shared",
    ownerUserId: doc.owner ?? null,
    createdByUserId: doc.owner ?? null,
  });
}

async function reindexAndEmbed(dim = EMBED_DIMENSIONS): Promise<void> {
  await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
  await new RetrievalEmbeddingBackfillService(db.pool, markerEmbedder(dim)).backfillSpace(SPACE, {
    embeddingDimensions: dim,
  });
}

describe("Vector recall arm (real Postgres + pgvector)", () => {
  it("surfaces a semantically-near object that the deterministic arms miss", async () => {
    if (!db.available) return;
    await seedKnowledge({ id: "alpha", title: "Alpha doc", content: "alpha marker aaa" });
    await seedKnowledge({ id: "beta", title: "Beta doc", content: "beta marker bbb" });
    await reindexAndEmbed();

    // A query that matches no alias/title/lexical content at all.
    const query = "qqqzzz no lexical overlap";

    // Without an embedder, the deterministic arms return nothing.
    const deterministic = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query,
      maxResults: 10,
    });
    expect(deterministic.items).toHaveLength(0);

    // With the vector arm (query in the "alpha" direction), alpha is recalled.
    const hybrid = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      queryEmbedder: querySlot(0),
    }).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query,
      maxResults: 10,
    });

    expect(hybrid.items[0]).toMatchObject({
      object_id: "alpha",
      evidence: { kind: "vector_match" },
    });
  });

  it("still drops a vector hit the viewer may not read (revalidate gate holds)", async () => {
    if (!db.available) return;
    // A private knowledge item owned by OTHER, embedded in the "ccc" direction.
    await seedKnowledge({
      id: "secret",
      title: "Secret doc",
      content: "secret marker ccc",
      visibility: "private",
      owner: OTHER,
    });
    await reindexAndEmbed();

    const result = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      queryEmbedder: querySlot(2),
    }).search({
      spaceId: SPACE,
      viewerUserId: VIEWER, // not the owner
      objectTypes: ["knowledge_item"],
      query: "qqqzzz no lexical overlap",
      maxResults: 10,
    });

    // The vector arm matched it in the projection, but revalidate gates it out.
    expect(result.items.map((i) => i.object_id)).not.toContain("secret");
  });

  it("supports a non-default embedding dimension for model experiments", async () => {
    if (!db.available) return;
    const dim = 384;
    await seedKnowledge({ id: "alpha", title: "Alpha doc", content: "alpha marker aaa" });
    await seedKnowledge({ id: "beta", title: "Beta doc", content: "beta marker bbb" });
    await reindexAndEmbed(dim);

    const row = await db.pool.query<{ dims: number }>(
      `SELECT embedding_dimensions AS dims FROM retrieval_chunks
        WHERE embedding IS NOT NULL
        LIMIT 1`,
    );
    expect(row.rows[0]?.dims).toBe(dim);

    const result = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      queryEmbedder: querySlot(1, dim),
    }).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "qqqzzz no lexical overlap",
      maxResults: 10,
    });

    expect(result.items[0]).toMatchObject({
      object_id: "beta",
      evidence: { kind: "vector_match" },
    });
  });
});
