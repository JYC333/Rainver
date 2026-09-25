import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { PASSWORD_MAX_LENGTH, assertPasswordPolicy, hashOpaqueToken, normalizeAuthEmail, passwordMinimumLength } from "./securityPolicy.js";
import { googleAuthConfigured } from "./betterAuth.js";
import { authRepositoryFromConfig, createAuthRuntime, introspectIdentity, sessionTokenFromRequest, setAuthRuntimeForComposition, type AuthFailure } from "./identity.js";
import { RegistrationService } from "./registration.js";
import { recordAuthSecurityEvent } from "./securityEvents.js";
import { consumeManualResetLink } from "./recovery.js";
import { clearReauthGrant, hasRecentReauth, recentReauthExpiresAt, setReauthGrant } from "./reauth.js";
import { guardedHibpRangeTransport, isPasswordCompromised } from "./hibp.js";
import { consumeGoogleReauth, issueGoogleReauth } from "./googleReauth.js";
import { authCookieHeader } from "./authCookie.js";

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

async function sendAuthResult(reply: FastifyReply, result: { status: number; body: Record<string, unknown>; headers: Headers }): Promise<void> {
  const setCookie = (result.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookie?.length) reply.header("set-cookie", setCookie);
  else if (result.headers.get("set-cookie")) reply.header("set-cookie", result.headers.get("set-cookie")!);
  if (result.status === 204) { reply.code(204).send(); return; }
  reply.code(result.status).send(result.body);
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
function safeNext(value: unknown): string { return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/" }
function runtimeOrError(context: ModuleContext, reply: FastifyReply): ModuleContext["authRuntime"] | null {
  if (context.authRuntime) return context.authRuntime;
  reply.code(503).send({ code: "auth_unavailable", message: "Authentication is unavailable" });
  return null;
}

async function currentUser(context: ModuleContext, request: FastifyRequest): Promise<Awaited<ReturnType<NonNullable<ModuleContext["authRuntime"]>["repository"]["getCurrentUser"]>> | null> {
  const repository = authRepositoryFromConfig(context.config);
  if (!repository) return null;
  return repository.getCurrentUser(sessionTokenFromRequest(request));
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

async function passwordAllowed(runtime: NonNullable<ModuleContext["authRuntime"]>, request: FastifyRequest, password: string): Promise<boolean> {
  if (process.env.RAINVER_HIBP_DISABLED === "1") return true;
  try {
    if (await isPasswordCompromised(password, guardedHibpRangeTransport())) {
      await recordAuthSecurityEvent(runtime.pool, { eventType: "password_compromised", outcome: "failure", requestId: resolveRequestId(request), sourceIp: clientIp(request), details: { route: request.url, reason_code: "hibp_match" } }).catch(() => {});
      return false;
    }
  } catch {
    await recordAuthSecurityEvent(runtime.pool, { eventType: "password_compromise_check", outcome: "degraded", requestId: resolveRequestId(request), sourceIp: clientIp(request), details: { route: request.url, degraded_dependency: "hibp" } }).catch(() => {});
  }
  return true;
}

async function forwardBetterAuth(runtime: NonNullable<ModuleContext["authRuntime"]>, request: FastifyRequest, reply: FastifyReply, path: string, method = request.method, overrideBody?: Record<string, unknown>): Promise<void> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined && key.toLowerCase() !== "content-length") headers.set(key, Array.isArray(value) ? value[0]! : value);
  }
  const payload = overrideBody ?? (request.body as Record<string, unknown> | undefined);
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (payload !== undefined && method !== "GET" && method !== "HEAD") { headers.set("content-type", "application/json"); init.body = JSON.stringify(payload) }
  const response = await runtime.auth.handler(new Request(`${runtime.auth.options.baseURL}${runtime.auth.options.basePath}${path}`, init));
  reply.code(response.status);
  const setCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookie?.length) reply.header("set-cookie", setCookie); else if (response.headers.get("set-cookie")) reply.header("set-cookie", response.headers.get("set-cookie")!);
  const contentType = response.headers.get("content-type"); if (contentType) reply.header("content-type", contentType);
  const location = response.headers.get("location"); if (location) reply.header("location", location);
  if (response.status === 204) { reply.send(); return }
  reply.send(Buffer.from(await response.arrayBuffer()));
}

async function authResponse(runtime: NonNullable<ModuleContext["authRuntime"]>, request: FastifyRequest, path: string, bodyValue?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value[0]! : value);
  headers.set("content-type", "application/json");
  const response = await runtime.auth.handler(new Request(`${runtime.auth.options.baseURL}${runtime.auth.options.basePath}${path}`, { method: "POST", headers, body: JSON.stringify(bodyValue ?? body(request)) }));
  let parsed: Record<string, unknown> = {};
  try { parsed = await response.json() as Record<string, unknown> } catch { /* generic response */ }
  return { status: response.status, body: parsed, headers: response.headers };
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const runtime = context.authRuntime ?? createAuthRuntime(context.config);
  if (runtime && !context.authRuntime) setAuthRuntimeForComposition(runtime);
  const registration = runtime ? new RegistrationService(runtime.pool, context.config) : null;
  const minimumPasswordLength = passwordMinimumLength(context.config.rainverEnv);

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
    return sendAuthResult(reply, result);
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (!runtime) {
      const repository = authRepositoryFromConfig(context.config);
      if (!repository) return runtimeOrError(context, reply);
      await repository.logout(sessionTokenFromRequest(request));
      reply.header("set-cookie", authCookieHeader(context.config, { name: "better-auth.session_token", value: "", maxAgeSeconds: 0 }));
      return reply.code(204).send();
    }
    return forwardBetterAuth(runtime, request, reply, "/sign-out", "POST", {});
  });

  app.get("/api/v1/auth/google", async (request, reply) => {
    if (!runtime || !googleAuthConfigured(context.config)) return reply.code(501).send({ code: "google_unavailable", message: "Google OAuth is not configured" });
    const next = safeNext(query(request).next);
    const callbackURL = `${context.config.frontendUrl.replace(/\/$/, "")}/login?redirect=${encodeURIComponent(next)}`;
    const result = await authResponse(runtime, request, "/sign-in/social", { provider: "google", callbackURL });
    if (result.status >= 400 || typeof result.body.url !== "string") return reply.code(502).send({ code: "google_unavailable", message: "Google OAuth is unavailable" });
    return reply.redirect(result.body.url, 307);
  });
  app.post("/api/v1/auth/register/google", async (request, reply) => {
    if (!runtime || !registration || !googleAuthConfigured(context.config)) return reply.code(501).send({ code: "google_unavailable", message: "Google OAuth is not configured" });
    const input = body(request); const intentId = typeof input.intent_id === "string" ? input.intent_id : ""; const claimSecret = typeof input.claim_secret === "string" ? input.claim_secret : "";
    const check = await runtime.pool.query("SELECT 1 FROM registration_intents WHERE id = $1 AND claim_secret_hash = $2 AND state IN ('issued', 'claimed', 'provisioning') AND expires_at > now()", [intentId, hashOpaqueToken(claimSecret)]);
    if (!check.rowCount) return reply.code(400).send({ code: "registration_invalid", message: "Registration authority is invalid" });
    const result = await authResponse(runtime, request, "/sign-in/social", { provider: "google", requestSignUp: true, callbackURL: `${context.config.frontendUrl.replace(/\/$/, "")}/login?registration=${encodeURIComponent(intentId)}`, additionalData: { registration_intent_id: intentId, claim_secret: claimSecret } });
    if (result.status >= 400 || typeof result.body.url !== "string") return reply.code(502).send({ code: "google_unavailable", message: "Google OAuth is unavailable" });
    reply.header("set-cookie", authCookieHeader(context.config, { name: "rainver.registration_claim", value: `${intentId}.${claimSecret}`, maxAgeSeconds: 1800 }));
    return reply.send({ url: result.body.url });
  });

  app.get("/api/v1/auth/callback/google", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const queryString = new URLSearchParams(Object.entries(query(request)).filter((entry): entry is [string, string] => typeof entry[1] === "string")).toString();
    return forwardBetterAuth(runtime, request, reply, `/callback/google${queryString ? `?${queryString}` : ""}`, "GET");
  });

  app.get("/api/v1/auth/introspect", async (request, reply) => {
    const identity = await introspectIdentity(context.config, request);
    if (identity.ok) return reply.send({ space_id: identity.spaceId, user_id: identity.userId });
    if (identity.reason === "denied") return reply.code(identity.statusCode).send(identity.body);
    return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity resolution failed", resolveRequestId(request)));
  });

  app.get("/api/v1/me", async (request, reply) => {
    const requestId = resolveRequestId(request); reply.header(REQUEST_ID_HEADER, requestId);
    const repository = authRepositoryFromConfig(context.config); if (!repository) return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    const user = await repository.getCurrentUser(sessionTokenFromRequest(request)); if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    return reply.send(user);
  });
  app.get("/api/v1/me/spaces", async (request, reply) => {
    const requestId = resolveRequestId(request); reply.header(REQUEST_ID_HEADER, requestId);
    const repository = authRepositoryFromConfig(context.config); if (!repository) return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    const user = await repository.getCurrentUser(sessionTokenFromRequest(request)); if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    return reply.send(await repository.getUserSpaces(user.id));
  });
  app.get("/api/v1/auth/capabilities", async (request, reply) => {
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok) return reply.code(identity.statusCode).send(identity.body);
    const account = await runtime?.pool.query<{ has_password: boolean; has_google: boolean }>(
      "SELECT bool_or(password IS NOT NULL) AS has_password, bool_or(provider_id = 'google') AS has_google FROM auth_accounts WHERE user_id = $1",
      [identity.userId],
    );
    return reply.send({ google_login: googleAuthConfigured(context.config), password_login: true, has_password: Boolean(account?.rows[0]?.has_password), has_google: Boolean(account?.rows[0]?.has_google), registration_open: false });
  });

  app.post("/api/v1/auth/reauth", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const input = body(request); const password = typeof input.password === "string" ? input.password : "";
    try { assertPasswordPolicy(password, minimumPasswordLength); } catch { return genericAuthFailure(reply, 401); }
    const result = await authResponse(runtime, request, "/verify-password", { password });
    if (result.status >= 400) return genericAuthFailure(reply, 401);
    setReauthGrant(reply, context.config, user.id);
    return reply.send({ ok: true, expires_in: 600 });
  });

  app.get("/api/v1/auth/reauth/status", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const expiresAt = recentReauthExpiresAt(request, context.config, user.id);
    reply.header("Cache-Control", "no-store");
    return reply.send({ expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString() });
  });

  app.post("/api/v1/auth/reauth/google", async (request, reply) => {
    if (!runtime || !googleAuthConfigured(context.config)) return reply.code(501).send({ code: "google_unavailable", message: "Google OAuth is not configured" });
    const user = await currentUser(context, request);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const nonce = issueGoogleReauth(user.id);
    const result = await authResponse(runtime, request, "/sign-in/social", { provider: "google", callbackURL: `${context.config.frontendUrl.replace(/\/$/, "")}/settings/security?google_reauth=1` });
    if (result.status >= 400 || typeof result.body.url !== "string") return genericAuthFailure(reply, 400);
    reply.header("set-cookie", authCookieHeader(context.config, { name: "rainver.google_reauth", value: nonce, maxAgeSeconds: 600 }));
    return reply.send({ url: result.body.url });
  });

  app.post("/api/v1/auth/reauth/google/complete", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const nonce = requestCookie(request, "rainver.google_reauth"); const pendingReauth = nonce ? consumeGoogleReauth(nonce) : null;
    if (!pendingReauth) return genericAuthFailure(reply, 401);
    const session = await runtime.auth.api.getSession({ headers: new Headers({ cookie: `better-auth.session_token=${encodeURIComponent(sessionTokenFromRequest(request) ?? "")}` }) });
    if (!session?.user?.id || session.user.id !== pendingReauth.userId || new Date(session.session.createdAt).getTime() < pendingReauth.issuedAt) return genericAuthFailure(reply, 401);
    const account = await runtime.pool.query("SELECT 1 FROM auth_accounts WHERE user_id = $1 AND provider_id = 'google' LIMIT 1", [session.user.id]);
    if (!account.rowCount) return genericAuthFailure(reply, 401);
    setReauthGrant(reply, context.config, session.user.id);
    return reply.send({ ok: true, expires_in: 600 });
  });

  app.post("/api/v1/auth/password/set", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    if (!hasRecentReauth(request, context.config, user.id)) return reply.code(403).send({ code: "reauthentication_required", message: "Recent reauthentication required" });
    const input = body(request); const password = typeof input.new_password === "string" ? input.new_password : "";
    try { assertPasswordPolicy(password, minimumPasswordLength); } catch { return genericAuthFailure(reply, 400); }
    if (!await passwordAllowed(runtime, request, password)) return genericAuthFailure(reply, 400);
    try {
      const authContext = await runtime.auth.$context;
      const account = await authContext.internalAdapter.findCredentialAccount(user.id);
      const passwordHash = await authContext.password.hash(password);
      if (!account) await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: passwordHash });
      else if (!account.password) await authContext.internalAdapter.updateAccount(account.id, { password: passwordHash });
      else return genericAuthFailure(reply, 409);
      clearReauthGrant(reply, context.config);
      return reply.send({ ok: true });
    } catch { return genericAuthFailure(reply, 400); }
  });

  app.post("/api/v1/auth/password/change", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    if (!hasRecentReauth(request, context.config, user.id)) return reply.code(403).send({ code: "reauthentication_required", message: "Recent reauthentication required" });
    const input = body(request); const currentPassword = typeof input.current_password === "string" ? input.current_password : ""; const newPassword = typeof input.new_password === "string" ? input.new_password : "";
    try { assertPasswordPolicy(newPassword, minimumPasswordLength); } catch { return genericAuthFailure(reply, 400); }
    if (!await passwordAllowed(runtime, request, newPassword)) return genericAuthFailure(reply, 400);
    const result = await authResponse(runtime, request, "/change-password", { currentPassword, newPassword, revokeOtherSessions: input.revoke_other_sessions !== false });
    if (result.status >= 400) return genericAuthFailure(reply, 400);
    clearReauthGrant(reply, context.config);
    return sendAuthResult(reply, result);
  });

  app.get("/api/v1/auth/accounts", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const accounts = await runtime.pool.query<{ id: string; provider_id: string; account_id: string; created_at: Date | string }>("SELECT id, provider_id, account_id, created_at FROM auth_accounts WHERE user_id = $1 ORDER BY created_at ASC", [user.id]);
    return reply.send(accounts.rows.map((account) => ({ id: account.id, provider: account.provider_id, account_id: account.account_id, created_at: new Date(account.created_at).toISOString() })));
  });

  app.get("/api/v1/auth/sessions", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request);
    if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const current = sessionTokenFromRequest(request);
    const currentRow = current ? await runtime.pool.query<{ id: string }>("SELECT id FROM user_sessions WHERE token_hash = $1 LIMIT 1", [hashOpaqueToken(current.split(".", 1)[0]!)]) : { rows: [] };
    const sessions = await runtime.pool.query<{ id: string; created_at: Date | string; updated_at: Date | string; expires_at: Date | string; ip_address: string | null; user_agent: string | null }>("SELECT id, created_at, updated_at, expires_at, ip_address, user_agent FROM user_sessions WHERE user_id = $1 AND expires_at > now() ORDER BY updated_at DESC", [user.id]);
    return reply.send(sessions.rows.map((session) => ({ id: session.id, created_at: new Date(session.created_at).toISOString(), updated_at: new Date(session.updated_at).toISOString(), expires_at: new Date(session.expires_at).toISOString(), ip_address: session.ip_address, user_agent: session.user_agent, current: session.id === currentRow.rows[0]?.id })));
  });

  app.post("/api/v1/auth/sessions/:sessionId/revoke", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request); if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const id = typeof routeParams(request).sessionId === "string" ? routeParams(request).sessionId : "";
    await runtime.pool.query("DELETE FROM user_sessions WHERE id = $1 AND user_id = $2", [id, user.id]);
    return reply.send({ ok: true });
  });

  app.post("/api/v1/auth/sessions/revoke-others", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request); if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    const token = sessionTokenFromRequest(request); const current = token ? await runtime.pool.query<{ id: string }>("SELECT id FROM user_sessions WHERE token_hash = $1 LIMIT 1", [hashOpaqueToken(token.split(".", 1)[0]!)]) : { rows: [] };
    if (current.rows[0]) await runtime.pool.query("DELETE FROM user_sessions WHERE user_id = $1 AND id <> $2", [user.id, current.rows[0].id]);
    return reply.send({ ok: true });
  });

  app.post("/api/v1/auth/google/link", async (request, reply) => {
    if (!runtime || !googleAuthConfigured(context.config)) return reply.code(501).send({ code: "google_unavailable", message: "Google OAuth is not configured" });
    const user = await currentUser(context, request); if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    if (!hasRecentReauth(request, context.config, user.id)) return reply.code(403).send({ code: "reauthentication_required", message: "Recent reauthentication required" });
    const result = await authResponse(runtime, request, "/link-social", { provider: "google", disableRedirect: true, callbackURL: `${context.config.frontendUrl.replace(/\/$/, "")}/settings/security` });
    if (result.status >= 400 || typeof result.body.url !== "string") return genericAuthFailure(reply, 400);
    return reply.send({ url: result.body.url });
  });

  app.post("/api/v1/auth/google/unlink", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const user = await currentUser(context, request); if (!user || isFailure(user)) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    if (!hasRecentReauth(request, context.config, user.id)) return reply.code(403).send({ code: "reauthentication_required", message: "Recent reauthentication required" });
    const accountId = typeof body(request).account_id === "string" ? body(request).account_id : "";
    const accounts = await runtime.pool.query<{ id: string; provider_id: string }>("SELECT id, provider_id FROM auth_accounts WHERE user_id = $1 ORDER BY created_at ASC", [user.id]);
    if (accounts.rows.length <= 1 || !accounts.rows.some((account) => account.id === accountId && account.provider_id === "google")) return genericAuthFailure(reply, 400);
    await runtime.pool.query("DELETE FROM auth_accounts WHERE id = $1 AND user_id = $2 AND provider_id = 'google'", [accountId, user.id]);
    clearReauthGrant(reply, context.config);
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
    const user = await currentUser(context, request); if (!user || isFailure(user) || !user.is_instance_admin) return reply.code(403).send({ code: "forbidden", message: "Administrator access required" });
    const users = await runtime.pool.query<{ id: string; email: string; display_name: string; status: string; registration_source: string; last_login_at: Date | string | null; account_count: string }>(`SELECT u.id, u.email, u.display_name, u.status, u.registration_source, u.last_login_at, count(a.id)::text AS account_count FROM users u LEFT JOIN auth_accounts a ON a.user_id = u.id GROUP BY u.id ORDER BY u.created_at ASC`);
    return reply.send(users.rows.map((row) => ({ ...row, account_count: Number(row.account_count) })));
  });

  app.post("/api/v1/auth/admin/users/:userId/disable", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const actor = await currentUser(context, request); if (!actor || isFailure(actor) || !actor.is_instance_admin) return reply.code(403).send({ code: "forbidden", message: "Administrator access required" });
    const userId = typeof routeParams(request).userId === "string" ? routeParams(request).userId : ""; if (userId === actor.id) return genericAuthFailure(reply, 400);
    await runtime.pool.query("UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1", [userId]); await runtime.pool.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
    return reply.send({ ok: true });
  });

  app.post("/api/v1/auth/admin/users/:userId/enable", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const actor = await currentUser(context, request); if (!actor || isFailure(actor) || !actor.is_instance_admin) return reply.code(403).send({ code: "forbidden", message: "Administrator access required" });
    const userId = typeof routeParams(request).userId === "string" ? routeParams(request).userId : "";
    await runtime.pool.query("UPDATE users SET status = 'active', updated_at = now() WHERE id = $1", [userId]); return reply.send({ ok: true });
  });

  app.post("/api/v1/auth/admin/users/:userId/reset-link", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const actor = await currentUser(context, request); if (!actor || isFailure(actor) || !actor.is_instance_admin) return reply.code(403).send({ code: "forbidden", message: "Administrator access required" });
    const userId = typeof routeParams(request).userId === "string" ? routeParams(request).userId : "";
    const target = await runtime.pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1 AND status <> 'disabled'", [userId]); if (!target.rows[0]) return genericAuthFailure(reply, 404);
    const result = await authResponse(runtime, request, "/request-password-reset", { email: target.rows[0].email, redirectTo: `${context.config.frontendUrl.replace(/\/$/, "")}/reset-password` });
    if (result.status >= 400) return genericAuthFailure(reply, 400);
    const link = consumeManualResetLink(target.rows[0].email); return link ? reply.send({ reset_link: link }) : genericAuthFailure(reply, 503);
  });

  app.get("/api/v1/auth/admin/registration-intents", async (request, reply) => {
    if (!runtime) return runtimeOrError(context, reply);
    const actor = await currentUser(context, request); if (!actor || isFailure(actor) || !actor.is_instance_admin) return reply.code(403).send({ code: "forbidden", message: "Administrator access required" });
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
    if ([...name].length > 256) return reply.code(400).send({ code: "invalid_registration", message: "Registration details are invalid" });
    const intent = await runtime.pool.query<{ email: string; pending_user_id: string | null }>("SELECT email, pending_user_id FROM registration_intents WHERE id = $1 AND claim_secret_hash = $2 LIMIT 1", [intentId, hashOpaqueToken(claimSecret)]);
    if (!intent.rows[0] || normalizeAuthEmail(intent.rows[0].email) !== normalizedEmail) return reply.code(400).send({ code: "invalid_registration", message: "Registration details are invalid" });
    const result = await authResponse(runtime, request, intent.rows[0].pending_user_id ? "/sign-in/email" : "/sign-up/email", { email: normalizedEmail, password, name, rememberMe: input.remember_me !== false });
    if (result.status >= 400 && result.status !== 409) return reply.code(401).send({ code: "invalid_registration", message: "Registration could not be completed" });
    const sessionCookie = result.headers.get("set-cookie")?.match(/better-auth\.session_token=([^;]+)/)?.[1];
    const userId = sessionCookie ? await registration.sessionUserId(decodeURIComponent(sessionCookie)) : null;
    if (!userId) return reply.code(503).send({ code: "registration_pending", message: "Registration is pending; please retry" });
    try {
      await registration.complete({ intentId, claimSecret, userId, displayName: name });
    } catch { return reply.code(503).send({ code: "registration_pending", message: "Registration is pending; please retry" }) }
    reply.code(201); if (result.headers.get("set-cookie")) reply.header("set-cookie", result.headers.get("set-cookie")!); return reply.send({ ok: true, user_id: userId });
  });

  app.post("/api/v1/auth/register/complete", async (request, reply) => {
    if (!runtime || !registration) return runtimeOrError(context, reply);
    const input = body(request); const intentId = typeof input.intent_id === "string" ? input.intent_id : ""; const claimCookie = requestCookie(request, "rainver.registration_claim"); const cookieParts = claimCookie?.split(".") ?? []; const claimSecret = typeof input.claim_secret === "string" && input.claim_secret ? input.claim_secret : cookieParts.length >= 2 && cookieParts[0] === intentId ? cookieParts.slice(1).join(".") : ""; const userId = await registration.sessionUserId(sessionTokenFromRequest(request));
    if (!userId) return reply.code(401).send({ code: "authentication_required", message: "Authentication required" });
    try { const result = await registration.complete({ intentId, claimSecret, userId, displayName: typeof input.name === "string" ? input.name : undefined }); reply.header("set-cookie", authCookieHeader(context.config, { name: "rainver.registration_claim", value: "", maxAgeSeconds: 0 })); return reply.send({ ok: true, ...result }); } catch { return reply.code(400).send({ code: "registration_invalid", message: "Registration cannot be completed" }) }
  });

  app.post("/api/v1/auth/keys", async (request, reply) => { const identity = await introspectIdentity(context.config, request); if (!identity.ok) return reply.code(identity.statusCode).send(identity.body); return reply.code(501).send({ detail: "API key storage is not in the canonical schema (ApiKey is deferred)." }) });
  app.get("/api/v1/auth/keys", async (request, reply) => { const identity = await introspectIdentity(context.config, request); if (!identity.ok) return reply.code(identity.statusCode).send(identity.body); return reply.code(501).send({ detail: "API key storage is not in the canonical schema (ApiKey is deferred)." }) });
  app.delete("/api/v1/auth/keys/:keyId", async (request, reply) => { const identity = await introspectIdentity(context.config, request); if (!identity.ok) return reply.code(identity.statusCode).send(identity.body); return reply.code(501).send({ detail: "API key storage is not in the canonical schema (ApiKey is deferred)." }) });
}
