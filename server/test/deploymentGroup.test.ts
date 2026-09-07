import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  __setAuthIdentityForTests,
  __setAuthRepositoryForTests,
  type AuthRepository,
  type CurrentUser,
} from "../src/modules/auth/identity.js";
import { ALLOWED_DEPLOYER_JOB_TYPES, DeployerSocketClient } from "../src/modules/deployment/client.js";
import { deploymentModule } from "../src/modules/deployment/index.js";
import { DeploymentService } from "../src/modules/deployment/service.js";
import { DeploymentRepository } from "../src/modules/deployment/repository.js";
import { UNATTENDED_RUN_JOB_TYPES } from "../src/modules/deployment/drainAdmission.js";
import { scanAutomationsAndFire } from "../src/modules/automations/scheduler.js";
import { JobDeferredError, JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { buildJobHandlerRegistry } from "../src/modules/jobs/workerRuntime.js";
import { registerAgentRunHandler } from "../src/modules/runs/agentRunHandler.js";
import type {
  DeploymentHeartbeatRequest,
  DeploymentStageEventRequest,
} from "@rainver/protocol";
import { buildModuleServer } from "./support/moduleServer.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const AGENT_VERSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const INTERNAL_TOKEN = "internal-token-for-deployment-tests";
const DEPLOYER = "deployer-container-a";

const repoRoot = join(import.meta.dirname, "..", "..");
const db = useTestDatabase(import.meta.filename);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("deployer socket boundary", () => {
  it("limits submitted deployer jobs to the allowlist", async () => {
    expect([...ALLOWED_DEPLOYER_JOB_TYPES].sort()).toEqual([
      "health_check",
      "rebuild_rainver",
      "restart_rainver",
    ]);
    const client = new DeployerSocketClient({ deployerSocketPath: "/tmp/missing-deployer.sock" });
    await expect(client.submit("self_evolution_apply" as string)).resolves.toMatchObject({
      status: "failed",
      error: "Unknown deployer job_type: self_evolution_apply",
    });
  });

  it("keeps the privileged deployer socket limited to its three operator scripts", () => {
    const protocol = readFileSync(join(repoRoot, "deployer", "protocol.py"), "utf8");
    const deployer = readFileSync(join(repoRoot, "deployer", "deployer.py"), "utf8");
    // The socket maps exactly three job types to three scripts. update.sh
    // exists beside them but belongs to the pull loop and is unreachable from
    // the socket: the two entries stay separate (B43).
    const socketScripts = [...deployer.matchAll(/SCRIPT_DIR \/ "([a-z_]+\.sh)"/g)].map((match) => match[1]).sort();
    expect(socketScripts).toEqual(["health_check.sh", "rebuild.sh", "restart.sh"]);
    expect(deployer).not.toContain("update.sh");
    expect(protocol).not.toContain("code_patch");
    expect(deployer).not.toContain("code_patch");
    const allowedReferences = new Set([
      join(repoRoot, "server", "src", "modules", "deployment", "client.ts"),
      join(repoRoot, "server", "src", "modules", "deployment", "index.ts"),
    ]);
    const unexpectedCallers = sourceFiles(join(repoRoot, "server", "src"))
      .filter((path) => !allowedReferences.has(path))
      .filter((path) => readFileSync(path, "utf8").includes("DeployerSocketClient"));
    expect(unexpectedCallers).toEqual([]);
  });

  it("fails closed when the configured socket is absent", async () => {
    const client = new DeployerSocketClient({ deployerSocketPath: "/tmp/missing-deployer.sock" });
    await expect(client.submit("health_check")).resolves.toMatchObject({
      status: "failed",
      job_id: null,
    });
  });
});

describe("deployment authority", () => {
  let app: FastifyInstance | undefined;

  function config(rainverEnv = "prod") {
    return loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      INSTANCE_ADMIN_EMAIL: "admin@example.test",
      SERVER_INTERNAL_TOKEN: INTERNAL_TOKEN,
      RAINVER_ENV: rainverEnv,
    });
  }

  function service(rainverEnv = "prod"): DeploymentService {
    return new DeploymentService(db.pool, rainverEnv);
  }

  function user(id: string, email: string): CurrentUser {
    return {
      id,
      email,
      display_name: id,
      avatar_url: null,
      is_instance_admin: false,
      created_at: new Date().toISOString(),
      last_login_at: null,
    };
  }

  const internal = { [`x-rainver-internal-token`]: INTERNAL_TOKEN };

  /** A heartbeat from one deployer; identity is what scopes the release. */
  function beat(overrides: Partial<DeploymentHeartbeatRequest> = {}): DeploymentHeartbeatRequest {
    return {
      deployer_id: DEPLOYER,
      services: [],
      remote: null,
      docker_version: null,
      ...overrides,
    };
  }

  let events = 0;
  /** A stage report with its own id, which is what makes a retry idempotent. */
  function stageEvent(
    input: Omit<DeploymentStageEventRequest, "event_id">,
    eventId?: string,
  ): DeploymentStageEventRequest {
    events += 1;
    return { event_id: eventId ?? `event-${events}`, ...input };
  }

  beforeAll(async () => {
    if (!db.available) return;
    app = buildModuleServer(config(), [deploymentModule]);
  });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(db.pool, ["deployment_jobs", "deployment_observations", "spaces", "users"], {
      cascade: true,
    });
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO users (id,email,display_name,status,created_at,updated_at)
       VALUES ($1,'admin@example.test','Admin','active',$3,$3),
              ($2,'member@example.test','Member','active',$3,$3)`,
      [ADMIN, MEMBER, now],
    );
    const users: Record<string, CurrentUser> = {
      [ADMIN]: user(ADMIN, "admin@example.test"),
      [MEMBER]: user(MEMBER, "member@example.test"),
    };
    __setAuthRepositoryForTests({
      async getCurrentUser() {
        return users[ADMIN]!;
      },
    } as unknown as AuthRepository);
    // An instance whose deployer is beating, which is the precondition for
    // creating an update: a queued one defers every unattended Run, so it is
    // refused when nothing would claim it. The liveness tests below undo this.
    await service().heartbeat(beat());
  });

  afterEach(() => {
    __setAuthIdentityForTests(null);
    __setAuthRepositoryForTests(null);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("lets only the instance admin create a job, and only one at a time", async (ctx) => {
    if (!db.available || !app) return ctx.skip();

    __setAuthIdentityForTests({ userId: MEMBER, spaceId: SPACE } as never);
    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/deployments/jobs",
      payload: { job_type: "update" },
    });
    expect(refused.statusCode).toBe(403);
    expect((await db.pool.query(`SELECT id FROM deployment_jobs`)).rowCount).toBe(0);

    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/deployments/jobs",
      payload: { job_type: "update" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      job_type: "update",
      status: "queued",
      requested_by_user_id: ADMIN,
      drain_timeout_seconds: 600,
      current_stage: null,
      target_tag: null,
    });

    // The second request loses on the database's single-active index, not on a
    // prior read: two administrators can press Update in the same instant.
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/deployments/jobs",
      payload: { job_type: "check_update" },
    });
    expect(second.statusCode).toBe(409);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/deployments/jobs",
      payload: { job_type: "rebuild_rainver" },
    });
    expect(rejected.statusCode).toBe(422);
  });

  it("refuses an update outside production instead of queueing one that can only fail", async (ctx) => {
    if (!db.available) return ctx.skip();
    // dev and test build their images from a checkout the deployer does not
    // mount. A queued job would pause every unattended Run until it failed.
    await expect(service("dev").createJob("update", ADMIN)).rejects.toMatchObject({ statusCode: 422 });
    expect((await db.pool.query(`SELECT id FROM deployment_jobs`)).rowCount).toBe(0);
    expect(await service().updatePending()).toBe(false);

    // Reading which build is running is useful everywhere.
    expect((await service("dev").createJob("check_update", ADMIN)).status).toBe("queued");
  });

  it("hands a queued job to the deployer exactly once", async (ctx) => {
    if (!db.available) return ctx.skip();
    const job = await service().createJob("update", ADMIN);

    const first = await service().heartbeat(beat({
      services: [
        { service: "server", image_ref: "ghcr.io/x/server:stable", digest: "sha256:aaa", revision: "abc1234", surface: "surface-1" },
      ],
      docker_version: "27.0.0",
    }));
    expect(first.job).toEqual({ id: job.id, job_type: "update", drain_timeout_seconds: 600 });

    const claimed = (await db.pool.query<{ status: string; started_at: string | null }>(
      `SELECT status, started_at FROM deployment_jobs WHERE id = $1`,
      [job.id],
    )).rows[0]!;
    expect(claimed.status).toBe("running");
    expect(claimed.started_at).not.toBeNull();
    // Timestamps leave the repository as ISO strings, not pg Date objects.
    expect(typeof (await service().getJobDetail(job.id)).job.started_at).toBe("string");

    // The claim itself is the exactly-once step: a second one finds nothing
    // queued, so two deployers cannot run the same job.
    expect(await new DeploymentRepository(db.pool).claimQueuedJob(DEPLOYER)).toBeNull();
  });

  it("records stage events in order and ends the job at the failing stage", async (ctx) => {
    if (!db.available) return ctx.skip();
    const job = await service().createJob("update", ADMIN);
    await service().heartbeat(beat());

    await service().recordStageEvent(job.id, stageEvent({
      stage: "pull",
      status: "started",
      target_tag: "stable",
    }));
    await service().recordStageEvent(job.id, stageEvent({
      stage: "pull",
      status: "succeeded",
      result_json: { pulled: { server: "sha256:bbb" } },
    }));
    const failed = await service().recordStageEvent(job.id, stageEvent({
      stage: "migrate",
      status: "failed",
      log_tail: "pre-migration backup written: /rainver/db/dumps/pre-migrate-1.dump\nmigration failed",
    }));

    expect(failed.job).toMatchObject({
      status: "failed",
      failure_stage: "migrate",
      current_stage: "migrate",
      target_tag: "stable",
      result_json: { pulled: { server: "sha256:bbb" } },
    });
    expect(failed.job.ended_at).not.toBeNull();
    expect(failed.events.map((event) => [event.seq, event.stage, event.status])).toEqual([
      [0, "pull", "started"],
      [1, "pull", "succeeded"],
      [2, "migrate", "failed"],
    ]);
    expect(failed.events[2]!.log_tail).toContain("pre-migrate-1.dump");


    // A terminal job is not revived by a late event, and the slot is free.
    await expect(service().recordStageEvent(job.id, stageEvent({ stage: "health", status: "succeeded" })))
      .rejects.toMatchObject({ statusCode: 409 });
    const next = await service().createJob("update", ADMIN);
    expect(next.status).toBe("queued");
  });

  it("ends a job as succeeded on the deployer's last event", async (ctx) => {
    if (!db.available) return ctx.skip();
    const job = await service().createJob("update", ADMIN);
    await service().heartbeat(beat());

    // An over-long tail keeps its end, stays inside the bound, and never
    // stores the replacement characters a byte-boundary cut produces.
    const bounded = await service().recordStageEvent(job.id, stageEvent({
      stage: "pull",
      status: "succeeded",
      log_tail: `${"中".repeat(6000)}END`,
    }));
    const tail = bounded.events.at(-1)!.log_tail!;
    expect(tail.endsWith("END")).toBe(true);
    expect(tail.includes("\uFFFD")).toBe(false);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(8 * 1024);

    await service().recordStageEvent(job.id, stageEvent({ stage: "recreate", status: "succeeded" }));
    const running = await service().status();
    expect(running.active_job?.id).toBe(job.id);
    expect(running.last_job).toBeNull();

    const done = await service().recordStageEvent(job.id, stageEvent({
      stage: "health",
      status: "succeeded",
      terminal: true,
      result_json: { health: "ok" },
    }));
    expect(done.job).toMatchObject({
      status: "succeeded",
      failure_stage: null,
      error_text: null,
      current_stage: "health",
      result_json: { health: "ok" },
    });
    expect(done.job.ended_at).not.toBeNull();

    const after = await service().status();
    expect(after.active_job).toBeNull();
    expect(after.last_job?.id).toBe(job.id);
    expect((await service().listJobs(10)).map((entry) => entry.id)).toEqual([job.id]);
  });

  it("cancels only a job the deployer has not picked up", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);
    const job = await service().createJob("update", ADMIN);

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/deployments/jobs/${job.id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: "cancelled" });

    // Nothing is handed out after a cancel.
    expect((await service().heartbeat(beat())).job).toBeNull();

    const running = await service().createJob("update", ADMIN);
    await service().heartbeat(beat());
    const tooLate = await app.inject({
      method: "POST",
      url: `/api/v1/deployments/jobs/${running.id}/cancel`,
    });
    expect(tooLate.statusCode).toBe(409);
  });

  it("fails a running job whose deployer stopped reporting", async (ctx) => {
    if (!db.available) return ctx.skip();
    const job = await service().createJob("update", ADMIN);
    await service().heartbeat(beat());
    await service().recordStageEvent(job.id, stageEvent({ stage: "drain", status: "started" }));

    expect(await service().sweepLostJobs()).toBe(0);

    // The running threshold has to exceed the deployer's own per-stage budget,
    // or a slow pull would be swept while it is still working.
    await db.pool.query(
      `UPDATE deployment_jobs SET last_progress_at = now() - interval '31 minutes' WHERE id = $1`,
      [job.id],
    );
    expect(await service().sweepLostJobs()).toBe(0);
    await db.pool.query(
      `UPDATE deployment_jobs SET last_progress_at = now() - interval '61 minutes' WHERE id = $1`,
      [job.id],
    );
    expect(await service().sweepLostJobs()).toBe(1);

    const swept = await service().getJobDetail(job.id);
    expect(swept.job).toMatchObject({
      status: "failed",
      error_text: "deployer_lost",
      failure_stage: "drain",
    });
    // The single-active slot is released, so the next update is possible.
    expect((await service().createJob("update", ADMIN)).status).toBe("queued");
  });

  it("releases a job whose deployer died, on the next heartbeat", async (ctx) => {
    if (!db.available) return ctx.skip();
    const job = await service().createJob("update", ADMIN);
    await service().heartbeat(beat());
    await service().recordStageEvent(job.id, stageEvent({ stage: "recreate", status: "started" }));

    // Another deployer's beat says nothing about this job: its Compose
    // commands may still be running, and failing it here would leave the
    // instance changing under a job the panel calls finished.
    const other = await service().heartbeat(beat({ deployer_id: "deployer-container-b" }));
    expect(other.job).toBeNull();
    expect((await service().getJobDetail(job.id)).job.status).toBe("running");

    // The same deployer beating again means its own executor died and came
    // back: the loop cannot beat and execute at the same time. Waiting out the
    // hour would defer every unattended Run meanwhile.
    const restarted = await service().heartbeat(beat());
    expect(restarted.job).toBeNull();
    expect((await service().getJobDetail(job.id)).job).toMatchObject({
      status: "failed",
      error_text: "deployer_lost",
      failure_stage: "recreate",
    });
    expect(await service().updatePending()).toBe(false);
  });

  it("does not name a stage that succeeded as the one that failed", async (ctx) => {
    if (!db.available) return ctx.skip();
    const job = await service().createJob("update", ADMIN);
    await service().heartbeat(beat());
    await service().recordStageEvent(job.id, stageEvent({ stage: "pull", status: "started" }));
    await service().recordStageEvent(job.id, stageEvent({ stage: "pull", status: "succeeded" }));

    // The deployer died between two stages. `current_stage` still says `pull`,
    // but the event stream shows the pull finishing — calling it the failing
    // stage would make the panel contradict the audit it is drawn from.
    await service().heartbeat(beat());
    expect((await service().getJobDetail(job.id)).job).toMatchObject({
      status: "failed",
      error_text: "deployer_lost",
      current_stage: "pull",
      failure_stage: null,
    });
  });

  it("records a retried stage report once", async (ctx) => {
    if (!db.available) return ctx.skip();
    const job = await service().createJob("update", ADMIN);
    await service().heartbeat(beat());

    // The deployer retries a report whose response was lost — including the
    // terminal one, whose first attempt already ended the job.
    const first = await service().recordStageEvent(job.id, stageEvent({ stage: "pull", status: "started" }, "e1"));
    const retry = await service().recordStageEvent(job.id, stageEvent({ stage: "pull", status: "started" }, "e1"));
    expect(retry.events).toEqual(first.events);
    expect(retry.events).toHaveLength(1);

    await service().recordStageEvent(job.id, stageEvent({ stage: "health", status: "succeeded", terminal: true }, "e2"));
    const terminalRetry = await service().recordStageEvent(
      job.id,
      stageEvent({ stage: "health", status: "succeeded", terminal: true }, "e2"),
    );
    expect(terminalRetry.job.status).toBe("succeeded");
    expect(terminalRetry.events.map((event) => event.event_id)).toEqual(["e1", "e2"]);
  });

  it("names the failure with the end of the stage's own output", async (ctx) => {
    if (!db.available) return ctx.skip();
    const job = await service().createJob("update", ADMIN);
    await service().heartbeat(beat());

    const failed = await service().recordStageEvent(job.id, stageEvent({
      stage: "migrate",
      status: "failed",
      log_tail: "[migrate] applying 0002_widget.sql\nERROR: relation \"widget\" already exists\n",
    }));
    expect(failed.job.error_text).toBe('ERROR: relation "widget" already exists');
  });

  it("fails a queued job no deployer ever picked up", async (ctx) => {
    if (!db.available) return ctx.skip();
    const job = await service().createJob("update", ADMIN);
    expect(await service().updatePending()).toBe(true);
    expect(await service().sweepLostJobs()).toBe(0);

    // Nothing claims it — the deployer is stopped or its poll loop is absent.
    // Unbounded, that would pause every unattended Run indefinitely.
    await db.pool.query(
      `UPDATE deployment_jobs SET requested_at = now() - interval '31 minutes' WHERE id = $1`,
      [job.id],
    );
    expect(await service().sweepLostJobs()).toBe(1);
    expect((await service().getJobDetail(job.id)).job).toMatchObject({
      status: "failed",
      error_text: "deployer_unavailable",
    });
    expect(await service().updatePending()).toBe(false);
  });

  it("derives update_available from the digests the deployer reported", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(`DELETE FROM deployment_observations`);
    const empty = await service().status();
    expect(empty).toMatchObject({ observations: null, update_available: null, active_job: null, last_job: null });

    await service().heartbeat(beat({
      services: [{ service: "server", image_ref: "ghcr.io/x/server:stable", digest: "sha256:running", revision: "abc", surface: "s1" }],
      remote: null,
      docker_version: "27.0.0",
    }));
    expect((await service().status()).update_available).toBeNull();

    await service().heartbeat(beat({
      services: [{ service: "server", image_ref: "ghcr.io/x/server:stable", digest: "sha256:running", revision: "abc", surface: "s1" }],
      remote: { tag: "stable", digest: "sha256:running", checked_at: new Date().toISOString() },
      docker_version: "27.0.0",
    }));
    expect((await service().status()).update_available).toBe(false);

    await service().heartbeat(beat({
      services: [{ service: "server", image_ref: "ghcr.io/x/server:stable", digest: "sha256:running", revision: "abc", surface: "s1" }],
      remote: { tag: "stable", digest: "sha256:newer", checked_at: new Date().toISOString() },
      docker_version: "27.0.0",
    }));
    const status = await service().status();
    expect(status.update_available).toBe(true);
    expect(status.observations?.services[0]?.revision).toBe("abc");

    // A remote result outlives the heartbeat that carried it, and the operator
    // may change RAINVER_IMAGE_TAG in between. A digest read for another
    // channel answers nothing about this one.
    await service().heartbeat(beat({
      services: [{ service: "server", image_ref: "ghcr.io/x/server:edge", digest: "sha256:running", revision: "abc", surface: "s1" }],
      remote: null,
    }));
    expect((await service().status()).update_available).toBeNull();
  });

  it("asks for the host step only when the deployment surface actually changed", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The deployer never recreates itself (ADR 0020 §6), and the compose files
    // and ops scripts it runs come from the host checkout with it.
    const observe = async (deployer: { revision: string | null; surface: string | null }) =>
      service().heartbeat(beat({
        services: [
          { service: "server", image_ref: "ghcr.io/x/server:stable", digest: "sha256:a", revision: "commit-2", surface: "surface-1" },
          { service: "deployer", image_ref: "ghcr.io/x/deployer:stable", digest: "sha256:b", ...deployer },
        ],
      }));

    // The state after every successful update: the deployer is a commit behind
    // because an update cannot recreate it. Nothing about it changed, so this
    // must not ask for a host step — an alarm that is always on is no alarm.
    await observe({ revision: "commit-1", surface: "surface-1" });
    expect((await service().status()).deployer_behind).toBe(false);

    // A release that changed deployer/ or ops/ is the case that needs one.
    await observe({ revision: "commit-1", surface: "surface-0" });
    expect((await service().status()).deployer_behind).toBe(true);

    // A locally built image carries no label, and an unknown comparison is not
    // an answer.
    await observe({ revision: "commit-1", surface: null });
    expect((await service().status()).deployer_behind).toBeNull();
  });

  it("refuses an update when no deployer is reporting, rather than queueing one that pauses work", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A queued update defers every unattended Run from the moment it exists,
    // and only the half-hour sweep would release them.
    await db.pool.query(
      `UPDATE deployment_observations SET observed_at = now() - interval '10 minutes'`,
    );
    expect((await service().status()).deployer_online).toBe(false);
    await expect(service().createJob("update", ADMIN)).rejects.toMatchObject({ statusCode: 503 });
    // Reading the registry costs the instance nothing, so it may wait for a
    // deployer that is restarting.
    expect((await service().createJob("check_update", ADMIN)).status).toBe("queued");

    await db.pool.query(`DELETE FROM deployment_observations`);
    expect((await service().status()).deployer_online).toBe(false);
  });

  it("keeps the internal channel on the internal token and out of admin reach", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);

    expect((await app.inject({ method: "GET", url: "/internal/deployment/drain" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/internal/deployment/heartbeat",
      payload: beat(),
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/internal/deployment/jobs/any-job/events",
      payload: stageEvent({ stage: "pull", status: "started" }),
    })).statusCode).toBe(401);
    // A wrong token is not a partial credential.
    expect((await app.inject({
      method: "GET",
      url: "/internal/deployment/drain",
      headers: { "x-rainver-internal-token": "wrong-token-of-same-length-xx" },
    })).statusCode).toBe(401);

    expect((await app.inject({ method: "GET", url: "/internal/deployment/drain", headers: internal })).statusCode).toBe(200);
    const beaten = await app.inject({
      method: "POST",
      url: "/internal/deployment/heartbeat",
      headers: internal,
      payload: beat(),
    });
    expect(beaten.statusCode).toBe(200);
    expect(beaten.json()).toEqual({ job: null });

    // Every admin route is admin-gated, not only job creation.
    __setAuthIdentityForTests({ userId: MEMBER, spaceId: SPACE } as never);
    for (const [method, url] of [
      ["GET", "/api/v1/deployments/status"],
      ["GET", "/api/v1/deployments/jobs"],
      ["GET", "/api/v1/deployments/jobs/any-job"],
      ["POST", "/api/v1/deployments/jobs/any-job/cancel"],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(403);
    }

    // The internal token grants nothing on the admin routes: the deployer
    // cannot create work for itself (B43).
    __setAuthIdentityForTests({ userId: MEMBER, spaceId: SPACE } as never);
    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/deployments/jobs",
      headers: internal,
      payload: { job_type: "update" },
    });
    expect(forged.statusCode).toBe(403);
    expect((await db.pool.query(`SELECT id FROM deployment_jobs`)).rowCount).toBe(0);
  });

  it("counts running Runs for the drain and defers unattended Runs while an update waits", async (ctx) => {
    if (!db.available) return ctx.skip();
    const now = new Date().toISOString();
    // A separate owner: the admin row already exists from the auth fixture.
    const owner = randomUUID();
    await seedSpaceOwnerProject(db.pool, { space: SPACE, owner, project: PROJECT, now });
    await seedAgentWithVersion(db.pool, {
      agent: AGENT,
      version: AGENT_VERSION,
      space: SPACE,
      owner,
      now,
    });

    async function seedQueuedRun(triggerOrigin: string): Promise<string> {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin,
                           status, mode, owner_user_id, visibility, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'agent',$5,'queued','live',$6,'space_shared',$7,$7)`,
        [id, SPACE, AGENT, AGENT_VERSION, triggerOrigin, owner, now],
      );
      return id;
    }

    const automationRun = await seedQueuedRun("automation");
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin,
                         status, mode, owner_user_id, visibility, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'agent','manual','running','live',$5,'space_shared',$6,$6)`,
      [randomUUID(), SPACE, AGENT, AGENT_VERSION, owner, now],
    );
    expect(await service().drain()).toEqual({ running_runs: 1 });

    const registry = new JobHandlerRegistry();
    registerAgentRunHandler(registry, config());
    const handler = registry.get("agent_run")!;
    const envelope = (runId: string) => ({
      job_id: randomUUID(),
      space_id: SPACE,
      user_id: owner,
      job_type: "agent_run",
      attempts: 1,
      max_attempts: 3,
      worker_id: "test-worker",
      payload: { run_id: runId },
    });

    // No update pending: the automation Run is admitted (it fails later, in
    // execution, for want of a runtime — what matters is that it was not
    // deferred).
    await expect(handler(envelope(automationRun))).rejects.not.toBeInstanceOf(JobDeferredError);

    await service().createJob("update", ADMIN);
    await expect(handler(envelope(automationRun))).rejects.toMatchObject({
      name: "JobDeferredError",
      message: "instance_update_pending",
    });

    // A conversation-originated Run keeps going while the instance drains.
    const manualRun = await seedQueuedRun("manual");
    await expect(handler(envelope(manualRun))).rejects.not.toBeInstanceOf(JobDeferredError);

    // A delegated child inherits the question from its root: one hop of
    // `agent.delegate` is not a way past the drain. Its parent is parked in
    // `waiting_for_dependency`, so deferring the child stalls nothing.
    async function seedDelegatedChild(rootOrigin: string): Promise<string> {
      const root = await seedQueuedRun(rootOrigin);
      const child = randomUUID();
      await db.pool.query(
        `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin,
                           status, mode, owner_user_id, visibility, root_run_id, parent_run_id,
                           created_at, updated_at)
         VALUES ($1,$2,$3,$4,'agent','delegation','queued','live',$5,'space_shared',$6,$6,$7,$7)`,
        [child, SPACE, AGENT, AGENT_VERSION, owner, root, now],
      );
      return child;
    }

    await expect(handler(envelope(await seedDelegatedChild("automation")))).rejects.toMatchObject({
      name: "JobDeferredError",
      message: "instance_update_pending",
    });
    await expect(handler(envelope(await seedDelegatedChild("manual"))))
      .rejects.not.toBeInstanceOf(JobDeferredError);
  });

  it("defers the job families that start unattended Runs outside agent_run", async (ctx) => {
    if (!db.available) return ctx.skip();
    const registry = buildJobHandlerRegistry(config());
    const envelope = (jobType: string) => ({
      job_id: randomUUID(),
      space_id: SPACE,
      user_id: ADMIN,
      job_type: jobType,
      attempts: 1,
      max_attempts: 3,
      worker_id: "test-worker",
      payload: {},
    });

    await service().createJob("update", ADMIN);
    for (const jobType of UNATTENDED_RUN_JOB_TYPES) {
      await expect(registry.dispatch(envelope(jobType))).rejects.toMatchObject({
        name: "JobDeferredError",
        message: "instance_update_pending",
      });
    }

    // Conversation-shaped work is not swept up by the job-type rule.
    await expect(registry.dispatch(envelope("room_conversation_title")))
      .rejects.not.toBeInstanceOf(JobDeferredError);

    // Without a database neither the handlers nor the gate exist, and building
    // the registry must not fail for want of a job type to wrap.
    expect(() => buildJobHandlerRegistry(loadConfig({}))).not.toThrow();
  });

  it("leaves due automations due instead of firing them during a drain", async (ctx) => {
    if (!db.available) return ctx.skip();
    const now = new Date().toISOString();
    const owner = randomUUID();
    await seedSpaceOwnerProject(db.pool, { space: SPACE, owner, project: PROJECT, now });
    await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner, now });
    const automationId = randomUUID();
    await db.pool.query(
      `INSERT INTO automations (id, space_id, owner_user_id, agent_id, name, trigger_type,
                                config_json, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'Due automation','schedule',
               '{"target_type":"context_ops_review_cycle","cron":"* * * * *","timezone":"UTC"}'::jsonb,
               'active', $5, $5)`,
      [automationId, SPACE, owner, AGENT, now],
    );
    const due = new Date(Date.now() - 60_000).toISOString();
    await db.pool.query(
      `INSERT INTO scheduler_tasks (id, task_type, task_key, scope_type, scope_id, space_id,
                                    user_id, status, next_run_at, created_at, updated_at)
       VALUES ($1,'automation',$2,'space',$3,$3,$4,'active',$5,$6,$6)`,
      [randomUUID(), automationId, SPACE, owner, due, now],
    );

    await service().createJob("update", ADMIN);
    expect(await scanAutomationsAndFire(config())).toBe(0);

    // Still due: no schedule advanced, no automation run, no Run row.
    const task = (await db.pool.query<{ next_run_at: string; last_run_at: string | null }>(
      `SELECT next_run_at, last_run_at FROM scheduler_tasks WHERE task_key = $1`,
      [automationId],
    )).rows[0]!;
    expect(new Date(task.next_run_at).toISOString()).toBe(due);
    expect(task.last_run_at).toBeNull();
    expect((await db.pool.query(`SELECT id FROM automation_runs`)).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT id FROM runs`)).rowCount).toBe(0);
  });
});
