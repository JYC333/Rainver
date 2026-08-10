import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import type { Queryable } from "../src/modules/routeUtils/common";
import { ProjectSourceProposalService } from "../src/modules/projects/projectSourceProposalService";

const identity = { spaceId: "space-1", userId: "user-1" };

describe("Project source composite command idempotency", () => {
  it("denies a Project viewer before creating a binding proposal",async()=>{
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes("SELECT id")&&sql.includes("FROM projects"))return{rows:[{id:"project-1",status:"active"}],rowCount:1};
      if(sql.includes("SELECT owner_user_id")&&sql.includes("FROM projects"))return{rows:[{owner_user_id:"user-2"}],rowCount:1};
      if(sql.includes("FROM space_memberships"))return{rows:[{role:"member"}],rowCount:1};
      if(sql.includes("FROM project_members"))return{rows:[{role:"viewer"}],rowCount:1};
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service=new ProjectSourceProposalService({query} as unknown as Queryable,loadConfig({}));
    await expect(service.proposeBind(identity,"project-1",{source_channel_id:"channel-1"})).rejects.toMatchObject({statusCode:403});
    expect(query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO proposals"))).toBe(false);
  });

  it("requires an idempotency key before creating a source setup operation", async () => {
    const query = vi.fn();
    const service = new ProjectSourceProposalService({ query } as Queryable, loadConfig({}));

    await expect(service.proposeSourceSetup(identity, "project-1", { preset_id: "arxiv" }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed when a source setup key is reused with different parameters", async () => {
    const query = vi.fn(async (sql: string) => {
      if(sql.includes("FROM projects"))return{rows:[{id:"project-1",owner_user_id:"user-1",status:"active"}],rowCount:1};
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("FROM project_operations") && sql.includes("idempotency")) {
        return { rows: [{ id: "operation-1", fingerprint: "different" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service = new ProjectSourceProposalService({ query } as unknown as Queryable, loadConfig({}));

    await expect(service.proposeSourceSetup(identity, "project-1", {
      idempotency_key: "setup-key",
      preset_id: "arxiv",
      search_query: "agents",
      binding: { binding_key: "default" },
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO project_operations"))).toBe(false);
  });

  it("rejects a backfill key owned by another Project binding before creating an operation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("effective_access_level")) return { rows: [{ effective_access_level: "full" }] };
      if(sql.includes("FROM projects"))return{rows:[{id:"project-1",owner_user_id:"user-1",status:"active"}],rowCount:1};
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("FROM project_source_bindings") && sql.includes("status='active'")) {
        return { rows: [{ source_channel_id: "channel-1" }] };
      }
      if (sql.includes("JOIN source_connectors")) {
        return { rows: [{ connector_key: "arxiv_api", source_connection_id: "connection-1" }] };
      }
      if (sql.includes("FROM source_backfill_plans") && sql.includes("idempotency_key") && sql.includes("FOR UPDATE")) {
        return { rows: [{
          id: "plan-old",
          project_source_binding_id: "binding-other-project",
          project_operation_id: "operation-old",
          strategy_json: {},
          quota_policy_json: {},
          proposal_id: "proposal-old",
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service = new ProjectSourceProposalService({ query } as unknown as Queryable, loadConfig({}));

    const command=service.proposeBackfill(identity, "project-1", "binding-1", {
      idempotency_key: "shared-key",
      strategy: { window_unit: "date_window", window_size: 30, max_items: 10 },
      quota_policy: { window: "minute", limit_count: 10 },
    });
    await expect(command).rejects.toMatchObject({ statusCode: 409 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO project_operations"))).toBe(false);
  });

  it("locks Project before the Source binding in backfill proposal transactions", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT owner_user_id") && sql.includes("FROM projects")) {
        return { rows: [{ owner_user_id: identity.userId }], rowCount: 1 };
      }
      if (sql.includes("FROM projects")) {
        return { rows: [{ id: "project-1", status: "active" }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("FROM project_source_bindings") && sql.includes("FOR UPDATE")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service = new ProjectSourceProposalService({ query } as unknown as Queryable, loadConfig({}));
    await expect(service.proposeBackfill(identity, "project-1", "binding-1", {
      idempotency_key: "lock-order",
    })).rejects.toMatchObject({ statusCode: 404 });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    const projectLock = statements.findIndex((sql) => sql.includes("FROM projects") && sql.includes("FOR UPDATE"));
    const bindingLock = statements.findIndex((sql) => sql.includes("FROM project_source_bindings") && sql.includes("FOR UPDATE"));
    expect(projectLock).toBeGreaterThanOrEqual(0);
    expect(bindingLock).toBeGreaterThan(projectLock);
  });
});
