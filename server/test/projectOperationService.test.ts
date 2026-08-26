import { describe, expect, it, vi } from "vitest";
import { ProjectOperationService } from "../src/modules/projects/projectOperationService.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

describe("ProjectOperationService boundaries", () => {
  it("rejects unsupported link targets before target SQL", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ one: 1 }], rowCount: 1 });
    const service = new ProjectOperationService({ query } as Queryable);
    await expect(service.link("space-1", "project-1", "operation-1", "credential", "secret-1"))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects a job that is not scoped to the operation project", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ one: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const service = new ProjectOperationService({ query } as Queryable);
    await expect(service.link("space-1", "project-1", "operation-1", "job", "job-1"))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("creates the operation and its steps in one transaction",async()=>{const clientQuery=vi.fn(async(sql:string)=>{if(sql.includes("FROM projects"))return{rows:[{id:"project-1",owner_user_id:"user-1",status:"active"}],rowCount:1};if(sql.includes("SELECT status FROM project_operations"))return{rows:[{status:"draft"}],rowCount:1};if(sql.includes("SELECT * FROM project_operations"))return{rows:[{id:"operation-1"}],rowCount:1};if(sql.includes("SELECT 1 FROM project_operations"))return{rows:[{one:1}],rowCount:1};return{rows:[],rowCount:0};});const release=vi.fn();const query=vi.fn(async(sql:string)=>sql.includes("owner_user_id")?{rows:[{owner_user_id:"user-1"}],rowCount:1}:{rows:[{id:"project-1",status:"active"}],rowCount:1});const connect=vi.fn().mockResolvedValue({query:clientQuery,release});await new ProjectOperationService({query,connect} as unknown as Queryable).create({spaceId:"space-1",userId:"user-1"},"project-1",{kind:"source_backfill",title:"Import",steps:[{title:"Plan"}]});expect(clientQuery.mock.calls.map(call=>call[0])).toEqual(expect.arrayContaining(["BEGIN","COMMIT"]));expect(release).toHaveBeenCalledOnce();});
});
