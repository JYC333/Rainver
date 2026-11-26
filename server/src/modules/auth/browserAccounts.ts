import type { FastifyRequest } from "fastify";
import { getSessionCookie } from "better-auth/cookies";
import type { ServerConfig } from "../../config.js";
import { authCookieHeader } from "./authCookie.js";

/**
 * The accounts one browser is signed in to, held only in HttpOnly cookies.
 *
 * Better Auth's official multi-session plugin was evaluated and not used: its
 * account list hands the raw session token to page script, it needs that raw
 * token to switch (the hashing adapter keeps only digests, so after a restart
 * it cannot switch back), and its per-account cookie is persistent even for a
 * sign-in that asked not to be remembered.
 *
 * Instead every session this browser holds is one jar cookie named by its
 * server-owned session id, carrying Better Auth's own signed cookie value and
 * whether it is remembered. A separate selector cookie names the active one.
 * Identity follows the selector, never the most recent Better Auth cookie, so
 * a sliding-window refresh that arrives late — it rewrites only its own jar
 * entry — cannot switch the browser back. A browser that has never had a jar
 * (signed in before this existed) keeps using Better Auth's cookie alone.
 */
export const ACCOUNT_SELECTOR_COOKIE = "rainver.active_account";
export const ACCOUNT_JAR_PREFIX = "rainver.account_";
/** Set by an explicit "add account" Google start; the callback refuses past the limit instead of evicting. */
export const ACCOUNT_ADD_COOKIE = "rainver.account_add";
export const BROWSER_ACCOUNT_LIMIT = 5;
/** The account handle of a browser that has no selector (one account, pre-jar). */
export const LEGACY_ACCOUNT_HANDLE = "-";
/** A tab names the account it was loaded for; a request from any other account's tab is refused. */
export const ACCOUNT_HEADER = "x-rainver-account";
/** Long enough for any session; the jar entry, not the selector, decides whether the session is valid. */
const SELECTOR_MAX_AGE = 400 * 86_400;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BETTER_AUTH_SESSION = /^(?:__Secure-)?better-auth\.session_token$/;
const BETTER_AUTH_DONT_REMEMBER = /^(?:__Secure-)?better-auth\.dont_remember$/;

export interface JarEntry { sessionId: string; token: string; remembered: boolean }
export interface BrowserAccounts {
  selector: string | null;
  entries: JarEntry[];
  /** Better Auth's own cookie, only when there is no jar at all. */
  legacy: { token: string; remembered: boolean } | null;
}
export interface ActiveBrowserSession { token: string; remembered: boolean; handle: string; entry: JarEntry | null }

function cookieHeaderOf(request: Pick<FastifyRequest, "headers">): string {
  const header = request.headers.cookie;
  return (Array.isArray(header) ? header[0] : header) ?? "";
}

/** Name → raw (still encoded) value, first occurrence wins as browsers send the most specific first. */
function rawCookies(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

function decode(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}

function jarValue(entry: Pick<JarEntry, "token" | "remembered">): string {
  return `${entry.remembered ? "r" : "e"}.${encodeURIComponent(entry.token)}`;
}

function parseJarValue(value: string): Pick<JarEntry, "token" | "remembered"> | null {
  const flag = value[0];
  if ((flag !== "r" && flag !== "e") || value[1] !== ".") return null;
  const token = decode(value.slice(2));
  return token ? { token, remembered: flag === "r" } : null;
}

export function readBrowserAccounts(request: Pick<FastifyRequest, "headers">): BrowserAccounts {
  const header = cookieHeaderOf(request);
  const cookies = rawCookies(header);
  const entries: JarEntry[] = [];
  for (const [name, value] of cookies) {
    if (!name.startsWith(ACCOUNT_JAR_PREFIX)) continue;
    const sessionId = name.slice(ACCOUNT_JAR_PREFIX.length);
    const parsed = SESSION_ID.test(sessionId) ? parseJarValue(value) : null;
    if (parsed) entries.push({ sessionId, ...parsed });
  }
  const rawSelector = cookies.get(ACCOUNT_SELECTOR_COOKIE);
  const selector = rawSelector && SESSION_ID.test(rawSelector) ? rawSelector : null;
  let legacy: BrowserAccounts["legacy"] = null;
  if (!selector && entries.length === 0 && header) {
    const token = getSessionCookie(new Headers({ cookie: header }));
    if (token) legacy = { token, remembered: ![...cookies.keys()].some((name) => BETTER_AUTH_DONT_REMEMBER.test(name) && cookies.get(name)) };
  }
  return { selector, entries, legacy };
}

/**
 * The session this request acts as. With a jar it is the selected entry or
 * none — never a fallback to whatever Better Auth cookie is also present.
 */
export function activeBrowserSession(request: Pick<FastifyRequest, "headers">, accounts = readBrowserAccounts(request)): ActiveBrowserSession | null {
  if (accounts.legacy) return { ...accounts.legacy, handle: LEGACY_ACCOUNT_HANDLE, entry: null };
  if (!accounts.selector) return null;
  const entry = accounts.entries.find((candidate) => candidate.sessionId === accounts.selector);
  return entry ? { token: entry.token, remembered: entry.remembered, handle: entry.sessionId, entry } : null;
}

/** The handle a tab loaded for this browser state carries: the selected session id, or `-`. */
export function browserAccountHandle(request: Pick<FastifyRequest, "headers">): string {
  return readBrowserAccounts(request).selector ?? LEGACY_ACCOUNT_HANDLE;
}

/**
 * A tab that names an account other than the browser's current one is stale:
 * another tab switched or added an account. Its request must not run as the
 * new identity. Cookie comparison only; no database read.
 */
export function staleAccountTab(request: Pick<FastifyRequest, "headers">): boolean {
  const header = request.headers[ACCOUNT_HEADER];
  const expected = Array.isArray(header) ? header[0] : header;
  if (expected === undefined) return false;
  return expected !== browserAccountHandle(request);
}

function setCookieName(cookie: string): string { return cookie.slice(0, Math.max(0, cookie.indexOf("="))).trim(); }
function setCookieValue(cookie: string): string {
  const start = cookie.indexOf("=") + 1;
  const end = cookie.indexOf(";", start);
  return cookie.slice(start, end < 0 ? undefined : end).trim();
}
function setCookieAttributes(cookie: string): string {
  const index = cookie.indexOf(";");
  return index < 0 ? "" : cookie.slice(index);
}
function clearsCookie(cookie: string): boolean {
  return setCookieValue(cookie) === "" || /;\s*max-age=0(?:;|$)/i.test(cookie);
}
export function isBetterAuthSessionCookie(cookie: string): boolean { return BETTER_AUTH_SESSION.test(setCookieName(cookie)); }
export function isBetterAuthDontRememberCookie(cookie: string): boolean { return BETTER_AUTH_DONT_REMEMBER.test(setCookieName(cookie)); }

/** The signed session token a Better Auth `Set-Cookie` issues, or null when it clears the cookie. */
export function issuedSessionToken(cookie: string): string | null {
  if (!isBetterAuthSessionCookie(cookie) || clearsCookie(cookie)) return null;
  return decode(setCookieValue(cookie));
}
export function issuedAsRemembered(cookie: string): boolean { return /;\s*max-age=[1-9]/i.test(cookie); }

function withoutLifetime(attributes: string): string {
  return attributes.split(";").filter((part) => !/^\s*(max-age|expires)=/i.test(part)).join(";");
}

/**
 * Better Auth's refresh of `entry`, carried onto the entry's own jar cookie
 * with Better Auth's attributes. An entry that is not remembered keeps no
 * lifetime: the refresh never makes it outlive the browser session.
 */
function jarCookieFromRefresh(cookie: string, entry: JarEntry): string {
  const attributes = entry.remembered ? setCookieAttributes(cookie) : withoutLifetime(setCookieAttributes(cookie));
  return `${ACCOUNT_JAR_PREFIX}${entry.sessionId}=${jarValue(entry)}${attributes}`;
}

/**
 * Rewrites the cookies Better Auth set while validating this request's
 * session (its sliding-window refresh) for the browser. With a jar the
 * refresh lands only on the active entry's own cookie; Better Auth's cookie
 * and the selector are never touched, so a response that arrives after a
 * switch refreshes its own account and switches nothing.
 */
export function refreshCookiesForBrowser(request: Pick<FastifyRequest, "headers">, setCookies: readonly string[]): string[] {
  if (!setCookies.length) return [];
  const accounts = readBrowserAccounts(request);
  const active = activeBrowserSession(request, accounts);
  if (accounts.legacy) {
    // A sign-in that asked not to be remembered stays a browser-session cookie.
    return setCookies.map((cookie) => (isBetterAuthSessionCookie(cookie) && !accounts.legacy!.remembered
      ? `${setCookieName(cookie)}=${setCookieValue(cookie)}${withoutLifetime(setCookieAttributes(cookie))}`
      : cookie));
  }
  if (!active?.entry) return [];
  return setCookies.flatMap((cookie) => (issuedSessionToken(cookie) === active.token ? [jarCookieFromRefresh(cookie, active.entry!)] : []));
}

/** The Cookie header Better Auth receives: Better Auth's own cookie names the active session, and nothing of the jar. */
export function betterAuthCookieHeader(request: Pick<FastifyRequest, "headers">, sessionCookieName: string): string {
  const header = cookieHeaderOf(request);
  const accounts = readBrowserAccounts(request);
  if (accounts.legacy || (!accounts.selector && accounts.entries.length === 0)) return header;
  const active = activeBrowserSession(request, accounts);
  const kept = header.split(";").map((part) => part.trim()).filter((part) => {
    const name = part.slice(0, Math.max(0, part.indexOf("="))).trim();
    return part && name !== ACCOUNT_SELECTOR_COOKIE && !name.startsWith(ACCOUNT_JAR_PREFIX)
      && !BETTER_AUTH_SESSION.test(name) && !BETTER_AUTH_DONT_REMEMBER.test(name);
  });
  if (active) kept.push(`${sessionCookieName}=${encodeURIComponent(active.token)}`);
  return kept.join("; ");
}

export function jarCookie(config: ServerConfig, entry: JarEntry): string {
  return authCookieHeader(config, { name: `${ACCOUNT_JAR_PREFIX}${entry.sessionId}`, value: jarValue(entry), maxAgeSeconds: entry.remembered ? config.sessionExpireDays * 86_400 : null, encoded: true });
}
export function clearJarCookie(config: ServerConfig, sessionId: string): string {
  return authCookieHeader(config, { name: `${ACCOUNT_JAR_PREFIX}${sessionId}`, value: "", maxAgeSeconds: 0 });
}
/** The selector lives as long as the session it names would; an unremembered one ends with the browser session. */
export function selectorCookie(config: ServerConfig, entry: JarEntry): string {
  return authCookieHeader(config, { name: ACCOUNT_SELECTOR_COOKIE, value: entry.sessionId, maxAgeSeconds: entry.remembered ? SELECTOR_MAX_AGE : null });
}
export function clearSelectorCookie(config: ServerConfig): string {
  return authCookieHeader(config, { name: ACCOUNT_SELECTOR_COOKIE, value: "", maxAgeSeconds: 0 });
}
