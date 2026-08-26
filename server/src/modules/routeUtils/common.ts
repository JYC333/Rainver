import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool, type PoolClient } from "../../db/pool.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";

export type { Pool };

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface SpaceUserIdentity {
  spaceId: string;
  userId: string;
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function dbPool(config: ServerConfig): Pool {
  if (!config.databaseUrl) {
    throw new HttpError(502, "SERVER_DATABASE_URL is required");
  }
  return getDbPool(config.databaseUrl);
}

export async function resolveIdentity(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SpaceUserIdentity | null> {
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(config, request);
  if (identity.ok) return { spaceId: identity.spaceId, userId: identity.userId };
  if (identity.reason === "denied") {
    reply.code(identity.statusCode);
    reply.header("content-type", "application/json");
    reply.send(identity.body);
    return null;
  }
  await sendErrorEnvelope(
    reply,
    502,
    errorEnvelope(
      identity.reason === "contract_violation"
        ? "introspect_contract_violation"
        : "identity_unavailable",
      "Identity introspection failed",
      requestId,
    ),
  );
  return null;
}

export function sendRouteError(reply: FastifyReply, error: unknown): FastifyReply {
  logServerRouteError(reply, error);
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send(error.responseBody ?? { detail: error.message });
  }
  if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    return reply
      .code((error as { statusCode: number }).statusCode)
      .send({ detail: error.message });
  }
  throw error;
}

/**
 * 5xx responses carry only `detail` to the client; the server log keeps the
 * full picture, including any provider response text a ProviderInvocationError
 * retained for failure triage.
 */
function logServerRouteError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof Error)) return;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode !== "number" || statusCode < 500) return;
  const responseText = (error as { responseText?: unknown }).responseText;
  reply.log.error({
    status_code: statusCode,
    error_code: (error as { code?: unknown }).code ?? null,
    reason: error.message,
    diagnostics: (error as { diagnostics?: unknown }).diagnostics ?? null,
    provider_response_text: typeof responseText === "string" ? responseText.slice(0, 8000) : null,
  }, "route request failed");
}

export function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

export function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}

export function bodyText(request: FastifyRequest): string {
  return request.body instanceof Buffer ? request.body.toString("utf8") : "";
}

export function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const text = bodyText(request);
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(422, "JSON object body is required");
  }
  return parsed as Record<string, unknown>;
}

export function parsePage(
  q: Record<string, string | undefined>,
  fallbackLimit = 50,
): { limit: number; offset: number } {
  const limit = intQuery(q.limit, fallbackLimit);
  const offset = intQuery(q.offset, 0);
  if (limit === null || limit < 1 || limit > 200) {
    throw new HttpError(422, "limit must be between 1 and 200");
  }
  if (offset === null || offset < 0) {
    throw new HttpError(422, "offset must be non-negative");
  }
  return { limit, offset };
}

export function intQuery(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function boolQuery(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new HttpError(422, `Invalid boolean value ${JSON.stringify(value)}`);
}

/**
 * A comma-separated query-string list (`?collection_ids=a,b,c`), de-duplicated,
 * or null when the parameter is absent or carries nothing.
 *
 * Bounded on purpose: these values go into an `= ANY(...)` predicate, and an
 * unbounded list is a cheap way to make the database do unbounded work.
 */
export function csvQuery(value: string | undefined, max = 200): string[] | null {
  if (value === undefined) return null;
  const items = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (items.length === 0) return null;
  if (items.length > max) throw new HttpError(422, `at most ${max} comma-separated values are allowed`);
  return items;
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new HttpError(422, `${field} is required`);
  return normalized;
}

export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// A confidence is a probability: any module that records one validates it the
// same way, so this lives beside the other shared parsers rather than inside
// whichever module happened to need it first.
export function confidence(value: unknown): number | null {
  const parsed = numberValue(value);
  if (parsed === null) return null;
  if (parsed < 0 || parsed > 1) throw new HttpError(422, "confidence must be between 0 and 1");
  return parsed;
}

export function optionalObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

export function objectValue(value: unknown): Record<string, unknown> {
  return optionalObject(value) ?? {};
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function dateIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(value as string | number | Date).toISOString();
}

export function toDbDate(value: unknown): string | null {
  const text = optionalString(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new HttpError(422, "invalid datetime");
  return date.toISOString();
}

export async function withDbTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Same transaction semantics as `withDbTransaction`, but for application
 * services that are constructed with a `Queryable` that may already be a
 * transaction client (nested inside a caller's transaction). Opens a real
 * transaction only when `db` is a connectable `Pool`; otherwise runs `fn`
 * directly against the given client so nested calls join the existing
 * transaction instead of starting a new one.
 */
export async function withQueryableTransaction<T>(
  db: Queryable,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const pool = db as Queryable & {
    connect?: () => Promise<PoolClient>;
    release?: () => void;
  };
  // pg PoolClient also exposes `connect` on its prototype. `release` is the
  // discriminator that identifies an already checked-out client; calling
  // connect() on it would throw and, when nested in proposal acceptance,
  // roll back the caller's transaction.
  if (typeof pool.release === "function" || typeof pool.connect !== "function") return fn(db);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Wraps an async callback so every call chains strictly after the one
 * before it, instead of racing when called from synchronous, un-awaited
 * call sites (a live output-stream callback firing several times per
 * chunk, none of which its caller awaits). Without this, two calls whose
 * work reads-then-writes some shared "current max" state (an
 * `event_index`-style cursor) can both read the same starting point and
 * collide. A rejection from one call does not skip or block the next —
 * each call is attempted regardless of how the previous one settled — and
 * the returned function's own promise never rejects (a live/best-effort
 * callback must not crash its un-awaited caller via an unhandled
 * rejection); a caller that needs to know a batch actually landed should
 * `await` the returned promise and check separately, not rely on rejection.
 * `control-center-phase2-plan.md` P1: built for `host_thread_events` writes
 * and the pre-existing `run_events` semantic-event sink, which had the
 * identical race, found via this same phase's own test coverage.
 */
export function serializeCalls<TArg>(
  fn: (arg: TArg) => Promise<unknown>,
): (arg: TArg) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (arg) => {
    const attempt = () => fn(arg);
    const next = chain.then(attempt, attempt).then(() => undefined, () => undefined);
    chain = next;
    return next;
  };
}

export function page<T>(
  items: T[],
  total: number,
  limit: number,
  offset: number,
): { items: T[]; total: number; limit: number; offset: number } {
  return { items, total, limit, offset };
}

export function countFromRow(row: { total?: unknown } | undefined): number {
  const total = row?.total;
  if (typeof total === "number") return total;
  if (typeof total === "string") return Number(total);
  return 0;
}
