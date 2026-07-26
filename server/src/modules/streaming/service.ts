import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import type { ServerConfig } from "../../config";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext";
import { resolveIdentity } from "../routeUtils/common";
import { PgRunRepository, type RunEventPage } from "../runs/repository";
import { runEventToOut } from "../runs/runReadModel";
import {
  CHAT_TEXT_DELTA_TYPE,
  subscribeChatTextDeltas,
} from "./conversationDeltaBus";

/** Runtime string kept in lockstep with `EventType.RunEventAppended`. */
export const RUN_EVENT_APPENDED_TYPE = "run.event_appended";
const STREAM_ERROR_EVENT = "server.error";

interface RunEventsPage {
  items: RunEventDTO[];
  total: number;
  limit: number;
  offset: number;
}

interface RunEventDTO {
  id: string;
  space_id: string;
  run_id: string;
  event_index: number;
  event_type: string;
  status: string;
  step_id?: string | null;
  actor_id?: string | null;
  summary?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  project_folder_id?: string | null;
  artifact_id?: string | null;
  proposal_id?: string | null;
  data_exposure_level?: string | null;
  trust_level?: string | null;
  metadata_json?: unknown;
  created_at: string;
}

interface RunEventAppendedEnvelope {
  event_id: string;
  type: typeof RUN_EVENT_APPENDED_TYPE;
  occurred_at: string;
  space_id: string;
  payload: { event: RunEventDTO };
}

interface StreamOptions {
  fromEventIndex: number;
  tail: boolean;
  eventType: string | null;
  status: string | null;
}

type PageFetchResult =
  | { ok: true; page: RunEventsPage }
  | {
      ok: false;
      statusCode: number;
      error: string;
      message: string;
    };

type StreamingRunRepository = Pick<PgRunRepository, "getVisibleRun" | "listRunEventsPage">;
type StreamingRunRepositoryFactory = (config: ServerConfig) => StreamingRunRepository;

let repositoryFactoryOverride: StreamingRunRepositoryFactory | null = null;

export function __setStreamingRepositoryFactoryForTests(
  factory: StreamingRunRepositoryFactory | null,
): void {
  repositoryFactoryOverride = factory;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStreamOptions(request: FastifyRequest): StreamOptions {
  const url = new URL(request.url, "http://server.local");
  const fromParam = url.searchParams.get("from_event_index");
  const lastEventId = request.headers["last-event-id"];
  const rawLastEventId = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const fromLastEventId =
    rawLastEventId !== undefined && /^\d+$/.test(rawLastEventId)
      ? Number(rawLastEventId) + 1
      : undefined;
  const fromEventIndex =
    fromParam !== null && /^\d+$/.test(fromParam)
      ? Number(fromParam)
      : fromLastEventId ?? 0;
  const tailParam = url.searchParams.get("tail");
  return {
    fromEventIndex,
    tail: tailParam === null || !["0", "false", "no"].includes(tailParam.toLowerCase()),
    eventType: url.searchParams.get("event_type"),
    status: url.searchParams.get("status"),
  };
}

async function fetchRunEventsPage(
  repository: StreamingRunRepository,
  runId: string,
  spaceId: string,
  offset: number,
  limit: number,
  options: Pick<StreamOptions, "eventType" | "status">,
): Promise<PageFetchResult> {
  try {
    const page = await repository.listRunEventsPage(spaceId, runId, {
      from_event_index: offset,
      limit,
      event_type: options.eventType,
      status: options.status,
    });
    return { ok: true, page: pageToDto(page) };
  } catch {
    return {
      ok: false,
      statusCode: 500,
      error: "run_event_stream_unavailable",
      message: "Run event stream is unavailable",
    };
  }
}

function startSse(reply: FastifyReply, requestId: string): ServerResponse {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    [REQUEST_ID_HEADER]: requestId,
  });
  reply.raw.write(": connected\n\n");
  return reply.raw;
}

function writeSse(raw: ServerResponse, event: string, data: unknown, id?: string): void {
  if (id !== undefined) raw.write(`id: ${id}\n`);
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function toEnvelope(event: RunEventDTO): RunEventAppendedEnvelope {
  return {
    event_id: event.id,
    type: RUN_EVENT_APPENDED_TYPE,
    occurred_at: event.created_at,
    space_id: event.space_id,
    payload: { event },
  };
}

function sendInitialFailure(
  reply: FastifyReply,
  requestId: string,
  result: Extract<PageFetchResult, { ok: false }>,
): FastifyReply {
  return sendErrorEnvelope(
    reply,
    result.statusCode,
    errorEnvelope(result.error, result.message, requestId),
  );
}

export async function streamRunEvents(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const runId = (request.params as { runId?: string }).runId;
  const requestId = resolveRequestId(request);
  if (!runId) {
    return sendErrorEnvelope(
      reply,
      400,
      errorEnvelope("missing_run_id", "Missing run id", requestId),
    );
  }

  const identity = await resolveIdentity(config, request, reply);
  if (!identity) return reply;

  const repository = repositoryFactoryOverride?.(config) ?? PgRunRepository.fromConfig(config);
  const run = await repository.getVisibleRun(identity.spaceId, identity.userId, runId);
  if (!run) {
    return sendErrorEnvelope(
      reply,
      404,
      errorEnvelope("run_not_found", "Run not found", requestId),
    );
  }

  const options = parseStreamOptions(request);
  let offset = options.fromEventIndex;
  let closed = false;
  request.raw.on("close", () => {
    closed = true;
  });

  let pageResult = await fetchRunEventsPage(
    repository,
    runId,
    identity.spaceId,
    offset,
    config.runEventStreamPageLimit,
    options,
  );
  if (!pageResult.ok) return sendInitialFailure(reply, requestId, pageResult);

  const raw = startSse(reply, requestId);
  const unsubscribeDeltas = subscribeChatTextDeltas(runId, (event) => {
    if (!closed && !raw.destroyed) writeSse(raw, CHAT_TEXT_DELTA_TYPE, event);
  });

  try {
    while (!closed) {
      const emitted = pageResult.page.items.length;
      for (const event of pageResult.page.items) {
        writeSse(
          raw,
          RUN_EVENT_APPENDED_TYPE,
          toEnvelope(event),
          String(event.event_index),
        );
        offset = event.event_index + 1;
      }

      if (!options.tail && (offset >= pageResult.page.total || emitted === 0)) break;

      const caughtUp = offset >= pageResult.page.total || emitted === 0;
      if (caughtUp) await sleep(config.runEventStreamPollIntervalMs);
      if (closed) break;

      pageResult = await fetchRunEventsPage(
        repository,
        runId,
        identity.spaceId,
        offset,
        config.runEventStreamPageLimit,
        options,
      );
      if (!pageResult.ok) {
        writeSse(raw, STREAM_ERROR_EVENT, {
          error: pageResult.error,
          message: pageResult.message,
        });
        break;
      }
    }
  } finally {
    unsubscribeDeltas();
    raw.end();
  }
}

function pageToDto(page: RunEventPage): RunEventsPage {
  return {
    items: page.items.map((row) => runEventToOut(row) as unknown as RunEventDTO),
    total: page.total,
    limit: page.limit,
    offset: page.offset,
  };
}
