import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer";
import { notificationsModule } from "../src/modules/notifications";
import { loadConfig } from "../src/config";
import { startMockUpstream, type MockUpstream } from "./support/mockUpstream";

let app: FastifyInstance;
let target: MockUpstream | undefined;

afterEach(async () => {
  await app?.close();
  const current = target;
  target = undefined;
  await current?.close();
});

describe("notification webhook egress", () => {
  it("exposes webhook egress policy state", async () => {
    app = buildModuleServer(loadConfig({}), [notificationsModule]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/server/notifications/webhooks/policy",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: false,
      allowed_targets: 0,
      supported_event_types: ["proposal.pending"],
      max_payload_bytes: 65536,
    });
  });

  it("denies dispatch by default with a server error envelope", async () => {
    app = buildModuleServer(loadConfig({}), [notificationsModule]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/server/notifications/webhooks/dispatch",
      headers: { "content-type": "application/json", "x-request-id": "req-webhook" },
      payload: {
        target_url: "https://hooks.example.com/proposal",
        event_type: "proposal.pending",
        payload: { proposal_id: "p1" },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: "notification_webhook_egress_disabled",
      message: "Notification webhook egress is disabled",
      request_id: "req-webhook",
    });
  });

  it("dispatches JSON to an allowlisted target without forwarding client secrets", async () => {
    target = await startMockUpstream((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const targetUrl = `${target.baseUrl}/proposal`;
    app = buildModuleServer(
      loadConfig({
        SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS: "true",
        SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST: targetUrl,
      }), [notificationsModule], { logger: false },);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/server/notifications/webhooks/dispatch",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token-123",
        cookie: "session=abc",
      },
      payload: {
        target_url: targetUrl,
        event_type: "proposal.pending",
        payload: { proposal_id: "p1", title: "Review memory proposal" },
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      delivered: true,
      target_origin: target.baseUrl,
      upstream_status: 204,
    });
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0].method).toBe("POST");
    expect(target.requests[0].url).toBe("/proposal");
    expect(target.requests[0].headers.authorization).toBeUndefined();
    expect(target.requests[0].headers.cookie).toBeUndefined();
    expect(JSON.parse(target.requests[0].body)).toEqual({
      event_type: "proposal.pending",
      payload: { proposal_id: "p1", title: "Review memory proposal" },
    });
  });

  it("denies targets outside the allowlist without echoing the denied URL", async () => {
    app = buildModuleServer(
      loadConfig({
        SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS: "true",
        SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST:
          "https://hooks.example.com/proposal",
      }), [notificationsModule], { logger: false },);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/server/notifications/webhooks/dispatch",
      payload: {
        target_url: "https://attacker.example.com/proposal",
        event_type: "proposal.pending",
        payload: { proposal_id: "p1" },
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: "notification_webhook_target_denied",
    });
    expect(res.payload).not.toContain("attacker.example.com");
  });
});
