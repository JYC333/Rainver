import { describe, expect, it, vi } from "vitest";
import { ActionApprovalGrantService } from "../src/modules/policy/actionApprovalGrantService.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

describe("ActionApprovalGrantService", () => {
  it("rejects never-grantable actions before inserting", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ one: 1 }], rowCount: 1 });
    const service = new ActionApprovalGrantService({ query } as Queryable);
    await expect(service.create({ databaseUrl: "" }, { spaceId: "space-1", userId: "owner-1" }, {
      agent_id: "agent-1", action_id: "policy.action_grant.create",
    })).rejects.toMatchObject({ statusCode: 422 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not consume grants for non-grantable actions", async () => {
    const query = vi.fn();
    const service = new ActionApprovalGrantService({ query } as Queryable);
    expect(await service.consumeMatching({ spaceId: "space-1", agentId: "agent-1", actionId: "proposal.apply" })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("atomically consumes a scoped grant under its use limit", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "grant-1", granted_by_user_id: "owner-1" }], rowCount: 1 });
    const service = new ActionApprovalGrantService({ query } as Queryable);
    const grant = await service.consumeMatching({ spaceId: "space-1", agentId: "agent-1", actionId: "project.source.propose_bind", projectId: "project-1" });
    expect(grant).toMatchObject({ id: "grant-1" });
    expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE SKIP LOCKED");
  });
});
