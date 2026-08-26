import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { frontendSupportModule } from "../src/modules/frontendSupport/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { __setFrontendSupportServiceFactoryForTests } from "../src/modules/frontendSupport/routes.js";

let app: FastifyInstance;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setFrontendSupportServiceFactoryForTests(null);
  await app?.close();
});

describe("frontend-support read models", () => {
  it("serves home as space-scoped and me as user-wide native read models", async () => {
    __setAuthIdentityForTests({ spaceId: "space-active", userId: "user-1" });
    __setFrontendSupportServiceFactoryForTests(() => ({
      async homeSummary(identity) {
        return {
          ...emptyHomeSummary(),
          runtime_status: {
            ...emptyHomeSummary().runtime_status,
            message: identity.spaceId,
          },
        };
      },
      async meSummary(userId) {
        return {
          pending_proposals_count: 0,
          assigned_tasks_count: 0,
          recent_runs: [],
          recent_participation: [],
          accessible_spaces_count: userId === "user-1" ? 1 : 0,
          spaces: [
            {
              space_id: "space-active",
              name: "Active",
              type: "team",
              pending_proposals_count: 0,
              assigned_tasks_count: 0,
              recent_failed_runs_count: 0,
            },
          ],
        };
      },
      async meTimeline(userId) {
        return [
          {
            id: `timeline-${userId}`,
            entry_type: "participation",
            source_space_id: "space-active",
            source_object_type: "run",
            source_object_id: "run-1",
            role: "participant",
            occurred_at: "2026-06-17T00:00:00.000Z",
            created_at: "2026-06-17T00:00:00.000Z",
          },
        ];
      },
      async mePending(userId) {
        return [
          {
            id: `pending-${userId}`,
            space_id: "space-active",
            proposal_type: "memory_create",
            status: "pending",
            urgency: "normal",
            title: "Pending",
            visibility: "space_shared",
            created_by_user_id: userId,
            created_at: "2026-06-17T00:00:00.000Z",
            updated_at: "2026-06-17T00:00:00.000Z",
          },
        ];
      },
    }));
    app = buildModuleServer(loadConfig({}), [frontendSupportModule]);

    const home = await app.inject({
      method: "GET",
      url: "/api/v1/home/summary?recent_runs_limit=3",
    });
    const summary = await app.inject({
      method: "GET",
      url: "/api/v1/me/summary?space_id=ignored&recent_runs_limit=4",
    });
    const timeline = await app.inject({ method: "GET", url: "/api/v1/me/timeline?limit=5" });
    const pending = await app.inject({ method: "GET", url: "/api/v1/me/pending?limit=6" });

    expect(home.statusCode).toBe(200);
    expect(home.json().runtime_status.message).toBe("space-active");
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      accessible_spaces_count: 1,
      spaces: [{ space_id: "space-active" }],
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toEqual([expect.objectContaining({ id: "timeline-user-1" })]);
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual([expect.objectContaining({ id: "pending-user-1" })]);
  });
});

function emptyHomeSummary() {
  return {
    operations_in_progress: [],
    recent_runs: [],
    active_runs: [],
    pending_proposals: { count: 0, items: [] },
    recent_artifacts: [],
    task_summary: {
      by_status: {},
      total_open: 0,
      needs_review_count: 0,
      blocked_count: 0,
      done_count: 0,
    },
    active_tasks: [],
    activity_summary: { recent_count: 0, raw_count: 0, today_count: 0 },
    run_stats_today: {
      created: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      dry_run_count: 0,
    },
    job_queue_status: {
      queued: 0,
      running: 0,
      failed: 0,
      retryable: 0,
      recent_error_preview: null,
    },
    runtime_status: {
      real_adapters_configured_count: 0,
      configured_adapter_types: [],
      message: "No runtime adapters configured.",
    },
    model_provider_status: {
      model_providers_count: 0,
      enabled_model_providers_count: 0,
      missing_model_provider_config: true,
      message: "No enabled model providers configured.",
    },
    suggested_actions: [],
    source_summary: {
      open_items: 0,
      new_items_today: 0,
      pending_extraction_jobs: 0,
      failed_extraction_jobs: 0,
      candidate_evidence: 0,
      active_evidence: 0,
      due_connections: 0,
    },
  };
}
