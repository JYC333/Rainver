/**
 * Tests for observable gateway behavior: request-id continuity, the server-owned
 * error envelope, unknown API route handling, and safe header access.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
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
