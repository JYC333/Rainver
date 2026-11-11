import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { notificationsModule } from "../src/modules/notifications/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests } from "../src/modules/auth/identity.js";
import { deniedAuthRepository } from "./support/routeFakes.js";

let app: FastifyInstance;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
  await app?.close();
});

describe("notification webhook egress", () => {
  it("requires authentication for webhook policy", async () => {
    __setAuthRepositoryForTests(deniedAuthRepository());
    app = buildModuleServer(loadConfig({}), [notificationsModule]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/server/notifications/webhooks/policy",
    });
    expect(res.statusCode).toBe(401);
  });

  it("exposes webhook egress policy state", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
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

  // Dispatch is `notification.webhook.dispatch` (a system command): refusal, the loopback send,
  // payload redaction and the unconfirmed-send rule run on real PostgreSQL in
  // `settingsOperationsDb.test.ts`.
});
