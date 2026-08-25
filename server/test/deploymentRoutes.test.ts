import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer";
import { deploymentModule } from "../src/modules/deployment";
import { loadConfig } from "../src/config";
import { __setAuthIdentityForTests } from "../src/modules/auth";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  app = undefined;
});

describe("deployment trigger boundary", () => {
  it("keeps authenticated product deployment triggers fail-closed", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildModuleServer(loadConfig({}), [deploymentModule]);

    const list = await app.inject({ method: "GET", url: "/api/v1/deployments/jobs" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [] });

    const create = await app.inject({ method: "POST", url: "/api/v1/deployments/jobs" });
    expect(create.statusCode).toBe(501);
    expect(create.json()).toEqual({ detail: "deployment_jobs is not implemented" });

    const detail = await app.inject({ method: "GET", url: "/api/v1/deployments/jobs/job-1" });
    expect(detail.statusCode).toBe(501);
    expect(detail.json()).toEqual({ detail: "deployment_jobs is not implemented" });
  });
});
