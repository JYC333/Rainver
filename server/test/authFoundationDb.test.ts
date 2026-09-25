import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrator.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

const db = useTestDatabase(import.meta.filename, { empty: true });
const migrationsDir = join(process.cwd(), "migrations");

beforeAll(async () => {
  if (!db.available) return;
  await migrate(db.pool, migrationsDir);
});

describe("auth foundation constraints", () => {
  it("enforces normalized identities, provider uniqueness, and lifecycle states", async () => {
    if (!db.available) return;
    await resetTables(db.pool, [
      "auth_security_events",
      "registration_intents",
      "auth_accounts",
      "user_sessions",
      "users",
    ], { cascade: true });

    await db.pool.query(
      `INSERT INTO users
         (id, email, display_name, email_verified, registration_source, status, created_at, updated_at)
       VALUES ('pending-user', 'pending@example.test', 'Pending', false, 'space_invitation', 'pending', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO users
         (id, email, display_name, email_verified, registration_source, status, created_at, updated_at)
       VALUES ('active-user', 'active@example.test', 'Active', false, 'bootstrap', 'active', now(), now())`,
    );

    await expect(db.pool.query(
      `INSERT INTO users
         (id, email, display_name, email_verified, registration_source, status, created_at, updated_at)
       VALUES ('mixed-case', 'Mixed@example.test', 'Mixed', false, 'system', 'active', now(), now())`,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query(
      `INSERT INTO users
         (id, email, display_name, email_verified, registration_source, status, created_at, updated_at)
       VALUES ('duplicate-email', 'active@example.test', 'Duplicate', false, 'system', 'active', now(), now())`,
    )).rejects.toMatchObject({ code: "23505" });
    await expect(db.pool.query(
      `INSERT INTO users
         (id, email, display_name, email_verified, registration_source, status, created_at, updated_at)
       VALUES ('bad-status', 'bad@example.test', 'Bad', false, 'system', 'unknown', now(), now())`,
    )).rejects.toMatchObject({ code: "23514" });

    await db.pool.query(
      `INSERT INTO auth_accounts
         (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ('account-google', 'google-sub-1', 'google', 'active-user', NULL, now(), now())`,
    );
    await expect(db.pool.query(
      `INSERT INTO auth_accounts
         (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ('account-google-duplicate', 'google-sub-1', 'google', 'pending-user', NULL, now(), now())`,
    )).rejects.toMatchObject({ code: "23505" });

    const actionTokenTable = await db.pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.auth_action_tokens') AS name",
    );
    expect(actionTokenTable.rows[0]?.name).toBeNull();
    await db.pool.query(
      `INSERT INTO spaces
         (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ('space-1', 'Space', 'team', 'active-user', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO space_invitations
         (id, space_id, invited_email, role, token_hash, status,
          invited_by_user_id, created_at, expires_at)
       VALUES ('invitation-1', 'space-1', 'pending@example.test', 'member',
               repeat('d', 64), 'available', 'active-user', now(), now() + interval '7 days')`,
    );
    await db.pool.query(
      `INSERT INTO registration_intents
         (id, claim_secret_hash, email, authority, invitation_id, state,
          created_at, last_activity_at, expires_at)
       VALUES ('invitation-intent', repeat('c', 64), 'pending@example.test',
               'space_invitation', 'invitation-1', 'issued', now(), now(), now() + interval '1 hour')`,
    );
    await expect(db.pool.query("DELETE FROM space_invitations WHERE id = 'invitation-1'"))
      .rejects.toMatchObject({ code: "23503" });
  });
});
