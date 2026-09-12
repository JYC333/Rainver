import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import type { PoolClient } from "../src/db/pool.js";
import { setupTargetsForMissingBackend } from "../src/modules/agents/spaceAssistantService.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { knowledgeRetrievalAdapter } from "../src/modules/knowledge/retrievalAdapter.js";
import { PgAnnotationRepository, PgReaderRepository } from "../src/modules/reader/repository.js";
import { seedSpaceDefaults } from "../src/modules/spaces/spaceSeeds.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("spaceAssistantService", () => {
  describe("managed Assistant backend setup targets", () => {
    // Both destinations are always real work now: a Space with no backend can
    // either add a ModelProvider or log a CLI in on an execution host. The
    // second used to be conditional on the server having a CLI installed,
    // which is no longer a thing that can be true (ADR 0016).
    it("names both places a missing backend can be configured", () => {
      expect(setupTargetsForMissingBackend()).toEqual(["model_providers", "execution_hosts"]);
    });
  });
});

describe("spaceSeeds", () => {
  class SeedClient {
    readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];

    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      this.queries.push({ sql, params });
      if (sql.includes("SELECT count(*)::text AS count FROM note_collections")) {
        return { rows: [{ count: "1" }] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    }
  }

  describe("space default seeds", () => {
    it("does not seed policy text into user/project memory", async () => {
      const client = new SeedClient();

      await seedSpaceDefaults(client as unknown as PoolClient, "space-1", "user-1");

      const memoryInserts = client.queries.filter(call => call.sql.includes("INSERT INTO memory_entries"));
      expect(memoryInserts).toHaveLength(0);
      expect(client.queries.some(call => call.sql.includes("INSERT INTO runtime_context_policy_versions"))).toBe(true);
    });
  });
});

describe("spaceObjectContentAccessDb", () => {
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PROJECT = "22222222-2222-4222-8222-222222222222";
  const ITEM = "33333333-3333-4333-8333-333333333333";

  const db = useTestDatabase(`${import.meta.filename}#spaceObjectContentAccessDb`, { max: 2 });

  const owner = { spaceId: SPACE, userId: OWNER };
  const other = { spaceId: SPACE, userId: OTHER };
  const readerConfig = { artifactStorageRoot: "/tmp", sandboxRoot: "/tmp" } as ServerConfig;

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      [
        "reader_annotations",
        "note_revisions",
        "note_collection_items",
        "note_collections",
        "notes",
        "knowledge_items",
        "space_objects",
        "project_members",
        "projects",
        "space_memberships",
        "users",
        "spaces",
      ],
      { cascade: true },
    );
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Team','household',$2,$2)`,
      [SPACE, now],
    );
    for (const [id, name] of [[OWNER, "Owner"], [OTHER, "Other"]] as const) {
      await db.pool.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$2,'active',$3,$3)`,
        [id, name, now],
      );
      await db.pool.query(
        `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
         VALUES ($1,$2,$3,'member','active',$4,$4)`,
        [randomUUID(), SPACE, id, now],
      );
    }
    await db.pool.query(
      `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
       VALUES ($1,$2,'Project','active',$3,$4,$4)`,
      [PROJECT, SPACE, OWNER, now],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
    for (const userId of [OWNER, OTHER]) {
      await db.pool.query(
        `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
        [randomUUID(), SPACE, PROJECT, userId, now],
      );
    }
  });

  describe("space_object content access (real Postgres)", () => {
    it("does not serve a private project note through the research_notebook Reader", async () => {
      const knowledge = new PgKnowledgeRepository(db.pool);
      const note = await knowledge.createNote(owner, {
        title: "Private understanding",
        primary_project_id: PROJECT,
        plain_text: "Secret finding",
        excerpt: "A blurb",
      }) as { id: string };
      await db.pool.query(
        `UPDATE space_objects SET visibility='private', owner_user_id=$2 WHERE id=$1`,
        [note.id, OWNER],
      );

      expect(await knowledge.getNote(other, note.id)).toBeNull();
      const reader = new PgReaderRepository(db.pool, readerConfig);
      expect(await reader.getDocument(other, "research_notebook", note.id)).toBeNull();
      expect(await reader.getDocument(owner, "research_notebook", note.id)).toMatchObject({
        document_type: "research_notebook",
        plain_text: "Secret finding",
      });
      await expect(new PgAnnotationRepository(db.pool).listAnnotations(other, "research_notebook", note.id))
        .rejects.toMatchObject({ statusCode: 404 });
    });

    it("withholds note and knowledge bodies from summary-level viewers", async () => {
      const knowledge = new PgKnowledgeRepository(db.pool);
      const note = await knowledge.createNote(owner, {
        title: "Shared note",
        excerpt: "Public blurb",
        plain_text: "SECRET NOTE BODY",
      }) as { id: string };
      await db.pool.query(
        `UPDATE space_objects SET access_level='summary', visibility='space_shared' WHERE id=$1`,
        [note.id],
      );
      await insertKnowledgeItem(db.pool, {
        id: ITEM,
        spaceId: SPACE,
        title: "Shared item",
        content: "SECRET ITEM BODY",
        visibility: "space_shared",
        ownerUserId: OWNER,
        createdByUserId: OWNER,
      });
      await db.pool.query(
        `UPDATE space_objects SET access_level='summary', summary='Item blurb' WHERE id=$1`,
        [ITEM],
      );

      const noteForOther = await knowledge.getNote(other, note.id) as {
        excerpt: string | null;
        plain_text: string | null;
        content_json: unknown;
      };
      expect(noteForOther.excerpt).toBe("Public blurb");
      expect(noteForOther.plain_text).toBeNull();
      expect(noteForOther.content_json).toBeNull();
      expect(await knowledge.getNote(owner, note.id)).toMatchObject({ plain_text: "SECRET NOTE BODY" });

      const itemForOther = await knowledge.getItem(other, ITEM) as {
        content_preview: string | null;
        content: string | null;
        plain_text: string | null;
      };
      expect(itemForOther.content_preview).toBe("Item blurb");
      expect(itemForOther.content).toBeNull();
      expect(itemForOther.plain_text).toBeNull();
      expect(await knowledge.getItem(owner, ITEM)).toMatchObject({ content: "SECRET ITEM BODY" });

      const noteHit = await knowledgeRetrievalAdapter.revalidate(db.pool, SPACE, "note", note.id, OTHER);
      expect(noteHit?.text).toBe("Public blurb");
      expect(noteHit?.text).not.toContain("SECRET");
      const itemHit = await knowledgeRetrievalAdapter.revalidate(db.pool, SPACE, "knowledge_item", ITEM, OTHER);
      expect(itemHit?.text).toBe("Item blurb");
      expect(itemHit?.text).not.toContain("SECRET");
    });

    it("withholds note history, source text, link quotes, and claim text from summary viewers", async () => {
      const knowledge = new PgKnowledgeRepository(db.pool);
      const note = await knowledge.createNote(owner, {
        title: "History note",
        excerpt: "Blurb",
        plain_text: "SECRET NOTE BODY",
      }) as { id: string };
      await db.pool.query(
        `UPDATE space_objects SET access_level='summary', visibility='space_shared' WHERE id=$1`,
        [note.id],
      );
      await expect(knowledge.listNoteRevisions(other, note.id)).rejects.toMatchObject({ statusCode: 404 });
      expect((await knowledge.listNoteRevisions(owner, note.id)).length).toBeGreaterThan(0);
      expect(await knowledge.getNote(other, note.id)).toMatchObject({ content_hash: null });

      const source = await knowledge.createSource(owner, {
        source_type: "webpage",
        visibility: "space_shared",
        title: "Shared source",
        raw_text: "SECRET SOURCE TEXT",
        content_ref: "SECRET-CONTENT-REF",
        summary: "Source blurb",
      }) as { id: string; raw_text: string | null };
      // The author's own create response carries the body.
      expect(source.raw_text).toBe("SECRET SOURCE TEXT");
      await db.pool.query(
        `UPDATE space_objects SET access_level='summary', visibility='space_shared' WHERE id=$1`,
        [source.id],
      );
      expect(await knowledge.getSource(other, source.id)).toMatchObject({
        raw_text: null,
        content_ref: null,
        summary: "Source blurb",
      });
      expect(await knowledge.getSource(owner, source.id)).toMatchObject({
        raw_text: "SECRET SOURCE TEXT",
        content_ref: "SECRET-CONTENT-REF",
      });

      await insertKnowledgeItem(db.pool, {
        id: ITEM,
        spaceId: SPACE,
        title: "Linked item",
        content: "Item body",
        visibility: "space_shared",
        ownerUserId: OWNER,
        createdByUserId: OWNER,
      });
      await knowledge.createItemSource(owner, ITEM, { source_id: source.id, quote: "SECRET QUOTE" });
      await db.pool.query(`UPDATE space_objects SET access_level='summary' WHERE id=$1`, [ITEM]);
      expect(await knowledge.listItemSources(other, ITEM)).toEqual([expect.objectContaining({ quote: null })]);
      expect(await knowledge.listItemSources(owner, ITEM)).toEqual([expect.objectContaining({ quote: "SECRET QUOTE" })]);

      const CLAIM = "44444444-4444-4444-8444-444444444444";
      await db.pool.query(
        `INSERT INTO space_objects (id, space_id, object_type, title, summary, visibility, access_level,
                                    owner_user_id, created_by_user_id, created_at, updated_at)
         VALUES ($1,$2,'claim','Shared claim','Claim blurb','space_shared','summary',$3,$3,now(),now())`,
        [CLAIM, SPACE, OWNER],
      );
      await db.pool.query(
        `INSERT INTO claims (object_id, space_id, subject_text, claim_kind, claim_text, normalized_claim_hash,
                             confidence_method, resolution_state, status)
         VALUES ($1,$2,'Retrieval','fact','SECRET CLAIM TEXT','hash-1','human_confirmed','unreviewed','active')`,
        [CLAIM, SPACE],
      );
      await db.pool.query(
        `INSERT INTO claim_sources (id, space_id, claim_id, source_object_id, evidence_role, locator,
                                    quote_excerpt, created_at)
         VALUES ($1,$2,$3,$4,'supports','p. 3','SECRET EVIDENCE QUOTE',now())`,
        [randomUUID(), SPACE, CLAIM, source.id],
      );
      expect(await knowledge.getClaim(other, CLAIM)).toMatchObject({
        claim_text: null,
        excerpt: "Claim blurb",
        sources: [expect.objectContaining({ quote_excerpt: null, locator: null })],
      });
      expect(await knowledge.getClaim(owner, CLAIM)).toMatchObject({
        claim_text: "SECRET CLAIM TEXT",
        sources: [expect.objectContaining({ quote_excerpt: "SECRET EVIDENCE QUOTE" })],
      });
    });
  });
});
