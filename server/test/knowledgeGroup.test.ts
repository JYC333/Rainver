import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { knowledgeModule } from "../src/modules/knowledge/index.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { knowledgeItemOut } from "../src/modules/knowledge/knowledgeRepositoryMappers.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
});

describe("knowledgeNotePurgeDb", () => {
  // purgeDeletedNotes reported a 30-day retention window that its DELETE did not
  // apply, so it hard-deleted a note the moment that note was soft-deleted. The
  // purge is irreversible, so the window has to be real.

  const SPACE = "11111111-1111-4111-8111-111111111111";
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";


  const db = useTestDatabase(`${import.meta.filename}#knowledgeNotePurgeDb`, { max: 2 });

  beforeAll(async () => {
    if (!db.available) return;
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
  });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["notes", "space_objects", "space_memberships", "users", "spaces"],
      { cascade: true },
    );
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
  });

  describe("purgeDeletedNotes retention window (real Postgres)", () => {
    it("keeps a just-deleted note and destroys only one past the reported window", async () => {
      if (!db.available) return;
      const identity = { spaceId: SPACE, userId: USER };
      const repository = new PgKnowledgeRepository(db.pool);

      const recent = await repository.createNote(identity, { title: "Deleted today" }) as { id: string };
      const stale = await repository.createNote(identity, { title: "Deleted long ago" }) as { id: string };
      await repository.deleteNote(identity, recent.id);
      await repository.deleteNote(identity, stale.id);
      await db.pool.query(
        `UPDATE space_objects SET deleted_at = now() - interval '31 days' WHERE id = $1`,
        [stale.id],
      );

      const result = await repository.purgeDeletedNotes(identity) as { deleted: number; retention_days: number };

      expect(result).toEqual({ deleted: 1, retention_days: 30 });
      const remaining = await db.pool.query<{ id: string }>(
        `SELECT id FROM space_objects WHERE space_id = $1 AND object_type = 'note'`,
        [SPACE],
      );
      expect(remaining.rows.map((row) => row.id)).toEqual([recent.id]);
    });
  });
});

describe("knowledgeNoteScopeDb", () => {
  /**
   * A notes surface hoisted into a folder covers that folder's subtree, and the
   * narrowing has to reach the note *query* — a surface that filters only what it
   * draws, while its search still spans every Project, is the wrong half of the
   * feature (U4). `collection_ids` is what carries the subtree.
   */

  const SPACE = "11111111-1111-4111-8111-111111111111";
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  let app: FastifyInstance | undefined;

  const db = useTestDatabase(`${import.meta.filename}#knowledgeNoteScopeDb`, { max: 2 });

  beforeAll(async () => {
    // Not `|| !app`: `app` is what this hook builds, so guarding on it meant the
    // hook returned before building it and every test in this describe took its
    // own `!app` early return — reporting a pass without running.
    if (!db.available) return;
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    app = buildModuleServer(loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      SERVER_INTERNAL_TOKEN: "test-internal-token",
      RAINVER_HOME: "/tmp/rainver-note-scope-test",
    }), [knowledgeModule]);
  });

  beforeEach(async () => {
    if (!db.available || !app) return;
    await resetTables(
      db.pool,
      ["notes", "note_collections", "note_collection_items", "content_access_grants", "space_objects", "space_memberships", "users", "spaces"],
      { cascade: true },
    );
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
  });

  async function makeFolder(name: string, parentId: string | null = null): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'normal',0,false,false,$5,$5)`,
      [id, SPACE, parentId, name, now],
    );
    return id;
  }

  const identity = { spaceId: SPACE, userId: USER };

  function ids(listed: unknown): string[] {
    return (listed as { items: Array<{ id: string }> }).items.map((item) => item.id);
  }

  describe("note list collection scoping (real Postgres)", () => {
    it("keeps a search inside the hoisted subtree", async () => {
      if (!db.available || !app) return;
      const repository = new PgKnowledgeRepository(db.pool);
      const hoisted = await makeFolder("Hoisted");
      const nested = await makeFolder("Nested", hoisted);
      const outside = await makeFolder("Outside");

      const inRoot = await repository.createNote(identity, { title: "Protocol draft", collection_id: hoisted }) as { id: string };
      const inNested = await repository.createNote(identity, { title: "Protocol interviews", collection_id: nested }) as { id: string };
      const elsewhere = await repository.createNote(identity, { title: "Protocol elsewhere", collection_id: outside }) as { id: string };

      const scoped = await repository.listNotes(identity, {
        status: null, projectId: null, collectionId: null,
        collectionIds: [hoisted, nested], q: "Protocol", limit: 50, offset: 0,
      });
      expect(ids(scoped).sort()).toEqual([inRoot.id, inNested.id].sort());
      expect(ids(scoped)).not.toContain(elsewhere.id);
      expect((scoped as { total: number }).total).toBe(2);

      const unscoped = await repository.listNotes(identity, {
        status: null, projectId: null, collectionId: null,
        collectionIds: null, q: "Protocol", limit: 50, offset: 0,
      });
      expect(ids(unscoped)).toHaveLength(3);
    });

    it("returns a note once even when it sits in several scoped folders", async () => {
      if (!db.available || !app) return;
      const repository = new PgKnowledgeRepository(db.pool);
      const first = await makeFolder("First");
      const second = await makeFolder("Second");
      const note = await repository.createNote(identity, { title: "Shared note", collection_id: first }) as { id: string };
      await db.pool.query(
        `INSERT INTO note_collection_items (id, space_id, collection_id, note_id, sort_order, created_at)
         VALUES ($1,$2,$3,$4,0,$5)`,
        [randomUUID(), SPACE, second, note.id, new Date().toISOString()],
      );

      const listed = await repository.listNotes(identity, {
        status: null, projectId: null, collectionId: null,
        collectionIds: [first, second], q: null, limit: 50, offset: 0,
      });

      expect(ids(listed)).toEqual([note.id]);
      expect((listed as { total: number }).total).toBe(1);
    });

    it("carries the scope through the public list route", async () => {
      if (!db.available || !app) return;
      const repository = new PgKnowledgeRepository(db.pool);
      const hoisted = await makeFolder("Hoisted");
      const outside = await makeFolder("Outside");
      const inside = await repository.createNote(identity, { title: "Inside", collection_id: hoisted }) as { id: string };
      await repository.createNote(identity, { title: "Outside", collection_id: outside });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/knowledge/notes?collection_ids=${hoisted}`,
        headers: { "x-internal-token": "test-internal-token" },
      });

      expect(response.statusCode).toBe(200);
      expect(ids(response.json())).toEqual([inside.id]);
    });

    /**
     * Readable is not writable. A `selected_users` note hands reading to its
     * grantees; a repository that gated the mutation on that same read
     * predicate let a grantee rewrite the owner's note. The refusal is the read
     * gate's own 404, and the same rule decides a Source.
     */
    it("lets a grantee read an owner-scoped note but not rewrite it", async () => {
      if (!db.available || !app) return;
      const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const now = new Date().toISOString();
      await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Other','active',$2,$2)`, [other, now]);
      await db.pool.query(
        `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`,
        [randomUUID(), SPACE, other, now],
      );
      const repository = new PgKnowledgeRepository(db.pool);
      const folder = await makeFolder("Private");
      const note = await repository.createNote(identity, { title: "Owner note", collection_id: folder, visibility: "private" }) as { id: string };
      // Shared with named people: the one visibility a read grant widens.
      await db.pool.query(`UPDATE space_objects SET visibility='selected_users' WHERE id=$1`, [note.id]);
      await db.pool.query(
        `INSERT INTO content_access_grants (id, space_id, resource_type, resource_id, grantee_user_id, access_level, granted_by_user_id, created_at, updated_at)
         VALUES ($1,$2,'space_object',$3,$4,'full',$5,$6,$6)`,
        [randomUUID(), SPACE, note.id, other, USER, now],
      );

      const granteeIdentity = { spaceId: SPACE, userId: other };
      await expect(repository.getNote(granteeIdentity, note.id)).resolves.toMatchObject({ id: note.id });
      await expect(repository.updateNote(granteeIdentity, note.id, { title: "Rewritten" }))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(repository.getNote(identity, note.id)).resolves.toMatchObject({ title: "Owner note" });
    });

    /**
     * A list that answers what the detail page refuses. `listSources` filtered
     * by Space alone, so every Knowledge source in the Space was listable — its
     * title and URI with it — whatever its owner or visibility.
     */
    it("keeps another member's private Knowledge source out of the list", async () => {
      if (!db.available || !app) return;
      const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const now = new Date().toISOString();
      await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Other','active',$2,$2)`, [other, now]);
      await db.pool.query(
        `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`,
        [randomUUID(), SPACE, other, now],
      );
      const repository = new PgKnowledgeRepository(db.pool);
      const mine = await repository.createSource(identity, {
        source_type: "external_note", title: "My source", visibility: "space_shared",
      }) as { id: string };
      const theirs = await repository.createSource(
        { spaceId: SPACE, userId: other },
        { source_type: "external_note", title: "Their private source", visibility: "private" },
      ) as { id: string };

      const listed = await repository.listSources(identity, {
        sourceType: null, status: null, q: null, limit: 50, offset: 0,
      }) as { items: Array<{ id: string }> };
      const listedIds = listed.items.map((item) => item.id);
      expect(listedIds).toContain(mine.id);
      expect(listedIds).not.toContain(theirs.id);
    });

    it("rejects an oversized scope rather than building an unbounded predicate", async () => {
      if (!db.available || !app) return;
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/knowledge/notes?collection_ids=${Array.from({ length: 201 }, () => randomUUID()).join(",")}`,
        headers: { "x-internal-token": "test-internal-token" },
      });

      expect(response.statusCode).toBe(422);
    });
  });
});

describe("knowledgeRetrievalDb", () => {
  // Real-PostgreSQL round-trip for the zero-LLM retrieval substrate. The focused
  // knowledgeRetrieval.test.ts uses an in-memory fake, which cannot catch SQL
  // bugs (column names, window-alias ORDER BY, to_tsvector / ts_rank_cd, LATERAL
  // joins, ON CONFLICT). This test applies the committed baseline to a throwaway
  // Postgres and exercises projection writes + every search arm for real. Skips
  // gracefully when Docker is unavailable.

  const SPACE = "11111111-1111-4111-8111-111111111111";
  const ITEM_A = "33333333-3333-4333-8333-333333333333";
  const ITEM_B = "44444444-4444-4444-8444-444444444444";
  const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";


  const db = useTestDatabase(`${import.meta.filename}#knowledgeRetrievalDb`);

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["retrieval_objects", "retrieval_edges", "knowledge_items", "space_objects"],
      { cascade: true },
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at)
       VALUES ($1, 'Test Space', 'personal', now(), now()) ON CONFLICT (id) DO NOTHING`,
      [SPACE],
    );
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'Viewer', 'active', now(), now()), ($2, 'Other', 'active', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [VIEWER, OTHER],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())
       ON CONFLICT (space_id, user_id) DO NOTHING`,
      [SPACE, VIEWER],
    );
  });

  async function insertItem(over: {
    id: string;
    title: string;
    content: string;
    slug?: string;
    aliases?: string[];
    status?: string;
    visibility?: string;
  }): Promise<void> {
    await insertKnowledgeItem(db.pool, {
      id: over.id,
      spaceId: SPACE,
      title: over.title,
      content: over.content,
      slug: over.slug ?? null,
      aliases: over.aliases ?? [],
      status: over.status ?? "active",
      visibility: over.visibility ?? "space_shared",
    });
  }

  describe("Knowledge zero-LLM retrieval (real Postgres)", () => {
    it("indexes a KnowledgeItem and finds it by title, alias, and lexical content", async () => {
      if (!db.available) return;
      await insertItem({
        id: ITEM_A,
        title: "Alpha",
        content: "Alpha is the canonical page about light.",
        slug: "alpha",
        aliases: ["Hall of Light"],
      });
      await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindex(SPACE, "knowledge_item", ITEM_A);
      const service = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry);

      const byTitle = await service.search({ spaceId: SPACE, viewerUserId: VIEWER, query: "Alpha" });
      expect(byTitle.items[0]).toMatchObject({ object_id: ITEM_A, evidence: { kind: "exact_title_match" } });

      const byAlias = await service.search({ spaceId: SPACE, viewerUserId: VIEWER, query: "hall of light" });
      expect(byAlias.items[0]).toMatchObject({ object_id: ITEM_A, evidence: { kind: "alias_hit" } });

      const byLexical = await service.search({ spaceId: SPACE, viewerUserId: VIEWER, query: "canonical page" });
      expect(byLexical.items.map((item) => item.object_id)).toContain(ITEM_A);
    });

    it("projects a wikilink into an edge and expands graph neighbors", async () => {
      if (!db.available) return;
      await insertItem({ id: ITEM_B, title: "Beta", content: "Beta reference content.", slug: "beta" });
      await insertItem({ id: ITEM_A, title: "Alpha", content: "Alpha links to [[Beta]].", slug: "alpha" });
      const projection = new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry);
      await projection.reindex(SPACE, "knowledge_item", ITEM_B);
      await projection.reindex(SPACE, "knowledge_item", ITEM_A);

      const out = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry).search({
        spaceId: SPACE,
        viewerUserId: VIEWER,
        query: "Alpha",
        maxResults: 5,
      });

      const beta = out.items.find((item) => item.object_id === ITEM_B);
      expect(beta?.evidence.kind).toBe("graph_neighbor");
    });

    it("drops a non-visible item during canonical revalidation", async () => {
      if (!db.available) return;
      await insertKnowledgeItem(db.pool, {
        id: ITEM_A,
        spaceId: SPACE,
        title: "Alpha",
        content: "secret",
        slug: "alpha",
        visibility: "private",
        ownerUserId: OTHER,
        createdByUserId: OTHER,
      });
      await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindex(SPACE, "knowledge_item", ITEM_A);

      const out = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry).search({
        spaceId: SPACE,
        viewerUserId: VIEWER,
        query: "Alpha",
      });

      expect(out.items).toHaveLength(0);
    });
  });
});

describe("knowledge item source refs at summary level", () => {
  it("drops the evidence excerpt a source ref carries of the item's own content", () => {
    const row = {
      id: "item-1", space_id: "space-1", project_id: null, project_folder_id: null, knowledge_kind: "concept",
      slug: null, title: "Item", content: "SECRET BODY", plain_text: "SECRET BODY", excerpt: "Blurb", status: "active",
      visibility: "space_shared", verification_status: "unverified", reflection_status: "unreviewed", tags_json: [],
      confidence: null, version: 1, updated_at: "2026-09-11T00:00:00.000Z", effective_access_level: "summary",
    } as unknown as Parameters<typeof knowledgeItemOut>[0];
    const refs = [{ source_type: "note", source_id: "note-1", evidence_json: { excerpt: "SECRET BODY" } }];
    const summary = knowledgeItemOut(row, refs);
    expect(summary.source_refs).toEqual([{ source_type: "note", source_id: "note-1" }]);
    expect(knowledgeItemOut({ ...row, effective_access_level: "full" }, refs).source_refs).toEqual(refs);
  });
});
