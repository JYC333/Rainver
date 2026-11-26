import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { AuthRuntime } from "./identity.js";
import { sessionCookieName } from "./identity.js";
import {
  ACCOUNT_ADD_COOKIE, ACCOUNT_JAR_PREFIX, ACCOUNT_SELECTOR_COOKIE, BROWSER_ACCOUNT_LIMIT, activeBrowserSession, clearJarCookie, clearSelectorCookie,
  isBetterAuthDontRememberCookie, isBetterAuthSessionCookie, issuedAsRemembered, issuedSessionToken,
  jarCookie, readBrowserAccounts, refreshCookiesForBrowser, selectorCookie, type JarEntry,
} from "./browserAccounts.js";
import { authCookieHeader } from "./authCookie.js";
import { endBrowser, endedFor, forgetIssued, issuedElsewhere, lateSelectorRepair, noteSelected, recordIssued, revokedLate } from "./browserAccountLedger.js";

/**
 * The database side of the browser account jar (`browserAccounts.ts`):
 * every jar entry is judged by Better Auth, the sole judge of its own cookie,
 * and a sign-in's new session is merged into the jar here. Session ids, never
 * tokens, leave the server.
 */
interface InspectedSession { sessionId: string; userId: string; updatedAt: number }
interface BrowserAccountUser { id: string; email: string | null; display_name: string; avatar_url: string | null }
type Runtime = Pick<AuthRuntime, "auth" | "pool">;

/** Better Auth's view of one signed cookie value, without refreshing it. Throws only when the store is unavailable. */
async function inspectSession(runtime: Runtime, config: ServerConfig, token: string): Promise<InspectedSession | null> {
  const result = await runtime.auth.api.getSession({
    headers: new Headers({ cookie: `${sessionCookieName(config)}=${encodeURIComponent(token)}` }),
    query: { disableRefresh: true },
  }).catch((error: unknown) => {
    // A signature or token Better Auth rejects is no session; anything else is an outage.
    if (error && typeof error === "object" && "status" in error && (error as { status?: unknown }).status !== "INTERNAL_SERVER_ERROR") return null;
    throw error;
  });
  if (!result?.session?.id || !result.session.userId) return null;
  return { sessionId: result.session.id, userId: result.session.userId, updatedAt: new Date(result.session.updatedAt).getTime() };
}

async function activeUsers(runtime: Runtime, ids: string[]): Promise<Map<string, BrowserAccountUser>> {
  if (!ids.length) return new Map();
  const result = await runtime.pool.query<BrowserAccountUser>(
    "SELECT id, email, display_name, avatar_url FROM users WHERE id = ANY($1::text[]) AND status = 'active'",
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

/**
 * Which of these sessions are still a usable session of an active account.
 * A session revoked elsewhere (from the sessions page, by a password change,
 * by an administrator) no longer holds a place in any browser.
 */
async function liveSessions(runtime: Runtime, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const result = await runtime.pool.query<{ id: string }>(
    "SELECT s.id FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ANY($1::text[]) AND s.expires_at > now() AND u.status = 'active'",
    [ids],
  );
  return new Set(result.rows.map((row) => row.id));
}

async function revokeSession(runtime: Runtime, sessionId: string): Promise<void> {
  // Grants cascade with the row, as on every other session revocation.
  await runtime.pool.query("DELETE FROM user_sessions WHERE id = $1", [sessionId]);
}

interface ValidEntry { entry: JarEntry; session: InspectedSession; user: BrowserAccountUser }

/**
 * The jar's entries that are still a usable session of an active account,
 * plus the cookies that drop the rest. A Better Auth cookie from before the
 * jar existed is read as one remembered-or-not entry.
 */
async function validEntries(runtime: Runtime, config: ServerConfig, request: FastifyRequest): Promise<{ valid: ValidEntry[]; clears: string[]; selector: string | null }> {
  const accounts = readBrowserAccounts(request);
  const candidates: Array<{ entry: JarEntry | null; token: string; remembered: boolean }> = accounts.legacy
    ? [{ entry: null, token: accounts.legacy.token, remembered: accounts.legacy.remembered }]
    : accounts.entries.map((entry) => ({ entry, token: entry.token, remembered: entry.remembered }));
  const sessions = await Promise.all(candidates.map((candidate) => inspectSession(runtime, config, candidate.token)));
  const users = await activeUsers(runtime, [...new Set(sessions.flatMap((session) => (session ? [session.userId] : [])))]);
  const valid: ValidEntry[] = [];
  const clears: string[] = [];
  candidates.forEach((candidate, index) => {
    const session = sessions[index];
    const user = session ? users.get(session.userId) : undefined;
    // A jar cookie must name its own session: one copied under another id is not that session.
    if (session && user && (!candidate.entry || candidate.entry.sessionId === session.sessionId)) {
      valid.push({ entry: candidate.entry ?? { sessionId: session.sessionId, token: candidate.token, remembered: candidate.remembered }, session, user });
    } else if (candidate.entry) {
      clears.push(clearJarCookie(config, candidate.entry.sessionId));
    }
  });
  const selector = accounts.legacy ? valid[0]?.entry.sessionId ?? null : accounts.selector;
  return { valid, clears, selector };
}

export type SettleMode = {
  /** An explicit "add account": past the limit it is refused instead of evicting the oldest entry. */
  add?: boolean;
  /** Reauthentication: a session for any other person is revoked and changes nothing in the browser. */
  requireUserId?: string | null;
  /** A rotation of the active session (password change, reauthentication) keeps its remember-me choice. */
  inheritRemember?: boolean;
  /**
   * The id of the active session this request proved before Better Auth
   * replaced it (a password change deletes it first). It and the request's
   * active token are grouped with the new session, so a logout that still
   * carries the old cookie revokes the new session too.
   */
  rotatedFrom?: string;
};
export type SettleResult = {
  setCookies: string[];
  refused?: "account_limit" | "account_mismatch" | "signed_out";
  userId?: string;
  /** The browser's account handle once these cookies apply: the new session's id. */
  accountHandle?: string;
};

function lifetimeFor(cookie: string, remembered: boolean): string {
  if (remembered || !isBetterAuthSessionCookie(cookie)) return cookie;
  return cookie.split(";").filter((part, index) => index === 0 || !/^\s*(max-age|expires)=/i.test(part)).join(";");
}

/**
 * Merges the session a Better Auth response issued into this browser's jar.
 *
 * - No new session: cookies pass through (state cookies, a refresh of the
 *   active session rewritten onto its own entry).
 * - A new session joins the jar and becomes active; a previous session of the
 *   same person is replaced (its cookie dropped, as a single-account sign-in
 *   replaced it); other people's entries stay. Better Auth's own cookie passes
 *   through for the clients that read it, but identity follows the selector.
 * - A refusal revokes the new session and leaves every cookie the browser had.
 *   A browser that signed out of a session this request carried refuses it,
 *   and the limit counts sessions already issued to the browser by requests
 *   still in flight, unless revoked since (`browserAccountLedger.ts`).
 */
export async function settleSessionCookies(runtime: Runtime, config: ServerConfig, request: FastifyRequest, setCookies: readonly string[], mode: SettleMode): Promise<SettleResult> {
  const issuedCookie = setCookies.find((cookie) => issuedSessionToken(cookie) !== null);
  if (!issuedCookie) return { setCookies: [...setCookies] };
  const issued = issuedSessionToken(issuedCookie)!;
  const accounts = readBrowserAccounts(request);
  const active = activeBrowserSession(request, accounts);
  const others = setCookies.filter((cookie) => !isBetterAuthSessionCookie(cookie) && !isBetterAuthDontRememberCookie(cookie));
  if (active && issued === active.token) {
    return { setCookies: [...others, ...refreshCookiesForBrowser(request, setCookies.filter(isBetterAuthSessionCookie))] };
  }
  const created = await inspectSession(runtime, config, issued);
  if (!created) return { setCookies: [...setCookies] };
  const refuse = async (refused: NonNullable<SettleResult["refused"]>): Promise<SettleResult> => {
    forgetIssued(created.sessionId);
    await revokeSession(runtime, created.sessionId);
    return { setCookies: others, refused };
  };
  const signedOut = () => endedFor(accounts.entries.map((entry) => entry.sessionId), browserSessionTokens(request));
  if (signedOut()) return refuse("signed_out");
  if (mode.requireUserId !== undefined && created.userId !== mode.requireUserId) return refuse("account_mismatch");

  const { valid, clears } = await validEntries(runtime, config, request);
  const validIds = valid.map((candidate) => candidate.session.sessionId);
  const rotated = mode.rotatedFrom && active ? { sessionIds: [mode.rotatedFrom], tokens: [active.token] } : { sessionIds: [], tokens: [] };
  const proven = { sessionIds: [...validIds, ...rotated.sessionIds], tokens: [...valid.map((candidate) => candidate.entry.token), ...rotated.tokens] };
  // Read before the step below; a session issued after this read is counted.
  const pending = issuedElsewhere(proven.sessionIds, proven.tokens).map((other) => other.sessionId);
  const live = await liveSessions(runtime, pending);
  const gone = new Set(pending.filter((id) => !live.has(id)));
  for (const id of gone) forgetIssued(id);
  // From here to `recordIssued` nothing awaits: a logout or another addition
  // for this browser lands entirely before or entirely after this check.
  if (signedOut()) return refuse("signed_out");
  // The choice the rotated session was made with, read from this request's
  // own cookie: Better Auth may already have deleted that session.
  const remembered = mode.inheritRemember && active ? active.remembered : issuedAsRemembered(issuedCookie);
  const kept = valid.filter((candidate) => candidate.session.userId !== created.userId && candidate.session.sessionId !== created.sessionId);
  const replaced = valid.filter((candidate) => !kept.includes(candidate) && accounts.entries.some((entry) => entry.sessionId === candidate.entry.sessionId));
  const inFlight = issuedElsewhere(proven.sessionIds, proven.tokens).filter((other) => other.sessionId !== created.sessionId && !gone.has(other.sessionId));
  const people = () => new Set([...kept, ...inFlight].map((other) => ("session" in other ? other.session.userId : other.userId)).filter((userId) => userId !== created.userId)).size;
  const evicted: ValidEntry[] = [];
  while (people() + 1 > BROWSER_ACCOUNT_LIMIT) {
    if (mode.add || !kept.length) return refuse("account_limit");
    kept.sort((left, right) => left.session.updatedAt - right.session.updatedAt);
    evicted.push(kept.shift()!);
  }
  recordIssued(proven.sessionIds, { sessionId: created.sessionId, userId: created.userId }, proven.tokens);
  for (const entry of evicted) {
    forgetIssued(entry.session.sessionId);
    await revokeSession(runtime, entry.session.sessionId);
  }
  const entry: JarEntry = { sessionId: created.sessionId, token: issued, remembered };
  const jarred = new Set(accounts.entries.map((candidate) => candidate.sessionId));
  return {
    userId: created.userId,
    accountHandle: created.sessionId,
    setCookies: [
      ...others,
      ...setCookies.filter((cookie) => isBetterAuthSessionCookie(cookie) || isBetterAuthDontRememberCookie(cookie)).map((cookie) => lifetimeFor(cookie, remembered)),
      ...clears,
      ...[...replaced, ...evicted].map((candidate) => clearJarCookie(config, candidate.entry.sessionId)),
      // A session from before the jar is written into it, so it can be switched back to.
      ...kept.filter((candidate) => !jarred.has(candidate.entry.sessionId)).map((candidate) => jarCookie(config, candidate.entry)),
      jarCookie(config, entry),
      selectorCookie(config, entry),
    ],
  };
}

/**
 * The ledger side of signing this browser out of every account: whatever was
 * issued to it by a request still in flight is revoked, and a sign-in or
 * rotation that began before now is refused when it settles. Call it before
 * the browser's own sessions are revoked, which it needs to verify.
 * A session rotated away (a password change) is found through the token the
 * browser still sends for it.
 */
export async function endBrowserAccounts(runtime: Runtime, config: ServerConfig, request: FastifyRequest): Promise<void> {
  const tokens = browserSessionTokens(request);
  // Marked before any await, so a settle that runs meanwhile already sees
  // it. A group found through a token is dropped here, so what it held is
  // revoked below with what the verified sessions find.
  const found = endBrowser([], tokens);
  const { valid } = await validEntries(runtime, config, request);
  const held = new Set(valid.map((candidate) => candidate.session.sessionId));
  // The browser's own sessions are left for the logout itself, which needs them verified.
  for (const sessionId of new Set([...found, ...endBrowser([...held], tokens)])) if (!held.has(sessionId)) await revokeSession(runtime, sessionId);
}

/**
 * The cookies that drop this browser's jar entries Better Auth no longer
 * accepts, for a response that found no signed-in account. A late response
 * can write back a session a logout already revoked; while its cookie stays,
 * every sign-in from this browser carries it and is refused as one that
 * began before the logout. Dropping only entries that can never be valid
 * again is safe whichever request lands first; the selector is left alone,
 * as a sign-in elsewhere may have set it since.
 */
export async function deadEntryClears(runtime: Runtime, config: ServerConfig, request: FastifyRequest): Promise<string[]> {
  return (await validEntries(runtime, config, request)).clears;
}

/**
 * Reads this request as the account the browser did select when a response
 * landing after a logout wrote back a session that logout revoked before the
 * browser held it (`lateSelectorRepair`): a password rotation's late answer
 * selects its new session, displacing the account selected since — by a
 * sign-in in another tab, say. The request's own cookies change: that
 * session's jar cookie and Better Auth's cookie carrying it are dropped,
 * and the selector, while it names that session, becomes the session the
 * browser selected most recently since the logout if the ledger proves it
 * is (no newer selection since in any group born after the logout) and its
 * entry is still in the jar, or none (never an earlier selection among the
 * entries left; the person signs in again, keeping them). The request is
 * then judged with those cookies (a tab of the account selected since is
 * not refused as stale; nothing it settles carries the revoked session).
 *
 * The response only clears that revoked session's own jar cookie, which
 * no later response can make valid again, so it is right in whatever order
 * the browser applies it. It never writes the selector or Better Auth's
 * shared cookie: a response of an earlier request can land after a sign-in,
 * switch or logout that replaced them and would undo it. The browser keeps
 * the written-back selector until one of those replaces it, and every
 * request until then is read this way; the ledger mark keyed by the id it
 * names recognizes it with or without the jar cookie. Cookie and ledger
 * reads only. Returns the cookies for the response.
 */
const selectorDropped = new WeakSet<FastifyRequest>();
/** Whether the browser sent a selector this request is read without (`repairLateSelector`). */
function rawSelectorSent(request: FastifyRequest): boolean { return selectorDropped.has(request); }

export function repairLateSelector(config: ServerConfig, request: FastifyRequest): string[] {
  const accounts = readBrowserAccounts(request);
  const repair = lateSelectorRepair(accounts.selector, accounts.entries.map((entry) => entry.sessionId));
  const late = accounts.entries.filter((entry) => revokedLate(entry.sessionId));
  if (!repair && !late.length) return [];
  const lateIds = new Set(late.map((entry) => entry.sessionId));
  const lateTokens = new Set(late.map((entry) => entry.token));
  const header = request.headers.cookie;
  const raw: string = (Array.isArray(header) ? header[0] : header) ?? "";
  const kept = raw.split(";").map((part) => part.trim()).filter((part) => {
    const name = part.slice(0, Math.max(0, part.indexOf("="))).trim();
    if (name.startsWith(ACCOUNT_JAR_PREFIX) && lateIds.has(name.slice(ACCOUNT_JAR_PREFIX.length))) return false;
    if (repair && name === ACCOUNT_SELECTOR_COOKIE) return false;
    if (isBetterAuthSessionCookie(part)) {
      // A browser with a selector is never read through Better Auth's cookie;
      // without one after this repair it must not fall back to it either.
      if (repair) return false;
      let value: string | null;
      try { value = decodeURIComponent(part.slice(part.indexOf("=") + 1)); } catch { value = null; }
      if (value !== null && lateTokens.has(value)) return false;
    }
    return Boolean(part);
  });
  if (repair?.to) kept.push(`${ACCOUNT_SELECTOR_COOKIE}=${repair.to}`);
  else if (repair) selectorDropped.add(request);
  request.headers.cookie = kept.join("; ");
  return late.map((entry) => clearJarCookie(config, entry.sessionId));
}

/** Whether one more account would pass the browser's limit. Read-only. */
export async function browserAccountsFull(runtime: Runtime, config: ServerConfig, request: FastifyRequest): Promise<boolean> {
  const { valid } = await validEntries(runtime, config, request);
  return valid.length >= BROWSER_ACCOUNT_LIMIT;
}

/** Every session token this browser holds, for signing all of them out. */
export function browserSessionTokens(request: FastifyRequest): string[] {
  const accounts = readBrowserAccounts(request);
  return [...new Set([...accounts.entries.map((entry) => entry.token), ...(accounts.legacy ? [accounts.legacy.token] : [])])];
}

/** The cookies that remove every jar entry and the selector. */
export function browserAccountClears(config: ServerConfig, request: FastifyRequest): string[] {
  const accounts = readBrowserAccounts(request);
  return [
    ...accounts.entries.map((entry) => clearJarCookie(config, entry.sessionId)),
    // Also when this request was read without it (`repairLateSelector`): the browser still sends one.
    ...(accounts.selector || accounts.entries.length || rawSelectorSent(request) ? [clearSelectorCookie(config)] : []),
    authCookieHeader(config, { name: ACCOUNT_ADD_COOKIE, value: "", maxAgeSeconds: 0 }),
  ];
}

function accountView(candidate: ValidEntry, selector: string | null) {
  return {
    user_id: candidate.user.id,
    email: candidate.user.email,
    display_name: candidate.user.display_name,
    avatar_url: candidate.user.avatar_url,
    active: candidate.entry.sessionId === selector,
    remembered: candidate.entry.remembered,
  };
}

export function registerBrowserAccountRoutes(app: FastifyInstance, config: ServerConfig, runtime: Runtime | null): void {
  /** The accounts this browser can switch to. Names people, never sessions or tokens; drops entries that stopped being valid. */
  app.get("/api/v1/auth/browser-accounts", async (request, reply) => {
    if (!runtime) return reply.code(503).send({ code: "auth_unavailable", message: "Authentication is unavailable" });
    const { valid, clears, selector } = await validEntries(runtime, config, request);
    if (clears.length) reply.header("set-cookie", clears);
    reply.header("cache-control", "no-store");
    if (!valid.some((candidate) => candidate.entry.sessionId === selector)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    return reply.send({ accounts: valid.map((candidate) => accountView(candidate, selector)), limit: BROWSER_ACCOUNT_LIMIT });
  });

  /**
   * Makes another of this browser's accounts the active one for every tab.
   * Only the selector changes: no session is created, refreshed or revoked,
   * and the previous account stays signed in to switch back to.
   */
  app.post("/api/v1/auth/browser-accounts/switch", async (request, reply) => {
    if (!runtime) return reply.code(503).send({ code: "auth_unavailable", message: "Authentication is unavailable" });
    const input = request.body instanceof Buffer && request.body.length ? (() => { try { return JSON.parse(request.body.toString("utf8")) as Record<string, unknown>; } catch { return {}; } })() : {};
    const userId = typeof input.user_id === "string" ? input.user_id : "";
    const { valid, clears, selector } = await validEntries(runtime, config, request);
    if (!valid.some((candidate) => candidate.entry.sessionId === selector)) {
      if (clears.length) reply.header("set-cookie", clears);
      return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    }
    const target = valid.find((candidate) => candidate.user.id === userId);
    if (!target) {
      if (clears.length) reply.header("set-cookie", clears);
      return reply.code(404).send({ code: "account_unavailable", message: "That account is no longer signed in on this browser" });
    }
    const jarred = readBrowserAccounts(request).entries.some((entry) => entry.sessionId === target.entry.sessionId);
    noteSelected(valid.map((candidate) => candidate.session.sessionId), target.entry.sessionId, valid.map((candidate) => candidate.entry.token));
    reply.header("set-cookie", [
      ...clears,
      ...(jarred ? [] : [jarCookie(config, target.entry)]),
      selectorCookie(config, target.entry),
      // A recent-authentication grant belongs to the account it was proven for.
      authCookieHeader(config, { name: "rainver.reauth", value: "", maxAgeSeconds: 0 }),
    ]);
    return reply.send({ ok: true, account_handle: target.entry.sessionId });
  });
}
