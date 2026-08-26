import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { runsModule } from "../src/modules/runs/index.js";
import { loadConfig } from "../src/config.js";
import { __setRunsCommandServicesFactoryForTests, __setRunsIdentityForTests, __setRunsReadResponseForTests } from "../src/modules/runs/routes.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

let app: FastifyInstance;

afterEach(async () => {
  __setRunsCommandServicesFactoryForTests(null);
  __setRunsIdentityForTests(null);
  __setRunsReadResponseForTests(null);
  await app?.close();
});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    run_type: "agent",
    status: "running",
    mode: "live",
    prompt: "Say hello",
    instruction: null,
    project_folder_id: null,
    session_id: null,
    project_id: null,
    adapter_type: "model_api",
    model_provider_id: "provider-1",
    required_sandbox_level: "none",
    trigger_origin: "manual",
    error_message: null,
    started_at: "2026-06-12T10:00:00.000Z",
    ended_at: null,
    ...overrides,
  };
}

function runsConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

describe("runs command routes", () => {
  it("executes a run without accepting request-body execution overrides", async () => {
    __setRunsIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let currentRun = run({ status: "succeeded", ended_at: "2026-06-12T10:00:01.000Z" });
    __setRunsCommandServicesFactoryForTests(() => ({
      repository: {
        async getVisibleRun() {
          return currentRun;
        },
      },
      orchestration: {
        async executeRun(input) {
          const raw = input as unknown as Record<string, unknown>;
          if ("prompt" in raw || "adapter_config" in raw || "sandbox_cwd" in raw) {
            currentRun = run({ status: "failed", error_message: "unsafe override accepted" });
          }
          return { run_id: input.run_id, status: "succeeded" };
        },
        async cancelRun() {
          throw new Error("cancel should not run");
        },
      },
    }));
    app = buildModuleServer(runsConfig(), [runsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs/run-1/execute?space_id=space-1",
      payload: {
        prompt: "override",
        adapter_config: { executable_path: "/tmp/attacker-binary", permission_bypass: true },
        sandbox_cwd: "/tmp/attacker-cwd",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-legacy-read"]).toBeUndefined();
    expect(res.json()).toMatchObject({
      id: "run-1",
      space_id: "space-1",
      agent_id: "agent-1",
      status: "succeeded",
      mode: "live",
      resolved_model: {
        provider_id: "provider-1",
        provider_name: null,
        adapter_model_support: "uses_model",
      },
    });
  });

  it("executes via the service-authenticated internal route", async () => {
    __setRunsCommandServicesFactoryForTests(() => ({
      repository: {
        async getVisibleRun() {
          return run();
        },
      },
      orchestration: {
        async executeRun(input) {
          return {
            run_id: input.run_id,
            status: input.command_source === "internal" ? "succeeded" : "failed",
          };
        },
        async cancelRun() {
          throw new Error("cancel should not run");
        },
      },
    }));
    app = buildModuleServer(runsConfig(), [runsModule]);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/internal/runs/execute",
      payload: { run_id: "run-1", space_id: "space-1" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const missingIds = await app.inject({
      method: "POST",
      url: "/internal/runs/execute",
      headers: { "x-rainver-internal-token": "internal-token" },
      payload: { run_id: "run-1" },
    });
    expect(missingIds.statusCode).toBe(422);

    const res = await app.inject({
      method: "POST",
      url: "/internal/runs/execute",
      headers: { "x-rainver-internal-token": "internal-token" },
      payload: { run_id: "run-1", space_id: "space-1", worker_id: "chat-worker" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ run_id: "run-1", status: "succeeded" });
  });

  it("stops a visible run and returns the public cancelled shape", async () => {
    __setRunsIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let currentRun = run();
    __setRunsCommandServicesFactoryForTests(() => ({
      repository: {
        async getVisibleRun() {
          return currentRun;
        },
      },
      orchestration: {
        async executeRun() {
          throw new Error("execute should not run");
        },
        async cancelRun(input) {
          currentRun = run({
            id: input.run_id,
            status: "cancelled",
            ended_at: "2026-06-12T10:00:02.000Z",
          });
          return { run_id: input.run_id, status: "cancelled", error_code: "run_cancelled" };
        },
      },
    }));
    app = buildModuleServer(runsConfig(), [runsModule]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/runs/run-1/stop?space_id=space-1",
      payload: { reason: "stop" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: "run-1",
      status: "cancelled",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      changed: true,
    });
  });
});
