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

// Better Auth keeps one in-memory per-IP rate-limit store for the whole
// process, and the server forwards it only the address Fastify resolved.
// A direct `auth.handler` call therefore names its address in
// `x-forwarded-for`, while a request through the facade names it in
// `inject({ remoteAddress })` — a client-sent forwarded header never reaches
// Better Auth.
let signUpSourceCounter = 10;
async function signUp(config: ServerConfig, email: string, name: string, sourceIp?: string) {
  const auth = createBetterAuth(config, db.pool);
  const requestSourceIp = sourceIp ?? `192.0.2.${signUpSourceCounter++}`;
  const response = await auth.handler(new Request(`${config.frontendUrl}/api/v1/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.frontendUrl, "x-forwarded-for": requestSourceIp },
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
  it("returns the OAuth state cookie with Google login and routes callback errors to login", async () => {
    if (!db.available) return;
    const app = buildModuleServer(authConfig("owner@example.test", true), [authModule]);
    try {
      const start = await app.inject({ method: "GET", url: "/api/v1/auth/google" });
      expect(start.statusCode).toBe(307);
      expect(start.headers.location).toContain("accounts.google.com");
      expect(String(start.headers["set-cookie"])).toMatch(/better-auth\.state=/);

      const failedCallback = await app.inject({ method: "GET", url: "/api/v1/auth/callback/google?state=missing" });
      expect(failedCallback.statusCode).toBe(302);
      expect(failedCallback.headers.location).toBe("http://localhost:5173/login?error=state_mismatch");
    } finally {
      await app.close();
    }
  });
  it("keeps both Google state and registration claim cookies", async () => {
    if (!db.available) return;
    const config = authConfig("owner@example.test", true);
    const intent = await new RegistrationService(db.pool, config).issueIntent({ email: "owner@example.test" });
    const app = buildModuleServer(config, [authModule]);
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/auth/register/google",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        payload: JSON.stringify({ intent_id: intent.intentId, claim_secret: intent.claimSecret }),
      });
      expect(response.statusCode).toBe(200);
      expect(String(response.headers["set-cookie"])).toMatch(/better-auth\.state=/);
      expect(String(response.headers["set-cookie"])).toMatch(/rainver\.registration_claim=/);
    } finally {
      await app.close();
    }
  });

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
        remoteAddress: sourceIp,
        headers: { cookie: sessionCookie, origin: "http://localhost:5173" },
        payload: {},
      });
      expect(withoutGrant.statusCode).toBe(403);
      expect(withoutGrant.json()).toMatchObject({ code: "reauthentication_required" });

      const reauth = await app.inject({
        method: "POST", url: "/api/v1/auth/reauth",
        remoteAddress: sourceIp,
        headers: { cookie: sessionCookie, origin: "http://localhost:5173", "content-type": "application/json" },
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
        remoteAddress: sourceIp,
        headers: { cookie: `${sessionCookie}; ${grantCookie}`, origin: "http://localhost:5173" },
        payload: {},
      });
      expect(link.statusCode).toBe(200);
      expect(link.json().url).toContain("accounts.google.com");
      expect(String(link.headers["set-cookie"])).toMatch(/better-auth\.state=/);

      const googleReauth = await app.inject({
        method: "POST", url: "/api/v1/auth/reauth/google",
        headers: { cookie: sessionCookie, origin: "http://localhost:5173" },
        payload: {},
      });
      expect(googleReauth.statusCode).toBe(200);
      expect(String(googleReauth.headers["set-cookie"])).toMatch(/better-auth\.state=/);
      expect(String(googleReauth.headers["set-cookie"])).toMatch(/rainver\.google_reauth=/);
    } finally {
      await app.close();
    }
  });
  it("reads the secure Better Auth session cookie on HTTPS", async () => {
    if (!db.available) return;
    const config = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      BETTER_AUTH_SECRET: "registration-test-secret-that-is-long-enough",
      FRONTEND_URL: "https://rainver.example.test",
      INSTANCE_ADMIN_EMAIL: "owner@example.test",
    });
    const intent = await new RegistrationService(db.pool, config).issueIntent({ email: "owner@example.test" });
    const { userId } = await signUp(config, "owner@example.test", "Owner");
    await new RegistrationService(db.pool, config).complete({ intentId: intent.intentId, claimSecret: intent.claimSecret, userId });
    const app = buildModuleServer(config, [authModule]);
    try {
      const signIn = await app.inject({
        method: "POST", url: "/api/v1/auth/sign-in/email",
        remoteAddress: "192.0.2.201",
        headers: { origin: config.frontendUrl, "content-type": "application/json" },
        payload: JSON.stringify({ email: "owner@example.test", password: "a password with at least fifteen characters" }),
      });
      expect(signIn.statusCode).toBe(200);
      const cookie = String(signIn.headers["set-cookie"]).split(";", 1)[0];
      expect(cookie).toMatch(/^__Secure-better-auth\.session_token=/);
      const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ id: userId });
    } finally {
      await app.close();
    }
  });

  it("signs in through the facade after setting a password on an existing account", async () => {
    if (!db.available) return;
    const config = authConfig();
    const intent = await new RegistrationService(db.pool, config).issueIntent({ email: "owner@example.test" });
    const { raw, userId } = await signUp(config, "owner@example.test", "Owner");
    await new RegistrationService(db.pool, config).complete({ intentId: intent.intentId, claimSecret: intent.claimSecret, userId });
    const app = buildModuleServer(config, [authModule]);
    const sessionCookie = `better-auth.session_token=${encodeURIComponent(raw)}`;
    try {
      const reauth = await app.inject({
        method: "POST", url: "/api/v1/auth/reauth",
        headers: { cookie: sessionCookie, origin: "http://localhost:5173", "content-type": "application/json" },
        payload: JSON.stringify({ password: "a password with at least fifteen characters" }),
      });
      expect(reauth.statusCode).toBe(200);
      const grant = String(reauth.headers["set-cookie"]).split(";", 1)[0];
      await db.pool.query("DELETE FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'", [userId]);
      const setPassword = await app.inject({
        method: "POST", url: "/api/v1/auth/password/set",
        headers: { cookie: `${sessionCookie}; ${grant}`, origin: "http://localhost:5173", "content-type": "application/json" },
        payload: JSON.stringify({ new_password: "a new password with at least fifteen characters" }),
      });
      expect(setPassword.statusCode).toBe(200);
      const signIn = await app.inject({
        method: "POST", url: "/api/v1/auth/sign-in/email",
        remoteAddress: "192.0.2.202",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        payload: JSON.stringify({ email: "owner@example.test", password: "a new password with at least fifteen characters" }),
      });
      expect(signIn.statusCode).toBe(200);
      const cookie = String(signIn.headers["set-cookie"]).split(";", 1)[0];
      expect(cookie).toMatch(/^better-auth\.session_token=/);
      const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
      expect(me.statusCode).toBe(200);
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
      headers: { "content-type": "application/json", origin: "http://localhost:5173", "x-forwarded-for": "192.0.2.203" },
      body: JSON.stringify({ email: "owner@example.test", password: "a password with at least fifteen characters" }),
    }));
    expect(signIn.status).toBe(200);
    const login = await db.pool.query<{ last_login_at: Date | null }>("SELECT last_login_at FROM users WHERE id = $1", [userId]);
    expect(login.rows[0]?.last_login_at).toBeInstanceOf(Date);

    const app = buildModuleServer(config, [authModule]);
    try {
      const routeLogin = await app.inject({
        method: "POST", url: "/api/v1/auth/sign-in/email",
        remoteAddress: "192.0.2.204",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        payload: JSON.stringify({ email: "owner@example.test", password: "a password with at least fifteen characters", rememberMe: true }),
      });
      expect(routeLogin.statusCode).toBe(200);
      // The session credential travels only in the HttpOnly cookie.
      expect(routeLogin.json()).not.toHaveProperty("token");
      const cookie = String(routeLogin.headers["set-cookie"]).split(";", 1)[0];
      expect(cookie).toMatch(/^better-auth\.session_token=/);
      const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ id: userId, email: "owner@example.test" });

      // A cookie Better Auth cannot verify is not a session, even when the
      // raw token in front of the signature names a live row.
      const rawToken = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".", 1)[0]!;
      for (const forged of [rawToken, `${rawToken}.x`]) {
        const rejected = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: `better-auth.session_token=${encodeURIComponent(forged)}` } });
        expect(rejected.statusCode).toBe(401);
      }
    } finally {
      await app.close();
    }

    const duplicate = await registrations.issueIntent({ email: "owner@example.test" }).catch((error: Error) => error.message);
    expect(duplicate).toBe("registration_invitation_required");
  });

  it("records the client address Fastify resolved, not the forwarded header the client sent", async () => {
    if (!db.available) return;
    const config = authConfig();
    const intent = await new RegistrationService(db.pool, config).issueIntent({ email: "owner@example.test" });
    const { userId } = await signUp(config, "owner@example.test", "Owner");
    await new RegistrationService(db.pool, config).complete({ intentId: intent.intentId, claimSecret: intent.claimSecret, userId });
    const app = buildModuleServer(config, [authModule]);
    try {
      const signIn = await app.inject({
        method: "POST", url: "/api/v1/auth/sign-in/email",
        remoteAddress: "192.0.2.77",
        headers: { origin: config.frontendUrl, "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        payload: JSON.stringify({ email: "owner@example.test", password: "a password with at least fifteen characters" }),
      });
      expect(signIn.statusCode).toBe(200);
      const session = await db.pool.query<{ ip_address: string | null }>(
        "SELECT ip_address FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [userId],
      );
      expect(session.rows[0]).toEqual({ ip_address: "192.0.2.77" });
    } finally {
      await app.close();
    }
  });

  it("keeps the registration claim secret out of Better Auth's stored OAuth state", async () => {
    if (!db.available) return;
    const config = authConfig("owner@example.test", true);
    const intent = await new RegistrationService(db.pool, config).issueIntent({ email: "owner@example.test" });
    const app = buildModuleServer(config, [authModule]);
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/auth/register/google",
        remoteAddress: "192.0.2.150",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        payload: JSON.stringify({ intent_id: intent.intentId, claim_secret: intent.claimSecret }),
      });
      expect(response.statusCode).toBe(200);
      const stored = await db.pool.query<{ value: string }>("SELECT value FROM auth_verifications");
      expect(stored.rows.length).toBeGreaterThan(0);
      for (const row of stored.rows) expect(row.value).not.toContain(intent.claimSecret);
    } finally {
      await app.close();
    }
  });

  it("lets an administrator disable and enable admitted accounts only, never a pending identity", async () => {
    if (!db.available) return;
    const config = authConfig();
    const registrations = new RegistrationService(db.pool, config);
    const intent = await registrations.issueIntent({ email: "owner@example.test" });
    const admin = await signUp(config, "owner@example.test", "Owner");
    await registrations.complete({ intentId: intent.intentId, claimSecret: intent.claimSecret, userId: admin.userId });
    // Signed up but never completed: the reconciler reclaims it only while it stays 'pending'.
    const pending = await signUp(config, "pending@example.test", "Pending");
    await expect(db.pool.query("SELECT status FROM users WHERE id = $1", [pending.userId]))
      .resolves.toMatchObject({ rows: [{ status: "pending" }] });
    const app = buildModuleServer(config, [authModule]);
    const headers = { cookie: `better-auth.session_token=${encodeURIComponent(admin.raw)}`, origin: "http://localhost:5173" };
    try {
      for (const action of ["enable", "disable"]) {
        const response = await app.inject({ method: "POST", url: `/api/v1/auth/admin/users/${pending.userId}/${action}`, headers, payload: {} });
        expect(response.statusCode).toBe(400);
        await expect(db.pool.query("SELECT status FROM users WHERE id = $1", [pending.userId]))
          .resolves.toMatchObject({ rows: [{ status: "pending" }] });
      }
      // Once admitted (what RegistrationService.complete leaves behind), the
      // account is the administrator's to disable and re-enable.
      await db.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [pending.userId]);
      const disable = await app.inject({ method: "POST", url: `/api/v1/auth/admin/users/${pending.userId}/disable`, headers, payload: {} });
      expect(disable.statusCode).toBe(200);
      await expect(db.pool.query("SELECT status FROM users WHERE id = $1", [pending.userId]))
        .resolves.toMatchObject({ rows: [{ status: "disabled" }] });
      const enable = await app.inject({ method: "POST", url: `/api/v1/auth/admin/users/${pending.userId}/enable`, headers, payload: {} });
      expect(enable.statusCode).toBe(200);
      await expect(db.pool.query("SELECT status FROM users WHERE id = $1", [pending.userId]))
        .resolves.toMatchObject({ rows: [{ status: "active" }] });
    } finally {
      await app.close();
    }
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

  it("reclaims a pending signup no registration intent ever bound, reopening bootstrap", async () => {
    if (!db.available) return;
    const config = authConfig();
    const registrations = new RegistrationService(db.pool, config);
    await registrations.issueIntent({ email: "owner@example.test" });
    // The Google account chosen at the provider was not the intent's email.
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, email_verified, registration_source, status, created_at, updated_at)
       VALUES ('wrong-account', 'someone@gmail.test', 'Someone', true, 'system', 'pending', now() - interval '31 minutes', now() - interval '31 minutes'),
              ('fresh-signup', 'fresh@gmail.test', 'Fresh', true, 'system', 'pending', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ('wrong-account-google', 'wrong-google-sub', 'google', 'wrong-account', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO user_sessions (id, user_id, token_hash, created_at, updated_at, expires_at)
       VALUES ('wrong-account-session', 'wrong-account', $1, now(), now(), now() + interval '1 day')`,
      [hashOpaqueToken("wrong-account-session-token")],
    );
    await db.pool.query("UPDATE registration_intents SET expires_at = now() - interval '1 minute'");

    await registrations.reapStale();

    expect((await db.pool.query("SELECT id FROM users ORDER BY id")).rows).toEqual([{ id: "fresh-signup" }]);
    expect((await db.pool.query("SELECT 1 FROM auth_accounts WHERE user_id = 'wrong-account'")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM user_sessions WHERE user_id = 'wrong-account'")).rowCount).toBe(0);
    await db.pool.query("DELETE FROM users WHERE id = 'fresh-signup'");
    await expect(registrations.isBootstrapAvailable()).resolves.toBe(true);
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
