import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer";
import { systemModule } from "../src/modules/system";
import { loadConfig } from "../src/config";
import {
  computeFeatures,
  isProtocolPackageDetected,
} from "../src/modules/system";

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

describe("server-owned features route", () => {
  it("advertises the public server feature list", async () => {
    app = buildModuleServer(loadConfig({}), [systemModule]);
    const res = await app.inject({ method: "GET", url: "/api/v1/server/features" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { service: string; features: string[] };
    expect(body.service).toBe("server");
    expect(body.features).toEqual(
      expect.arrayContaining([
        "server_health",
        "runs_server_authority",
        "proposals_server_authority",
        "memory_server_authority",
        "providers_credentials_server_authority",
        "notification_webhook_egress_policy_gate",
      ]),
    );
    expect(new Set(body.features).size).toBe(body.features.length);
  });

  it("exposes the product feature-list route used by the frontend", async () => {
    app = buildModuleServer(loadConfig({}), [systemModule]);
    const res = await app.inject({ method: "GET", url: "/api/v1/features" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; name: string; enabled: boolean; always_on: boolean }>;
    expect(body).toContainEqual({
      id: "server_health",
      name: "server_health",
      enabled: true,
      always_on: true,
    });
  });

  it("detects the @agent-space/protocol package (declared file dependency)", () => {
    expect(isProtocolPackageDetected()).toBe(true);
    expect(computeFeatures(loadConfig({}))).toContain("protocol_package_detected");
  });

  it("advertises notification_webhook_egress only when policy enables it", () => {
    expect(computeFeatures(loadConfig({}))).not.toContain("notification_webhook_egress");
    const enabled = computeFeatures(
      loadConfig({
        SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS: "true",
        SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST:
          "https://hooks.example.com/proposal",
      }),
    );
    expect(enabled).toContain("notification_webhook_egress");
  });
});
