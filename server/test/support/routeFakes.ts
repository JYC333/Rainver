import type { AuthRepository } from "../../src/modules/auth/index.js";

/** An auth repository that answers for one user in a team Space with the given role. */
export function fakeAuthRepository(role: "owner" | "admin" | "reviewer" | "member" | "guest" = "admin"): AuthRepository {
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
        created_by_user_id: "owner-1",
        created_at: "2026-06-18T00:00:00.000Z",
        updated_at: "2026-06-18T00:00:00.000Z",
      };
    },
    async getCurrentUser() { throw new Error("not used"); },
    async getUserSpaces() { throw new Error("not used"); },
    async logout() { throw new Error("not used"); },
    async findOrCreateFromGoogle() { throw new Error("not used"); },
    async createSession() { throw new Error("not used"); },
  };
}

/** A Space retrieval settings row as the knowledge routes read it. */
export function retrievalSettingsRow() {
  return {
    settings_json: {
      default_search_mode: "hybrid",
      rerank_enabled: false,
      query_rewrite_enabled: false,
      query_rewrite_default: false,
      use_query_cache: true,
      include_trace: false,
      external_egress_enabled: true,
      retrieval_tool_mode: "off",
      context_ops_review_mode: "private_only",
      context_ops_scan_mode: "admins",
      embedding_dimensions: 2560,
      max_results_default: 10,
    },
    created_at: "2026-06-12T10:00:00.000Z",
    updated_at: "2026-06-12T10:00:00.000Z",
  };
}
