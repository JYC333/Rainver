/**
 * Tests for observable gateway behavior: request-id continuity, the server-owned
 * error envelope, unknown API route handling, and safe header access.
 */

import { Writable } from "node:stream";
import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createServerApp, registerGatewayConventions } from "../src/gateway/appShell.js";
import { LOG_REDACT_PATHS } from "../src/gateway/logging.js";
import {
  SERVER_MARKER_HEADER,
  SERVER_MARKER_VALUE,
  readHeader,
} from "../src/gateway/requestContext.js";
import { __setHealthDatabaseForTests } from "../src/modules/system/service.js";

let app: FastifyInstance;

afterEach(async () => {
  __setHealthDatabaseForTests(null);
  await app?.close();
});

describe("request id on server-owned routes", () => {
  it("preserves an incoming x-request-id on the response", async () => {
    __setHealthDatabaseForTests({ async query<Row>() { return { rows: [{ healthy: 1 } as Row], rowCount: 1 }; } });
    app = buildServer(loadConfig({}), { logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "req-abc" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("req-abc");
    expect(res.headers[SERVER_MARKER_HEADER]).toBe(SERVER_MARKER_VALUE);
  });

  it("generates an x-request-id when the client did not send one", async () => {
    __setHealthDatabaseForTests({ async query<Row>() { return { rows: [{ healthy: 1 } as Row], rowCount: 1 }; } });
    app = buildServer(loadConfig({}), { logger: false });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers[SERVER_MARKER_HEADER]).toBe(SERVER_MARKER_VALUE);
  });
});

describe("error envelope for server-owned routes", () => {
  function buildAppWithThrowingRoute(message: string, statusCode?: number) {
    // A static route beats the /api/v1/* wildcard, so this simulates a server-owned
    // module route that throws.
    const server = buildServer(loadConfig({}), { logger: false });
    server.get("/api/v1/server/boom", async () => {
      const err = new Error(message);
      if (statusCode !== undefined) Object.assign(err, { statusCode });
      throw err;
    });
    return server;
  }

  it("returns { error, message, request_id } with a generic message for 5xx", async () => {
    app = buildAppWithThrowingRoute("kaboom with internals: db at 10.0.0.5");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/server/boom",
      headers: { "x-request-id": "req-err-1" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "internal_error",
      message: "Internal server error",
      request_id: "req-err-1",
    });
    // No stack traces or internal detail in the body.
    expect(res.payload).not.toContain("kaboom");
    expect(res.payload).not.toContain("10.0.0.5");
    expect(res.payload).not.toContain("at "); // stack frame marker
  });

  it("keeps intentional client-safe messages for 4xx", async () => {
    app = buildAppWithThrowingRoute("unknown feature flag", 404);
    const res = await app.inject({ method: "GET", url: "/api/v1/server/boom" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as Record<string, string>;
    expect(body.error).toBe("request_error");
    expect(body.message).toBe("unknown feature flag");
    expect(body.request_id).toBeTruthy();
  });

  it("never echoes Authorization or Cookie values in error bodies", async () => {
    app = buildAppWithThrowingRoute("boom");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/server/boom",
      headers: {
        authorization: "Bearer secret-token-123",
        cookie: "session=topsecret",
      },
    });
    expect(res.statusCode).toBe(500);
    expect(res.payload).not.toContain("secret-token-123");
    expect(res.payload).not.toContain("topsecret");
  });

  it("returns the local 404 body for unknown API routes", async () => {
    app = buildServer(loadConfig({}), { logger: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/unknown-smoke" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ detail: "Route not found" });
  });
});

describe("safe header access", () => {
  function fakeRequest(headers: Record<string, string | string[]>): FastifyRequest {
    return { headers } as unknown as FastifyRequest;
  }

  it("returns ordinary headers and normalizes arrays", () => {
    expect(readHeader(fakeRequest({ accept: "application/json" }), "Accept")).toBe(
      "application/json",
    );
    expect(readHeader(fakeRequest({ "x-thing": ["a", "b"] }), "x-thing")).toBe("a");
    expect(readHeader(fakeRequest({}), "x-missing")).toBeUndefined();
  });

  /**
   * The log itself, not the list. Asserting the constant only said the names
   * were typed somewhere; what has to hold is that the bytes pino emits for a
   * request carrying every one of these headers contain none of their values.
   *
   * Worth knowing while reading this: what actually keeps them out today is
   * Fastify's own `req` serializer, which reduces the request to method, url
   * and address and never reaches `headers`. `LOG_REDACT_PATHS` is the second
   * line — it is what would catch a custom serializer, or a handler logging a
   * request-shaped object — and it is unreachable while the default serializer
   * stands. This test pins the outcome either way.
   */
  it("keeps credential-bearing request headers out of what the logger emits", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) { lines.push(String(chunk)); done(); },
    });
    const config = loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
      SERVER_LOG_LEVEL: "info",
    });
    // Only `logStream`: passing `logger` too takes the override branch and the
    // stream is ignored, which is how a test like this reads as passing while
    // asserting nothing.
    const app = createServerApp(config, { logStream: stream });
    registerGatewayConventions(app, config);
    app.get("/api/v1/logging-probe", async (request, reply) => {
      // The ordinary thing a handler does when it wants the request in the log.
      request.log.info({ req: request, res: reply }, "logging probe");
      return reply.send({ ok: true });
    });
    await app.ready();

    const secrets = {
      authorization: "Bearer bearer-secret-value",
      "proxy-authorization": "Basic proxy-secret-value",
      cookie: "session=cookie-secret-value",
      "x-api-key": "x-api-key-secret-value",
      "api-key": "api-key-secret-value",
      "x-goog-api-key": "goog-secret-value",
      "anthropic-auth-token": "anthropic-secret-value",
      "x-rainver-internal-token": "internal-secret-value",
    };
    const response = await app.inject({ method: "GET", url: "/api/v1/logging-probe", headers: secrets });
    expect(response.statusCode).toBe(200);
    await app.close();

    const emitted = lines.join("");
    expect(emitted).not.toBe("");
    for (const value of Object.values(secrets)) {
      expect(emitted, value).not.toContain(value);
    }
    // The probe really did emit these lines, so the absences above are about
    // what the logger writes rather than about an empty stream.
    expect(emitted).toContain("logging probe");
    expect(emitted).toContain("/api/v1/logging-probe");
  });

  /**
   * And the list itself, because the test above cannot see it.
   *
   * With the default `req` serializer these paths never match, so removing one
   * changes nothing that a captured log line can show. That makes this the only
   * assertion that notices a name being dropped — pino matches a path exactly,
   * with no substring rule, so each spelling has to stay listed.
   */
  /**
   * Every API response is somebody's private content answered against their
   * session cookie, so nothing may keep a copy — not a shared proxy, and not
   * the browser's own back/forward cache, which is the residue logout exists
   * to clear.
   */
  it("marks every API response no-store, and leaves other responses alone", async () => {
    __setHealthDatabaseForTests({ async query<Row>() { return { rows: [{ healthy: 1 } as Row], rowCount: 1 }; } });
    app = buildServer(loadConfig({}), { logger: false });
    const api = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(api.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate, private");

    const health = await app.inject({ method: "GET", url: "/health" });
    // Not an API route; whatever it says about caching is its own business.
    expect(health.headers["cache-control"]).not.toBe("no-store, no-cache, must-revalidate, private");
  });

  it("lists every credential-bearing header spelling as a redact path", () => {
    expect(LOG_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        "req.headers.authorization",
        "req.headers['proxy-authorization']",
        "req.headers.cookie",
        "req.headers['x-api-key']",
        "req.headers['api-key']",
        "req.headers['x-goog-api-key']",
        "req.headers['anthropic-auth-token']",
        "req.headers['x-rainver-internal-token']",
        "res.headers['set-cookie']",
      ]),
    );
  });

  it("refuses to return Authorization, Cookie and Proxy-Authorization", () => {
    const request = fakeRequest({
      authorization: "Bearer secret-token-123",
      cookie: "session=topsecret",
      "proxy-authorization": "Basic secret",
    });
    expect(readHeader(request, "authorization")).toBeUndefined();
    expect(readHeader(request, "Authorization")).toBeUndefined();
    expect(readHeader(request, "cookie")).toBeUndefined();
    expect(readHeader(request, "proxy-authorization")).toBeUndefined();
  });
});
