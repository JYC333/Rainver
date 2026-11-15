import { hashOpaqueToken } from "../src/modules/auth/securityPolicy.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { acceptInvitation, createInvitation, createSpace } from "../src/modules/spaces/writers.js";

// Domain writers the Space core operations call (spaceOperationsDb.test.ts covers the operation contract).
const db = useTestDatabase(import.meta.filename);
const secret = () => Buffer.from(randomUUID() + randomUUID()).toString("base64url");

async function seedUser(email = `${randomUUID()}@test.invalid`): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Creator', 'active', now(), now(), $2, 'system')`,
    [id, email],
  );
  return id;
}
const emailOf = async (user: string) => (await db.pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [user])).rows[0]!.email;
const settle = (calls: Promise<unknown>[]) => Promise.allSettled(calls);

describe("Space invitation writers", () => {
  it("atomically admits the invited existing account exactly once", async () => {
    if (!db.available) return;
    const owner = await seedUser();
    const invitee = await seedUser(`invitee-${randomUUID()}@test.invalid`);
    const { space_id: space } = await createSpace(db.pool, owner, { name: "Invitation Team", type: "team", oversight_mode: "none" });
    const token = secret();
    const invitation = await createInvitation(db.pool, owner, space, { email: await emailOf(invitee), role: "member", token });
    expect(invitation).not.toHaveProperty("token");
    const results = await settle([acceptInvitation(db.pool, invitee, token), acceptInvitation(db.pool, invitee, token)]);
    expect(results.filter(result => result.status === "fulfilled").map(result => (result as PromiseFulfilledResult<unknown>).value)).toEqual([{ space_id: space }]);
    const membership = await db.pool.query<{ role: string; status: string }>(
      "SELECT role, status FROM space_memberships WHERE space_id = $1 AND user_id = $2",
      [space, invitee],
    );
    expect(membership.rows).toEqual([{ role: "member", status: "active" }]);
    const state = await db.pool.query<{ status: string; token_hash: string }>("SELECT status, token_hash FROM user_invitations WHERE id = $1", [invitation.invitation_id]);
    expect(state.rows[0]).toEqual({ status: "accepted", token_hash: hashOpaqueToken(token) });
  });

  it("consumes an instance-only invitation once without changing any memberships", async () => {
    if (!db.available) return;
    const owner = await seedUser();
    const email = `invitee-${randomUUID()}@test.invalid`;
    const invitee = await seedUser(email);
    const other = await seedUser();
    const id = randomUUID();
    const token = randomUUID();
    await db.pool.query(`INSERT INTO user_invitations (id, invited_email, token_hash, status, invited_by_user_id, created_at, expires_at)
      VALUES ($1, $2, $3, 'available', $4, now(), now() + interval '7 days')`, [id, email, hashOpaqueToken(token), owner]);
    await expect(acceptInvitation(db.pool, other, token)).rejects.toMatchObject({ statusCode: 422 });
    const before = await db.pool.query("SELECT * FROM space_memberships WHERE user_id = $1", [invitee]);
    const results = await settle([acceptInvitation(db.pool, invitee, token), acceptInvitation(db.pool, invitee, token)]);
    expect(results.filter(result => result.status === "fulfilled").map(result => (result as PromiseFulfilledResult<unknown>).value)).toEqual([{ space_id: null }]);
    expect((await db.pool.query("SELECT * FROM space_memberships WHERE user_id = $1", [invitee])).rows).toEqual(before.rows);
    expect((await db.pool.query("SELECT status FROM user_invitations WHERE id = $1", [id])).rows[0].status).toBe("accepted");
  });

  it("rejects another account and an expired invitation without granting membership", async () => {
    if (!db.available) return;
    const owner = await seedUser();
    const invitee = await seedUser(`invitee-${randomUUID()}@test.invalid`);
    const other = await seedUser();
    const { space_id: space } = await createSpace(db.pool, owner, { name: "Private Team", type: "team", oversight_mode: "none" });
    const token = secret();
    const invitation = await createInvitation(db.pool, owner, space, { email: await emailOf(invitee), role: "member", token });

    await expect(acceptInvitation(db.pool, other, token)).rejects.toMatchObject({ statusCode: 422 });
    await db.pool.query("UPDATE user_invitations SET expires_at = now() - interval '1 second' WHERE id = $1", [invitation.invitation_id]);
    await expect(acceptInvitation(db.pool, invitee, token)).rejects.toMatchObject({ statusCode: 422 });
    const memberships = await db.pool.query(
      "SELECT id FROM space_memberships WHERE space_id = $1 AND user_id IN ($2, $3)",
      [space, invitee, other],
    );
    expect(memberships.rowCount).toBe(0);
  });

  it("refuses a reused invitation secret and a personal Space", async () => {
    if (!db.available) return;
    const owner = await seedUser();
    const { space_id: space } = await createSpace(db.pool, owner, { name: "Reuse Team", type: "team", oversight_mode: "none" });
    const token = secret();
    await createInvitation(db.pool, owner, space, { email: "a@example.com", role: "member", token });
    await expect(createInvitation(db.pool, owner, space, { email: "b@example.com", role: "member", token })).rejects.toMatchObject({ statusCode: 409 });
    const personal = randomUUID();
    await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Mine','personal',now(),now())", [personal]);
    await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())", [randomUUID(), personal, owner]);
    await expect(createInvitation(db.pool, owner, personal, { email: "c@example.com", role: "member", token: secret() })).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("createSpace — immutable and defaulted Space policy", () => {
  it("stores the chosen oversight_mode, team notifications and the creator as owner", async () => {
    if (!db.available) return;
    const userId = await seedUser();
    const { space_id: space } = await createSpace(db.pool, userId, { name: "Full Oversight Team", type: "team", oversight_mode: "full" });
    const row = await db.pool.query(
      `SELECT s.oversight_mode, s.egress_notifications_enabled, m.role FROM spaces s JOIN space_memberships m ON m.space_id = s.id WHERE s.id = $1`,
      [space],
    );
    expect(row.rows[0]).toEqual({ oversight_mode: "full", egress_notifications_enabled: true, role: "owner" });
  });
});
