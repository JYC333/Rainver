import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { PgSpaceRepository, type SpaceFailure, type SpaceResult } from "../src/modules/spaces/repository.js";

let repo: PgSpaceRepository | undefined;

const db = useTestDatabase(import.meta.filename);

beforeAll(async () => {
  if (!db.available) return;
  repo = new PgSpaceRepository(db.pool);
});

async function seedUser(email = `${randomUUID()}@test.invalid`): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Creator', 'active', now(), now(), $2, 'system')`,
    [id, email],
  );
  return id;
}

describe("PgSpaceRepository.acceptInvitation", () => {
  it("atomically admits the invited existing account exactly once", async () => {
    if (!db.available || !repo) return;
    const owner = await seedUser();
    const invitee = await seedUser(`invitee-${randomUUID()}@test.invalid`);
    const space = await repo.createSpace(owner, { name: "Invitation Team", type: "team" }) as SpaceResult;
    const invitation = await repo.createInvitation(owner, space.id, {
      email: (await db.pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [invitee])).rows[0]!.email,
      role: "member",
    });
    expect("token" in invitation).toBe(true);
    if (!("token" in invitation)) return;

    const results = await Promise.all([
      repo.acceptInvitation(invitee, invitation.token),
      repo.acceptInvitation(invitee, invitation.token),
    ]);
    expect(results.filter(result => "space_id" in result)).toEqual([{ space_id: space.id }]);
    const membership = await db.pool.query<{ role: string; status: string }>(
      "SELECT role, status FROM space_memberships WHERE space_id = $1 AND user_id = $2",
      [space.id, invitee],
    );
    expect(membership.rows).toEqual([{ role: "member", status: "active" }]);
    const state = await db.pool.query<{ status: string }>("SELECT status FROM space_invitations WHERE id = $1", [invitation.id]);
    expect(state.rows[0]?.status).toBe("accepted");
  });

  it("rejects another account and an expired invitation without granting membership", async () => {
    if (!db.available || !repo) return;
    const owner = await seedUser();
    const invitee = await seedUser(`invitee-${randomUUID()}@test.invalid`);
    const other = await seedUser();
    const space = await repo.createSpace(owner, { name: "Private Team", type: "team" }) as SpaceResult;
    const email = (await db.pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [invitee])).rows[0]!.email;
    const invitation = await repo.createInvitation(owner, space.id, { email });
    if (!("token" in invitation)) throw new Error("Invitation was not created");

    expect(await repo.acceptInvitation(other, invitation.token)).toMatchObject({ statusCode: 400 });
    await db.pool.query("UPDATE space_invitations SET expires_at = now() - interval '1 second' WHERE id = $1", [invitation.id]);
    expect(await repo.acceptInvitation(invitee, invitation.token)).toMatchObject({ statusCode: 400 });
    const memberships = await db.pool.query(
      "SELECT id FROM space_memberships WHERE space_id = $1 AND user_id IN ($2, $3)",
      [space.id, invitee, other],
    );
    expect(memberships.rowCount).toBe(0);
  });
});

function isFailure(value: SpaceResult | SpaceFailure): value is SpaceFailure {
  return "statusCode" in value;
}

describe("PgSpaceRepository.createSpace — immutable and defaulted Space policy", () => {
  it("accepts a valid oversight_mode and stores it", async () => {
    if (!db.available || !repo) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Full Oversight Team", type: "team", oversight_mode: "full" });

    expect(isFailure(result)).toBe(false);
    expect(result).toMatchObject({
      oversight_mode: "full",
      egress_notifications_enabled: true,
      role: "owner",
    });
    const row = await db.pool.query(
      `SELECT oversight_mode, egress_notifications_enabled FROM spaces WHERE id = $1`,
      [(result as SpaceResult).id],
    );
    expect(row.rows[0]).toEqual({
      oversight_mode: "full",
      egress_notifications_enabled: true,
    });
  });

  it("defaults oversight_mode to 'none' when omitted", async () => {
    if (!db.available || !repo) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Default Team", type: "team" });

    expect(isFailure(result)).toBe(false);
    expect(result).toMatchObject({ oversight_mode: "none" });
  });

  it("rejects an unknown oversight_mode with 422 and creates no row", async () => {
    if (!db.available || !repo || !db.pool) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Bad Team", type: "team", oversight_mode: "godmode" });

    expect(result).toMatchObject({ statusCode: 422 });
    const rows = await db.pool.query("SELECT id FROM spaces WHERE name = 'Bad Team'");
    expect(rows.rowCount).toBe(0);
  });

  it("still rejects explicit personal-type creation regardless of oversight_mode", async () => {
    if (!db.available || !repo) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Sneaky Personal", type: "personal", oversight_mode: "full" });

    expect(result).toMatchObject({ statusCode: 400 });
  });
});
