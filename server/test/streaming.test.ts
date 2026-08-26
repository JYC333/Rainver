import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { runsModule } from "../src/modules/runs/index.js";
import { streamingModule } from "../src/modules/streaming/index.js";
import { loadConfig } from "../src/config.js";
import { RUN_EVENT_APPENDED_TYPE, __setStreamingRepositoryFactoryForTests } from "../src/modules/streaming/service.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import {
  publishChatTextDelta,
  subscribeChatTextDeltas,
} from "../src/modules/streaming/conversationDeltaBus.js";

let app: FastifyInstance;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setStreamingRepositoryFactoryForTests(null);
  await app?.close();
});

function runEvent(index: number) {
  return {
    id: `event-${index}`,
    space_id: "personal",
    run_id: "run-1",
    attempt_number: null,
    event_index: index,
    event_type: "adapter_completed",
    status: "succeeded",
    step_id: null,
    actor_id: null,
    summary: `event ${index}`,
    error_code: null,
    error_message: null,
    project_folder_id: null,
    artifact_id: null,
    proposal_id: null,
    data_exposure_level: null,
    trust_level: null,
    metadata_json: null,
    created_at: `2026-06-11T12:00:0${index}Z`,
  };
}

function runRecord() {
  return {
    id: "run-1",
    space_id: "personal",
    agent_id: "agent-1",
    agent_version_id: "version-1",
    status: "running",
    mode: "live",
    prompt: null,
    instruction: null,
    project_folder_id: null,
    session_id: null,
    project_id: null,
    adapter_type: "mock",
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    started_at: null,
    ended_at: null,
    visibility: "space_shared",
  };
}

function parseSseEvents(payload: string): Array<{ id?: string; event?: string; data: unknown }> {
  return payload
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.includes("data: "))
    .map((block) => {
      const lines = block.split("\n");
      const idLine = lines.find((line) => line.startsWith("id: "));
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      return {
        id: idLine?.slice(4),
        event: eventLine?.slice(7),
        data: JSON.parse(dataLine?.slice(6) ?? "null") as unknown,
      };
    });
}

describe("run-event SSE streaming edge", () => {
  it("replays bounded non-durable text deltas when the worker starts before SSE subscribes", () => {
    publishChatTextDelta("run-buffered", "early ");
    publishChatTextDelta("run-buffered", "reply");
    const received: Array<{ delta_index: number; delta: string }> = [];
    const unsubscribe = subscribeChatTextDeltas("run-buffered", event => {
      received.push({ delta_index: event.delta_index, delta: event.delta });
    });
    publishChatTextDelta("run-buffered", " live");
    unsubscribe();

    expect(received).toEqual([
      { delta_index: 0, delta: "early " },
      { delta_index: 1, delta: "reply" },
      { delta_index: 2, delta: " live" },
    ]);
  });

  it("replays server run events as canonical SSE envelopes", async () => {
    __setAuthIdentityForTests({ spaceId: "personal", userId: "user-1" });
    const events = [runEvent(0), runEvent(1)];
    __setStreamingRepositoryFactoryForTests(() => ({
      async getVisibleRun() {
        return runRecord();
      },
      async listRunEventsPage(_spaceId, _runId, filters) {
        return {
          items: events.filter((event) => event.event_index >= filters.from_event_index),
          total: events.length,
          limit: filters.limit,
          offset: filters.from_event_index,
        };
      },
    }));
    app = buildModuleServer(loadConfig({}), [streamingModule, runsModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1/events/stream?space_id=personal&tail=false",
      headers: { "x-request-id": "req-stream" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-request-id"]).toBe("req-stream");
    const blocks = parseSseEvents(res.payload);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ id: "0", event: RUN_EVENT_APPENDED_TYPE });
    expect(blocks[0].data).toEqual({
      event_id: "event-0",
      type: RUN_EVENT_APPENDED_TYPE,
      occurred_at: "2026-06-11T12:00:00Z",
      space_id: "personal",
      payload: { event: events[0] },
    });
  });

  it("uses Last-Event-ID to resume at the next run event index", async () => {
    __setAuthIdentityForTests({ spaceId: "personal", userId: "user-1" });
    __setStreamingRepositoryFactoryForTests(() => ({
      async getVisibleRun() {
        return runRecord();
      },
      async listRunEventsPage(_spaceId, _runId, filters) {
        const event = runEvent(filters.from_event_index);
        return {
          items: [event],
          total: filters.from_event_index + 1,
          limit: filters.limit,
          offset: filters.from_event_index,
        };
      },
    }));
    app = buildModuleServer(loadConfig({}), [streamingModule, runsModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1/events/stream?tail=false",
      headers: { "last-event-id": "2" },
    });

    expect(res.statusCode).toBe(200);
    const blocks = parseSseEvents(res.payload);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: "3", event: RUN_EVENT_APPENDED_TYPE });
    expect(blocks[0].data).toMatchObject({
      event_id: "event-3",
      payload: { event: { event_index: 3 } },
    });
  });

  it("denies missing or invisible runs before opening SSE", async () => {
    __setAuthIdentityForTests({ spaceId: "personal", userId: "user-1" });
    __setStreamingRepositoryFactoryForTests(() => ({
      async getVisibleRun() {
        return null;
      },
      async listRunEventsPage() {
        throw new Error("should not be called");
      },
    }));
    app = buildModuleServer(loadConfig({}), [streamingModule, runsModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runs/missing/events/stream?tail=false",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "run_not_found",
      message: "Run not found",
      request_id: expect.any(String),
    });
  });
});
