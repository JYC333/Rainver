/**
 * Reading this machine's own CLI history over the Agent Client Protocol.
 *
 * Every supported runtime exposes its past sessions through `session/list`
 * and replays one through `session/load`, so there is one generic client here
 * and no vendor session-file parser anywhere — those formats are
 * undocumented, self-corrupting (broken parent chains, sessions rewritten on
 * resume, one conversation split across files by compaction), and three of
 * them would have to be maintained forever.
 *
 * This module holds no dependency beyond Node and the ACP adapters the daemon
 * already ships, and no knowledge of any vendor: the server names the adapter
 * and the argv, and the limits below arrive in the request. What the daemon
 * does own is trimming and redaction, because both must happen before
 * anything leaves the machine — a raw replay carries every tool result in
 * full, which is most of the volume and where a leaked key would be.
 * Reconciliation, identity, and storage are the server's.
 */

import { spawn } from "node:child_process";
import { buildAmbientRecords } from "./ambientRecords.js";
import { redactAmbientText, sanitizeFailure } from "./ambientRedaction.js";

// Re-exported so a caller asks this module for "reading ambient sessions"
// rather than having to know which file inside it holds what.
export { buildAmbientRecords } from "./ambientRecords.js";
export { redactAmbientText, sanitizeFailure } from "./ambientRedaction.js";

const INITIALIZE_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 60_000;
const LOAD_TIMEOUT_MS = 180_000;
/**
 * How long the replay must be silent before it counts as finished, and the
 * ceiling on waiting for that silence.
 *
 * A single fixed pause would drop the tail of any runtime that keeps pushing
 * after `session/load` returns — Claude's load starts an SDK resume query
 * underneath — and the session would still be recorded `complete`, so the
 * next sync would never retry it.
 */
const REPLAY_QUIET_MS = 750;
const REPLAY_DRAIN_LIMIT_MS = 30_000;

/** Used only when a request omits them; the server owns these numbers. */
export const DEFAULT_LIMITS: AmbientTrimLimits = {
  text_max_bytes: 64_000,
  tool_input_max_bytes: 512,
  tool_output_max_bytes: 512,
  raw_max_bytes: 2_048,
};

export interface AmbientTrimLimits {
  text_max_bytes: number;
  tool_input_max_bytes: number;
  tool_output_max_bytes: number;
  raw_max_bytes: number;
}

export interface AmbientSessionSummary {
  session_id: string;
  cwd: string;
  title: string | null;
  updated_at: string | null;
}

export interface AmbientRecord {
  record_key: string;
  kind: "user_message" | "agent_message" | "tool_call" | "plan" | "unknown";
  sequence: number;
  occurred_at: string | null;
  text: string | null;
  tool_name: string | null;
  tool_status: string | null;
  tool_input: string | null;
  tool_output: string | null;
  raw_json: string | null;
  truncated: boolean;
}

export interface AmbientUsage {
  record_key: string;
  model: string | null;
  occurred_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_tokens: number | null;
}

export interface AmbientSessionImport {
  session: AmbientSessionSummary;
  load_state: "complete" | "partial";
  records: AmbientRecord[];
  usage: AmbientUsage[];
  error: string | null;
}

export interface AmbientRuntimeTarget {
  adapter_type: string;
  installation: string;
  /** Resolved by the server from the adapter spec; the daemon adds no runtime knowledge. */
  argv: string[];
}

/**
 * A minimal ACP client over one child process.
 *
 * It answers agent-initiated requests with an empty result rather than
 * ignoring them: a replay that asks for a permission decision and never hears
 * back hangs until the timeout, and an empty answer is both the least
 * authority we can grant and enough to keep the replay moving.
 */
class AcpProcess {
  private readonly child: ReturnType<typeof spawn>;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private buffer = "";
  private closed: Error | null = null;
  private updates: Record<string, unknown>[] = [];

  constructor(command: string, args: string[], env: Record<string, string>, cwd: string) {
    this.child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    this.child.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    this.child.on("close", () => this.fail(new Error("the runtime exited before the request completed")));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private consume(text: string): void {
    this.buffer += text;
    let at = this.buffer.indexOf("\n");
    while (at !== -1) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      at = this.buffer.indexOf("\n");
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve((message.result ?? {}) as Record<string, unknown>);
      return;
    }
    if (typeof message.method === "string" && id !== undefined) {
      this.write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (message.method === "session/update") {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const update = params.update;
      if (update && typeof update === "object") this.updates.push(update as Record<string, unknown>);
    }
  }

  private write(frame: Record<string, unknown>): void {
    try { this.child.stdin?.write(`${JSON.stringify(frame)}\n`); } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** How many updates have arrived, for deciding whether a replay has gone quiet. */
  updateCount(): number {
    return this.updates.length;
  }

  takeUpdates(): Record<string, unknown>[] {
    const taken = this.updates;
    this.updates = [];
    return taken;
  }

  kill(): void {
    try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Waits for the replay to go quiet.
 *
 * Returns false when the ceiling was reached while updates were still
 * arriving. That distinction is the whole point: a replay cut off mid-stream
 * and recorded `complete` is a truncated transcript nothing will ever retry.
 */
async function drainUpdates(runtime: AcpProcess): Promise<boolean> {
  const deadline = Date.now() + REPLAY_DRAIN_LIMIT_MS;
  let seen = runtime.updateCount();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REPLAY_QUIET_MS));
    const now = runtime.updateCount();
    if (now === seen) return true;
    seen = now;
  }
  return false;
}

/** Whether the runtime says it can both enumerate and replay; without both there is nothing to offer. */
export function supportsAmbientImport(initializeResult: Record<string, unknown>): boolean {
  const capabilities = (initializeResult.agentCapabilities ?? {}) as Record<string, unknown>;
  const session = (capabilities.sessionCapabilities ?? {}) as Record<string, unknown>;
  return capabilities.loadSession === true && session.list !== undefined && session.list !== null;
}

async function openRuntime(
  target: AmbientRuntimeTarget,
  cwd: string,
  resolveLaunch: AcpLaunchResolver,
): Promise<AcpProcess | null> {
  const [rawCommand, ...rest] = target.argv;
  if (!rawCommand) return null;
  const launch = resolveLaunch(rawCommand, rest, target.installation, target.adapter_type);
  const runtime = new AcpProcess(launch.command, launch.args, launch.env, cwd);
  try {
    const result = await runtime.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, INITIALIZE_TIMEOUT_MS);
    if (!supportsAmbientImport(result)) {
      runtime.kill();
      return null;
    }
    return runtime;
  } catch (error) {
    runtime.kill();
    throw error;
  }
}

/** Injected so this module never imports the launch resolver's own dependencies. */
export type AcpLaunchResolver = (
  rawCommand: string,
  args: string[],
  installation: string,
  adapterType: string,
) => { command: string; args: string[]; env: Record<string, string> };

function parseSessionList(result: Record<string, unknown>): { sessions: AmbientSessionSummary[]; cursor: string | null } {
  const raw = Array.isArray(result.sessions) ? result.sessions : [];
  const sessions = raw.flatMap((entry): AmbientSessionSummary[] => {
    const record = entry as Record<string, unknown> | null;
    const sessionId = stringOrNull(record?.sessionId);
    const cwd = stringOrNull(record?.cwd);
    if (!sessionId || !cwd) return [];
    return [{
      session_id: sessionId.slice(0, 256),
      cwd: cwd.slice(0, 1024),
      // Redacted like every other field that leaves this machine: a session
      // title is derived from its first user message, which is exactly where
      // a pasted key ends up.
      title: (() => {
        const title = stringOrNull(record?.title);
        return title ? redactAmbientText(title).slice(0, 512) : null;
      })(),
      updated_at: stringOrNull(record?.updatedAt)?.slice(0, 64) ?? null,
    }];
  });
  return { sessions, cursor: stringOrNull(result.nextCursor) };
}

/**
 * Enumerates the sessions a runtime holds for one directory.
 *
 * Paging is bounded rather than followed to the end: a runtime pages by time
 * and a machine can hold thousands of sessions, none of them wanted once the
 * window is full.
 */
async function listSessions(
  runtime: AcpProcess,
  cwd: string,
  maxSessions: number,
  windowDays: number,
  keepIds: ReadonlySet<string> = new Set(),
): Promise<AmbientEnumeration> {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const collected: AmbientSessionSummary[] = [];
  const held: string[] = [];
  let returnedAny = false;
  let exhausted = false;
  let cursor: string | null = null;
  const PAGE_BUDGET = 20;
  for (let page = 0; page < PAGE_BUDGET; page += 1) {
    const result: Record<string, unknown> = await runtime.request(
      "session/list",
      cursor ? { cwd, cursor } : { cwd },
      LIST_TIMEOUT_MS,
    );
    const parsed = parseSessionList(result);
    if (parsed.sessions.length > 0) returnedAny = true;
    for (const session of parsed.sessions) {
      // The filter is the runtime's, and it is checked rather than trusted:
      // every adapter here is an external package on its own release
      // schedule, and one that ignored `cwd` would hand this Project another
      // folder's history — including other people's Projects and personal
      // terminal work. The cost of verifying is one comparison.
      if (!samePath(session.cwd, cwd)) continue;
      // Recorded before any Rainver-side narrowing. This is the answer to
      // "what does the host still have for this folder", which is a different
      // question from "what should this sync replay" — and the only one that
      // can justify calling an import's source gone.
      held.push(session.session_id);
      // A session the caller named, or one already held in an unfinished
      // state, stays in scope regardless of age: otherwise a partial replay
      // older than the window could never be retried.
      if (!keepIds.has(session.session_id)) {
        // A session with no timestamp cannot be excluded by the window, and
        // keeping it is the conservative choice: the alternative silently
        // drops history a runtime simply does not date.
        const at = session.updated_at ? Date.parse(session.updated_at) : Number.NaN;
        if (Number.isFinite(at) && at < cutoff) continue;
        if (collected.length >= maxSessions) continue;
      }
      collected.push(session);
    }
    if (!parsed.cursor || parsed.sessions.length === 0) break;
    cursor = parsed.cursor;
    // Ran out of page budget with more to read: `held` is then a prefix of
    // what the host has, and treating a prefix as the whole would mark the
    // unread tail gone — the same mistake as trusting a filtered list, just
    // further along.
    if (page === PAGE_BUDGET - 1) exhausted = true;
  }
  // A runtime that answered with sessions of which none are this folder's is
  // not evidence that this folder has none: far more likely it ignored or
  // misread the `cwd` filter. Saying so is the difference between one sync
  // and a folder's entire imported history being marked gone at once.
  const conclusive = !exhausted && !(returnedAny && held.length === 0);
  return { selected: collected, held, conclusive };
}

/**
 * Test seam: the paging, window, cap and cwd rules over a canned
 * `session/list` reply, with no child process. The rules decide whether an
 * import's source is called gone, which is not something to leave to an
 * end-to-end test that needs three CLIs installed.
 */
export function listSessionsForTest(
  sessions: readonly Record<string, unknown>[],
  cwd: string,
  maxSessions: number,
  windowDays: number,
  keepIds: ReadonlySet<string> = new Set(),
  options: { alwaysPaginate?: boolean } = {},
): Promise<AmbientEnumeration> {
  let page = 0;
  const fake = {
    request: async () => ({
      sessions: sessions.map((session) => ({
        ...session,
        // A distinct id per page, so a never-ending listing does not merely
        // repeat one row.
        ...(options.alwaysPaginate ? { sessionId: `${String(session.sessionId)}-${page++}` } : {}),
      })),
      nextCursor: options.alwaysPaginate ? "more" : null,
    }),
  } as unknown as AcpProcess;
  return listSessions(fake, cwd, maxSessions, windowDays, keepIds);
}

/**
 * What one enumeration found.
 *
 * `held` is everything the host still has for the folder; `selected` is the
 * subset this sync will replay after the window, the cap, and any named ids.
 * They are kept apart because only the first can justify marking an import's
 * source gone, and conflating them means a session outside the window looks
 * deleted.
 */
export interface AmbientEnumeration {
  selected: AmbientSessionSummary[];
  held: string[];
  conclusive: boolean;
}

/**
 * Whether two paths name the same directory, as far as a string can tell.
 *
 * Deliberately shallow — no symlink resolution and no case folding — because
 * this is a check on a runtime's own filter, not a security boundary: the
 * daemon was told which directory to ask about and only needs to notice an
 * adapter answering about a different one.
 */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "");
  return normalize(left) === normalize(right);
}

export interface AmbientImportRequest {
  cwd: string;
  target: AmbientRuntimeTarget;
  /** Null replays every session in the window; a list replays only those. */
  session_ids: string[] | null;
  /**
   * Sessions the server holds in an unfinished state. They are replayed even
   * when the window would exclude them: a partial import that aged out could
   * otherwise never be completed.
   */
  retry_session_ids: string[];
  /**
   * Sessions the server already holds, and the `updated_at` it holds them at.
   * A session whose timestamp is unchanged is not replayed: replaying costs an
   * agent process per session, and the runtime's own timestamp is the only
   * cheap signal that anything happened.
   */
  unchanged: Map<string, string>;
  window_days: number;
  max_sessions: number;
  limits: AmbientTrimLimits;
}

/**
 * Replays the requested sessions and returns their trimmed, redacted records.
 *
 * A session whose replay fails is reported `partial` with whatever it did
 * produce rather than aborting the import: one unreadable session must not
 * cost the other twelve, and the next sync retries it.
 */
export async function importAmbientSessions(
  request: AmbientImportRequest,
  resolveLaunch: AcpLaunchResolver,
  log: (line: string) => void,
): Promise<{ sessions: AmbientSessionImport[]; enumeration: AmbientEnumeration }> {
  const runtime = await openRuntime(request.target, request.cwd, resolveLaunch);
  if (!runtime) throw new Error(`${request.target.adapter_type} does not support listing and loading sessions`);
  try {
    const keepIds = new Set([...(request.session_ids ?? []), ...request.retry_session_ids]);
    const enumeration = await listSessions(runtime, request.cwd, request.max_sessions, request.window_days, keepIds);
    const wanted = enumeration.selected.filter((session) => {
      if (request.session_ids && !request.session_ids.includes(session.session_id)) return false;
      if (request.retry_session_ids.includes(session.session_id)) return true;
      const held = request.unchanged.get(session.session_id);
      if (held === undefined || session.updated_at === null) return true;
      // Compared as instants, not strings: the server renders its stored
      // timestamp and the runtime prints its own, and the two formats agree
      // on the moment far more reliably than on the text.
      const heldAt = Date.parse(held);
      const listedAt = Date.parse(session.updated_at);
      if (!Number.isFinite(heldAt) || !Number.isFinite(listedAt)) return true;
      return heldAt !== listedAt;
    });
    const results: AmbientSessionImport[] = [];
    for (const session of wanted) {
      runtime.takeUpdates();
      let loadState: "complete" | "partial" = "complete";
      let error: string | null = null;
      try {
        await runtime.request("session/load", {
          sessionId: session.session_id,
          cwd: request.cwd,
          mcpServers: [],
        }, LOAD_TIMEOUT_MS);
        if (!await drainUpdates(runtime)) {
          loadState = "partial";
          error = "the replay was still streaming when the drain ceiling was reached";
        }
      } catch (failure) {
        loadState = "partial";
        // A runtime's failure text routinely names absolute paths on this
        // machine and can quote what it was working on; it is reported, so it
        // is redacted and stripped of paths like anything else.
        error = sanitizeFailure(failure);
        log(`ambient import: session ${session.session_id} replay failed: ${error}`);
      }
      const built = buildAmbientRecords(runtime.takeUpdates(), request.limits);
      results.push({ session, load_state: loadState, records: built.records, usage: built.usage, error });
      if (loadState === "partial") {
        // Stop after any unfinished replay. If it produced nothing the runtime
        // is not answering and further loads only pay the timeout again; if it
        // produced something it is by definition still emitting, and those
        // late updates would be collected as the *next* session's records and
        // recorded complete. Both sessions are retried on the next sync.
        break;
      }
    }
    return { sessions: results, enumeration };
  } finally {
    runtime.kill();
  }
}

/** Enumerates without replaying: what the heartbeat's counts are built from. */
export async function countAmbientSessions(
  target: AmbientRuntimeTarget,
  cwd: string,
  windowDays: number,
  maxSessions: number,
  resolveLaunch: AcpLaunchResolver,
): Promise<{ sessions: AmbientSessionSummary[] } | null> {
  const runtime = await openRuntime(target, cwd, resolveLaunch);
  if (!runtime) return null;
  try {
    return { sessions: (await listSessions(runtime, cwd, maxSessions, windowDays)).selected };
  } finally {
    runtime.kill();
  }
}
