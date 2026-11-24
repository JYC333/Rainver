import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { PgArtifactRepository, type ArtifactPage } from "../src/modules/artifacts/repository.js";
import type { Queryable } from "../src/modules/proposals/repository.js";
import { seedSpaceMember } from "./support/domainSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";

// The Artifact list's `total` and `items` must describe one database state:
// the same snapshot, a stable order for equal timestamps, an empty page past
// the end that still reports the total, and the read rules unchanged.

const SPACE = "11111111-1111-4111-8111-1111111111d1";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad1";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbd1";
const STAMP = "2026-01-01T00:00:00.000Z";
const STORAGE = { artifactStorageRoot: "/tmp/artifact-list-snapshot", sandboxRoot: "/tmp/artifact-list-snapshot/sandbox" };

const db = useTestDatabase(import.meta.filename, { max: 6 });
let writer: PoolClient | undefined;
let serial = 0;

beforeAll(async () => {
  if (!db.available) return;
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Team','household',$2,$2)`, [SPACE, STAMP]);
  await seedSpaceMember(db.pool, { space: SPACE, user: OWNER, role: "owner", now: STAMP });
  await seedSpaceMember(db.pool, { space: SPACE, user: MEMBER, role: "member", now: STAMP });
  writer = await db.pool.connect();
});

afterAll(() => writer?.release());

beforeEach(async () => {
  if (!db.available) return;
  await db.pool.query(`DELETE FROM artifacts WHERE space_id = $1`, [SPACE]);
});

async function insertArtifact(client: Queryable, input: { createdAt?: string; visibility?: string; type?: string } = {}): Promise<string> {
  serial += 1;
  const id = `artifact-${String(serial).padStart(6, "0")}`;
  const at = input.createdAt ?? STAMP;
  await client.query(
    `INSERT INTO artifacts (id, space_id, owner_user_id, artifact_type, title, content, export_formats_json, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $1, 'body', '[]'::jsonb, $5, $6, $6)`,
    [id, SPACE, OWNER, input.type ?? "markdown", input.visibility ?? "space_shared", at],
  );
  return id;
}

/** The ids the owner reads, in the list's order, as of now. */
async function visibleNow(client: Queryable): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM artifacts WHERE space_id = $1 AND surface_role <> 'system_archive' ORDER BY created_at DESC, id DESC`, [SPACE],
  );
  return result.rows.map((row) => row.id);
}

function repository(queryable: Queryable = db.pool): PgArtifactRepository {
  return new PgArtifactRepository(queryable, STORAGE);
}

function ids(page: ArtifactPage): string[] {
  return page.items.map((item) => item.id);
}

describe("Artifact list snapshot (real Postgres)", () => {
  it("pages equal timestamps in a stable id order without repeats or gaps, and reports the total past the end", async () => {
    if (!db.available) return;
    const all: string[] = [];
    for (let i = 0; i < 25; i += 1) all.push(await insertArtifact(db.pool));
    const expected = [...all].sort().reverse();
    const seen: string[] = [];
    for (let offset = 0; offset < 25; offset += 4) {
      const page = await repository().listVisible(SPACE, OWNER, { limit: 4, offset });
      expect(page.total).toBe(25);
      expect(ids(page)).toEqual(expected.slice(offset, offset + 4));
      seen.push(...ids(page));
    }
    expect(seen).toEqual(expected);
    for (const offset of [25, 40]) {
      const past = await repository().listVisible(SPACE, OWNER, { limit: 4, offset });
      expect(past).toMatchObject({ items: [], total: 25, limit: 4, offset });
    }
  });

  it("keeps the read rules: an unreadable candidate counts for nobody who cannot read it", async () => {
    if (!db.available) return;
    const shared = await insertArtifact(db.pool, { createdAt: "2026-01-02T00:00:00.000Z" });
    const privateIds = [await insertArtifact(db.pool, { visibility: "private" }), await insertArtifact(db.pool, { visibility: "private" })];
    const member = await repository().listVisible(SPACE, MEMBER, { limit: 10, offset: 0 });
    expect(member).toMatchObject({ total: 1 });
    expect(ids(member)).toEqual([shared]);
    const memberPast = await repository().listVisible(SPACE, MEMBER, { limit: 10, offset: 5 });
    expect(memberPast).toMatchObject({ items: [], total: 1 });
    const owner = await repository().listVisible(SPACE, OWNER, { limit: 10, offset: 0 });
    expect(owner.total).toBe(3);
    expect(ids(owner)).toEqual([shared, ...privateIds.sort().reverse()]);
    // Candidates exist for this filter but the member reads none of them.
    const csv = await insertArtifact(db.pool, { visibility: "private", type: "csv" });
    expect(await repository().listVisible(SPACE, MEMBER, { limit: 10, offset: 0, artifactType: "csv" })).toMatchObject({ items: [], total: 0 });
    expect(ids(await repository().listVisible(SPACE, OWNER, { limit: 10, offset: 0, artifactType: "csv" }))).toEqual([csv]);
    await db.pool.query(`UPDATE artifacts SET visibility = 'private' WHERE id = $1`, [shared]);
    expect(await repository().listVisible(SPACE, MEMBER, { limit: 10, offset: 0 })).toMatchObject({ items: [], total: 0 });
  });

  it("answers the no-candidate case exactly, with and without archives", async () => {
    if (!db.available) return;
    expect(await repository().listVisible(SPACE, OWNER, { limit: 10, offset: 0 })).toEqual({ items: [], total: 0, limit: 10, offset: 0 });
    const archive = await insertArtifact(db.pool);
    await db.pool.query(`UPDATE artifacts SET surface_role = 'system_archive' WHERE id = $1`, [archive]);
    expect(await repository().listVisible(SPACE, OWNER, { limit: 10, offset: 0 })).toMatchObject({ items: [], total: 0 });
    expect(await repository().listVisible(SPACE, OWNER, { limit: 10, offset: 0, artifactType: "csv" })).toMatchObject({ items: [], total: 0 });
    const audit = await repository().listVisible(SPACE, OWNER, { limit: 10, offset: 0, includeSystemArchives: true });
    expect(audit.total).toBe(1);
    expect(ids(audit)).toEqual([archive]);
  });

  it("describes one committed state when another writer commits before every statement the list issues", async () => {
    if (!db.available) return;
    for (let i = 0; i < 6; i += 1) await insertArtifact(db.pool, { createdAt: `2026-01-0${1 + (i % 3)}T00:00:00.000Z` });
    // Before each list statement reaches PostgreSQL another connection commits
    // a newer Artifact and the state it leaves is recorded; statements run one
    // at a time (a concurrent caller waits for the previous one), so each sees
    // a different state. The page must be exactly one recorded state's slice.
    let tick = 0;
    for (const offset of [0, 3, 7, 50]) {
      const states: string[][] = [];
      let previous: Promise<unknown> = Promise.resolve();
      const interleaved: Queryable = {
        query(sql, params) {
          const run = previous.then(async () => {
            if (/FROM artifacts a\b/.test(sql)) {
              tick += 1;
              await insertArtifact(writer!, { createdAt: `2026-02-01T00:00:${String(tick).padStart(2, "0")}.000Z` });
              states.push(await visibleNow(writer!));
            }
            return db.pool.query(sql, params as unknown[]);
          });
          previous = run.catch(() => undefined);
          return run as never;
        },
      };
      const page = await repository(interleaved).listVisible(SPACE, OWNER, { limit: 3, offset });
      expect(states.length).toBeGreaterThan(1);
      const matching = states.filter((state) => state.length === page.total
        && JSON.stringify(state.slice(offset, offset + 3)) === JSON.stringify(ids(page)));
      expect(matching, `offset ${offset}: total ${page.total}, items ${ids(page).join(",")}`).toHaveLength(1);
    }
  });

  it("stays self-consistent while writers insert and delete concurrently", async () => {
    if (!db.available) return;
    for (let i = 0; i < 40; i += 1) await insertArtifact(db.pool, { createdAt: `2026-01-01T00:00:${String(i % 4).padStart(2, "0")}.000Z` });
    let stop = false;
    const churn = (async () => {
      let round = 0;
      while (!stop) {
        round += 1;
        await insertArtifact(writer!, { createdAt: `2026-01-01T00:00:${String(round % 4).padStart(2, "0")}.000Z` });
        await writer!.query(`DELETE FROM artifacts WHERE id = (SELECT id FROM artifacts WHERE space_id = $1 ORDER BY random() LIMIT 1)`, [SPACE]);
        if (round % 3 === 0) await writer!.query(`DELETE FROM artifacts WHERE id = (SELECT id FROM artifacts WHERE space_id = $1 ORDER BY random() LIMIT 1)`, [SPACE]);
      }
    })();
    try {
      for (let i = 0; i < 25; i += 1) {
        const offset = (i * 7) % 45;
        const page = await repository().listVisible(SPACE, OWNER, { limit: 10, offset });
        expect(page.items).toHaveLength(Math.max(0, Math.min(10, page.total - offset)));
        expect(new Set(ids(page)).size).toBe(page.items.length);
        const order = page.items.map((item) => `${item.created_at}|${item.id}`);
        expect(order).toEqual([...order].sort().reverse());
      }
    } finally {
      stop = true;
      await churn;
    }
  });
});
