import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import { InstanceInvitationCreateSchema } from "@rainver/protocol";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { PASSWORD_MAX_LENGTH, assertPasswordPolicy, hashOpaqueToken, normalizeAuthEmail, passwordMinimumLength } from "./securityPolicy.js";
import { googleAuthConfigured } from "./betterAuth.js";
import { authRepositoryFromConfig, createAuthRuntime, introspectIdentity, sessionCookieName, sessionRefreshSink, sessionTokenFromRequest, setAuthRuntimeForComposition, type AuthFailure } from "./identity.js";
import { REGISTRATION_DISPLAY_NAME_MAX, RegistrationService } from "./registration.js";
import { recordAuthSecurityEvent } from "./securityEvents.js";
import { consumeManualResetLink } from "./recovery.js";
import { clearReauthCookie, consumeReauthGrant, issueReauthGrant, reauthGrantExpiresAt, revokeSessionReauthGrants, type ReauthOperation } from "./reauth.js";
import { withTransaction } from "../../db/tx.js";
import { guardedHibpRangeTransport, isPasswordCompromised, type HibpRangeTransport } from "./hibp.js";
import { consumeGoogleReauth, issueGoogleReauth, markGoogleReauthVerified, peekGoogleReauth } from "./googleReauth.js";
import { authCookieHeader } from "./authCookie.js";
import { createCookieGetter, getCookies } from "better-auth/cookies";
import { ACCOUNT_ADD_COOKIE, betterAuthCookieHeader, browserAccountHandle } from "./browserAccounts.js";
import { browserAccountClears, browserAccountsFull, browserSessionTokens, deadEntryClears, endBrowserAccounts, registerBrowserAccountRoutes, settleSessionCookies, type SettleMode } from "./browserAccountSessions.js";

type LoginLimit = { failures: number; blockedUntil: number; lastSeen: number };
const loginLimits = new Map<string, LoginLimit>();
const LOGIN_LIMIT_MAX = 2048;

function clientIp(request: FastifyRequest): string {
  return typeof request.ip === "string" ? request.ip.slice(0, 128) : "unknown";
}

function loginLimitKey(ip: string, email: string): string { return `${ip}\u0000${email}`; }

function pruneLoginLimits(now: number): void {
  for (const [key, value] of loginLimits) if (value.lastSeen + 15 * 60_000 < now) loginLimits.delete(key);
  while (loginLimits.size > LOGIN_LIMIT_MAX) {
    const first = loginLimits.keys().next().value;
    if (typeof first !== "string") break;
    loginLimits.delete(first);
  }
}

function loginThrottle(key: string): number {
  const now = Date.now(); pruneLoginLimits(now);
  const value = loginLimits.get(key);
  if (!value) return 0;
  value.lastSeen = now;
  return Math.max(0, value.blockedUntil - now);
}

function loginFailure(key: string): number {
  const now = Date.now(); pruneLoginLimits(now);
  const value = loginLimits.get(key) ?? { failures: 0, blockedUntil: 0, lastSeen: now };
  value.failures = Math.min(value.failures + 1, 8);
  value.blockedUntil = now + Math.min(30_000, 250 * (2 ** (value.failures - 1)));
  value.lastSeen = now; loginLimits.set(key, value);
  return value.blockedUntil - now;
}

function loginSuccess(key: string): void { loginLimits.delete(key); }

function authSetCookies(headers: Headers): string[] {
  const cookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  return cookies?.length ? cookies : headers.get("set-cookie") ? [headers.get("set-cookie")!] : [];
}

async function sendAuthResult(reply: FastifyReply, result: { status: number; body: Record<string, unknown>; headers: Headers }, cookies: readonly string[] = authSetCookies(result.headers), extra: Record<string, unknown> = {}): Promise<void> {
  const setCookie = [...cookies];
  if (setCookie.length) reply.header("set-cookie", setCookie);
  if (result.status === 204) { reply.code(204).send(); return; }
  // Better Auth answers sign-in and change-password with the raw session
  // token in the body as well as in the HttpOnly cookie. The browser needs
  // only the cookie; handing the token to page script defeats HttpOnly.
  reply.code(result.status).send({ ok: true, ...(result.body.user !== undefined ? { user: result.body.user } : {}), ...extra });
}

function body(request: FastifyRequest): Record<string, unknown> {
  if (!(request.body instanceof Buffer) || request.body.length === 0) return {};
  try {
    const parsed = JSON.parse(request.body.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
function query(request: FastifyRequest): Record<string, unknown> { return (request.query ?? {}) as Record<string, unknown> }
function isFailure(value: unknown): value is AuthFailure { return Boolean(value && typeof value === "object" && "statusCode" in value) }
function safeNext(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value : "/home";
}
function safeFrontendUrl(config: ModuleContext["config"], value: string): string {
  const base = config.frontendUrl.replace(/\/$/, "");
  return value.startsWith(`${base}/`) ? value : `${base}/home`;
}
/** Back where an account addition started, with the reason it did not happen. */
function addAccountErrorUrl(url: string, error: string): string {
  const target = new URL(url);
  target.searchParams.set("error", error);
  return target.toString();
}
function runtimeOrError(context: ModuleContext, reply: FastifyReply): ModuleContext["authRuntime"] | null {
  if (context.authRuntime) return context.authRuntime;
  reply.code(503).send({ code: "auth_unavailable", message: "Authentication is unavailable" });
  return null;
}

async function currentUser(context: ModuleContext, request: FastifyRequest, reply: FastifyReply): Promise<Awaited<ReturnType<NonNullable<ModuleContext["authRuntime"]>["repository"]["getCurrentUser"]>> | null> {
  const repository = authRepositoryFromConfig(context.config);
  if (!repository) return null;
  return repository.getCurrentUser(sessionTokenFromRequest(request), sessionRefreshSink(reply));
}

/** The person and the session behind this request, for anything bound to the session itself. */
async function currentSession(context: ModuleContext, request: FastifyRequest, reply: FastifyReply): Promise<{ id: string; user_id: string } | null> {
  const repository = authRepositoryFromConfig(context.config);
  if (!repository?.currentSession) return null;
  return repository.currentSession(sessionTokenFromRequest(request), sessionRefreshSink(reply));
}

/**
 * Spends the request's recent-authentication grant on `operation`, answering
 * 403 `reauthentication_required` when there is none live for this person at
 * this session. Run inside the mutation's transaction where the mutation is
 * local (`db` is the transaction client), and before a mutation Better Auth
 * performs itself.
 */
async function spendReauthGrant(
  db: Parameters<typeof consumeReauthGrant>[0],
  request: FastifyRequest,
  reply: FastifyReply,
  session: { id: string; user_id: string },
  operation: ReauthOperation,
): Promise<boolean> {
  if (await consumeReauthGrant(db, request, { userId: session.user_id, sessionId: session.id, operation })) return true;
  reply.code(403).send({ code: "reauthentication_required", message: "Recent reauthentication required" });
  return false;
}

function routeParams(request: FastifyRequest): Record<string, unknown> { return (request.params ?? {}) as Record<string, unknown>; }
function requestCookie(request: FastifyRequest, name: string): string | null {
  const header = Array.isArray(request.headers.cookie) ? request.headers.cookie[0] : request.headers.cookie;
  for (const raw of (header ?? "").split(";")) {
    const [key, ...value] = raw.trim().split("=");
    if (key !== name || value.length === 0) continue;
    try { return decodeURIComponent(value.join("=")); } catch { return value.join("="); }
  }
  return null;
}

function genericAuthFailure(reply: FastifyReply, status = 400): FastifyReply {
  return reply.code(status).send({ code: "operation_unavailable", message: "The authentication operation could not be completed" });
}

let hibpTransportOverride: HibpRangeTransport | null = null;
/** Test seam: the range check answers from this transport instead of the network. */
export function __setHibpTransportForTests(transport: HibpRangeTransport | null): void {
  hibpTransportOverride = transport;
}

async function passwordAllowed(runtime: NonNullable<ModuleContext["authRuntime"]>, request: FastifyRequest, password: string): Promise<boolean> {
  if (process.env.RAINVER_HIBP_DISABLED === "1") return true;
  try {
    if (await isPasswordCompromised(password, hibpTransportOverride ?? guardedHibpRangeTransport())) {
      await recordAuthSecurityEvent(runtime.pool, { eventType: "password_compromised", outcome: "failure", requestId: resolveRequestId(request), sourceIp: clientIp(request), details: { route: request.url, reason_code: "hibp_match" } }).catch(() => {});
      return false;
    }
  } catch {
    await recordAuthSecurityEvent(runtime.pool, { eventType: "password_compromise_check", outcome: "degraded", requestId: resolveRequestId(request), sourceIp: clientIp(request), details: { route: request.url, degraded_dependency: "hibp" } }).catch(() => {});
  }
  return true;
}

/**
 * Better Auth reads the client address from `x-forwarded-for` for its
 * per-IP rate limit and the session's recorded `ip_address`. The inbound
 * header is client-controlled (nginx appends to it rather than replacing
 * it), so the internal request carries only the address Fastify resolved
 * through the trusted-proxy policy.
 */
function setClientAddress(headers: Headers, request: FastifyRequest): void {
  headers.delete("x-real-ip");
  headers.set("x-forwarded-for", request.ip);
}

/**
 * Better Auth sees the browser's *selected* account as its own session cookie
 * and none of the account jar, so sign-out, password change and linking act
 * on the account the request is acting as.
 */
function setBetterAuthCookie(runtime: NonNullable<ModuleContext["authRuntime"]>, headers: Headers, request: FastifyRequest): void {
  const cookie = betterAuthCookieHeader(request, getCookies(runtime.auth.options).sessionToken.name);
  if (cookie) headers.set("cookie", cookie); else headers.delete("cookie");
}

type ForwardSettle = (response: Response, setCookies: string[]) => Promise<{ setCookies: string[]; location?: string }>;
async function forwardBetterAuth(runtime: NonNullable<ModuleContext["authRuntime"]>, request: FastifyRequest, reply: FastifyReply, path: string, method = request.method, overrideBody?: Record<string, unknown>, onResponse?: (response: Response) => void, extraSetCookies: readonly string[] = [], settle?: ForwardSettle): Promise<void> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined && key.toLowerCase() !== "content-length") headers.set(key, Array.isArray(value) ? value[0]! : value);
  }
  setClientAddress(headers, request);
  setBetterAuthCookie(runtime, headers, request);
  const payload = overrideBody ?? (request.body as Record<string, unknown> | undefined);
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (payload !== undefined && method !== "GET" && method !== "HEAD") { headers.set("content-type", "application/json"); init.body = JSON.stringify(payload) }
  const response = await runtime.auth.handler(new Request(`${runtime.auth.options.baseURL}${runtime.auth.options.basePath}${path}`, init));
  onResponse?.(response);
  reply.code(response.status);
  const settled = settle ? await settle(response, authSetCookies(response.headers)) : { setCookies: authSetCookies(response.headers) };
  const setCookie = [...settled.setCookies, ...extraSetCookies];
  if (setCookie.length) reply.header("set-cookie", setCookie);
  const contentType = response.headers.get("content-type"); if (contentType) reply.header("content-type", contentType);
  const location = settled.location ?? response.headers.get("location"); if (location) reply.header("location", location);
  if (response.status === 204) { reply.send(); return }
  reply.send(Buffer.from(await response.arrayBuffer()));
}

async function authResponse(runtime: NonNullable<ModuleContext["authRuntime"]>, request: FastifyRequest, path: string, bodyValue?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value[0]! : value);
  setClientAddress(headers, request);
  setBetterAuthCookie(runtime, headers, request);
  headers.set("content-type", "application/json");
  const response = await runtime.auth.handler(new Request(`${runtime.auth.options.baseURL}${runtime.auth.options.basePath}${path}`, { method: "POST", headers, body: JSON.stringify(bodyValue ?? body(request)) }));
  let parsed: Record<string, unknown> = {};
  try { parsed = await response.json() as Record<string, unknown> } catch { /* generic response */ }
  return { status: response.status, body: parsed, headers: response.headers };
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/auth/admin/users/:userId/disable',operation:'auth.user.disable',admission:'person',params:{userId:'user_id'}},
    {method:'POST',url:'/api/v1/auth/admin/users/:userId/enable',operation:'auth.user.enable',admission:'person',params:{userId:'user_id'}},
  ]);
  const runtime = context.authRuntime ?? createAuthRuntime(context.config);
  if (runtime && !context.authRuntime) setAuthRuntimeForComposition(runtime);
  const registration = runtime ? new RegistrationService(runtime.pool, context.config) : null;
  const minimumPasswordLength = passwordMinimumLength(context.config.rainverEnv);
  registerBrowserAccountRoutes(app, context.config, runtime);

  app.get("/api/v1/auth/config", async (_request, reply) => {
    let bootstrapRegistrationAvailable = false;
    try {
      bootstrapRegistrationAvailable = await registration?.isBootstrapAvailable() ?? false;
    } catch {
      // Fail closed when the identity store is unavailable.
    }
    return reply.send({
      google_auth_available: googleAuthConfigured(context.config),
      bootstrap_registration_available: bootstrapRegistrationAvailable,
      password_min_length: minimumPasswordLength,
      password_max_length: PASSWORD_MAX_LENGTH,
    });
  });

  app.post("/api/v1/auth/sign-in/email", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const input = body(request); const email = typeof input.email === "string" ? input.email : ""; const password = typeof input.password === "string" ? input.password : "";
    let normalizedEmail: string;
    try { normalizedEmail = normalizeAuthEmail(email); assertPasswordPolicy(password, minimumPasswordLength) } catch { return reply.code(401).send({ code: "invalid_credentials", message: "Invalid email or password" }) }
    const key = loginLimitKey(clientIp(request), normalizedEmail);
    const blockedFor = loginThrottle(key);
    if (blockedFor > 0) {
      if (runtime.pool) await recordAuthSecurityEvent(runtime.pool, { eventType: "password_login", outcome: "throttled", requestId: resolveRequestId(request), sourceIp: clientIp(request), details: { route: "/auth/sign-in/email", retry_after_seconds: Math.ceil(blockedFor / 1000) } }).catch(() => {});
      return reply.code(429).send({ code: "invalid_credentials", message: "Invalid email or password" });
    }
    const result = await authResponse(runtime, request, "/sign-in/email", { email: normalizedEmail, password, rememberMe: input.rememberMe === true });
    if (result.status >= 400) {
      const delay = loginFailure(key);
      await recordAuthSecurityEvent(runtime.pool, { eventType: "password_login", outcome: "failure", requestId: resolveRequestId(request), sourceIp: clientIp(request), details: { route: "/auth/sign-in/email", email_domain: normalizedEmail.split("@").pop() ?? "", retry_after_seconds: Math.ceil(delay / 1000) } }).catch(() => {});
      return reply.code(result.status === 429 ? 429 : 401).send({ code: "invalid_credentials", message: "Invalid email or password" });
    }
    loginSuccess(key);
    await recordAuthSecurityEvent(runtime.pool, { eventType: "password_login", outcome: "success", requestId: resolveRequestId(request), sourceIp: clientIp(request), details: { route: "/auth/sign-in/email", email_domain: normalizedEmail.split("@").pop() ?? "" } }).catch(() => {});
    // The new session joins this browser's accounts; the ones already signed in stay.
    const settled = await settleSessionCookies(runtime, context.config, request, authSetCookies(result.headers), { add: input.add_account === true });
    if (settled.refused === "signed_out") return reply.code(409).send({ code: "signed_out", message: "This browser signed out while signing in; sign in again" });
    if (settled.refused) return reply.code(409).send({ code: "account_limit", message: "This browser is signed in to as many accounts as it can hold" });
    // The tab that signed in acts as the new session from its next request.
    return sendAuthResult(reply, result, settled.setCookies, settled.accountHandle ? { account_handle: settled.accountHandle } : {});
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (!runtime) {
      const repository = authRepositoryFromConfig(context.config);
      if (!repository) return runtimeOrError(context, reply);
      await repository.logout(sessionTokenFromRequest(request));
      reply.header("set-cookie", [
        authCookieHeader(context.config, { name: sessionCookieName(context.config), value: "", maxAgeSeconds: 0 }),
        authCookieHeader(context.config, { name: "rainver.reauth", value: "", maxAgeSeconds: 0 }),
      ]);
      return reply.code(204).send();
    }
    // First, before anything awaits: a sign-in, addition or password rotation
    // still in flight for this browser is revoked or refused when it settles,
    // so its late response cannot sign the browser back in.
    await endBrowserAccounts(runtime, context.config, request);
    // The grant goes with the session: revoked here before Better Auth
    // deletes the session row, and its cookie cleared beside the session's.
    const session = await currentSession(context, request, reply);
    if (session) await revokeSessionReauthGrants(runtime.pool, session.id);
    // Signing out signs this browser out of every account it holds: each
    // other session is revoked as logout revokes one, then Better Auth ends
    // the active one and every jar cookie is cleared with its own.
    const active = sessionTokenFromRequest(request);
    for (const token of browserSessionTokens(request)) if (token !== active) await runtime.repository.logout(token);
    return forwardBetterAuth(runtime, request, reply, "/sign-out", "POST", {}, undefined, [
      authCookieHeader(context.config, { name: "rainver.reauth", value: "", maxAgeSeconds: 0 }),
      ...browserAccountClears(context.config, request),
      // A Google sign-in or addition begun before this logout fails its callback.
      authCookieHeader(context.config, { name: createCookieGetter(runtime.auth.options)("state").name, value: "", maxAgeSeconds: 0 }),
    ]);
  });

  app.get("/api/v1/auth/google", async (request, reply) => {
    if (!runtime || !googleAuthConfigured(context.config)) return reply.code(501).send({ code: "google_unavailable", message: "Google OAuth is not configured" });
    const next = safeNext(query(request).next);
    const callbackURL = `${context.config.frontendUrl.replace(/\/$/, "")}${next}`;
    // Adding an account returns to the page it started from on failure or
    // cancellation, still signed in as before; it never lands on Login.
    const adding = query(request).add_account === "1";
    if (adding && await browserAccountsFull(runtime, context.config, request)) return reply.redirect(addAccountErrorUrl(callbackURL, "account_limit"), 303);
    const result = await authResponse(runtime, request, "/sign-in/social", { provider: "google", callbackURL, ...(adding ? { errorCallbackURL: callbackURL } : {}) });
    if (result.status >= 400 || typeof result.body.url !== "string") return reply.code(502).send({ code: "google_unavailable", message: "Google OAuth is unavailable" });
    const setCookie = authSetCookies(result.headers);
    reply.header("set-cookie", [
      ...setCookie,
      authCookieHeader(context.config, { name: ACCOUNT_ADD_COOKIE, value: adding ? callbackURL : "", maxAgeSeconds: adding ? 600 : 0 }),
    ]);
    return reply.redirect(result.body.url, 307);
  });
  app.post("/api/v1/auth/register/google", async (request, reply) => {
    if (!runtime || !registration || !googleAuthConfigured(context.config)) return reply.code(501).send({ code: "google_unavailable", message: "Google OAuth is not configured" });
    const input = body(request); const intentId = typeof input.intent_id === "string" ? input.intent_id : ""; const claimSecret = typeof input.claim_secret === "string" ? input.claim_secret : "";
    const check = await runtime.pool.query("SELECT 1 FROM registration_intents WHERE id = $1 AND claim_secret_hash = $2 AND state IN ('issued', 'claimed', 'provisioning') AND expires_at > now()", [intentId, hashOpaqueToken(claimSecret)]);
    if (!check.rowCount) return reply.code(400).send({ code: "registration_invalid", message: "Registration authority is invalid" });
    const result = await authResponse(runtime, request, "/sign-in/social", { provider: "google", requestSignUp: true, callbackURL: `${context.config.frontendUrl.replace(/\/$/, "")}/login?registration=${encodeURIComponent(intentId)}` });
    if (result.status >= 400 || typeof result.body.url !== "string") return reply.code(502).send({ code: "google_unavailable", message: "Google OAuth is unavailable" });
    reply.header("set-cookie", [
      ...authSetCookies(result.headers),
      authCookieHeader(context.config, { name: "rainver.registration_claim", value: `${intentId}.${claimSecret}`, maxAgeSeconds: 1800 }),
    ]);
    return reply.send({ url: result.body.url });
  });

  app.get("/api/v1/auth/callback/google", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const queryString = new URLSearchParams(Object.entries(query(request)).filter((entry): entry is [string, string] => typeof entry[1] === "string")).toString();
    const reauthUrl = `${context.config.frontendUrl.replace(/\/$/, "")}/settings/security?google_reauth=1`;
    const addReturn = requestCookie(request, ACCOUNT_ADD_COOKIE);
    const settle: ForwardSettle = async (response, setCookies) => {
      const location = response.headers.get("location");
      const mode: SettleMode = { add: Boolean(addReturn) };
      // Reauthentication proves again the person who started it, from the
      // session that started it. A Google account of anyone else, or a browser
      // that switched account meanwhile, neither joins nor switches anything:
      // checked here, before any cookie is written, not only at completion.
      if (location === reauthUrl) {
        const nonce = requestCookie(request, "rainver.google_reauth");
        const started = nonce ? peekGoogleReauth(nonce) : null;
        const active = await currentSession(context, request, reply);
        mode.requireUserId = started && active && active.id === started.previousSessionId && active.user_id === started.userId ? started.userId : null;
        // It replaces the session it proved again, keeping that session's remember-me choice.
        mode.inheritRemember = true;
      }
      const settled = await settleSessionCookies(runtime, context.config, request, setCookies, mode);
      const cleared = [...settled.setCookies, authCookieHeader(context.config, { name: ACCOUNT_ADD_COOKIE, value: "", maxAgeSeconds: 0 })];
      if (settled.refused === "account_limit" && addReturn) return { setCookies: cleared, location: addAccountErrorUrl(safeFrontendUrl(context.config, addReturn), "account_limit") };
      return { setCookies: cleared };
    };
    return forwardBetterAuth(runtime, request, reply, `/callback/google${queryString ? `?${queryString}` : ""}`, "GET", undefined, (response) => {
      if (response.status < 300 || response.status >= 400 || response.headers.get("location") !== reauthUrl) return;
      const nonce = requestCookie(request, "rainver.google_reauth");
      const cookieName = sessionCookieName(context.config);
      const sessionCookie = authSetCookies(response.headers).find((cookie) => cookie.startsWith(`${cookieName}=`));
      const encodedToken = sessionCookie?.slice(cookieName.length + 1).split(";", 1)[0];
      if (!nonce || !encodedToken) return;
      try { markGoogleReauthVerified(nonce, hashOpaqueToken(decodeURIComponent(encodedToken).split(".", 1)[0]!)); } catch { /* invalid cookie */ }
    }, [], settle);
  });

  app.get("/api/v1/auth/introspect", async (request, reply) => {
    const identity = await introspectIdentity(context.config, request, reply);
    if (identity.ok) return reply.send({ space_id: identity.spaceId, user_id: identity.userId });
    if (identity.reason === "denied") return reply.code(identity.statusCode).send(identity.body);
    return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity resolution failed", resolveRequestId(request)));
  });

  app.get("/api/v1/me", async (request, reply) => {
    const requestId = resolveRequestId(request); reply.header(REQUEST_ID_HEADER, requestId);
    const repository = authRepositoryFromConfig(context.config); if (!repository) return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    const user = await repository.getCurrentUser(sessionTokenFromRequest(request), sessionRefreshSink(reply));
    if (isFailure(user)) {
      // A page that finds no account drops the revoked sessions its browser still sends (`deadEntryClears`), so the next sign-in is not refused for them.
      if (user.statusCode === 401 && runtime) {
        const clears = await deadEntryClears(runtime, context.config, request).catch(() => []);
        if (clears.length) reply.header("set-cookie", clears);
      }
      return reply.code(user.statusCode).send({ detail: user.detail });
    }
    // The tab keeps this handle and sends it back: any request from it after
    // another tab switched account is refused rather than run as the new one.
    return reply.send({ ...user, account_handle: browserAccountHandle(request) });
  });
  app.get("/api/v1/me/spaces", async (request, reply) => {
    const requestId = resolveRequestId(request); reply.header(REQUEST_ID_HEADER, requestId);
    const repository = authRepositoryFromConfig(context.config); if (!repository) return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    const user = await repository.getCurrentUser(sessionTokenFromRequest(request), sessionRefreshSink(reply)); if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    return reply.send(await repository.getUserSpaces(user.id));
  });
  app.get("/api/v1/auth/capabilities", async (request, reply) => {
    const identity = await introspectIdentity(context.config, request, reply);
    if (!identity.ok) return reply.code(identity.statusCode).send(identity.body);
    const account = await runtime?.pool.query<{ has_password: boolean; has_google: boolean }>(
      "SELECT bool_or(password IS NOT NULL) AS has_password, bool_or(provider_id = 'google') AS has_google FROM auth_accounts WHERE user_id = $1",
      [identity.userId],
    );
    return reply.send({ google_login: googleAuthConfigured(context.config), password_login: true, has_password: Boolean(account?.rows[0]?.has_password), has_google: Boolean(account?.rows[0]?.has_google), registration_open: false });
  });

  app.post("/api/v1/auth/reauth", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request, reply);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const input = body(request); const password = typeof input.password === "string" ? input.password : "";
    try { assertPasswordPolicy(password, minimumPasswordLength); } catch { return genericAuthFailure(reply, 401); }
    const result = await authResponse(runtime, request, "/verify-password", { password });
    if (result.status >= 400) return genericAuthFailure(reply, 401);
    const session = await currentSession(context, request, reply);
    if (!session || session.user_id !== user.id) return genericAuthFailure(reply, 401);
    const grant = await issueReauthGrant(runtime.pool, reply, context.config, { userId: user.id, sessionId: session.id, method: "password" });
    return reply.send({ ok: true, expires_in: 600, expires_at: grant.expiresAt.toISOString() });
  });

  app.get("/api/v1/auth/reauth/status", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const session = await currentSession(context, request, reply);
    if (!session) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    // Reads only: looking at the grant spends nothing.
    const expiresAt = await reauthGrantExpiresAt(runtime.pool, request, { userId: session.user_id, sessionId: session.id });
    reply.header("Cache-Control", "no-store");
    return reply.send({ expires_at: expiresAt === null ? null : expiresAt.toISOString() });
  });

  app.post("/api/v1/auth/reauth/google", async (request, reply) => {
    if (!runtime || !googleAuthConfigured(context.config)) return reply.code(501).send({ code: "google_unavailable", message: "Google OAuth is not configured" });
    const user = await currentUser(context, request, reply);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const token = sessionTokenFromRequest(request);
    if (!token) return genericAuthFailure(reply, 401);
    const previous = await runtime.pool.query<{ id: string }>("SELECT id FROM user_sessions WHERE user_id = $1 AND token_hash = $2 AND expires_at > now() LIMIT 1", [user.id, hashOpaqueToken(token.split(".", 1)[0]!)]);
    if (!previous.rows[0]) return genericAuthFailure(reply, 401);
    const result = await authResponse(runtime, request, "/sign-in/social", { provider: "google", callbackURL: `${context.config.frontendUrl.replace(/\/$/, "")}/settings/security?google_reauth=1` });
    if (result.status >= 400 || typeof result.body.url !== "string") return genericAuthFailure(reply, 400);
    // Issue a nonce only after Better Auth accepts the flow, and bind it to
    // the currently authenticated session that will be replaced.
    const nonce = issueGoogleReauth(user.id, previous.rows[0].id);
    reply.header("set-cookie", [
      ...authSetCookies(result.headers),
      authCookieHeader(context.config, { name: "rainver.google_reauth", value: nonce, maxAgeSeconds: 600 }),
    ]);
    return reply.send({ url: result.body.url });
  });

  app.post("/api/v1/auth/reauth/google/complete", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const nonce = requestCookie(request, "rainver.google_reauth"); const pendingReauth = nonce ? consumeGoogleReauth(nonce) : null;
    const currentToken = sessionTokenFromRequest(request);
    if (!pendingReauth || !currentToken) return genericAuthFailure(reply, 401);
    const session = await runtime.auth.api.getSession({ headers: new Headers({ cookie: `${sessionCookieName(context.config)}=${encodeURIComponent(currentToken)}` }) });
    if (!session?.user?.id || session.user.id !== pendingReauth.userId || pendingReauth.verifiedSessionTokenHash !== hashOpaqueToken(currentToken.split(".", 1)[0]!)) return genericAuthFailure(reply, 401);
    const account = await runtime.pool.query("SELECT 1 FROM auth_accounts WHERE user_id = $1 AND provider_id = 'google' LIMIT 1", [session.user.id]);
    if (!account.rowCount) return genericAuthFailure(reply, 401);
    await runtime.pool.query("DELETE FROM user_sessions WHERE id = $1 AND user_id = $2 AND id <> $3", [pendingReauth.previousSessionId, session.user.id, session.session.id]);
    // Reauthentication rotated the session: the grant binds to the session
    // the browser now holds, never to the one just revoked.
    const grant = await issueReauthGrant(runtime.pool, reply, context.config, { userId: session.user.id, sessionId: session.session.id, method: "google" });
    return reply.send({ ok: true, expires_in: 600, expires_at: grant.expiresAt.toISOString() });
  });

  app.post("/api/v1/auth/password/set", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request, reply);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const session = await currentSession(context, request, reply);
    if (!session || session.user_id !== user.id) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const input = body(request); const password = typeof input.new_password === "string" ? input.new_password : "";
    try { assertPasswordPolicy(password, minimumPasswordLength); } catch { return genericAuthFailure(reply, 400); }
    if (!await passwordAllowed(runtime, request, password)) return genericAuthFailure(reply, 400);
    try {
      const authContext = await runtime.auth.$context;
      const account = await authContext.internalAdapter.findCredentialAccount(user.id);
      if (account?.password) return genericAuthFailure(reply, 409);
      const passwordHash = await authContext.password.hash(password);
      // The grant is spent in the same transaction as the credential write:
      // either both happen or neither, and a second request finds it spent.
      const outcome = await withTransaction(runtime.pool, async (tx) => {
        if (!await consumeReauthGrant(tx, request, { userId: user.id, sessionId: session.id, operation: "password_set" })) return "no_grant" as const;
        if (!account) {
          await tx.query(
            `INSERT INTO auth_accounts (id, user_id, provider_id, account_id, password, created_at, updated_at)
             VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
            [randomUUID(), user.id, passwordHash],
          );
        } else {
          await tx.query(`UPDATE auth_accounts SET password = $2, updated_at = now() WHERE id = $1`, [account.id, passwordHash]);
        }
        return "done" as const;
      });
      if (outcome === "no_grant") return reply.code(403).send({ code: "reauthentication_required", message: "Recent reauthentication required" });
      clearReauthCookie(reply, context.config);
      return reply.send({ ok: true });
    } catch { return genericAuthFailure(reply, 400); }
  });

  app.post("/api/v1/auth/password/change", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request, reply);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const session = await currentSession(context, request, reply);
    if (!session || session.user_id !== user.id) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const input = body(request); const currentPassword = typeof input.current_password === "string" ? input.current_password : ""; const newPassword = typeof input.new_password === "string" ? input.new_password : "";
    try { assertPasswordPolicy(newPassword, minimumPasswordLength); } catch { return genericAuthFailure(reply, 400); }
    if (!await passwordAllowed(runtime, request, newPassword)) return genericAuthFailure(reply, 400);
    // Better Auth performs this change, so the grant is spent first: a
    // change that then fails costs a fresh verification, never a second use.
    if (!await spendReauthGrant(runtime.pool, request, reply, session, "password_change")) return reply;
    const result = await authResponse(runtime, request, "/change-password", { currentPassword, newPassword, revokeOtherSessions: input.revoke_other_sessions !== false });
    if (result.status >= 400) return genericAuthFailure(reply, 400);
    clearReauthCookie(reply, context.config);
    // A rotated session replaces the active account's entry and keeps its
    // remember-me choice. The tab adopts the new handle, so its own next
    // request is not refused as a tab of another account. The session
    // proved above is gone by now; it still ties the new one to this
    // browser, so a logout carrying its cookie revokes the new one too.
    const settled = await settleSessionCookies(runtime, context.config, request, authSetCookies(result.headers), { inheritRemember: true, rotatedFrom: session.id });
    return sendAuthResult(reply, result, settled.setCookies, settled.accountHandle ? { account_handle: settled.accountHandle } : {});
  });

  app.get("/api/v1/auth/accounts", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request, reply);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const accounts = await runtime.pool.query<{ id: string; provider_id: string; account_id: string; created_at: Date | string }>("SELECT id, provider_id, account_id, created_at FROM auth_accounts WHERE user_id = $1 ORDER BY created_at ASC", [user.id]);
    return reply.send(accounts.rows.map((account) => ({ id: account.id, provider: account.provider_id, account_id: account.account_id, created_at: new Date(account.created_at).toISOString() })));
  });

  app.get("/api/v1/auth/sessions", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request, reply);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const current = sessionTokenFromRequest(request);
    const currentRow = current ? await runtime.pool.query<{ id: string }>("SELECT id FROM user_sessions WHERE token_hash = $1 LIMIT 1", [hashOpaqueToken(current.split(".", 1)[0]!)]) : { rows: [] };
    const sessions = await runtime.pool.query<{ id: string; created_at: Date | string; updated_at: Date | string; expires_at: Date | string; ip_address: string | null; user_agent: string | null }>("SELECT id, created_at, updated_at, expires_at, ip_address, user_agent FROM user_sessions WHERE user_id = $1 AND expires_at > now() ORDER BY updated_at DESC", [user.id]);
    return reply.send(sessions.rows.map((session) => ({ id: session.id, created_at: new Date(session.created_at).toISOString(), updated_at: new Date(session.updated_at).toISOString(), expires_at: new Date(session.expires_at).toISOString(), ip_address: session.ip_address, user_agent: session.user_agent, current: session.id === currentRow.rows[0]?.id })));
  });

  app.post("/api/v1/auth/sessions/:sessionId/revoke", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request, reply); if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const id = typeof routeParams(request).sessionId === "string" ? routeParams(request).sessionId : "";
    await runtime.pool.query("DELETE FROM user_sessions WHERE id = $1 AND user_id = $2", [id, user.id]);
    return reply.send({ ok: true });
  });

  app.post("/api/v1/auth/sessions/revoke-others", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request, reply); if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const token = sessionTokenFromRequest(request); const current = token ? await runtime.pool.query<{ id: string }>("SELECT id FROM user_sessions WHERE token_hash = $1 LIMIT 1", [hashOpaqueToken(token.split(".", 1)[0]!)]) : { rows: [] };
    if (current.rows[0]) await runtime.pool.query("DELETE FROM user_sessions WHERE user_id = $1 AND id <> $2", [user.id, current.rows[0].id]);
    return reply.send({ ok: true });
  });

  app.post("/api/v1/auth/google/link", async (request, reply) => {
    if (!runtime || !googleAuthConfigured(context.config)) return reply.code(501).send({ code: "google_unavailable", message: "Google OAuth is not configured" });
    const user = await currentUser(context, request, reply); if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const session = await currentSession(context, request, reply);
    if (!session || session.user_id !== user.id) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    if (!await spendReauthGrant(runtime.pool, request, reply, session, "google_link")) return reply;
    const result = await authResponse(runtime, request, "/link-social", { provider: "google", disableRedirect: true, callbackURL: `${context.config.frontendUrl.replace(/\/$/, "")}/settings/security` });
    if (result.status >= 400 || typeof result.body.url !== "string") return genericAuthFailure(reply, 400);
    const setCookie = authSetCookies(result.headers);
    if (setCookie.length) reply.header("set-cookie", setCookie);
    return reply.send({ url: result.body.url });
  });

  app.post("/api/v1/auth/google/unlink", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request, reply); if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const session = await currentSession(context, request, reply);
    if (!session || session.user_id !== user.id) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const accountId = typeof body(request).account_id === "string" ? body(request).account_id : "";
    const outcome = await withTransaction(runtime.pool, async (tx) => {
      if (!await consumeReauthGrant(tx, request, { userId: user.id, sessionId: session.id, operation: "google_unlink" })) return "no_grant" as const;
      const accounts = await tx.query<{ id: string; provider_id: string }>("SELECT id, provider_id FROM auth_accounts WHERE user_id = $1 ORDER BY created_at ASC FOR UPDATE", [user.id]);
      if (accounts.rows.length <= 1 || !accounts.rows.some((account) => account.id === accountId && account.provider_id === "google")) return "refused" as const;
      await tx.query("DELETE FROM auth_accounts WHERE id = $1 AND user_id = $2 AND provider_id = 'google'", [accountId, user.id]);
      return "done" as const;
    });
    if (outcome === "no_grant") return reply.code(403).send({ code: "reauthentication_required", message: "Recent reauthentication required" });
    if (outcome === "refused") return genericAuthFailure(reply, 400);
    clearReauthCookie(reply, context.config);
    return reply.send({ ok: true });
  });

  app.post("/api/v1/auth/recovery/request", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const emailValue = body(request).email; const emailInput = typeof emailValue === "string" ? emailValue : "";
    let email: string; try { email = normalizeAuthEmail(emailInput); } catch { return reply.send({ ok: true }); }
    await authResponse(runtime, request, "/request-password-reset", { email, redirectTo: `${context.config.frontendUrl.replace(/\/$/, "")}/reset-password` });
    // The manual link is never returned to an unauthenticated requester.
    return reply.send({ ok: true });
  });

  app.post("/api/v1/auth/recovery/complete", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const input = body(request); const token = typeof input.token === "string" ? input.token : ""; const password = typeof input.new_password === "string" ? input.new_password : "";
    try { assertPasswordPolicy(password, minimumPasswordLength); } catch { return genericAuthFailure(reply, 400); }
    if (!await passwordAllowed(runtime, request, password)) return genericAuthFailure(reply, 400);
    const result = await authResponse(runtime, request, "/reset-password", { token, newPassword: password });
    if (result.status >= 400) return genericAuthFailure(reply, 400);
    return reply.send({ ok: true });
  });

  app.get("/api/v1/auth/admin/users", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request, reply); if (!user || isFailure(user) || !user.is_instance_admin) return reply.code(403).send({ code: "forbidden", message: "Administrator access required" });
    const users = await runtime.pool.query<{ id: string; email: string; display_name: string; status: string; registration_source: string; last_login_at: Date | string | null; account_count: string }>(`SELECT u.id, u.email, u.display_name, u.status, u.registration_source, u.last_login_at, count(a.id)::text AS account_count FROM users u LEFT JOIN auth_accounts a ON a.user_id = u.id GROUP BY u.id ORDER BY u.created_at ASC`);
    return reply.send(users.rows.map((row) => ({ ...row, account_count: Number(row.account_count) })));
  });

  app.post("/api/v1/auth/admin/users/:userId/reset-link", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const actor = await currentUser(context, request, reply); if (!actor || isFailure(actor) || !actor.is_instance_admin) return reply.code(403).send({ code: "forbidden", message: "Administrator access required" });
    const userId = typeof routeParams(request).userId === "string" ? routeParams(request).userId : "";
    const target = await runtime.pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1 AND status <> 'disabled'", [userId]); if (!target.rows[0]) return genericAuthFailure(reply, 404);
    const result = await authResponse(runtime, request, "/request-password-reset", { email: target.rows[0].email, redirectTo: `${context.config.frontendUrl.replace(/\/$/, "")}/reset-password` });
    if (result.status >= 400) return genericAuthFailure(reply, 400);
    const link = consumeManualResetLink(target.rows[0].email); return link ? reply.send({ reset_link: link }) : genericAuthFailure(reply, 503);
  });

  app.post("/api/v1/auth/admin/invitations", async (request, reply) => {
    if (!runtime || !registration) return runtimeOrError(context, reply);
    const actor = await currentUser(context, request, reply);
    if (!actor || isFailure(actor) || !actor.is_instance_admin) return reply.code(403).send({ code: "forbidden", message: "Administrator access required" });
    const parsed = InstanceInvitationCreateSchema.safeParse(body(request));
    if (!parsed.success) return reply.code(400).send({ code: "invalid_invitation", message: "A valid email is required" });
    reply.header("cache-control", "no-store");
    return reply.code(201).send(await registration.createInstanceInvitation(actor.id, parsed.data.email));
  });

  app.get("/api/v1/auth/admin/registration-intents", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const actor = await currentUser(context, request, reply); if (!actor || isFailure(actor) || !actor.is_instance_admin) return reply.code(403).send({ code: "forbidden", message: "Administrator access required" });
    const intents = await runtime.pool.query("SELECT id, email, authority, state, pending_user_id, created_at, last_activity_at, expires_at, completed_at FROM registration_intents ORDER BY created_at DESC LIMIT 100"); return reply.send(intents.rows);
  });

  app.post("/api/v1/auth/registration-intents", async (request, reply) => {
    if (!registration) return runtimeOrError(context, reply);
    const input = body(request); const email = typeof input.email === "string" ? input.email : ""; const invitationToken = typeof input.invitation_token === "string" ? input.invitation_token : undefined;
    try { return reply.code(201).send(await registration.issueIntent({ email, invitationToken })) } catch { return reply.code(403).send({ code: "registration_not_authorized", message: "Registration is not available for this request" }) }
  });

  app.post("/api/v1/auth/register", async (request, reply) => {
    if (!runtime || !registration) return runtimeOrError(context, reply);
    const input = body(request); const intentId = typeof input.intent_id === "string" ? input.intent_id : ""; const claimSecret = typeof input.claim_secret === "string" ? input.claim_secret : ""; const email = typeof input.email === "string" ? input.email : ""; const password = typeof input.password === "string" ? input.password : "";
    let normalizedEmail: string;
    try { normalizedEmail = normalizeAuthEmail(email); assertPasswordPolicy(password, minimumPasswordLength) } catch { return reply.code(400).send({ code: "invalid_registration", message: "Registration details are invalid" }) }
    const requestedName = typeof input.name === "string" ? input.name.trim() : "";
    const name = requestedName || normalizedEmail.split("@", 1)[0] || "User";
    if ([...name].length > REGISTRATION_DISPLAY_NAME_MAX) return reply.code(400).send({ code: "invalid_registration", message: "Registration details are invalid" });
    const intent = await runtime.pool.query<{ email: string; pending_user_id: string | null }>("SELECT email, pending_user_id FROM registration_intents WHERE id = $1 AND claim_secret_hash = $2 LIMIT 1", [intentId, hashOpaqueToken(claimSecret)]);
    if (!intent.rows[0] || normalizeAuthEmail(intent.rows[0].email) !== normalizedEmail) return reply.code(400).send({ code: "invalid_registration", message: "Registration details are invalid" });
    // A candidate password is checked against HIBP wherever one is set; sign-up
    // is where the first one is set. A pending identity resuming sign-in uses
    // the password it already has.
    if (!intent.rows[0].pending_user_id && !await passwordAllowed(runtime, request, password)) return reply.code(400).send({ code: "invalid_registration", message: "Registration details are invalid" });
    const result = await authResponse(runtime, request, intent.rows[0].pending_user_id ? "/sign-in/email" : "/sign-up/email", { email: normalizedEmail, password, name, rememberMe: input.remember_me !== false });
    if (result.status >= 400 && result.status !== 409) return reply.code(401).send({ code: "invalid_registration", message: "Registration could not be completed" });
    const sessionCookie = result.headers.get("set-cookie")?.match(/better-auth\.session_token=([^;]+)/)?.[1];
    const userId = sessionCookie ? await registration.sessionUserId(decodeURIComponent(sessionCookie)) : null;
    if (!userId) return reply.code(503).send({ code: "registration_pending", message: "Registration is pending; please retry" });
    try {
      await registration.complete({ intentId, claimSecret, userId, displayName: name });
    } catch { return reply.code(503).send({ code: "registration_pending", message: "Registration is pending; please retry" }) }
    const settled = await settleSessionCookies(runtime, context.config, request, authSetCookies(result.headers), {});
    if (settled.setCookies.length) reply.header("set-cookie", settled.setCookies);
    // The account exists; only this browser's session was refused.
    if (settled.refused === "signed_out") return reply.code(409).send({ code: "signed_out", message: "This browser signed out while signing in; sign in again" });
    reply.code(201); return reply.send({ ok: true, user_id: userId, ...(settled.accountHandle ? { account_handle: settled.accountHandle } : {}) });
  });

  app.post("/api/v1/auth/register/complete", async (request, reply) => {
    if (!runtime || !registration) return runtimeOrError(context, reply);
    const input = body(request); const intentId = typeof input.intent_id === "string" ? input.intent_id : ""; const claimCookie = requestCookie(request, "rainver.registration_claim"); const cookieParts = claimCookie?.split(".") ?? []; const claimSecret = typeof input.claim_secret === "string" && input.claim_secret ? input.claim_secret : cookieParts.length >= 2 && cookieParts[0] === intentId ? cookieParts.slice(1).join(".") : ""; const userId = await registration.sessionUserId(sessionTokenFromRequest(request));
    if (!userId) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    if (typeof input.name === "string" && [...input.name.trim()].length > REGISTRATION_DISPLAY_NAME_MAX) return reply.code(400).send({ code: "registration_invalid", message: "Registration cannot be completed" });
    try { const result = await registration.complete({ intentId, claimSecret, userId, displayName: typeof input.name === "string" ? input.name : undefined }); reply.header("set-cookie", authCookieHeader(context.config, { name: "rainver.registration_claim", value: "", maxAgeSeconds: 0 })); return reply.send({ ok: true, ...result }); } catch { return reply.code(400).send({ code: "registration_invalid", message: "Registration cannot be completed" }) }
  });

  app.post("/api/v1/auth/keys", async (request, reply) => { const identity = await introspectIdentity(context.config, request, reply); if (!identity.ok) return reply.code(identity.statusCode).send(identity.body); return reply.code(501).send({ detail: "API key storage is not in the canonical schema (ApiKey is deferred)." }) });
  app.get("/api/v1/auth/keys", async (request, reply) => { const identity = await introspectIdentity(context.config, request, reply); if (!identity.ok) return reply.code(identity.statusCode).send(identity.body); return reply.code(501).send({ detail: "API key storage is not in the canonical schema (ApiKey is deferred)." }) });
  app.delete("/api/v1/auth/keys/:keyId", async (request, reply) => { const identity = await introspectIdentity(context.config, request, reply); if (!identity.ok) return reply.code(identity.statusCode).send(identity.body); return reply.code(501).send({ detail: "API key storage is not in the canonical schema (ApiKey is deferred)." }) });
}
