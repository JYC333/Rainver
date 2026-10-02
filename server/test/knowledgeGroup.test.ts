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
import { registerKnowledgeProposalAppliers } from "../src/modules/knowledge/proposalApplier.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { insertProposalRow } from "../src/modules/proposals/reviewPackets.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
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
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Owner','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [USER, now]);
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

    it("purges a note another object still has a relation to", async () => {
      if (!db.available) return;
      const identity = { spaceId: SPACE, userId: USER };
      const repository = new PgKnowledgeRepository(db.pool);
      const stale = await repository.createNote(identity, { title: "Linked, then deleted" }) as { id: string };
      const live = await repository.createNote(identity, { title: "Still here" }) as { id: string };
      const other = await repository.createNote(identity, { title: "Also here" }) as { id: string };
      const insertRelation = (from: string, to: string, source: string | null) => db.pool.query<{ id: string }>(
        `INSERT INTO object_relations (id, space_id, from_object_id, to_object_id, link_type, status, source_object_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'related_to','active',$5,now(),now()) RETURNING id`,
        [randomUUID(), SPACE, from, to, source],
      );
      const toStale = (await insertRelation(live.id, stale.id, null)).rows[0]!.id;
      const derived = (await insertRelation(live.id, other.id, stale.id)).rows[0]!.id;
      await repository.deleteNote(identity, stale.id);
      await db.pool.query(`UPDATE space_objects SET deleted_at = now() - interval '31 days' WHERE id = $1`, [stale.id]);

      expect(await repository.purgeDeletedNotes(identity)).toMatchObject({ deleted: 1 });

      const relations = await db.pool.query<{ id: string; source_object_id: string | null }>(
        `SELECT id, source_object_id FROM object_relations WHERE space_id = $1`, [SPACE],
      );
      // An edge to the purged note goes with it; an edge between two live
      // objects stays and only loses the provenance pointer.
      expect(relations.rows).toEqual([{ id: derived, source_object_id: null }]);
      expect(relations.rows.map((row) => row.id)).not.toContain(toStale);
    });

    it("never purges a note that was restored after being deleted", async () => {
      if (!db.available) return;
      const identity = { spaceId: SPACE, userId: USER };
      const repository = new PgKnowledgeRepository(db.pool);
      const restored = await repository.createNote(identity, { title: "Deleted, then restored" }) as { id: string };
      await repository.deleteNote(identity, restored.id);
      await db.pool.query(
        `UPDATE space_objects SET deleted_at = now() - interval '31 days' WHERE id = $1`,
        [restored.id],
      );
      await repository.updateNote(identity, restored.id, { status: "active" });

      expect(await repository.purgeDeletedNotes(identity)).toMatchObject({ deleted: 0 });
      const row = await db.pool.query<{ deleted_at: string | null }>(
        `SELECT deleted_at FROM space_objects WHERE id = $1`, [restored.id],
      );
      expect(row.rows[0]).toEqual({ deleted_at: null });
    });

    it("does not let notes the caller cannot purge crowd out the ones they can", async () => {
      if (!db.available) return;
      const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const PROJECT = "22222222-2222-4222-8222-222222222222";
      const now = new Date().toISOString();
      await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Member','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [MEMBER, now]);
      await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`, [randomUUID(), SPACE, MEMBER, now]);
      await db.pool.query(`INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES ($1,$2,'Owner project','active',$3,$4,$4)`, [PROJECT, SPACE, USER, now]);
      await seedMainlineRoomsForAllProjects(db.pool);
      // More long-deleted notes than one purge batch holds, all in a Project
      // the member cannot write, then one of the member's own.
      await db.pool.query(
        `WITH objects AS (
           INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, primary_project_id, created_by_user_id, created_at, updated_at, deleted_at)
           SELECT gen_random_uuid()::varchar, $1, 'note', 'Old project note', 'space_shared', $2, $3, $2,
                  now() - interval '40 days', now() - interval '31 days', now() - interval '31 days'
             FROM generate_series(1, 501)
           RETURNING id
         )
         INSERT INTO notes (object_id, space_id, content_json, content_format, content_schema_version, plain_text, version, content_hash, status)
         SELECT id, $1, '{}'::jsonb, 'markdown', 1, '', 1, 'seed', 'deleted' FROM objects`,
        [SPACE, USER, PROJECT],
      );
      const mine = randomUUID();
      await db.pool.query(
        `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_by_user_id, created_at, updated_at, deleted_at)
         VALUES ($1, $2, 'note', 'My old note', 'private', $3, $3, now() - interval '40 days', now() - interval '31 days', now() - interval '31 days')`,
        [mine, SPACE, MEMBER],
      );
      await db.pool.query(
        `INSERT INTO notes (object_id, space_id, content_json, content_format, content_schema_version, plain_text, version, content_hash, status)
         VALUES ($1, $2, '{}'::jsonb, 'markdown', 1, '', 1, 'seed', 'deleted')`,
        [mine, SPACE],
      );

      const repository = new PgKnowledgeRepository(db.pool);
      expect(await repository.purgeDeletedNotes({ spaceId: SPACE, userId: MEMBER })).toMatchObject({ deleted: 1 });
      expect((await db.pool.query(`SELECT 1 FROM space_objects WHERE id = $1`, [mine])).rowCount).toBe(0);
    });
  });
});

describe("knowledgeUpdateApplyDb", () => {
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  const db = useTestDatabase(`${import.meta.filename}#knowledgeUpdateApplyDb`, { max: 3 });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(db.pool, ["knowledge_items", "space_objects", "proposals", "space_memberships", "users", "spaces"], { cascade: true });
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Owner','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [USER, now]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
  });

  it("keeps one active version when two update proposals for one item are accepted at once", async () => {
    if (!db.available) return;
    const itemId = randomUUID();
    await insertKnowledgeItem(db.pool, { id: itemId, spaceId: SPACE, title: "Alpha", content: "v1", ownerUserId: USER, createdByUserId: USER });
    const registry = new ProposalApplierRegistry();
    registerKnowledgeProposalAppliers(registry);
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test-internal-token" });
    // The new version points at the proposal that produced it, so each one is a real row.
    const proposal = async (content: string): Promise<ApplyProposal> => {
      const payload = { operation: "update", target_item_id: itemId, title: "Alpha", content };
      const row = await insertProposalRow(db.pool, {
        spaceId: SPACE,
        proposalType: "knowledge_update",
        title: "Update Alpha",
        payload,
        rationale: "Two reviewers, one item.",
        createdByUserId: USER,
        ownerUserId: USER,
        visibility: "space_shared",
      });
      return {
        id: row.id,
        space_id: SPACE,
        proposal_type: "knowledge_update",
        title: "Update Alpha",
        payload_json: payload,
        project_folder_id: null,
        visibility: "space_shared",
        created_by_user_id: USER,
        owner_user_id: USER,
        project_id: null,
      };
    };

    const first = await db.pool.connect();
    const second = await db.pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const [firstProposal, secondProposal] = await Promise.all([
        proposal("v2 from the first reviewer"),
        proposal("v2 from the second reviewer"),
      ]);
      await registry.apply({ config, db: first, proposal: firstProposal, userId: USER });
      // The second reviewer reads the item while the first version is still
      // uncommitted. Without the row lock it sees the old active head and
      // writes a second active version 2 beside the first.
      const racing = registry.apply({ config, db: second, proposal: secondProposal, userId: USER });
      await first.query("COMMIT");
      try {
        await expect(racing).rejects.toThrow(/not active/);
      } finally {
        await second.query("ROLLBACK").catch(() => undefined);
      }
    } finally {
      first.release();
      second.release();
    }

    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM knowledge_items WHERE space_id = $1 AND root_item_id = $2 AND status = 'active'`,
      [SPACE, itemId],
    )).rows[0]?.count).toBe("1");
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
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Owner','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [USER, now]);
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
      await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Other','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [other, now]);
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
      await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Other','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [other, now]);
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
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1, 'Viewer', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system'), ($2, 'Other', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')
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
