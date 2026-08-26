import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { __setHealthDatabaseForTests } from "../src/modules/system/service.js";

let app: FastifyInstance;

afterEach(async () => {
  __setHealthDatabaseForTests(null);
  await app?.close();
});

describe("server-owned health routes", () => {
  it("GET /health returns server liveness", async () => {
    __setHealthDatabaseForTests({ async query<Row>() { return { rows: [{ healthy: 1 } as Row], rowCount: 1 }; } });
    app = buildServer(loadConfig({}), { logger: false });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "server", checks: { database: "ok" } });
  });

  it("GET /api/v1/server/health returns server liveness", async () => {
    __setHealthDatabaseForTests({ async query<Row>() { return { rows: [{ healthy: 1 } as Row], rowCount: 1 }; } });
    app = buildServer(loadConfig({}), { logger: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/server/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "server", checks: { database: "ok" } });
  });

  it("returns 503 when database connectivity fails", async () => {
    __setHealthDatabaseForTests({ async query() { throw new Error("database unavailable"); } });
    app = buildServer(loadConfig({}), { logger: false });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "error",
      service: "server",
      checks: { database: "error" },
    });
  });

  it("does not serve the old /api/v1/gateway/health route", async () => {
    app = buildServer(loadConfig({}), { logger: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/gateway/health" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ detail: "Route not found" });
  });
});
