import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer";
import { networkProfilesModule } from "../src/modules/networkProfiles";
import { loadConfig } from "../src/config";
import {
  __setAuthRepositoryForTests,
  type AuthRepository,
} from "../src/modules/auth";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthRepositoryForTests(null);
  await app?.close();
  app = undefined;
});

function authWithRole(role: string): AuthRepository {
  return {
    async resolveIdentity() {
      return { ok: true, spaceId: "space-1", userId: "user-1" };
    },
    async getSpaceForUser() {
      return {
        id: "space-1",
        name: "Team",
        type: "team",
        role,
        oversight_mode: "none",
        egress_notifications_enabled: true,
        member_count: 1,
        created_by_user_id: "user-1",
        created_at: "2026-06-18T00:00:00.000Z",
        updated_at: "2026-06-18T00:00:00.000Z",
      };
    },
    async getCurrentUser() {
      throw new Error("not used");
    },
    async getUserSpaces() {
      throw new Error("not used");
    },
    async logout() {
      throw new Error("not used");
    },
    async findOrCreateFromGoogle() {
      throw new Error("not used");
    },
    async createSession() {
      throw new Error("not used");
    },
  };
}

describe("network profile route authority", () => {
  it("denies non-admin space members before exposing space network settings", async () => {
    __setAuthRepositoryForTests(authWithRole("member"));
    app = buildModuleServer(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server_ro@db:5432/agent_space" }), [networkProfilesModule], { logger: false },);

    const res = await app.inject({ method: "GET", url: "/api/v1/network-profiles" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ detail: "Requires space owner or admin role" });
  });
});
