import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { proposalsModule } from "../src/modules/proposals/index.js";
import { loadConfig } from "../src/config.js";
import { __setProposalIdentityForTests, __setProposalServicesFactoryForTests } from "../src/modules/proposals/routes.js";
import { ProposalApplyHttpError } from "../src/modules/proposals/applyService.js";
import { UnknownProposalApplierError } from "../src/modules/proposals/applierRegistry.js";
import type { ProposalOut, ProposalPage } from "@agent-space/protocol";

let app: FastifyInstance;

afterEach(async () => {
  __setProposalIdentityForTests(null);
  __setProposalServicesFactoryForTests(null);
  await app?.close();
});

function proposalsConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
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
            items: [proposal({ proposal_type: filters.proposalType ?? "memory_create" })],
            total: 1,
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

  it("serves accept, reject, and egress approval response shapes", async () => {
    __setProposalIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProposalServicesFactoryForTests(() => ({
      repository: {
        async listVisible() {
          throw new Error("listVisible should not run");
        },
        async getVisible() {
          throw new Error("getVisible should not run");
        },
      },
      applyService: {
        async accept(proposalId, _identity, options) {
          return {
            proposal: proposal({
              id: proposalId,
              status: "accepted",
              decided_at: "2026-06-14T10:01:00.000Z",
            }),
            result_type: "code_patch_apply",
            result: {
              updated_paths: options?.confirmIncompletePatch ? ["README.md"] : [],
            },
          };
        },
        async reject(proposalId) {
          return proposal({ id: proposalId, status: "rejected" });
        },
        async approveEgressGrantingUser(proposalId, identity, grantId) {
          return {
            id: "approval-1",
            proposal_id: proposalId,
            approval_type: "egress_granting_user",
            approver_user_id: identity.userId,
            grant_id: grantId,
            target_space_id: identity.spaceId,
            status: "approved",
            metadata_json: {},
            created_at: "2026-06-14T10:02:00.000Z",
            revoked_at: null,
          };
        },
        async rollback() {
          return { rolled_back_paths: ["README.md"] };
        },
      },
    }));
    app = buildModuleServer(proposalsConfig(), [proposalsModule]);

    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/proposals/proposal-1/accept?confirm_incomplete_patch=true",
    });
    const reject = await app.inject({
      method: "POST",
      url: "/api/v1/proposals/proposal-2/reject",
    });
    const approval = await app.inject({
      method: "POST",
      url: "/api/v1/proposals/proposal-3/approvals/egress-granting-user",
      payload: { grant_id: "grant-1" },
    });

    expect(accept.statusCode).toBe(200);
    expect(accept.json()).toMatchObject({
      proposal: { id: "proposal-1", status: "accepted" },
      result_type: "code_patch_apply",
      result: { updated_paths: ["README.md"] },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json()).toMatchObject({ id: "proposal-2", status: "rejected" });
    expect(approval.statusCode).toBe(200);
    expect(approval.json()).toMatchObject({
      id: "approval-1",
      proposal_id: "proposal-3",
      grant_id: "grant-1",
      approver_user_id: "user-1",
      status: "approved",
    });
  });

  it("rejects invalid incomplete code patch confirmation query values", async () => {
    __setProposalIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProposalServicesFactoryForTests(() => ({
      repository: {
        async listVisible() { throw new Error("should not run"); },
        async getVisible() { throw new Error("should not run"); },
      },
      applyService: {
        async accept() { throw new Error("accept should not run"); },
        async reject() { throw new Error("reject should not run"); },
        async approveEgressGrantingUser() { throw new Error("approval should not run"); },
        async rollback() { throw new Error("rollback should not run"); },
      },
    }));
    app = buildModuleServer(proposalsConfig(), [proposalsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/proposals/proposal-1/accept?confirm_incomplete_patch=maybe",
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      detail: expect.stringContaining("confirm_incomplete_patch"),
    });
  });

  it("returns 422 when accept is called for an unregistered proposal type (fail-closed)", async () => {
    __setProposalIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProposalServicesFactoryForTests(() => ({
      repository: {
        async listVisible() { throw new Error("should not run"); },
        async getVisible() { throw new Error("should not run"); },
      },
      applyService: {
        async accept() { throw new UnknownProposalApplierError("code_patch"); },
        async reject() { throw new Error("should not run"); },
        async approveEgressGrantingUser() { throw new Error("should not run"); },
        async rollback() { throw new Error("should not run"); },
      },
    }));
    app = buildModuleServer(proposalsConfig(), [proposalsModule]);
    const res = await app.inject({ method: "POST", url: "/api/v1/proposals/proposal-1/accept" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ detail: expect.stringContaining("code_patch") });
  });

  it("returns 403 when the policy gate blocks apply before the applier runs", async () => {
    __setProposalIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProposalServicesFactoryForTests(() => ({
      repository: {
        async listVisible() { throw new Error("should not run"); },
        async getVisible() { throw new Error("should not run"); },
      },
      applyService: {
        async accept() {
          throw new ProposalApplyHttpError(403, { code: "policy_denied", message: "policy denied" });
        },
        async reject() { throw new Error("should not run"); },
        async approveEgressGrantingUser() { throw new Error("should not run"); },
        async rollback() { throw new Error("should not run"); },
      },
    }));
    app = buildModuleServer(proposalsConfig(), [proposalsModule]);
    const res = await app.inject({ method: "POST", url: "/api/v1/proposals/proposal-1/accept" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ detail: { code: "policy_denied" } });
  });

  it("maps applier errors with statusCode without converting them to 500", async () => {
    class PrivatePacketError extends Error {
      readonly statusCode = 403;
    }

    __setProposalIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProposalServicesFactoryForTests(() => ({
      repository: {
        async listVisible() { throw new Error("should not run"); },
        async getVisible() { throw new Error("should not run"); },
      },
      applyService: {
        async accept() {
          throw new PrivatePacketError("memory maintenance packet is private to its creator");
        },
        async reject() { throw new Error("should not run"); },
        async approveEgressGrantingUser() { throw new Error("should not run"); },
        async rollback() { throw new Error("should not run"); },
      },
    }));
    app = buildModuleServer(proposalsConfig(), [proposalsModule]);

    const res = await app.inject({ method: "POST", url: "/api/v1/proposals/proposal-1/accept" });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      detail: "memory maintenance packet is private to its creator",
    });
  });
});
