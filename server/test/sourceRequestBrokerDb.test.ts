import { randomUUID } from "node:crypto";
import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { fixtureServerGuard } from "./support/outboundGuard.js";
import { createSourceRequestBroker, type SourceRequestGrant } from "../src/modules/sources/sourceRequestBroker.js";
import { sourceQuotaGroup } from "../src/modules/sources/sourceRequestQuota.js";
const db = useTestDatabase(import.meta.filename);
const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function fixture(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("fixture failed");
  return `http://127.0.0.1:${addr.port}`;
}
function grant(origin: string, overrides: Partial<SourceRequestGrant> = {}): SourceRequestGrant {
  return { scopeId:randomUUID(),quotaGroup: sourceQuotaGroup(randomUUID(), "test-endpoint"), quota: [{ window: "minute", limit: 10 }, { window: "day", limit: 10 }],
    routes: [{ origin, path_prefix: "/api", methods: ["GET"], query_keys:["page"] }], maxBytes: 4096, deadlineMs: 1000,
    authorize: async () => {}, ...overrides };
}

describe("source request broker authority", () => {
  it("rechecks scope and counts every redirect hop before sending", async () => {
    let hits = 0;
    const origin = await fixture((req, res) => { hits++; if (req.url === "/api/start") { res.writeHead(302, { location: "/api/next" }); res.end(); } else { res.end('{"ok":true}'); } });
    const policy = grant(origin); let checks = 0; policy.authorize = async () => { checks++; };
    const broker = createSourceRequestBroker(db.pool, policy, new AbortController().signal, fixtureServerGuard);
    expect((await broker({ sequence: 1, url: origin + "/api/start", method: "GET" })).status).toBe(200);
    expect(hits).toBe(2); expect(checks).toBeGreaterThanOrEqual(2);
    const state = await db.pool.query(`SELECT windows_json FROM source_request_quota_state WHERE group_key=$1`, [policy.quotaGroup]);
    expect(state.rows[0].windows_json.day.used).toBe(2);
  });
  it("blocks redirect scope escape, forged identity, alternative method and replay", async () => {
    let outside = 0;
    const origin = await fixture((req, res) => { if (req.url === "/api/start") { res.writeHead(302, { location: "/outside" }); res.end(); } else { outside++; res.end(); } });
    const broker = createSourceRequestBroker(db.pool, grant(origin), new AbortController().signal, fixtureServerGuard);
    await expect(broker({ sequence: 1, url: origin + "/api/start", method: "GET" })).rejects.toThrow("scope");
    await expect(broker({ sequence: 2, url: origin + "/api", method: "GET", quotaGroup: "other" })).rejects.toThrow();
    await expect(broker({ sequence: 2, url: origin + "/api", method: "POST" })).rejects.toThrow();
    await expect(broker({ sequence: 1, url: origin + "/api", method: "GET" })).rejects.toThrow("channel");
    await expect(broker({sequence:2,url:origin+"/api/%2e%2e%2foutside",method:"GET"})).rejects.toThrow("scope");
    expect(outside).toBe(0);
  });
  it("honors shared 429 cooldown for another run without sending", async () => {
    let hits = 0;
    const origin = await fixture((_req, res) => { hits++; res.writeHead(429, { "retry-after": "120" }); res.end(); });
    const policy = grant(origin);
    const make = () => createSourceRequestBroker(db.pool, policy, new AbortController().signal, fixtureServerGuard);
    expect((await make()({ sequence: 1, url: origin + "/api", method: "GET" })).status).toBe(429);
    await expect(make()({ sequence: 1, url: origin + "/api", method: "GET" })).rejects.toThrow("quota");
    expect(hits).toBe(1);
  });
  it("stops pagination at the hard daily limit shared by separate runs", async () => {
    let hits = 0; const origin = await fixture((_req, res) => { hits++; res.end('{"next":2}'); });
    const policy = grant(origin, { quota: [{ window: "minute", limit: 10 }, { window: "day", limit: 2 }] });
    const make = () => createSourceRequestBroker(db.pool, policy, new AbortController().signal, fixtureServerGuard);
    await make()({ sequence: 1, url: origin + "/api?page=1", method: "GET" });
    await make()({ sequence: 1, url: origin + "/api?page=2", method: "GET" });
    await expect(make()({ sequence: 1, url: origin + "/api?page=3", method: "GET" })).rejects.toThrow("quota");
    expect(hits).toBe(2);
  });
  it("does not expose credentials in responses or response headers", async () => {
    const secret = "fixture-source-key";
    const origin="https://secure.example.test";
    vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>new Response(JSON.stringify({echo:(init?.headers as Record<string,string>).authorization}),{headers:{"set-cookie":secret}}));
    const policy=grant(origin); policy.routes=[{origin,path_prefix:"/api",methods:["GET"],credentialHeaders:async()=>({authorization:"Bearer "+secret})}];
    const broker = createSourceRequestBroker(db.pool, policy, new AbortController().signal, fixtureServerGuard);
    const response = await broker({ sequence: 1, url: origin + "/api", method: "GET" });
    expect(Buffer.from(response.body_base64, "base64").toString()).not.toContain(secret);
    expect(response).not.toHaveProperty("set-cookie");
  });
  it("refuses revoked authority, cancellation and body overflow without fallback", async () => {
    let hits = 0; const origin = await fixture((_req, res) => { hits++; res.end("x".repeat(100)); });
    const signal = new AbortController();
    const broker = createSourceRequestBroker(db.pool, grant(origin, { maxBytes: 10 }), signal.signal, fixtureServerGuard);
    await expect(broker({ sequence: 1, url: origin + "/api", method: "GET" })).rejects.toThrow("source_response_too_large");
    signal.abort();
    await expect(broker({ sequence: 2, url: origin + "/api", method: "GET" })).rejects.toThrow("cancelled");
    const revoked = createSourceRequestBroker(db.pool, grant(origin, { authorize: async () => { throw new Error("revoked"); } }), new AbortController().signal, fixtureServerGuard);
    await expect(revoked({ sequence: 1, url: origin + "/api", method: "GET" })).rejects.toThrow("revoked");
    expect(hits).toBe(1);
  });
});
