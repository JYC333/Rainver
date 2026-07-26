import type { FastifyInstance, FastifyReply } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext";
import {
  API_KEYS_NOT_IMPLEMENTED,
  authRepositoryFromConfig,
  introspectIdentity,
  sessionTokenFromRequest,
  type AuthFailure,
} from "./identity";
import {
  OAUTH_STATE_COOKIE,
  POST_LOGIN_NEXT_COOKIE,
  buildGoogleAuthUrl,
  googleConfigured,
  googleOAuthClient,
  loginErrorUrl,
  randomOAuthState,
  safeNextUrl,
  sameState,
} from "./oauth";

function isFailure(value: unknown): value is AuthFailure {
  return Boolean(value && typeof value === "object" && "statusCode" in value);
}

function query(request: { query: unknown }): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

function body(request: { body: unknown }): Record<string, unknown> {
  return (request.body ?? {}) as Record<string, unknown>;
}

function cookieHeader(name: string, value: string, config: ModuleContext["config"], maxAge: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(config.debug ? [] : ["Secure"]),
  ].join("; ");
}

function deleteCookieHeader(name: string, config: ModuleContext["config"]): string {
  return [
    `${name}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(config.debug ? [] : ["Secure"]),
  ].join("; ");
}

function appendSetCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader("set-cookie");
  if (!existing) {
    reply.header("set-cookie", cookie);
  } else if (Array.isArray(existing)) {
    reply.header("set-cookie", [...existing.map(String), cookie]);
  } else {
    reply.header("set-cookie", [String(existing), cookie]);
  }
}

function setSessionDeleteCookie(reply: FastifyReply, config: ModuleContext["config"]): void {
  reply.header(
    "set-cookie",
    deleteCookieHeader("session_id", config),
  );
}

function cookieValue(cookieHeaderValue: string | string[] | undefined, name: string): string | undefined {
  const header = Array.isArray(cookieHeaderValue) ? cookieHeaderValue[0] : cookieHeaderValue;
  if (!header) return undefined;
  for (const rawPart of header.split(";")) {
    const part = rawPart.trim();
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq) !== name) continue;
    const value = part.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function sendApiKeyUnavailable(reply: FastifyReply): FastifyReply {
  return reply.code(501).send({ detail: API_KEYS_NOT_IMPLEMENTED });
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/auth/google-configured", async (_request, reply) => {
    return reply.send({ google_auth_available: googleConfigured(context.config) });
  });

  app.get("/api/v1/auth/google", async (request, reply) => {
    if (!googleConfigured(context.config)) {
      return reply.code(501).send({
        detail:
          "Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      });
    }
    const state = randomOAuthState();
    const rawNext = query(request).next;
    const next = safeNextUrl(typeof rawNext === "string" ? rawNext : undefined);
    appendSetCookie(reply, cookieHeader(OAUTH_STATE_COOKIE, state, context.config, 300));
    if (next) {
      appendSetCookie(reply, cookieHeader(POST_LOGIN_NEXT_COOKIE, next, context.config, 300));
    }
    return reply.redirect(buildGoogleAuthUrl(context.config, state), 307);
  });

  app.get("/api/v1/auth/google/callback", async (request, reply) => {
    const q = query(request);
    const error = typeof q.error === "string" ? q.error : "";
    const state = typeof q.state === "string" ? q.state : "";
    const code = typeof q.code === "string" ? q.code : "";
    const clearAndRedirect = (reason: string) => {
      appendSetCookie(reply, deleteCookieHeader(OAUTH_STATE_COOKIE, context.config));
      return reply.redirect(loginErrorUrl(context.config, reason), 307);
    };
    if (error) return clearAndRedirect("provider_error");
    const expectedState = cookieValue(request.headers.cookie, OAUTH_STATE_COOKIE);
    if (!sameState(expectedState, state)) return clearAndRedirect("csrf");
    const repository = authRepositoryFromConfig(context.config);
    if (!repository) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope(
          "identity_db_unavailable",
          "Identity database is unavailable",
          resolveRequestId(request),
        ),
      );
    }
    let userInfo;
    try {
      const tokens = await googleOAuthClient().exchangeCode(context.config, code);
      userInfo = await googleOAuthClient().getUserInfo(tokens.access_token);
    } catch {
      return clearAndRedirect("google_failed");
    }
    const googleSub = userInfo.sub;
    const email = userInfo.email ?? "";
    const displayName = userInfo.name || email.split("@")[0];
    if (!googleSub || !email) return clearAndRedirect("incomplete_profile");
    if (!userInfo.email_verified) return clearAndRedirect("email_not_verified");
    const user = await repository.findOrCreateFromGoogle({
      googleSub,
      email,
      displayName,
      avatarUrl: userInfo.picture ?? null,
    });
    const rawSession = await repository.createSession(user.id, context.config.sessionExpireDays);
    const pendingNext = safeNextUrl(
      cookieValue(request.headers.cookie, POST_LOGIN_NEXT_COOKIE),
    );
    const redirectTo = pendingNext
      ? `${context.config.frontendUrl}${pendingNext}`
      : context.config.frontendUrl;
    appendSetCookie(
      reply,
      cookieHeader(
        "session_id",
        rawSession,
        context.config,
        context.config.sessionExpireDays * 86_400,
      ),
    );
    appendSetCookie(reply, deleteCookieHeader(OAUTH_STATE_COOKIE, context.config));
    appendSetCookie(reply, deleteCookieHeader(POST_LOGIN_NEXT_COOKIE, context.config));
    return reply.redirect(redirectTo, 307);
  });

  app.post("/api/v1/auth/keys", async (request, reply) => {
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok && identity.reason === "denied") {
      reply.code(identity.statusCode).header("content-type", "application/json");
      return reply.send(identity.body);
    }
    if (!identity.ok) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity resolution failed", resolveRequestId(request)),
      );
    }
    void body(request);
    return sendApiKeyUnavailable(reply);
  });

  app.get("/api/v1/auth/keys", async (request, reply) => {
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok && identity.reason === "denied") {
      reply.code(identity.statusCode).header("content-type", "application/json");
      return reply.send(identity.body);
    }
    if (!identity.ok) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity resolution failed", resolveRequestId(request)),
      );
    }
    return sendApiKeyUnavailable(reply);
  });

  app.delete("/api/v1/auth/keys/:keyId", async (request, reply) => {
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok && identity.reason === "denied") {
      reply.code(identity.statusCode).header("content-type", "application/json");
      return reply.send(identity.body);
    }
    if (!identity.ok) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity resolution failed", resolveRequestId(request)),
      );
    }
    return sendApiKeyUnavailable(reply);
  });

  app.get("/api/v1/auth/introspect", async (request, reply) => {
    const identity = await introspectIdentity(context.config, request);
    if (identity.ok) {
      return reply.send({ space_id: identity.spaceId, user_id: identity.userId });
    }
    if (identity.reason === "denied") {
      reply.code(identity.statusCode);
      reply.header("content-type", "application/json");
      return reply.send(identity.body);
    }
    return sendErrorEnvelope(
      reply,
      502,
      errorEnvelope(
        identity.reason === "contract_violation"
          ? "identity_contract_violation"
          : "identity_db_unavailable",
        "Identity resolution failed",
        resolveRequestId(request),
      ),
    );
  });

  app.get("/api/v1/me", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const repository = authRepositoryFromConfig(context.config);
    if (!repository) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId),
      );
    }
    const user = await repository.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    return reply.send(user);
  });

  app.get("/api/v1/me/spaces", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const repository = authRepositoryFromConfig(context.config);
    if (!repository) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId),
      );
    }
    const user = await repository.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    return reply.send(await repository.getUserSpaces(user.id));
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const repository = authRepositoryFromConfig(context.config);
    if (!repository) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId),
      );
    }
    await repository.logout(sessionTokenFromRequest(request));
    setSessionDeleteCookie(reply, context.config);
    return reply.code(204).send();
  });
}
