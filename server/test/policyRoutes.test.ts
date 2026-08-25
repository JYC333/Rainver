import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer";
import { policyModule } from "../src/modules/policy";
import { loadConfig } from "../src/config";

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

function policyConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

describe("policy internal routes", () => {
  it("registers proposal-apply route behind service token auth", async () => {
    app = buildModuleServer(policyConfig(), [policyModule]);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/internal/policy/enforce-proposal-apply",
      payload: {
        user_id: "u1",
        space_id: "s1",
        proposal_id: "p1",
        proposal_type: "memory_create",
        membership_role: "owner",
        supported_proposal_types: ["memory_create"],
      },
    });
    expect(unauthorized.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "POST",
      url: "/internal/policy/enforce-proposal-apply",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: {
        user_id: "u1",
        space_id: "s1",
        proposal_id: "p1",
        proposal_type: "memory_create",
        membership_role: "owner",
      },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
