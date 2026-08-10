import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadConfig } from "../src/config";
import { migrate } from "../src/db/migrator";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { buildServer } from "../src/server";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

/**
 * A notes surface hoisted into a folder covers that folder's subtree, and the
 * narrowing has to reach the note *query* — a surface that filters only what it
 * draws, while its search still spans every Project, is the wrong half of the
 * feature (U4). `collection_ids` is what carries the subtree.
 */

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let app: FastifyInstance | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 2 });
    await migrate(pool, join(process.cwd(), "migrations"));
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    app = buildServer(loadConfig({
      SERVER_DATABASE_URL: database.getConnectionUri(),
      SERVER_INTERNAL_TOKEN: "test-internal-token",
      AGENT_SPACE_HOME: "/tmp/agent-space-note-scope-test",
    }), { logger: false });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[knowledge-note-scope-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(`TRUNCATE notes, note_collections, note_collection_items, space_objects, space_memberships, users, spaces CASCADE`);
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
});

async function makeFolder(name: string, parentId: string | null = null): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
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
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
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
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const first = await makeFolder("First");
    const second = await makeFolder("Second");
    const note = await repository.createNote(identity, { title: "Shared note", collection_id: first }) as { id: string };
    await pool.query(
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
    if (!available || !pool || !app) return;
    const repository = new PgKnowledgeRepository(pool);
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

  it("rejects an oversized scope rather than building an unbounded predicate", async () => {
    if (!available || !app) return;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/knowledge/notes?collection_ids=${Array.from({ length: 201 }, () => randomUUID()).join(",")}`,
      headers: { "x-internal-token": "test-internal-token" },
    });

    expect(response.statusCode).toBe(422);
  });
});
