import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthRepositoryForTests, type AuthRepository } from "../src/modules/auth/identity.js";
import { envForNetworkProfile, type ResolvedNetworkProfile, shouldBypassProxy, validateNetworkProfileInput } from "../src/modules/networkProfiles/transport.js";
import { networkProfilesModule } from "../src/modules/networkProfiles/index.js";
import { buildModuleServer } from "./support/moduleServer.js";

describe("networkProfiles", () => {
  function profile(overrides: Partial<ResolvedNetworkProfile> = {}): ResolvedNetworkProfile {
    return {
      id: "network-1",
      space_id: "space-1",
      name: "Local proxy",
      mode: "http_proxy",
      proxy_url: "http://127.0.0.1:7890",
      no_proxy: "localhost,127.0.0.1,::1,.internal",
      enabled: true,
      ...overrides,
    };
  }

  describe("network profile transport", () => {
    it("validates HTTP proxy profiles and rejects credential-bearing or socks URLs", () => {
      expect(validateNetworkProfileInput({
        mode: "http_proxy",
        proxy_url: "http://127.0.0.1:7890",
      })).toMatchObject({
        mode: "http_proxy",
        proxy_url: "http://127.0.0.1:7890",
      });

      expect(() => validateNetworkProfileInput({
        mode: "http_proxy",
        proxy_url: "socks5://127.0.0.1:7891",
      })).toThrow("http:// or https://");

      expect(() => validateNetworkProfileInput({
        mode: "http_proxy",
        proxy_url: "http://user:pass@proxy.example.com:8080",
      })).toThrow("must not contain credentials");
    });

    it("turns enabled HTTP proxy profiles into safe CLI proxy env", () => {
      expect(envForNetworkProfile(profile())).toMatchObject({
        HTTP_PROXY: "http://127.0.0.1:7890",
        HTTPS_PROXY: "http://127.0.0.1:7890",
        ALL_PROXY: "http://127.0.0.1:7890",
        NO_PROXY: "localhost,127.0.0.1,::1,.internal",
        http_proxy: "http://127.0.0.1:7890",
      });

      expect(envForNetworkProfile(profile({ enabled: false }))).toEqual({});
      expect(envForNetworkProfile(profile({ mode: "direct", proxy_url: null }))).toEqual({});
    });

    it("matches no_proxy exact hosts, ports, suffixes, and wildcard", () => {
      expect(shouldBypassProxy("http://localhost:3000/api", "localhost")).toBe(true);
      expect(shouldBypassProxy("http://127.0.0.1:11434/api", "127.0.0.1")).toBe(true);
      expect(shouldBypassProxy("https://api.internal/v1", ".internal")).toBe(true);
      expect(shouldBypassProxy("https://api.example.com/v1", "*.example.com")).toBe(true);
      expect(shouldBypassProxy("https://api.openai.com/v1", "*")).toBe(true);
      expect(shouldBypassProxy("https://api.openai.com/v1", "localhost,.internal")).toBe(false);
    });
  });
});

describe("networkProfilesRoutes", () => {
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
        loadConfig({ SERVER_DATABASE_URL: "postgresql://server_ro@db:5432/rainver" }), [networkProfilesModule], { logger: false },);

      const res = await app.inject({ method: "GET", url: "/api/v1/network-profiles" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ detail: "Requires space owner or admin role" });
    });
  });
});
