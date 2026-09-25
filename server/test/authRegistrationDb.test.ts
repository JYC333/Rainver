import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { migrate } from "../src/db/migrator.js";
import { createBetterAuth } from "../src/modules/auth/betterAuth.js";
import { PgAuthRepository } from "../src/modules/auth/identity.js";
import { authModule } from "../src/modules/auth/index.js";
import { RegistrationService } from "../src/modules/auth/registration.js";
import { hashOpaqueToken } from "../src/modules/auth/securityPolicy.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

const db = useTestDatabase(import.meta.filename, { empty: true });

beforeAll(async () => { if (db.available) await migrate(db.pool, join(process.cwd(), "migrations")); });
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["registration_intents", "space_invitations", "auth_accounts", "user_sessions", "spaces", "users"], { cascade: true });
});

function authConfig(instanceAdminEmail = "owner@example.test", google = false): ServerConfig {
  return loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    BETTER_AUTH_SECRET: "registration-test-secret-that-is-long-enough",
    FRONTEND_URL: "http://localhost:5173",
    INSTANCE_ADMIN_EMAIL: instanceAdminEmail,
    ...(google ? { GOOGLE_CLIENT_ID: "test-google-client-id", GOOGLE_CLIENT_SECRET: "test-google-client-secret" } : {}),
  });
}

async function signUp(config: ServerConfig, email: string, name: string, sourceIp?: string) {
  const auth = createBetterAuth(config, db.pool);
  const response = await auth.handler(new Request("http://localhost:5173/api/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173", ...(sourceIp ? { "x-forwarded-for": sourceIp } : {}) },
    body: JSON.stringify({ email, password: "a password with at least fifteen characters", name }),
  }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const raw = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const registrations = new RegistrationService(db.pool, config);
  const userId = await registrations.sessionUserId(raw);
  expect(userId).toBeTruthy();
  return { auth, raw, userId: userId! };
}

describe("registration and Better Auth facade primitives", () => {
  it("starts Google linking after a password reauthentication grant", async () => {
    if (!db.available) return;
    const config = authConfig("owner@example.test", true);
    const registrations = new RegistrationService(db.pool, config);
    const intent = await registrations.issueIntent({ email: "owner@example.test" });
    const sourceIp = "192.0.2.123";
    const { raw, userId } = await signUp(config, "owner@example.test", "Owner", sourceIp);
    await registrations.complete({ intentId: intent.intentId, claimSecret: intent.claimSecret, userId });
    const app = buildModuleServer(config, [authModule]);
    const sessionCookie = `better-auth.session_token=${encodeURIComponent(raw)}`;
    try {
      const anonymousStatus = await app.inject({ method: "GET", url: "/api/v1/auth/reauth/status" });
      expect(anonymousStatus.statusCode).toBe(401);

      const beforeStatus = await app.inject({
        method: "GET", url: "/api/v1/auth/reauth/status",
        headers: { cookie: sessionCookie },
      });
      expect(beforeStatus.statusCode).toBe(200);
      expect(beforeStatus.json()).toEqual({ expires_at: null });
      expect(beforeStatus.headers["cache-control"]).toContain("no-store");

      const withoutGrant = await app.inject({
        method: "POST", url: "/api/v1/auth/google/link",
        headers: { cookie: sessionCookie, origin: "http://localhost:5173", "x-forwarded-for": sourceIp },
        payload: {},
      });
      expect(withoutGrant.statusCode).toBe(403);
      expect(withoutGrant.json()).toMatchObject({ code: "reauthentication_required" });

      const reauth = await app.inject({
        method: "POST", url: "/api/v1/auth/reauth",
        headers: { cookie: sessionCookie, origin: "http://localhost:5173", "content-type": "application/json", "x-forwarded-for": sourceIp },
        payload: JSON.stringify({ password: "a password with at least fifteen characters" }),
      });
      expect(reauth.statusCode).toBe(200);
      const grantCookie = String(reauth.headers["set-cookie"]).split(";", 1)[0];
      expect(grantCookie).toContain("rainver.reauth=");

      const afterStatus = await app.inject({
        method: "GET", url: "/api/v1/auth/reauth/status",
        headers: { cookie: `${sessionCookie}; ${grantCookie}` },
      });
      expect(afterStatus.statusCode).toBe(200);
      expect(new Date(afterStatus.json().expires_at).getTime()).toBeGreaterThan(Date.now());

      const link = await app.inject({
        method: "POST", url: "/api/v1/auth/google/link",
        headers: { cookie: `${sessionCookie}; ${grantCookie}`, origin: "http://localhost:5173", "x-forwarded-for": sourceIp },
        payload: {},
      });
      expect(link.statusCode).toBe(200);
      expect(link.json().url).toContain("accounts.google.com");
    } finally {
      await app.close();
    }
  });
  it("admits the configured bootstrap email, provisions one identity, and records each login", async () => {
    if (!db.available) return;
    const config = authConfig("Owner@Example.test");
    const registrations = new RegistrationService(db.pool, config);
    await expect(registrations.isBootstrapAvailable()).resolves.toBe(true);
    const intent = await registrations.issueIntent({ email: " owner@example.test " });
    const { auth, raw, userId } = await signUp(config, "owner@example.test", "Owner");

    await registrations.complete({ intentId: intent.intentId, claimSecret: intent.claimSecret, userId, displayName: "Owner" });
    const user = await db.pool.query<{ status: string; registration_source: string; last_login_at: Date | null }>(
      "SELECT status, registration_source, last_login_at FROM users WHERE id = $1",
      [userId],
    );
    expect(user.rows[0]).toMatchObject({ status: "active", registration_source: "bootstrap" });
    expect(user.rows[0]?.last_login_at).toBeInstanceOf(Date);
    await expect(registrations.isBootstrapAvailable()).resolves.toBe(false);

    const repo = new PgAuthRepository(db.pool, config.instanceAdminEmail, auth);
    await expect(repo.resolveIdentity({ sessionToken: raw })).resolves.toMatchObject({ ok: true, userId });

    await db.pool.query("UPDATE users SET last_login_at = NULL WHERE id = $1", [userId]);
    const signIn = await auth.handler(new Request("http://localhost:5173/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "owner@example.test", password: "a password with at least fifteen characters" }),
    }));
    expect(signIn.status).toBe(200);
    const login = await db.pool.query<{ last_login_at: Date | null }>("SELECT last_login_at FROM users WHERE id = $1", [userId]);
    expect(login.rows[0]?.last_login_at).toBeInstanceOf(Date);

    const duplicate = await registrations.issueIntent({ email: "owner@example.test" }).catch((error: Error) => error.message);
    expect(duplicate).toBe("registration_invitation_required");
  });

  it("rotates the claim and resumes an immediately retried bootstrap registration", async () => {
    if (!db.available) return;
    const config = authConfig();
    const registrations = new RegistrationService(db.pool, config);
    const first = await registrations.issueIntent({ email: "owner@example.test" });
    const beforeSignupRetry = await registrations.issueIntent({ email: "owner@example.test" });
    expect(beforeSignupRetry.intentId).toBe(first.intentId);
    expect(beforeSignupRetry.claimSecret).not.toBe(first.claimSecret);
    const { userId } = await signUp(config, "owner@example.test", "Owner");
    await expect(registrations.isBootstrapAvailable()).resolves.toBe(true);

    const retry = await registrations.issueIntent({ email: "owner@example.test" });
    expect(retry.intentId).toBe(first.intentId);
    expect(retry.claimSecret).not.toBe(beforeSignupRetry.claimSecret);
    await expect(registrations.complete({ intentId: first.intentId, claimSecret: first.claimSecret, userId })).rejects.toThrow("registration_intent_invalid");
    await expect(registrations.complete({ intentId: retry.intentId, claimSecret: retry.claimSecret, userId })).resolves.toMatchObject({ userId, authority: "bootstrap" });
  });

  it("rotates the claim and resumes an immediately retried invitation registration", async () => {
    if (!db.available) return;
    const config = authConfig();
    const registrations = new RegistrationService(db.pool, config);
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, email_verified, registration_source, status, created_at, updated_at)
       VALUES ('owner-user', 'owner@example.test', 'Owner', true, 'bootstrap', 'active', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ('team-space', 'Team', 'team', 'owner-user', now(), now())`,
    );
    const invitationToken = "resume-invitation-token";
    await db.pool.query(
      `INSERT INTO space_invitations
         (id, space_id, invited_email, role, token_hash, status, invited_by_user_id, created_at, expires_at)
       VALUES ('resume-invite', 'team-space', 'invitee@example.test', 'member', $1, 'available', 'owner-user', now(), now() + interval '7 days')`,
      [hashOpaqueToken(invitationToken)],
    );

    const first = await registrations.issueIntent({ email: "invitee@example.test", invitationToken });
    const { userId } = await signUp(config, "invitee@example.test", "Invitee");
    const retry = await registrations.issueIntent({ email: "invitee@example.test", invitationToken });

    expect(retry.intentId).toBe(first.intentId);
    expect(retry.claimSecret).not.toBe(first.claimSecret);
    await expect(registrations.complete({ intentId: retry.intentId, claimSecret: retry.claimSecret, userId }))
      .resolves.toMatchObject({ userId, authority: "space_invitation" });
    await expect(db.pool.query("SELECT status FROM space_invitations WHERE id = 'resume-invite'"))
      .resolves.toMatchObject({ rows: [{ status: "accepted" }] });
  });

  it("reaps an expired partial invitation signup and makes the invitation reusable", async () => {
    if (!db.available) return;
    const config = authConfig();
    const registrations = new RegistrationService(db.pool, config);
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, email_verified, registration_source, status, created_at, updated_at)
       VALUES ('owner-user', 'owner@example.test', 'Owner', true, 'bootstrap', 'active', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ('team-space', 'Team', 'team', 'owner-user', now(), now())`,
    );
    const invitationToken = "invitation-token";
    await db.pool.query(
      `INSERT INTO space_invitations
         (id, space_id, invited_email, role, token_hash, status, invited_by_user_id, created_at, expires_at)
       VALUES ('invite-1', 'team-space', 'invitee@example.test', 'member', $1, 'available', 'owner-user', now(), now() + interval '7 days')`,
      [hashOpaqueToken(invitationToken)],
    );

    const first = await registrations.issueIntent({ email: "invitee@example.test", invitationToken });
    const userId = "stale-pending-user";
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, email_verified, registration_source, status, created_at, updated_at)
       VALUES ($1, 'invitee@example.test', 'Invitee', false, 'system', 'pending', now(), now())`,
      [userId],
    );
    await db.pool.query(
      `INSERT INTO auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ('stale-account', 'stale-google-sub', 'google', $1, now(), now())`,
      [userId],
    );
    await db.pool.query(
      `INSERT INTO user_sessions (id, user_id, token_hash, created_at, updated_at, expires_at)
       VALUES ('stale-session', $1, $2, now(), now(), now() + interval '1 day')`,
      [userId, hashOpaqueToken('stale-session-token')],
    );
    await db.pool.query(
      "UPDATE registration_intents SET pending_user_id = $1, state = 'provisioning', expires_at = now() - interval '1 minute' WHERE id = $2",
      [userId, first.intentId],
    );

    await expect(registrations.reapStale()).resolves.toBe(1);
    expect((await db.pool.query("SELECT 1 FROM users WHERE id = $1", [userId])).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM auth_accounts WHERE user_id = $1", [userId])).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM user_sessions WHERE user_id = $1", [userId])).rowCount).toBe(0);
    await expect(db.pool.query("SELECT state, pending_user_id FROM registration_intents WHERE id = $1", [first.intentId]))
      .resolves.toMatchObject({ rows: [{ state: "expired", pending_user_id: null }] });
    await expect(db.pool.query("SELECT status, reserved_by_intent_id FROM space_invitations WHERE id = 'invite-1'"))
      .resolves.toMatchObject({ rows: [{ status: "available", reserved_by_intent_id: null }] });

    const retry = await registrations.issueIntent({ email: "invitee@example.test", invitationToken });
    expect(retry.intentId).not.toBe(first.intentId);
  });

  it("parses the gateway JSON body when issuing a bootstrap registration intent", async () => {
    if (!db.available) return;
    const config = authConfig();
    const app = buildModuleServer(config, [authModule], { logger: false });

    try {
      const intentResponse = await app.inject({
        method: "POST",
        url: "/api/v1/auth/registration-intents",
        headers: { "content-type": "application/json", origin: config.frontendUrl },
        payload: JSON.stringify({ email: " Owner@Example.test " }),
      });
      expect(intentResponse.statusCode).toBe(201);
      const intent = intentResponse.json<{ intentId: string; claimSecret: string; authority: string; email: string }>();
      expect(intent).toMatchObject({ authority: "bootstrap", email: "owner@example.test" });
      expect(intent.intentId).toBeTruthy();
      expect(intent.claimSecret).toBeTruthy();

      await expect(db.pool.query("SELECT email, authority, state FROM registration_intents WHERE id = $1", [intent.intentId]))
        .resolves.toMatchObject({ rows: [{ email: "owner@example.test", authority: "bootstrap", state: "issued" }] });
    } finally {
      await app.close();
    }
  });
});
