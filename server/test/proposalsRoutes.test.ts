import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { proposalsModule } from "../src/modules/proposals/index.js";
import { loadConfig } from "../src/config.js";
import { __setProposalIdentityForTests, __setProposalServicesFactoryForTests } from "../src/modules/proposals/routes.js";
import type { ProposalOut, ProposalPage } from "@rainver/protocol";

let app: FastifyInstance;

afterEach(async () => {
  __setProposalIdentityForTests(null);
  __setProposalServicesFactoryForTests(null);
  await app?.close();
});

function proposalsConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
  });
}

function proposal(overrides: Partial<ProposalOut> = {}): ProposalOut {
  return {
    id: "proposal-1",
    space_id: "space-1",
    user_id: "user-1",
    project_folder_id: null,
    source_session_id: null,
    source_task_id: null,
    source_run_id: null,
    created_by_run_id: null,
    proposal_type: "memory_create",
    target_scope: "",
    target_namespace: "",
    memory_type: "",
    proposed_title: "Remember this",
    proposed_content: "content",
    rationale: "",
    status: "pending",
    risk_level: "low",
    urgency: "normal",
    visibility: "space_shared",
    preview: false,
    review_deadline: null,
    expires_at: null,
    expired: false,
    created_at: "2026-06-14T10:00:00.000Z",
    decided_at: null,
    resulting_memory_id: null,
    owner_user_id: null,
    subject_user_id: null,
    sensitivity_level: null,
    access_level: "full",
    provenance_entries: null,
    source_activity_id: null,
    grant_id: null,
    required_approver_user_id: null,
    requires_approval_type: null,
    egress_approval_status: null,
    egress_approval_id: null,
    project_id: null,
    ...overrides,
  };
}

describe("proposal review routes", () => {
  it("serves proposal list with the public page shape", async () => {
    __setProposalIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProposalServicesFactoryForTests(() => ({
      repository: {
        async listVisible(_spaceId, _userId, filters) {
          return {
            items: (filters.proposalTypes ?? [filters.proposalType ?? "memory_create"])
              .map((proposal_type) => proposal({ proposal_type })),
            total: filters.proposalTypes?.length ?? 1,
            limit: filters.limit,
            offset: filters.offset,
          } satisfies ProposalPage;
        },
        async getVisible() {
          throw new Error("getVisible should not run");
        },
      },
      applyService: {
        async accept() {
          throw new Error("accept should not run");
        },
        async reject() {
          throw new Error("reject should not run");
        },
        async approveEgressGrantingUser() {
          throw new Error("approval should not run");
        },
        async rollback() {
          throw new Error("rollback should not run");
        },
      },
    }));
    app = buildModuleServer(proposalsConfig(), [proposalsModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/proposals?limit=25&offset=10&type=code_patch&expired=false",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      items: [{ proposal_type: "code_patch" }],
      total: 1,
      limit: 25,
      offset: 10,
    });

    const combined = await app.inject({ method: "GET", url: "/api/v1/proposals?limit=20&offset=8&types=claim_create,knowledge_archive" });
    expect(combined.statusCode).toBe(200);
    expect(combined.json()).toMatchObject({
      items: [{ proposal_type: "claim_create" }, { proposal_type: "knowledge_archive" }],
      total: 2, limit: 20, offset: 8,
    });
    const ambiguous = await app.inject({ method: "GET", url: "/api/v1/proposals?type=code_patch&types=claim_create" });
    expect(ambiguous.statusCode).toBe(422);
  });

  it("serves visible proposal details with the public proposal shape", async () => {
    __setProposalIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProposalServicesFactoryForTests(() => ({
      repository: {
        async listVisible() {
          throw new Error("listVisible should not run");
        },
        async getVisible(_spaceId, _userId, proposalId) {
          return proposal({ id: proposalId });
        },
      },
      applyService: {
        async accept() {
          throw new Error("accept should not run");
        },
        async reject() {
          throw new Error("reject should not run");
        },
        async approveEgressGrantingUser() {
          throw new Error("approval should not run");
        },
        async rollback() {
          throw new Error("rollback should not run");
        },
      },
    }));
    app = buildModuleServer(proposalsConfig(), [proposalsModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/proposals/proposal-1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "proposal-1", status: "pending" });
  });

});
