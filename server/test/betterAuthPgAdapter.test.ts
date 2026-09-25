import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/db/migrator.js";
import { createBetterAuth } from "../src/modules/auth/betterAuth.js";
import { useTestDatabase } from "./support/testDatabase.js";

const db = useTestDatabase(import.meta.filename, { empty: true });

beforeAll(async () => {
  if (db.available) await migrate(db.pool, join(process.cwd(), "migrations"));
});

describe("Rainver Better Auth PostgreSQL adapter", () => {
  it("persists only session digests and resolves them from a fresh auth instance", async () => {
    if (!db.available) return;
    const config = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      BETTER_AUTH_SECRET: "phase-two-adapter-secret-that-is-long-enough",
      FRONTEND_URL: "http://localhost:5173",
      INSTANCE_ADMIN_EMAIL: "owner@example.test",
    });
    const auth = createBetterAuth(config, db.pool);
    const response = await auth.handler(new Request("http://localhost:5173/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "Adapter.User@Example.TEST",
        password: "a password with at least fifteen characters",
        name: "Adapter User",
      }),
    }));
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toMatch(/^better-auth\.session_token=/);
    const cookie = setCookie!.split(";", 1)[0]!;
    const rawToken = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
    const sessions = await db.pool.query<{ token_hash: string }>("SELECT token_hash FROM user_sessions");
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessions.rows[0]!.token_hash).not.toBe(rawToken);
    const accounts = await db.pool.query<{ access_token: string | null; refresh_token: string | null; id_token: string | null }>(
      "SELECT access_token, refresh_token, id_token FROM auth_accounts",
    );
    expect(accounts.rows).toEqual([{ access_token: null, refresh_token: null, id_token: null }]);

    const freshAuth = createBetterAuth(config, db.pool);
    const context = await freshAuth.$context;
    const userRow = await db.pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'adapter.user@example.test'");
    const account = await context.internalAdapter.createAccount({
      userId: userRow.rows[0]!.id,
      providerId: "google",
      accountId: "provider-sub-1",
      accessToken: "provider-access",
      refreshToken: "provider-refresh",
      idToken: "provider-id",
    });
    expect(account).toBeTruthy();
    await context.internalAdapter.updateAccount(account!.id, {
      accessToken: "updated-access",
      refreshToken: "updated-refresh",
      idToken: "updated-id",
    });
    const scrubbed = await db.pool.query<{ access_token: string | null; refresh_token: string | null; id_token: string | null }>(
      "SELECT access_token, refresh_token, id_token FROM auth_accounts WHERE id = $1",
      [account!.id],
    );
    expect(scrubbed.rows[0]).toEqual({ access_token: null, refresh_token: null, id_token: null });

    const identifier = "reset-identifier-for-phase-two";
    await context.internalAdapter.createVerificationValue({ identifier, value: "one-time-value", expiresAt: new Date(Date.now() + 60_000) });
    const storedVerification = await db.pool.query<{ identifier: string }>("SELECT identifier FROM auth_verifications WHERE value = 'one-time-value'");
    expect(storedVerification.rows[0]?.identifier).not.toBe(identifier);
    await expect(context.internalAdapter.findVerificationValue(identifier)).resolves.toMatchObject({ value: "one-time-value" });
    await expect(context.internalAdapter.consumeVerificationValue(identifier)).resolves.toMatchObject({ value: "one-time-value" });
    await expect(context.internalAdapter.consumeVerificationValue(identifier)).resolves.toBeNull();

    const session = await freshAuth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe("adapter.user@example.test");
    const listed = await freshAuth.handler(new Request("http://localhost:5173/api/v1/auth/list-sessions", {
      headers: { cookie },
    }));
    expect(listed.status).toBe(200);
    const listedBody = await listed.text();
    expect(listedBody).not.toContain(sessions.rows[0]!.token_hash);

    const second = await freshAuth.handler(new Request("http://localhost:5173/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "adapter.user@example.test", password: "a password with at least fifteen characters", rememberMe: true }),
    }));
    expect(second.status).toBe(200);
    const secondCookieHeader = second.headers.get("set-cookie");
    expect(secondCookieHeader).toMatch(/^better-auth\.session_token=/);
    const secondCookie = secondCookieHeader!.split(";", 1)[0]!;
    const secondRawToken = decodeURIComponent(secondCookie.slice(secondCookie.indexOf("=") + 1));
    const secondSessionToken = secondRawToken.split(".", 1)[0]!;
    const revoke = await freshAuth.handler(new Request("http://localhost:5173/api/v1/auth/revoke-other-sessions", {
      method: "POST",
      headers: { cookie: secondCookie },
    }));
    expect(revoke.status).toBe(200);
    const remaining = await db.pool.query("SELECT id FROM user_sessions");
    expect(remaining.rowCount).toBe(1);
    const transactionRead = await context.adapter.transaction(async (transactionAdapter) =>
      transactionAdapter.findOne<{ token: string }>({ model: "session", where: [{ field: "token", value: secondSessionToken }] }),
    );
    expect(transactionRead?.token).toBe(secondSessionToken);
    await expect(context.adapter.updateMany({
      model: "session",
      where: [{ field: "token", operator: "in", value: [secondSessionToken] }],
      update: { updatedAt: new Date() },
    })).resolves.toBe(1);
    await expect(context.adapter.deleteMany({
      model: "session",
      where: [{ field: "token", operator: "in", value: [secondSessionToken] }],
    })).resolves.toBe(1);
  });

  it("passes the development minimum through the Better Auth factory", async () => {
    if (!db.available) return;
    const config = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      BETTER_AUTH_SECRET: "development-auth-secret-that-is-long-enough",
      FRONTEND_URL: "http://localhost:5173",
      RAINVER_ENV: "dev",
    });
    const auth = createBetterAuth(config, db.pool);
    const response = await auth.handler(new Request("http://localhost:5173/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "short.dev.password@example.test",
        password: "devpass8",
        name: "Dev Password",
      }),
    }));

    expect(response.status).toBe(200);
  });
});
