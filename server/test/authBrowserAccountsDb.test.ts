import { join } from "node:path";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConfigSnapshot, loadConfig, type ServerConfig } from "../src/config.js";
import { migrate } from "../src/db/migrator.js";
import { createBetterAuth } from "../src/modules/auth/betterAuth.js";
import { authModule } from "../src/modules/auth/index.js";
import { createAuthRuntime } from "../src/modules/auth/identity.js";
import { settleSessionCookies } from "../src/modules/auth/browserAccountSessions.js";
import { __resetBrowserAccountLedgerForTests } from "../src/modules/auth/browserAccountLedger.js";
import { issueGoogleReauth } from "../src/modules/auth/googleReauth.js";
import type { AuthRuntime } from "../src/modules/auth/identity.js";
import { registerRoutes } from "../src/modules/auth/routes.js";
import { createServerApp, registerGatewayConventions, registerUnknownApiRoute } from "../src/gateway/appShell.js";
import { __setHibpTransportForTests } from "../src/modules/auth/routes.js";
import { hashOpaqueToken } from "../src/modules/auth/securityPolicy.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

const db = useTestDatabase(import.meta.filename, { empty: true });
const PASSWORD = "a password with at least fifteen characters";

beforeAll(async () => { if (db.available) await migrate(db.pool, join(process.cwd(), "migrations")); });
afterAll(() => { __setHibpTransportForTests(null); });
beforeEach(async () => {
  __resetBrowserAccountLedgerForTests();
  if (!db.available) return;
  await resetTables(db.pool, ["auth_accounts", "user_sessions", "spaces", "users"], { cascade: true });
});

function authConfig(): ServerConfig {
  return loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    BETTER_AUTH_SECRET: "browser-accounts-test-secret-that-is-long-enough",
    PUBLIC_BASE_URL: "http://localhost:5173",
    INSTANCE_ADMIN_EMAIL: "a@example.test",
  });
}

// Better Auth limits /sign-in per IP; every facade call names its own address.
let address = 10;
const nextAddress = () => `198.51.100.${address++ % 250}`;

/** An active account that can sign in with a password; it holds no session. */
async function account(config: ServerConfig, email: string): Promise<string> {
  const auth = createBetterAuth(config, db.pool);
  const response = await auth.handler(new Request(`${config.frontendUrl}/api/v1/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.frontendUrl, "x-forwarded-for": nextAddress() },
    body: JSON.stringify({ email, password: PASSWORD, name: email.split("@")[0] }),
  }));
  expect(response.status).toBe(200);
  const user = await db.pool.query<{ id: string }>("UPDATE users SET status = 'active' WHERE email = $1 RETURNING id", [email]);
  await db.pool.query("DELETE FROM user_sessions WHERE user_id = $1", [user.rows[0]!.id]);
  return user.rows[0]!.id;
}

/** A cookie store that applies `Set-Cookie` as a browser does, remembering which cookies outlive the session. */
class Browser {
  readonly cookies = new Map<string, { value: string; persistent: boolean }>();
  apply(headers: Record<string, unknown>): string[] {
    const raw = headers["set-cookie"];
    const list = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).map(String);
    for (const cookie of list) {
      const [pair, ...attributes] = cookie.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      const value = pair!.slice(at + 1).trim();
      const maxAge = attributes.map((part) => part.trim()).find((part) => /^max-age=/i.test(part));
      if (value === "" || maxAge?.toLowerCase() === "max-age=0") this.cookies.delete(name);
      else this.cookies.set(name, { value, persistent: Boolean(maxAge) });
    }
    return list;
  }
  header(): string { return [...this.cookies].map(([name, cookie]) => `${name}=${cookie.value}`).join("; "); }
  /** Closing the browser drops every cookie without a lifetime. */
  restart(): void { for (const [name, cookie] of this.cookies) if (!cookie.persistent) this.cookies.delete(name); }
  jarNames(): string[] { return [...this.cookies.keys()].filter((name) => name.startsWith("rainver.account_") && name !== "rainver.account_add"); }
}

type App = ReturnType<typeof buildModuleServer>;

async function signIn(app: App, browser: Browser, email: string, options: { rememberMe?: boolean; add?: boolean; password?: string; handle?: string } = {}) {
  const response = await app.inject({
    method: "POST", url: "/api/v1/auth/sign-in/email", remoteAddress: nextAddress(),
    headers: { origin: "http://localhost:5173", "content-type": "application/json", cookie: browser.header(), ...(options.handle ? { "x-rainver-account": options.handle } : {}) },
    payload: JSON.stringify({ email, password: options.password ?? PASSWORD, rememberMe: options.rememberMe ?? true, ...(options.add ? { add_account: true } : {}) }),
  });
  browser.apply(response.headers as Record<string, unknown>);
  return response;
}

async function me(app: App, browser: Browser, handle?: string) {
  const response = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: browser.header(), ...(handle ? { "x-rainver-account": handle } : {}) } });
  browser.apply(response.headers as Record<string, unknown>);
  return response;
}

async function switchTo(app: App, browser: Browser, userId: string) {
  const response = await app.inject({
    method: "POST", url: "/api/v1/auth/browser-accounts/switch",
    headers: { origin: "http://localhost:5173", "content-type": "application/json", cookie: browser.header() },
    payload: JSON.stringify({ user_id: userId }),
  });
  browser.apply(response.headers as Record<string, unknown>);
  return response;
}

async function logout(app: App, cookie: string) {
  return app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { origin: "http://localhost:5173", cookie } });
}

async function sessionCount(userId: string): Promise<number> {
  const result = await db.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1", [userId]);
  return result.rows[0]!.count;
}

/** A Better Auth session issued outside any browser, as a provider callback would issue it. */
async function issuedFor(runtime: AuthRuntime, email: string): Promise<string[]> {
  const result = await runtime.auth.api.signInEmail({ body: { email, password: PASSWORD, rememberMe: true }, headers: new Headers({ "x-forwarded-for": nextAddress() }), returnHeaders: true });
  return result.headers.getSetCookie();
}

describe("browser accounts", () => {
  it("adds an existing account beside the current one and switches between them across a restart", async () => {
    if (!db.available) return;
    const config = authConfig();
    const a = await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    let app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      expect((await signIn(app, browser, "a@example.test")).statusCode).toBe(200);
      const first = (await me(app, browser)).json();
      expect(first.id).toBe(a);

      // A wrong password while adding changes nothing in the browser.
      const before = browser.header();
      const refused = await signIn(app, browser, "b@example.test", { add: true, password: "not the right password at all" });
      expect(refused.statusCode).toBe(401);
      expect(browser.header()).toBe(before);
      expect((await me(app, browser)).json().id).toBe(a);

      const added = await signIn(app, browser, "b@example.test", { add: true, rememberMe: false });
      expect(added.statusCode).toBe(200);
      expect(JSON.stringify(added.json())).not.toMatch(/token/i);
      const second = (await me(app, browser)).json();
      expect(second.id).toBe(b);
      expect(second.account_handle).not.toBe(first.account_handle);

      const listed = await app.inject({ method: "GET", url: "/api/v1/auth/browser-accounts", headers: { cookie: browser.header() } });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().accounts.map((entry: { user_id: string; active: boolean; remembered: boolean }) => [entry.user_id, entry.active, entry.remembered]))
        .toEqual(expect.arrayContaining([[a, false, true], [b, true, false]]));
      // Names people, never sessions or the credentials that act as them.
      const sessions = await db.pool.query<{ id: string }>("SELECT id FROM user_sessions");
      for (const session of sessions.rows) expect(listed.body).not.toContain(session.id);
      for (const name of browser.jarNames()) expect(listed.body).not.toContain(decodeURIComponent(browser.cookies.get(name)!.value).slice(2, 34));
      // Remember-me is per account: the unremembered one leaves no lasting cookie.
      expect(browser.cookies.get(`rainver.account_${second.account_handle}`)?.persistent).toBe(false);
      expect(browser.cookies.get(`rainver.account_${first.account_handle}`)?.persistent).toBe(true);
      expect(browser.cookies.get("rainver.active_account")?.persistent).toBe(false);

      // A tab still showing A is refused rather than served as B.
      const stale = await me(app, browser, first.account_handle);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("account_switched");
      expect((await me(app, browser, second.account_handle)).statusCode).toBe(200);

      // The server restarts; nothing it held in memory is needed to switch back.
      await app.close();
      app = buildModuleServer(config, [authModule]);
      expect((await switchTo(app, browser, a)).statusCode).toBe(200);
      expect((await me(app, browser)).json().id).toBe(a);
      expect(browser.cookies.get("rainver.active_account")?.persistent).toBe(true);
      expect((await switchTo(app, browser, b)).statusCode).toBe(200);
      expect((await me(app, browser)).json().id).toBe(b);

      // Closing the browser forgets the unremembered account and its selection, not the remembered one.
      browser.restart();
      expect((await me(app, browser)).statusCode).toBe(401);
      expect(browser.jarNames()).toEqual([`rainver.account_${first.account_handle}`]);
    } finally {
      await app.close();
    }
  });

  it("keeps a late sliding-window refresh on its own account", async () => {
    if (!db.available) return;
    const config = authConfig();
    const a = await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      await signIn(app, browser, "a@example.test");
      await signIn(app, browser, "b@example.test", { add: true });
      const handleB = (await me(app, browser)).json().account_handle;
      // A request from B's tab starts with B's cookies; the switch to A lands first.
      const inFlight = browser.header();
      await db.pool.query("UPDATE user_sessions SET expires_at = now() + interval '12 hours', updated_at = now() - interval '2 days' WHERE user_id = $1", [b]);
      expect((await switchTo(app, browser, a)).statusCode).toBe(200);
      const late = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: inFlight } });
      expect(late.statusCode).toBe(200);
      const written = browser.apply(late.headers as Record<string, unknown>);
      expect(written.map((cookie) => cookie.split("=", 1)[0])).toEqual([`rainver.account_${handleB}`]);
      expect(written[0]).toMatch(/Max-Age=\d+/);
      const row = await db.pool.query<{ expires_at: string }>("SELECT expires_at FROM user_sessions WHERE user_id = $1", [b]);
      expect(new Date(row.rows[0]!.expires_at).getTime()).toBeGreaterThan(Date.now() + 24 * 3600 * 1000);
      // Still A; and B, refreshed, is still there to switch back to.
      expect((await me(app, browser)).json().id).toBe(a);
      expect((await switchTo(app, browser, b)).statusCode).toBe(200);
      expect((await me(app, browser)).json().id).toBe(b);
    } finally {
      await app.close();
    }
  });

  it("signs the browser out of every account and drops accounts revoked elsewhere", async () => {
    if (!db.available) return;
    const config = authConfig();
    const a = await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const c = await account(config, "c@example.test");
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      await signIn(app, browser, "a@example.test");
      await signIn(app, browser, "b@example.test", { add: true });
      await signIn(app, browser, "c@example.test", { add: true });
      // Revoked from another device: it leaves this browser's list on the next read.
      await db.pool.query("DELETE FROM user_sessions WHERE user_id = $1", [b]);
      const listed = await app.inject({ method: "GET", url: "/api/v1/auth/browser-accounts", headers: { cookie: browser.header() } });
      browser.apply(listed.headers as Record<string, unknown>);
      expect(listed.json().accounts.map((entry: { user_id: string }) => entry.user_id).sort()).toEqual([a, c].sort());
      expect(browser.jarNames()).toHaveLength(2);
      expect((await switchTo(app, browser, b)).statusCode).toBe(404);

      const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { origin: config.frontendUrl, cookie: browser.header(), "x-rainver-account": "stale-tab" } });
      expect(logout.statusCode).toBeLessThan(300);
      browser.apply(logout.headers as Record<string, unknown>);
      await expect(db.pool.query("SELECT count(*)::int AS count FROM user_sessions")).resolves.toMatchObject({ rows: [{ count: 0 }] });
      expect(browser.jarNames()).toEqual([]);
      expect(browser.cookies.has("rainver.active_account")).toBe(false);
      expect((await me(app, browser)).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("keeps a session from before the jar and lets the browser switch back to it", async () => {
    if (!db.available) return;
    const config = authConfig();
    const a = await account(config, "a@example.test");
    await account(config, "b@example.test");
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      await signIn(app, browser, "a@example.test");
      // What an older release left: Better Auth's cookie and nothing else.
      for (const name of [...browser.cookies.keys()]) if (name.startsWith("rainver.")) browser.cookies.delete(name);
      expect((await me(app, browser)).json()).toMatchObject({ id: a, account_handle: "-" });
      await signIn(app, browser, "b@example.test", { add: true });
      expect(browser.jarNames()).toHaveLength(2);
      expect((await switchTo(app, browser, a)).statusCode).toBe(200);
      expect((await me(app, browser)).json().id).toBe(a);
    } finally {
      await app.close();
    }
  });

  it("refuses an added account past the limit and an account switch during reauthentication", async () => {
    if (!db.available) return;
    const config = authConfig();
    const users: string[] = [];
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) users.push(await account(config, `${name}@example.test`));
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      await signIn(app, browser, "a@example.test");
      for (const name of ["b", "c", "d", "e"]) expect((await signIn(app, browser, `${name}@example.test`, { add: true })).statusCode).toBe(200);
      const full = browser.header();
      const over = await signIn(app, browser, "f@example.test", { add: true });
      expect(over.statusCode).toBe(409);
      expect(over.json().code).toBe("account_limit");
      expect(browser.header()).toBe(full);
      await expect(db.pool.query("SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1", [users[5]])).resolves.toMatchObject({ rows: [{ count: 0 }] });
      // An ordinary sign-in at the limit signs out the longest-unused account instead.
      await db.pool.query("UPDATE user_sessions SET updated_at = now() - interval '3 hours' WHERE user_id = $1", [users[1]]);
      expect((await signIn(app, browser, "f@example.test")).statusCode).toBe(200);
      await expect(db.pool.query("SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1", [users[1]])).resolves.toMatchObject({ rows: [{ count: 0 }] });
      expect(browser.jarNames()).toHaveLength(5);

      // A Google reauthentication that comes back as someone else is revoked and changes nothing.
      const runtime = createAuthRuntime(config)!;
      const other = await runtime.auth.api.signInEmail({ body: { email: "g@example.test", password: PASSWORD }, headers: new Headers({ "x-forwarded-for": nextAddress() }), returnHeaders: true });
      const issued = other.headers.getSetCookie();
      const request = { headers: { cookie: browser.header() } } as unknown as FastifyRequest;
      const settled = await settleSessionCookies(runtime, config, request, issued, { requireUserId: users[5] });
      expect(settled.refused).toBe("account_mismatch");
      expect(settled.setCookies.join("\n")).not.toMatch(/session_token|rainver\.account/);
      await expect(db.pool.query("SELECT count(*)::int AS count FROM user_sessions WHERE token_hash = $1", [hashOpaqueToken(other.response.token)])).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await app.close();
    }
  });

  it("lets a logout void a sign-in whose response arrives after it", async () => {
    if (!db.available) return;
    const config = authConfig();
    const a = await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      await signIn(app, browser, "a@example.test");
      // The addition settles first, but its response reaches the browser
      // only after the logout's, which carried the cookies from before it.
      const before = browser.header();
      const added = await app.inject({
        method: "POST", url: "/api/v1/auth/sign-in/email", remoteAddress: nextAddress(),
        headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: before },
        payload: JSON.stringify({ email: "b@example.test", password: PASSWORD, rememberMe: true, add_account: true }),
      });
      expect(added.statusCode).toBe(200);
      const out = await logout(app, before);
      expect(out.statusCode).toBeLessThan(300);
      browser.apply(out.headers as Record<string, unknown>);
      expect(String(out.headers["set-cookie"])).toMatch(/better-auth\.state=; Max-Age=0/);
      browser.apply(added.headers as Record<string, unknown>);
      expect(browser.jarNames()).toHaveLength(1);
      expect((await me(app, browser)).statusCode).toBe(401);
      expect(await sessionCount(a)).toBe(0);
      expect(await sessionCount(b)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("refuses a sign-in or rotation that began before a logout and settles after it", async () => {
    if (!db.available) return;
    const config = authConfig();
    await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const app = buildModuleServer(config, [authModule]);
    const runtime = createAuthRuntime(config)!;
    const browser = new Browser();
    try {
      await signIn(app, browser, "a@example.test");
      const snapshot = browser.header();
      // Better Auth has issued B's session; the facade has not merged it yet.
      const issued = await issuedFor(runtime, "b@example.test");
      const out = await logout(app, snapshot);
      browser.apply(out.headers as Record<string, unknown>);
      const settled = await settleSessionCookies(runtime, config, { headers: { cookie: snapshot } } as unknown as FastifyRequest, issued, { add: true });
      expect(settled.refused).toBe("signed_out");
      expect(settled.setCookies.join("\n")).not.toMatch(/session_token|rainver\.account|rainver\.active_account/);
      expect(await sessionCount(b)).toBe(0);

      // A sign-in that begins after the logout is an ordinary new sign-in.
      expect((await signIn(app, browser, "b@example.test")).statusCode).toBe(200);
      expect((await me(app, browser)).json().id).toBe(b);
    } finally {
      await app.close();
    }
  });

  it("refuses a request sent with the cookies from before a logout that reaches the server after it", async () => {
    if (!db.available) return;
    const config = authConfig();
    await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      await signIn(app, browser, "a@example.test");
      const before = browser.header();
      // Both left the browser together; the logout reached the server first.
      const out = await logout(app, before);
      const added = await app.inject({
        method: "POST", url: "/api/v1/auth/sign-in/email", remoteAddress: nextAddress(),
        headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: before },
        payload: JSON.stringify({ email: "b@example.test", password: PASSWORD, rememberMe: true, add_account: true }),
      });
      expect(added.statusCode).toBe(409);
      expect(added.json().code).toBe("signed_out");
      browser.apply(out.headers as Record<string, unknown>);
      browser.apply(added.headers as Record<string, unknown>);
      expect(browser.jarNames()).toHaveLength(0);
      expect((await me(app, browser)).statusCode).toBe(401);
      expect(await sessionCount(b)).toBe(0);

      // Sent after the browser applied the logout, it carries none of those cookies.
      const again = await signIn(app, browser, "b@example.test");
      expect(again.statusCode).toBe(200);
      const signedIn = (await me(app, browser, again.json().account_handle)).json();
      expect(signedIn).toMatchObject({ id: b, account_handle: again.json().account_handle });
    } finally {
      await app.close();
    }
  });

  /**
   * One account signs in, changes its password, and signs out before the
   * change's response lands; `meanwhile` runs once the sign-out applied and
   * before that response does. Returns that response.
   */
  async function lateRotation(app: App, config: ServerConfig, browser: Browser, email: string, meanwhile?: () => Promise<void>) {
    await signIn(app, browser, email);
    const reauth = await app.inject({
      method: "POST", url: "/api/v1/auth/reauth", remoteAddress: nextAddress(),
      headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: browser.header() },
      payload: JSON.stringify({ password: PASSWORD }),
    });
    expect(reauth.statusCode).toBe(200);
    browser.apply(reauth.headers as Record<string, unknown>);
    const before = browser.header();
    const changed = await app.inject({
      method: "POST", url: "/api/v1/auth/password/change", remoteAddress: nextAddress(),
      headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: before },
      payload: JSON.stringify({ current_password: PASSWORD, new_password: "another password of at least fifteen characters" }),
    });
    expect(changed.statusCode).toBe(200);
    const out = await logout(app, before);
    expect(out.statusCode).toBeLessThan(300);
    browser.apply(out.headers as Record<string, unknown>);
    await meanwhile?.();
    browser.apply(changed.headers as Record<string, unknown>);
    return changed;
  }

  it("signs in normally after a late password change wrote back a revoked session, on reload or on the same page", async () => {
    if (!db.available) return;
    __setHibpTransportForTests({ async fetchRange() { return ""; } });
    const config = authConfig();
    const a = await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const c = await account(config, "c@example.test");
    const app = buildModuleServer(config, [authModule]);
    try {
      // Reload: the page asks who is signed in, finds no one, and the revoked session's cookie goes with that answer.
      const reloaded = new Browser();
      const changed = await lateRotation(app, config, reloaded, "a@example.test");
      expect(reloaded.jarNames()).toEqual([`rainver.account_${changed.json().account_handle}`]);
      expect((await me(app, reloaded)).statusCode).toBe(401);
      expect(reloaded.jarNames()).toHaveLength(0);
      const signedIn = await signIn(app, reloaded, "b@example.test");
      expect(signedIn.statusCode).toBe(200);
      expect((await me(app, reloaded, signedIn.json().account_handle)).json().id).toBe(b);
      // Still signed out: the rotated session stayed revoked.
      expect(await sessionCount(a)).toBe(0);

      // Same page: the tab already names no account (`-`) and signs in at once, with no second sign-out.
      const samePage = new Browser();
      await lateRotation(app, config, samePage, "c@example.test");
      expect(await sessionCount(c)).toBe(0);
      const again = await signIn(app, samePage, "b@example.test", { handle: "-" });
      expect(again.statusCode).toBe(200);
      expect(samePage.jarNames()).toEqual([`rainver.account_${again.json().account_handle}`]);
      expect((await me(app, samePage, again.json().account_handle)).json()).toMatchObject({ id: b, account_handle: again.json().account_handle });
      expect(await sessionCount(c)).toBe(0);
    } finally {
      __setHibpTransportForTests(null);
      await app.close();
    }
  });

  it("keeps an account signed in by another tab after the sign-out selected when a late password change answers, and restores it", async () => {
    if (!db.available) return;
    __setHibpTransportForTests({ async fetchRange() { return ""; } });
    const config = authConfig();
    const a = await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const c = await account(config, "c@example.test");
    const app = buildModuleServer(config, [authModule]);
    try {
      const browser = new Browser();
      let bHandle = "";
      // Another tab signs in as b after the sign-out, before a's change answers.
      const changed = await lateRotation(app, config, browser, "a@example.test", async () => {
        const signedIn = await signIn(app, browser, "b@example.test", { handle: "-" });
        expect(signedIn.statusCode).toBe(200);
        bHandle = signedIn.json().account_handle;
      });
      const rotated = changed.json().account_handle as string;
      // The late answer selected the session the sign-out revoked, over b's.
      expect(browser.cookies.get("rainver.active_account")?.value).toBe(rotated);
      expect(await sessionCount(a)).toBe(0);
      expect(await sessionCount(b)).toBe(1);

      // b's tab is not refused as stale: it acts as b. Only the revoked session's jar cookie is dropped;
      // the selector is read as b's for each request and never rewritten by one.
      const bTab = await me(app, browser, bHandle);
      expect(bTab.statusCode).toBe(200);
      expect(bTab.json()).toMatchObject({ id: b, account_handle: bHandle });
      expect(browser.cookies.get("rainver.active_account")?.value).toBe(rotated);
      expect(browser.jarNames()).toEqual([`rainver.account_${bHandle}`]);
      // Without its jar cookie the old selector is still recognized.
      expect((await me(app, browser, bHandle)).json()).toMatchObject({ id: b, account_handle: bHandle });
      // A reload finds b, and b keeps working: adding an account is not refused for the revoked session.
      expect((await me(app, browser)).json()).toMatchObject({ id: b, account_handle: bHandle });
      const added = await signIn(app, browser, "c@example.test", { add: true, handle: bHandle });
      expect(added.statusCode).toBe(200);
      // The addition replaced the selector; switching back writes b's own.
      expect(browser.cookies.get("rainver.active_account")?.value).toBe(added.json().account_handle);
      expect((await switchTo(app, browser, b)).statusCode).toBe(200);
      expect(browser.cookies.get("rainver.active_account")?.value).toBe(bHandle);
      expect((await me(app, browser, bHandle)).json().id).toBe(b);
      expect(await sessionCount(a)).toBe(0);
      expect(await sessionCount(b)).toBe(1);
      expect(await sessionCount(c)).toBe(1);

      // The old page's tab (`-`) is still refused while b is selected.
      expect((await me(app, browser, "-")).statusCode).toBe(409);
    } finally {
      __setHibpTransportForTests(null);
      await app.close();
    }
  });

  it("restores the account the browser switched to last, even when the old tab's page is the one that reloads", async () => {
    if (!db.available) return;
    __setHibpTransportForTests({ async fetchRange() { return ""; } });
    const config = authConfig();
    await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const c = await account(config, "c@example.test");
    const app = buildModuleServer(config, [authModule]);
    try {
      const browser = new Browser();
      await lateRotation(app, config, browser, "a@example.test", async () => {
        expect((await signIn(app, browser, "b@example.test", { handle: "-" })).statusCode).toBe(200);
        expect((await signIn(app, browser, "c@example.test", { add: true })).statusCode).toBe(200);
        expect((await switchTo(app, browser, b)).statusCode).toBe(200);
      });
      // A fresh page names no account yet; it loads as b, the last selection, not c, the newest sign-in.
      expect((await me(app, browser)).json().id).toBe(b);
      expect(await sessionCount(c)).toBe(1);
    } finally {
      __setHibpTransportForTests(null);
      await app.close();
    }
  });

  it("signs the browser out, never into an earlier account, when its last selection since the sign-out is gone", async () => {
    if (!db.available) return;
    __setHibpTransportForTests({ async fetchRange() { return ""; } });
    const config = authConfig();
    const b = await account(config, "b@example.test");
    const c = await account(config, "c@example.test");
    const app = buildModuleServer(config, [authModule]);
    try {
      for (const gone of ["restart", "revoked", "expired"] as const) {
        // Each case changes the password of its own first account.
        await account(config, `${gone}@example.test`);
        await db.pool.query("DELETE FROM user_sessions");
        const browser = new Browser();
        let bHandle = "";
        let cHandle = "";
        // After the sign-out another tab signs in as b and adds c; c, the last selection, is remembered only for a restart.
        await lateRotation(app, config, browser, `${gone}@example.test`, async () => {
          bHandle = (await signIn(app, browser, "b@example.test", { handle: "-" })).json().account_handle;
          cHandle = (await signIn(app, browser, "c@example.test", { add: true, handle: bHandle, rememberMe: gone !== "restart" })).json().account_handle;
        });
        expect((await me(app, browser)).json(), gone).toMatchObject({ id: c, account_handle: cHandle });
        if (gone === "restart") browser.restart();
        else if (gone === "revoked") await db.pool.query("DELETE FROM user_sessions WHERE id = $1", [cHandle]);
        else await db.pool.query("UPDATE user_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [cHandle]);
        // Neither the first request nor any later one, once c's cookie is dropped, falls back to b or a legacy cookie.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect((await me(app, browser)).statusCode, `${gone} ${attempt}`).toBe(401);
        }
        expect(browser.jarNames(), gone).toEqual([`rainver.account_${bHandle}`]);
        expect((await me(app, browser, bHandle)).statusCode, gone).toBe(409);
        // A switch needs a signed-in account first; b's saved session is switchable once one signs in.
        expect((await switchTo(app, browser, b)).statusCode, gone).toBe(401);
        const again = await signIn(app, browser, "c@example.test", { handle: "-" });
        expect(again.statusCode, gone).toBe(200);
        expect((await me(app, browser, again.json().account_handle)).json(), gone).toMatchObject({ id: c });
        expect((await switchTo(app, browser, b)).statusCode, gone).toBe(200);
        expect((await me(app, browser, bHandle)).json(), gone).toMatchObject({ id: b, account_handle: bHandle });
      }
    } finally {
      __setHibpTransportForTests(null);
      await app.close();
    }
  });

  it("signs the browser out, never into a remaining account, when a concurrent sign-in it no longer shows was selected later", async () => {
    if (!db.available) return;
    __setHibpTransportForTests({ async fetchRange() { return ""; } });
    const config = authConfig();
    const b = await account(config, "b@example.test");
    const c = await account(config, "c@example.test");
    const app = buildModuleServer(config, [authModule]);
    try {
      for (const seen of ["never", "first"] as const) {
        await account(config, `${seen}@example.test`);
        await db.pool.query("DELETE FROM user_sessions");
        const browser = new Browser();
        let bHandle = "";
        let cHandle = "";
        // After the sign-out two tabs sign in together: neither request carries the other's cookie, so the
        // ledger holds them as two groups. c, selected later, is not remembered across a restart.
        await lateRotation(app, config, browser, `${seen}@example.test`, async () => {
          const tab = new Browser();
          for (const [name, cookie] of browser.cookies) tab.cookies.set(name, cookie);
          bHandle = (await signIn(app, browser, "b@example.test", { handle: "-" })).json().account_handle;
          const other = await signIn(app, tab, "c@example.test", { handle: "-", rememberMe: false });
          browser.apply(other.headers as Record<string, unknown>);
          cHandle = other.json().account_handle;
        });
        // Seen together once, or never before c's cookie is gone: either way b is not inferred to be the last selection.
        if (seen === "first") expect((await me(app, browser)).json(), seen).toMatchObject({ id: c, account_handle: cHandle });
        browser.restart();
        expect(browser.jarNames(), seen).toContain(`rainver.account_${bHandle}`);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect((await me(app, browser)).statusCode, `${seen} ${attempt}`).toBe(401);
        }
        // b stays signed in on this browser and is switchable once the person signs in again.
        expect(browser.jarNames(), seen).toEqual([`rainver.account_${bHandle}`]);
        expect(await sessionCount(b), seen).toBe(1);
        const again = await signIn(app, browser, "c@example.test", { handle: "-" });
        expect(again.statusCode, seen).toBe(200);
        expect((await switchTo(app, browser, b)).statusCode, seen).toBe(200);
        expect((await me(app, browser, bHandle)).json(), seen).toMatchObject({ id: b, account_handle: bHandle });
      }
    } finally {
      __setHibpTransportForTests(null);
      await app.close();
    }
  });

  /** A request whose response the browser applies only when `land` is called, after later requests' responses. */
  async function delayedMe(app: App, browser: Browser, handle: string) {
    const response = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: browser.header(), "x-rainver-account": handle } });
    return { response, land: () => browser.apply(response.headers as Record<string, unknown>) };
  }

  it("lets no earlier request's recovery answer, landing last, undo a later switch or sign-in", async () => {
    if (!db.available) return;
    __setHibpTransportForTests({ async fetchRange() { return ""; } });
    const config = authConfig();
    await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const c = await account(config, "c@example.test");
    for (const name of ["d", "e"]) await account(config, `${name}@example.test`);
    const app = buildModuleServer(config, [authModule]);
    try {
      // A switch: two requests carry the written-back selector; the slow one's answer lands after the switch to c.
      const browser = new Browser();
      let bHandle = "";
      const changed = await lateRotation(app, config, browser, "a@example.test", async () => {
        bHandle = (await signIn(app, browser, "b@example.test", { handle: "-" })).json().account_handle;
      });
      const rotated = changed.json().account_handle as string;
      const slow = await delayedMe(app, browser, bHandle);
      expect(slow.response.json()).toMatchObject({ id: b, account_handle: bHandle });
      expect((await me(app, browser, bHandle)).json().id).toBe(b);
      const added = await signIn(app, browser, "c@example.test", { add: true, handle: bHandle });
      expect(added.statusCode).toBe(200);
      const cHandle = added.json().account_handle as string;
      expect((await switchTo(app, browser, b)).statusCode).toBe(200);
      expect((await switchTo(app, browser, c)).statusCode).toBe(200);
      expect(browser.cookies.get("rainver.active_account")?.value).toBe(cHandle);
      slow.land();
      expect(browser.cookies.get("rainver.active_account")?.value).toBe(cHandle);
      expect((await me(app, browser, cHandle)).json()).toMatchObject({ id: c, account_handle: cHandle });
      // The old pages stay isolated: b's tab and the signed-out tab are refused as stale.
      expect((await me(app, browser, bHandle)).statusCode).toBe(409);
      expect((await me(app, browser, "-")).statusCode).toBe(409);
      expect(browser.jarNames()).not.toContain(`rainver.account_${rotated}`);

      // Same page: a slow answer read with no account lands after that page signed in again.
      const samePage = new Browser();
      const again = await lateRotation(app, config, samePage, "d@example.test");
      const revoked = again.json().account_handle as string;
      const slowSignedOut = await delayedMe(app, samePage, "-");
      expect(slowSignedOut.response.statusCode).toBe(401);
      const signedIn = await signIn(app, samePage, "b@example.test", { handle: "-" });
      expect(signedIn.statusCode).toBe(200);
      const handle = signedIn.json().account_handle as string;
      slowSignedOut.land();
      expect(samePage.cookies.get("rainver.active_account")?.value).toBe(handle);
      expect(samePage.jarNames()).toEqual([`rainver.account_${handle}`]);
      expect((await me(app, samePage, handle)).json()).toMatchObject({ id: b, account_handle: handle });
      expect(revoked).not.toBe(handle);

      // A sign-out read without the written-back selector still clears it.
      const leaving = new Browser();
      await lateRotation(app, config, leaving, "e@example.test");
      expect((await me(app, leaving, "-")).statusCode).toBe(401);
      expect(leaving.cookies.has("rainver.active_account")).toBe(true);
      leaving.apply((await logout(app, leaving.header())).headers as Record<string, unknown>);
      expect(leaving.cookies.has("rainver.active_account")).toBe(false);
    } finally {
      __setHibpTransportForTests(null);
      await app.close();
    }
  });

  it("revokes a password change's rotated session when a logout carrying the replaced cookie lands before its response", async () => {
    if (!db.available) return;
    __setHibpTransportForTests({ async fetchRange() { return ""; } });
    const config = authConfig();
    const a = await account(config, "a@example.test");
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      // One account only: once Better Auth deletes it, no valid session is left to tie the rotation to.
      await signIn(app, browser, "a@example.test");
      const reauth = await app.inject({
        method: "POST", url: "/api/v1/auth/reauth", remoteAddress: nextAddress(),
        headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: browser.header() },
        payload: JSON.stringify({ password: PASSWORD }),
      });
      expect(reauth.statusCode).toBe(200);
      browser.apply(reauth.headers as Record<string, unknown>);
      const before = browser.header();
      const changed = await app.inject({
        method: "POST", url: "/api/v1/auth/password/change", remoteAddress: nextAddress(),
        headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: before },
        payload: JSON.stringify({ current_password: PASSWORD, new_password: "another password of at least fifteen characters" }),
      });
      expect(changed.statusCode).toBe(200);
      expect(await sessionCount(a)).toBe(1);
      // The change completed on the server; its response is still on the way when the logout, with the old cookies, lands.
      const out = await logout(app, before);
      expect(out.statusCode).toBeLessThan(300);
      browser.apply(out.headers as Record<string, unknown>);
      browser.apply(changed.headers as Record<string, unknown>);
      // The written-back selection is read as none: the browser holds no account, so a tab naming the rotated session is stale, and a fresh page finds no one.
      // The selector itself stays until a sign-in, switch or sign-out of the browser replaces it.
      expect((await me(app, browser, changed.json().account_handle)).statusCode).toBe(409);
      expect(browser.cookies.get("rainver.active_account")?.value).toBe(changed.json().account_handle);
      expect((await me(app, browser)).statusCode).toBe(401);
      expect(await sessionCount(a)).toBe(0);
    } finally {
      __setHibpTransportForTests(null);
      await app.close();
    }
  });

  it("frees the place of an account revoked elsewhere for the next addition", async () => {
    if (!db.available) return;
    const config = authConfig();
    for (const name of ["a", "b", "c", "d", "e", "f"]) await account(config, `${name}@example.test`);
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    const device = new Browser();
    try {
      await signIn(app, browser, "a@example.test");
      for (const name of ["b", "c", "d", "e"]) expect((await signIn(app, browser, `${name}@example.test`, { add: true })).statusCode).toBe(200);
      // B, not the active account, signs this browser's session out from another device.
      await signIn(app, device, "b@example.test");
      const listed = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: { cookie: device.header() } });
      const elsewhere = (listed.json() as Array<{ id: string; current: boolean }>).find((session) => !session.current)!;
      const revoked = await app.inject({ method: "POST", url: `/api/v1/auth/sessions/${elsewhere.id}/revoke`, headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: device.header() }, payload: "{}" });
      expect(revoked.statusCode).toBe(200);
      const accounts = await app.inject({ method: "GET", url: "/api/v1/auth/browser-accounts", headers: { cookie: browser.header() } });
      browser.apply(accounts.headers as Record<string, unknown>);
      expect(accounts.json().accounts).toHaveLength(4);
      // Four accounts are held: the fifth place is free again.
      expect((await signIn(app, browser, "f@example.test", { add: true })).statusCode).toBe(200);
      expect(browser.jarNames()).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it("keeps an unremembered account unremembered across a password change and hands the tab its new handle", async () => {
    if (!db.available) return;
    __setHibpTransportForTests({ async fetchRange() { return ""; } });
    const config = authConfig();
    const a = await account(config, "a@example.test");
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      await signIn(app, browser, "a@example.test", { rememberMe: false });
      const handle = (await me(app, browser)).json().account_handle as string;
      const reauth = await app.inject({
        method: "POST", url: "/api/v1/auth/reauth", remoteAddress: nextAddress(),
        headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: browser.header() },
        payload: JSON.stringify({ password: PASSWORD }),
      });
      expect(reauth.statusCode).toBe(200);
      browser.apply(reauth.headers as Record<string, unknown>);
      const changed = await app.inject({
        method: "POST", url: "/api/v1/auth/password/change", remoteAddress: nextAddress(),
        headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: browser.header(), "x-rainver-account": handle },
        payload: JSON.stringify({ current_password: PASSWORD, new_password: "another password of at least fifteen characters" }),
      });
      expect(changed.statusCode).toBe(200);
      const written = browser.apply(changed.headers as Record<string, unknown>);
      const next = changed.json().account_handle as string;
      expect(next).toBeTruthy();
      expect(next).not.toBe(handle);
      // Better Auth deleted the old session before the merge ran; the choice still came from it.
      expect(written.filter((cookie) => /session_token=[^;]|rainver\.account_|rainver\.active_account=[^;]/.test(cookie)).every((cookie) => !/Max-Age=[1-9]|Expires=/i.test(cookie))).toBe(true);
      expect(browser.cookies.get(`rainver.account_${next}`)?.persistent).toBe(false);
      expect(browser.cookies.get("rainver.active_account")?.persistent).toBe(false);
      // The tab that changed it carries the new handle and is not refused as stale.
      const after = await me(app, browser, next);
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({ id: a, account_handle: next });
      browser.restart();
      expect((await me(app, browser)).statusCode).toBe(401);
    } finally {
      __setHibpTransportForTests(null);
      await app.close();
    }
  });

  it("lets only one of two concurrent additions take the last place", async () => {
    if (!db.available) return;
    const config = authConfig();
    for (const name of ["a", "b", "c", "d", "e", "f"]) await account(config, `${name}@example.test`);
    const app = buildModuleServer(config, [authModule]);
    const browser = new Browser();
    try {
      await signIn(app, browser, "a@example.test");
      for (const name of ["b", "c", "d"]) expect((await signIn(app, browser, `${name}@example.test`, { add: true })).statusCode).toBe(200);
      const snapshot = browser.header();
      const add = (email: string) => app.inject({
        method: "POST", url: "/api/v1/auth/sign-in/email", remoteAddress: nextAddress(),
        headers: { origin: config.frontendUrl, "content-type": "application/json", cookie: snapshot },
        payload: JSON.stringify({ email, password: PASSWORD, rememberMe: true, add_account: true }),
      });
      const results = await Promise.all([add("e@example.test"), add("f@example.test")]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
      expect(results.find((result) => result.statusCode === 409)!.json().code).toBe("account_limit");
      for (const result of results) browser.apply(result.headers as Record<string, unknown>);
      expect(browser.jarNames()).toHaveLength(5);
      const listed = await app.inject({ method: "GET", url: "/api/v1/auth/browser-accounts", headers: { cookie: browser.header() } });
      expect(listed.json().accounts).toHaveLength(5);
      const sessions = await db.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM user_sessions");
      expect(sessions.rows[0]!.count).toBe(5);
    } finally {
      await app.close();
    }
  });

  it("binds a Google reauthentication callback to the person and session that started it before writing a cookie", async () => {
    if (!db.available) return;
    const config = authConfig();
    const a = await account(config, "a@example.test");
    const b = await account(config, "b@example.test");
    const runtime = createAuthRuntime(config)!;
    const reauthUrl = `${config.frontendUrl}/settings/security?google_reauth=1`;
    // Google itself is not reachable here: the provider step answers as
    // Better Auth's callback does, with a fresh session for whoever came back.
    let returning = "a@example.test";
    const handler = runtime.auth.handler;
    const auth = Object.assign(Object.create(Object.getPrototypeOf(runtime.auth)), runtime.auth, {
      handler: async (request: Request) => {
        if (!new URL(request.url).pathname.endsWith("/callback/google")) return handler(request);
        const headers = new Headers({ location: reauthUrl });
        for (const cookie of await issuedFor(runtime, returning)) headers.append("set-cookie", cookie);
        return new Response(null, { status: 302, headers });
      },
    });
    const app = createServerApp(config, { logger: false });
    registerGatewayConventions(app, config);
    registerRoutes(app, { config, snapshot: createConfigSnapshot(config), authRuntime: { ...runtime, auth } as AuthRuntime });
    registerUnknownApiRoute(app);
    const browser = new Browser();
    const callback = async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/auth/callback/google?state=s&code=c", headers: { cookie: browser.header() } });
      browser.apply(response.headers as Record<string, unknown>);
      return response;
    };
    try {
      await signIn(app, browser, "a@example.test", { rememberMe: false });
      const handleA = (await me(app, browser)).json().account_handle as string;
      await signIn(app, browser, "b@example.test", { add: true });
      await switchTo(app, browser, a);
      browser.cookies.set("rainver.google_reauth", { value: issueGoogleReauth(a, handleA), persistent: true });

      // Another tab switched to B meanwhile, and Google returned B: refused before any cookie.
      await switchTo(app, browser, b);
      returning = "b@example.test";
      let before = browser.header();
      expect((await callback()).statusCode).toBe(302);
      expect(browser.header()).toBe(before);
      expect(await sessionCount(b)).toBe(1);
      expect((await me(app, browser)).json().id).toBe(b);

      // Google returned A, but the browser no longer acts as A's starting session: refused too.
      returning = "a@example.test";
      before = browser.header();
      await callback();
      expect(browser.header()).toBe(before);
      expect(await sessionCount(a)).toBe(1);

      // From the session that started it, as the person who started it: the session rotates.
      await switchTo(app, browser, a);
      await callback();
      const rotated = (await me(app, browser)).json();
      expect(rotated.id).toBe(a);
      expect(rotated.account_handle).not.toBe(handleA);
      // Google issues a lasting session; the account was signed in without "remember me" and stays so.
      expect(browser.cookies.get(`rainver.account_${rotated.account_handle}`)?.persistent).toBe(false);
      expect(browser.cookies.get("rainver.active_account")?.persistent).toBe(false);
    } finally {
      await app.close();
    }
  });
});
