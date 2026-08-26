import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
import { runGradedCases, type EvalCase } from "./support/retrievalEval.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

// Retrieval eval benches over real Postgres + pgvector. Beyond the recall@k
// gate (retrievalEvalDb), these track graded quality (MRR / nDCG), entity recall
// under distractor pressure (NamedThing), relational recall, recency/staleness,
// per-mode precision↔recall tradeoff, and — as a hard gate — that no cross-space
// or non-readable object ever leaks. Thresholds are conservative baselines; the
// recall-depth workstreams (per-page max-db.pool, intent, typed-graph) tighten them.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const K = 5;

/**
 * Deterministic "concept" embedder: maps recognized concept words to a fixed
 * slot so a query and a document that share a concept but NO lexical token still
 * land near each other (exercising the vector arm beyond lexical overlap). Used
 * for both chunk embedding (RetrievalEmbedder) and query embedding (QueryEmbedder).
 */
const CONCEPT_SLOTS: Record<string, number> = {
  cat: 0, feline: 0, kitten: 0,
  dog: 1, canine: 1, puppy: 1,
  ledger: 2, accounting: 2, bookkeeping: 2,
};

function slotFor(text: string): number {
  const tokens = text.toLowerCase().split(/[^a-z]+/);
  for (const token of tokens) {
    if (token in CONCEPT_SLOTS) return CONCEPT_SLOTS[token]!;
  }
  return 9; // "no concept" noise slot, away from the real concept directions
}

function oneHot(slot: number, dim = EMBED_DIMENSIONS): number[] {
  const v = new Array<number>(dim).fill(0);
  v[slot] = 1;
  return v;
}

const conceptEmbedder: RetrievalEmbedder = {
  async embed(_spaceId, texts) {
    return { model: "concept-embed", vectors: texts.map((t) => oneHot(slotFor(t))) };
  },
};

const conceptQueryEmbedder: QueryEmbedder = {
  async embedQuery(_spaceId, text) {
    return oneHot(slotFor(text));
  },
};


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "object_relations", "knowledge_items", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  for (const [id, name] of [[SPACE, "Bench"], [OTHER_SPACE, "Other"]] as const) {
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at)
       VALUES ($1, $2, 'team', now(), now())`,
      [id, name],
    );
  }
  for (const id of [VIEWER, OTHER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'U', 'active', now(), now())`,
      [id],
    );
  }
  for (const [spaceId, userId] of [
    [SPACE, VIEWER],
    [SPACE, OTHER],
    [OTHER_SPACE, VIEWER],
    [OTHER_SPACE, OTHER],
  ]) {
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [randomUUID(), spaceId, userId],
    );
  }
});

interface SeedDoc {
  id: string;
  title: string;
  content: string;
  slug?: string;
  aliases?: string[];
  spaceId?: string;
  visibility?: string;
  owner?: string | null;
  /** Override updated_at/created_at (ISO) for the recency/staleness bench. */
  updatedAt?: string;
}

async function seed(doc: SeedDoc): Promise<void> {
  const ts = doc.updatedAt ?? new Date().toISOString();
  await insertKnowledgeItem(db.pool, {
    id: doc.id,
    spaceId: doc.spaceId ?? SPACE,
    title: doc.title,
    content: doc.content,
    slug: doc.slug ?? doc.id,
    aliases: doc.aliases ?? [],
    visibility: doc.visibility ?? "space_shared",
    ownerUserId: doc.owner ?? null,
    createdByUserId: doc.owner ?? null,
    updatedAt: ts,
  });
}

async function relate(fromId: string, toId: string, linkType = "related_to"): Promise<void> {
  await db.pool.query(
    `INSERT INTO object_relations (
       id, space_id, from_object_id, to_object_id, link_type, status, confidence, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'active', 0.9, now(), now())`,
    [randomUUID(), SPACE, fromId, toId, linkType],
  );
}

async function reindex(): Promise<void> {
  const svc = new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry);
  await svc.reindexAll(SPACE);
  await svc.reindexAll(OTHER_SPACE);
}

async function reindexAndEmbed(): Promise<void> {
  await reindex();
  await new RetrievalEmbeddingBackfillService(db.pool, conceptEmbedder).backfillSpace(SPACE, {
    embeddingDimensions: EMBED_DIMENSIONS,
  });
}

function knowledgeSearch(withVector = false): RetrievalSearchService {
  return new RetrievalSearchService(
    db.pool,
    knowledgeRetrievalRegistry,
    withVector ? { queryEmbedder: conceptQueryEmbedder } : {},
  );
}

/** A long body that produces several chunks (>2200 chars each) mentioning a term. */
function longBodyMentioning(term: string, copies = 4): string {
  const filler =
    "This page collects assorted background notes and meeting minutes. " .repeat(60);
  return Array.from({ length: copies }, (_, i) => `${filler} section ${i} about ${term}.`).join("\n\n");
}

/** Enough repeated term-bearing text to produce more chunks than one arm fetch window. */
function chunkCrowdingBody(term: string, segments = 70): string {
  const filler = "background ".repeat(190);
  return Array.from({ length: segments }, (_, i) => `${term} ${filler} section ${i}.`).join("\n");
}

describe("Retrieval bench: NamedThing entity recall (real Postgres)", () => {
  it("recalls the named entity over multi-chunk distractors and reports graded quality", async () => {
    if (!db.available) return;
    // The named entity: a focused short page whose title IS the query.
    await seed({ id: "named", title: "Project Helios", content: "Project Helios is the solar roadmap." });
    // Distractors: long pages (many chunks) that mention "helios" weakly many times.
    await seed({ id: "distractor-1", title: "Engineering notes", content: longBodyMentioning("helios") });
    await seed({ id: "distractor-2", title: "Archive dump", content: longBodyMentioning("helios") });
    await reindex();

    // Query the shared term only ("helios"), NOT the full title — so the named
    // page wins on its single dense chunk, while each distractor brings many weak
    // chunks. Before per-page max-db.pool (W2), fusion summed RRF across an object's
    // chunks, so distractor chunk-count inflated their score and pushed the named
    // entity down (baseline MRR ≈ 0.33). With per-arm max-db.pool + the title-phrase
    // boost (the query term is in the named entity's title), the named entity
    // ranks first and the distractors fall in behind it.
    const cases: EvalCase[] = [
      { query: "helios", expected: ["named"], graded: { named: 3, "distractor-1": 1, "distractor-2": 1 } },
    ];
    const report = await runGradedCases(
      knowledgeSearch(),
      { spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"], mode: "lexical" },
      cases,
      K,
    );

    expect(report.recall).toBe(1);
    expect(report.mrr).toBe(1); // named entity ranks #1, not buried under distractor chunks
    expect(report.ndcg).toBeGreaterThan(0.99); // ideal ordering: named, then the distractors
    expect(report.perCase[0]!.returned[0]).toBe("named");
  });

  it("max-pools lexical matches before the SQL fetch window is exhausted by one chunk-heavy object", async () => {
    if (!db.available) return;
    const ts = "2026-01-01T00:00:00.000Z";
    // The distractor has >50 matching chunks. If SQL LIMIT runs before per-object
    // pooling, it can consume the entire lexical arm window and the named page never
    // reaches the shared max-db.pool stage.
    await seed({
      id: "crowder",
      title: "Aardvark Archive",
      content: chunkCrowdingBody("helios"),
      updatedAt: ts,
    });
    await seed({
      id: "named",
      title: "Project Helios",
      content: "Helios signal page.",
      updatedAt: ts,
    });
    await reindex();

    const result = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "helios",
      mode: "lexical",
      maxResults: K,
    });
    const ids = result.items.map((i) => i.object_id);
    expect(ids).toContain("named");
    expect(ids.indexOf("named")).toBeLessThan(ids.indexOf("crowder"));
  });
});

describe("Retrieval bench: relational recall (real Postgres)", () => {
  it("recalls a 1-hop neighbor reachable only through an accepted relation", async () => {
    if (!db.available) return;
    // "anchor" is an exact title hit (the seed); "neighbor" shares no query term
    // and is reachable solely via the accepted relation edge.
    await seed({ id: "anchor", title: "Migration Playbook", content: "The canonical migration guide." });
    await seed({ id: "neighbor", title: "Rollback Drill", content: "Quarterly resilience exercise notes." });
    await relate("anchor", "neighbor", "related_to");
    await reindex();

    const result = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "Migration Playbook", // exact title ⇒ seeds the graph arm
      mode: "lexical",
      maxResults: K,
    });
    const ids = result.items.map((i) => i.object_id);
    expect(ids).toContain("anchor");
    // Relational arm surfaces the neighbor that pure free-text recall misses.
    expect(ids).toContain("neighbor");
    expect(result.items.find((i) => i.object_id === "neighbor")?.evidence.kind).toBe("graph_neighbor");
  });

  it("recalls an explicit relation-intent connection query", async () => {
    if (!db.available) return;
    await seed({ id: "anchor", title: "Migration Playbook", content: "The canonical migration guide." });
    await seed({ id: "neighbor", title: "Rollback Drill", content: "Quarterly resilience exercise notes." });
    await relate("anchor", "neighbor", "supports");
    await reindex();

    const result = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "how is Migration Playbook connected to Rollback Drill",
      mode: "lexical",
      includeTrace: true,
      maxResults: K,
    });

    const ids = result.items.map((i) => i.object_id);
    expect(ids).toContain("neighbor");
    const neighbor = result.items.find((i) => i.object_id === "neighbor");
    expect(neighbor?.matched_fields).toContain("relational:connection");
    expect(neighbor?.matched_fields).toContain("relation_weight:supports");
    expect((result.trace as { relational?: { intent: string; results: number } }).relational).toMatchObject({
      intent: "connection",
      results: 1,
    });
  });

  it("walks two hops: a neighbor-of-a-neighbor is recalled (W4 multi-hop)", async () => {
    if (!db.available) return;
    // anchor → mid → far. Only anchor matches lexically; "far" is reachable only
    // by a 2-hop traversal through "mid".
    await seed({ id: "anchor", title: "Service Mesh", content: "The canonical service mesh guide." });
    await seed({ id: "mid", title: "Sidecar Proxy", content: "Per-pod proxy notes." });
    await seed({ id: "far", title: "mTLS Rotation", content: "Certificate rotation runbook." });
    await relate("anchor", "mid", "related_to");
    await relate("mid", "far", "related_to");
    await reindex();

    const result = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "Service Mesh",
      mode: "lexical",
      includeTrace: true,
      maxResults: K,
    });
    const ids = result.items.map((i) => i.object_id);
    expect(ids).toContain("mid"); // hop 1
    expect(ids).toContain("far"); // hop 2 — only reachable through mid
    expect((result.trace as { graph?: { hops: number } }).graph?.hops).toBe(2);
  });

  it("seeds the graph from a lexical match, not just an exact title (W4)", async () => {
    if (!db.available) return;
    // The query matches "anchor" only LEXICALLY (no exact title / alias). Before
    // W4 the graph arm seeded from exact hits only, so the neighbor was missed.
    await seed({ id: "anchor", title: "Distributed Tracing", content: "Observability via jaeger spans." });
    await seed({ id: "neighbor", title: "Span Sampling", content: "Tail based sampling notes." });
    await relate("anchor", "neighbor", "related_to");
    await reindex();

    const result = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "jaeger spans observability", // lexical hit on anchor, not its title
      mode: "lexical",
      maxResults: K,
    });
    const ids = result.items.map((i) => i.object_id);
    expect(ids).toContain("anchor");
    expect(ids).toContain("neighbor"); // surfaced via graph from a lexical seed
  });

  it("never expands through a non-visible intermediate node (invariant 4)", async () => {
    if (!db.available) return;
    // anchor (visible) → hidden (private, owned by OTHER) → tail. The traversal
    // must NOT surface `tail`: `hidden` is non-visible, so it is neither returned
    // nor used as a hop-2 frontier, and `tail` is reachable only through it.
    await seed({ id: "anchor", title: "Incident Index", content: "The canonical incident index." });
    await seed({ id: "hidden", title: "Sealed Report", content: "Confidential.", visibility: "private", owner: OTHER });
    await seed({ id: "tail", title: "Downstream Effects", content: "Knock-on effects writeup." });
    await relate("anchor", "hidden", "related_to");
    await relate("hidden", "tail", "related_to");
    await reindex();

    const result = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER, // not the owner of `hidden`
      objectTypes: ["knowledge_item"],
      query: "Incident Index",
      mode: "lexical",
      maxResults: K,
    });
    const ids = result.items.map((i) => i.object_id);
    expect(ids).toContain("anchor");
    expect(ids).not.toContain("hidden"); // non-visible neighbor dropped
    expect(ids).not.toContain("tail"); // unreachable without expanding through hidden
  });
});

describe("Retrieval bench: recency / staleness (real Postgres)", () => {
  it("ranks the fresher of two equally-matching pages first via the canonical-time recency signal", async () => {
    if (!db.available) return;
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    // Adversarial ids: the FRESH page sorts alphabetically LAST, so the lexical
    // arm's object_id tiebreak puts the STALE page first. Only the recency signal
    // — which now reads the CANONICAL source_updated_at, not projection time — can
    // lift the fresh page above it. This fails if recency keys off reindex time.
    await seed({ id: "aaa-stale-onboarding", title: "Onboarding guide", content: "Team onboarding checklist and links.", updatedAt: old });
    await seed({ id: "zzz-fresh-onboarding", title: "Onboarding guide", content: "Team onboarding checklist and links.", updatedAt: fresh });
    await reindex();

    const result = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "onboarding checklist links",
      mode: "lexical",
      maxResults: K,
    });
    const ids = result.items.map((i) => i.object_id);
    expect(ids).toContain("zzz-fresh-onboarding");
    expect(ids).toContain("aaa-stale-onboarding");
    expect(ids.indexOf("zzz-fresh-onboarding")).toBeLessThan(ids.indexOf("aaa-stale-onboarding"));
  });
});

describe("Retrieval bench: intent-aware ranking (real Postgres)", () => {
  it("classifies the query end-to-end and reorders by intent without dropping recall", async () => {
    if (!db.available) return;
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const body = "Onboarding checklist for this year.";
    await seed({ id: "old-release", title: "Onboarding", content: body, updatedAt: old });
    await seed({ id: "new-release", title: "Onboarding", content: body });
    await reindex();

    // Temporal intent ("this year" is an explicit time reference) — trace exposes
    // the classified intent (derived from the caller's own query).
    const temporal = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "onboarding this year",
      mode: "lexical",
      includeTrace: true,
      maxResults: K,
    });
    expect((temporal.trace as { intent?: string }).intent).toBe("temporal");
    // Intent only reorders: BOTH the fresh and the stale doc are still recalled.
    const ids = temporal.items.map((i) => i.object_id);
    expect(ids).toContain("new-release");
    expect(ids).toContain("old-release");
    expect(ids.indexOf("new-release")).toBeLessThan(ids.indexOf("old-release"));

    // A short, name-like query with no temporal/event vocabulary routes to entity.
    const entity = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "Project Helios",
      mode: "lexical",
      includeTrace: true,
      maxResults: K,
    });
    expect((entity.trace as { intent?: string }).intent).toBe("entity");
  });
});

describe("Retrieval bench: per-mode precision↔recall tradeoff (real Postgres)", () => {
  it("exact trades recall for precision; hybrid recovers semantic recall lexical misses", async () => {
    if (!db.available) return;
    // "cats" page matches the query lexically AND semantically (concept: feline).
    await seed({ id: "cats", title: "Caring for cats", content: "Daily routine for a happy cat." });
    // "feline-only" page matches the concept but shares NO lexical token with the
    // query "feline companion" — only the vector arm can recall it.
    await seed({ id: "feline-vec", title: "Whiskers log", content: "Notes about a kitten and grooming." });
    // Noise page, unrelated concept.
    await seed({ id: "ledger", title: "Monthly ledger", content: "Accounting and bookkeeping notes." });
    await reindexAndEmbed();

    const cases: EvalCase[] = [{ query: "cats", expected: ["cats"] }];
    const exact = await runGradedCases(
      knowledgeSearch(), { spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"], mode: "exact" }, cases, K,
    );
    // Exact matches the title precisely and nothing else: precision 1.
    expect(exact.precision).toBe(1);
    expect(exact.perCase[0]!.returned).toEqual(["cats"]);

    // Hybrid recalls the concept-only neighbor that has no lexical overlap.
    const hybrid = await knowledgeSearch(true).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "feline companion",
      mode: "hybrid",
      maxResults: K,
    });
    const hybridIds = hybrid.items.map((i) => i.object_id);
    expect(hybridIds).toContain("feline-vec");

    // The same query in lexical mode (no vector arm) cannot reach it.
    const lexical = await knowledgeSearch().search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "feline companion",
      mode: "lexical",
      maxResults: K,
    });
    expect(lexical.items.map((i) => i.object_id)).not.toContain("feline-vec");
  });
});

describe("Retrieval bench: cross-space / visibility leak fuzz (real Postgres)", () => {
  it("never returns a cross-space or non-readable object across any mode or arm", async () => {
    if (!db.available) return;
    // Same space, readable by VIEWER.
    await seed({ id: "ok-public", title: "Shared runbook", content: "Public shared runbook xenon details." });
    await seed({ id: "ok-mine", title: "My private note", content: "My own private krypton note.", visibility: "private", owner: VIEWER });
    // Same space, NOT readable by VIEWER (owned by OTHER, private/selected without a grant).
    await seed({ id: "leak-private", title: "Their private", content: "Secret radon material owned by other.", visibility: "private", owner: OTHER });
    await seed({ id: "leak-selected", title: "Their selected item", content: "Selected argon dossier.", visibility: "selected_users", owner: OTHER });
    // Different space entirely.
    await seed({ id: "leak-otherspace", title: "Other space doc", content: "Cross-space neon secret.", spaceId: OTHER_SPACE });
    await reindexAndEmbed();

    const forbidden = new Set(["leak-private", "leak-selected", "leak-otherspace"]);
    // Probe with the distinctive term of EVERY doc (including forbidden ones) so we
    // actively try to surface what must never be returned.
    const probes = [
      "xenon", "krypton", "radon", "argon", "neon", "secret", "private", "runbook", "dossier",
    ];
    const modes = ["exact", "lexical", "hybrid", "hybrid_rerank"] as const;

    const leaks: Array<{ query: string; mode: string; id: string }> = [];
    for (const mode of modes) {
      for (const query of probes) {
        const res = await knowledgeSearch(true).search({
          spaceId: SPACE,
          viewerUserId: VIEWER,
          objectTypes: ["knowledge_item"],
          query,
          mode,
          maxResults: 50,
        });
        // Cover both the primary list and the query-rewrite discovery list.
        for (const item of [...res.items, ...(res.rewrite_items ?? [])]) {
          if (forbidden.has(item.object_id)) leaks.push({ query, mode, id: item.object_id });
        }
      }
    }
    // Hard gate: zero leaks. (VIEWER's own private doc IS allowed to appear.)
    expect(leaks).toEqual([]);
  });
});
