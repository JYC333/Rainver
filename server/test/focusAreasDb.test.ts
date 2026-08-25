import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { useTestDatabase } from "./support/testDatabase";
import { FocusAreaService } from "../src/modules/focusAreas/service";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// A focus area classifies and never gates (ADR 0015). The properties worth
// real-Postgres coverage are therefore the ones a service-level test cannot
// see: that the composite FK stops a classification crossing a Space, and that
// the aggregation subtracts through the same read gate every other reader uses
// rather than exposing what the classifier could see.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };
const otherIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OTHER_USER };

const db = useTestDatabase(__filename);

beforeAll(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  // A shared Space: in a personal one the project predicate short-circuits.
  for (const [id, name] of [[SPACE, "Team"], [OTHER_SPACE, "Other"]]) {
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,$2,'team',$3,$3)`, [id, name, now]);
  }
  for (const [id, name] of [[OWNER, "Owner"], [OTHER_USER, "Other"]]) {
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,$2,'active',$3,$3)`, [id, name, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), SPACE, id, now],
    );
  }
});

async function insertObject(
  db: Pool,
  input: { spaceId: string; owner: string; title: string; visibility: string },
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO space_objects
       (id, space_id, object_type, title, owner_user_id, visibility, access_level, created_at, updated_at)
     VALUES ($1,$2,'note',$3,$4,$5,'full',$6,$6)`,
    [id, input.spaceId, input.title, input.owner, input.visibility, now],
  );
  return id;
}

describe("focus areas (real Postgres)", () => {
  it("refuses to classify content from another Space", async () => {
    if (!db.available) return;
    const service = new FocusAreaService(db.pool);
    const area = await service.create(identity, { name: `Cross ${randomUUID()}` });
    const foreign = await insertObject(db.pool, {
      spaceId: OTHER_SPACE, owner: OWNER, title: "Foreign", visibility: "space_shared",
    });

    // The service's own guard rejects it, and the composite FK is the backstop.
    await expect(service.setObjectFocusArea(identity, foreign, area.id)).rejects.toThrow();
    await expect(
      db.pool.query(`UPDATE space_objects SET focus_area_id = $2 WHERE id = $1`, [foreign, area.id]),
    ).rejects.toThrow();
  });

  it("aggregates only what the reader may already see", async () => {
    if (!db.available) return;
    const service = new FocusAreaService(db.pool);
    const area = await service.create(identity, { name: `Shared ${randomUUID()}` });

    const visible = await insertObject(db.pool, {
      spaceId: SPACE, owner: OWNER, title: "Shared note", visibility: "space_shared",
    });
    const privateNote = await insertObject(db.pool, {
      spaceId: SPACE, owner: OWNER, title: "Private note", visibility: "private",
    });
    await service.setObjectFocusArea(identity, visible, area.id);
    await service.setObjectFocusArea(identity, privateNote, area.id);

    const mine = await service.contents(identity, area.id);
    expect(mine.objects.map((o) => o.id).sort()).toEqual([visible, privateNote].sort());

    // Classifying granted nothing: the other member sees the shared note only.
    const theirs = await service.contents(otherIdentity, area.id);
    expect(theirs.objects.map((o) => o.id)).toEqual([visible]);
  });

  it("clears a classification without touching the content", async () => {
    if (!db.available) return;
    const service = new FocusAreaService(db.pool);
    const area = await service.create(identity, { name: `Clear ${randomUUID()}` });
    const note = await insertObject(db.pool, {
      spaceId: SPACE, owner: OWNER, title: "Note", visibility: "space_shared",
    });

    await service.setObjectFocusArea(identity, note, area.id);
    await service.setObjectFocusArea(identity, note, null);

    const after = await db.pool.query<{ focus_area_id: string | null; deleted_at: string | null }>(
      `SELECT focus_area_id, deleted_at FROM space_objects WHERE id = $1`,
      [note],
    );
    expect(after.rows[0]).toMatchObject({ focus_area_id: null, deleted_at: null });
    expect((await service.contents(identity, area.id)).objects).toEqual([]);
  });

  it("classifies a Project, and lists it for anyone who can see the Project", async () => {
    if (!db.available) return;
    const service = new FocusAreaService(db.pool);
    const area = await service.create(identity, { name: `Project ${randomUUID()}` });
    const projectId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,status,primary_mode,created_at,updated_at)
       VALUES ($1,$2,$3,'Tax return','active','delivery',$4,$4)`,
      [projectId, SPACE, OWNER, now],
    );

    await service.setProjectFocusArea(identity, projectId, area.id);
    expect((await service.contents(identity, area.id)).projects).toEqual([
      { id: projectId, name: "Tax return", status: "active" },
    ]);
    // Project metadata is space-visible, so a non-member sees it here too.
    expect((await service.contents(otherIdentity, area.id)).projects).toHaveLength(1);

    // A member who is not a project writer cannot classify it.
    await expect(service.setProjectFocusArea(otherIdentity, projectId, null)).rejects.toMatchObject({
      statusCode: expect.any(Number),
    });
  });

  it("refuses to file content into an archived area", async () => {
    if (!db.available) return;
    const service = new FocusAreaService(db.pool);
    const area = await service.create(identity, { name: `Archived ${randomUUID()}` });
    const note = await insertObject(db.pool, {
      spaceId: SPACE, owner: OWNER, title: "Note", visibility: "space_shared",
    });
    await db.pool.query(`UPDATE focus_areas SET archived_at = now() WHERE id = $1`, [area.id]);

    await expect(service.setObjectFocusArea(identity, note, area.id)).rejects.toThrow(/archived/);
  });

  it("lets anyone readable classify ownerless content, but not another's", async () => {
    if (!db.available) return;
    const service = new FocusAreaService(db.pool);
    const area = await service.create(identity, { name: `Ownerless ${randomUUID()}` });

    // Agent-ingested content carries no owner; without this path the feature's
    // headline use case — collected knowledge — could never be classified.
    const ingested = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO space_objects (id,space_id,object_type,title,owner_user_id,visibility,access_level,created_at,updated_at)
       VALUES ($1,$2,'knowledge_item','Ingested',NULL,'space_shared','full',$3,$3)`,
      [ingested, SPACE, now],
    );
    await service.setObjectFocusArea(otherIdentity, ingested, area.id);
    expect((await service.contents(identity, area.id)).objects.map((o) => o.id)).toEqual([ingested]);

    // Someone else's owned note stays theirs.
    const owned = await insertObject(db.pool, {
      spaceId: SPACE, owner: OWNER, title: "Mine", visibility: "space_shared",
    });
    await expect(service.setObjectFocusArea(otherIdentity, owned, area.id))
      .rejects.toMatchObject({ statusCode: 404 });

    // The permissive half is bounded by the data model rather than by this
    // rule: `ck_space_objects_private_owner` forbids ownerless content that is
    // not space_shared, so "ownerless" can never mean "hidden from a member".
    await expect(db.pool.query(
      `INSERT INTO space_objects (id,space_id,object_type,title,owner_user_id,visibility,access_level,created_at,updated_at)
       VALUES ($1,$2,'knowledge_item','Hidden',NULL,'selected_users','full',$3,$3)`,
      [randomUUID(), SPACE, new Date().toISOString()],
    )).rejects.toThrow(/ck_space_objects_private_owner/);
  });

  it("lets only the creator rename an area", async () => {
    if (!db.available) return;
    const service = new FocusAreaService(db.pool);
    const area = await service.create(identity, { name: `Owned ${randomUUID()}` });
    await expect(service.update(otherIdentity, area.id, { name: "Taken" })).rejects.toThrow(/owner/);
    const renamed = await service.update(identity, area.id, { name: `Renamed ${randomUUID()}` });
    expect(renamed.id).toBe(area.id);
  });

  it("never takes content with it when archived or deleted", async () => {
    if (!db.available) return;
    const service = new FocusAreaService(db.pool);
    const area = await service.create(identity, { name: `Lifecycle ${randomUUID()}` });
    const note = await insertObject(db.pool, {
      spaceId: SPACE, owner: OWNER, title: "Survivor", visibility: "space_shared",
    });
    await service.setObjectFocusArea(identity, note, area.id);

    // Archiving hides the area, not the content.
    await db.pool.query(`UPDATE focus_areas SET archived_at = now() WHERE id = $1`, [area.id]);
    const afterArchive = await db.pool.query<{ focus_area_id: string | null; deleted_at: string | null }>(
      `SELECT focus_area_id, deleted_at FROM space_objects WHERE id = $1`,
      [note],
    );
    expect(afterArchive.rows[0]).toMatchObject({ focus_area_id: area.id, deleted_at: null });

    // Deleting is refused while anything still points at it: `no action` on the
    // FK means content can never be cascaded away by removing its classifier.
    await expect(db.pool.query(`DELETE FROM focus_areas WHERE id = $1`, [area.id]))
      .rejects.toThrow(/space_objects_focus_area_id_fkey/);

    await service.setObjectFocusArea(identity, note, null);
    await db.pool.query(`DELETE FROM focus_areas WHERE id = $1`, [area.id]);
    const afterDelete = await db.pool.query(`SELECT id FROM space_objects WHERE id = $1`, [note]);
    expect(afterDelete.rows).toHaveLength(1);
  });

  it("rejects a duplicate active name and frees it on archive", async () => {
    if (!db.available) return;
    const service = new FocusAreaService(db.pool);
    const name = `Unique ${randomUUID()}`;
    const first = await service.create(identity, { name });
    await expect(service.create(identity, { name })).rejects.toThrow(/already exists/);

    await db.pool.query(`UPDATE focus_areas SET archived_at = now() WHERE id = $1`, [first.id]);
    const second = await service.create(identity, { name });
    expect(second.id).not.toBe(first.id);
  });
});
