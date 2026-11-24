/**
 * `source.gmail.digest.read` — the mail read of a scheduled digest Run
 * (ADR 0033 phase B), an operation-core query on ADR 0030's sensitive path:
 *
 * - **Offered** only to a digest delivery's own Run: its snapshot lists only
 *   this tool (`runs/repository.ts`), the conversation is the Project
 *   conversation the digest delivers into (the owner's private one, a Room or
 *   the mainline), the scenario is `scheduled` (an `automation`-origin Run,
 *   owner-only in a private conversation). It runs on that
 *   conversation's own selected runtime (CLI, Host, native login, model;
 *   ADR 0033 §6); the Gmail credential stays on the
 *   server and the read goes through its broker.
 * - **Authorize** (call time): the frozen pin, the live scenario and the
 *   digest's consent (`liveGmailDigestConsents`: this Run is the running
 *   delivery of an active digest whose consent still admits — owner active,
 *   still reading the Project, connection active, opted in, same generation),
 *   and every reader of the Run reads that Project.
 *   It is never requestable: a missing consent is refused.
 * - **Execute**: one page of the frozen window (daily) or frozen ids (rule),
 *   at most `readsPerRun` calls per Run, with the consent, the running Run,
 *   the running delivery and the conversation's whole audience
 *   (`gmailDigestRunAdmits`) rechecked before every Gmail send — and, for an
 *   automation, that the request's launch is still current and proven; for a
 *   daily or rule digest, that the Run was created and launched on exactly the
 *   configuration its card showed (`digestRunOnConfirmedRuntime`, ADR 0035 §3).
 * - **Release gate** (audit transaction): Project `FOR SHARE` with the
 *   owner's member row → person → Run `FOR UPDATE` → (an automation's) the
 *   request's launch attempt `FOR SHARE` → Gmail mutex → connection → consent
 *   `FOR SHARE`, as the on-demand read and in the order the automation's fact
 *   command takes them (`plugins/operationRegistry.ts`); then the taint,
 *   the Agent-read log (`gmail_message` ids, the consent), the owner's Gmail
 *   audit (`digest_read`, counts only) and the delivery's progress.
 * - **One launch** (application updates, ADR 0034): the read, its model-proof
 *   wait, every Gmail send and its release belong to the launch the request
 *   came from (`runs/runToolRequest.ts`); a request of an earlier launch is
 *   refused before its next send or withheld once the Run was relaunched,
 *   whatever the new launch proved. The release is logged for that launch, and
 *   only that launch's facts and flags may cite it.
 * - **One budget**: the model-proof wait, the Gmail page and the release share
 *   `GMAIL_DIGEST_READ_BUDGET_MS` from the request's arrival, inside the
 *   caller's 65-second HTTP timeout (`packages/agent-cli/src/toolHttp.ts`): the
 *   release holds that absolute deadline up to its commit boundary — each
 *   statement's lock wait and run time are cut to what is left when it starts,
 *   the statement in progress is cancelled at the deadline or when the caller
 *   goes away — and it commits nothing (no audit, no read progress) once the
 *   budget is spent (`boundRelease`).
 *
 * The result reaches the model only; event logs carry neither arguments nor
 * result (`privateToolCalls.ts`); the reply is the delivery conversation's.
 */
import { GMAIL_DIGEST_LIMITS, type GmailDigestReadInput, type GmailDigestReadOutput, type GmailDigestRuntimeBinding, type OperationActor, type RegisteredSystemActionDefinition } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool, getGmailReadControlPool } from "../../../db/pool.js";
import { runHostWorkOutsideOperation } from "../../../db/operationTransaction.js";
import { poisonTransaction } from "../../../db/tx.js";
import { lockActivePeople } from "../../access/activePerson.js";
import { recordAgentDataRead } from "../../contentAccess/agentReads.js";
import { pluginDataFacts } from "../../plugins/dataAccess.js";
import { assertProjectReadableLocked } from "../../projects/access.js";
import type { Queryable } from "../../routeUtils/common.js";
import { persistRunContextTaint } from "../../runs/contextTaint.js";
import { stopAtCommitOnModelFallback } from "../../runs/runtimeModelFallback.js";
import { runToolRequest } from "../../runs/runToolRequest.js";
import { assertCurrentActor } from "../../systemActions/operations/actor.js";
import { hidden, OperationError, OperationRefusal } from "../../systemActions/operations/errors.js";
import type { OperationRegistration } from "../../systemActions/operations/types.js";
import { GmailReadError, recheckGmailRead, type GmailReadSnapshot } from "./gmailReadAuthority.js";
import { applicationUpdateRunState, digestRunOnConfirmedRuntime } from "./gmailApplicationUpdateRuns.js";
import { GMAIL_DIGEST_CONSENT_ID, GMAIL_DIGEST_READ_ACTION, gmailDigestAgentAdmitted, gmailDigestConversationAdmits, gmailDigestReadAvailable, gmailDigestRunAdmits, type DeliveryRow, type DigestRow } from "./gmailDigests.js";
import { GmailCursorError, gmailCursorExpiry, gmailCursorLive, openGmailCursor, signGmailCursor, type GmailDigestCursor } from "./gmailCursor.js";
import { readGmailDigestPage } from "./gmailDigestReads.js";

const FACTS = Symbol("rainver.gmail.digest_read_facts");

/**
 * One digest read end to end — an automation's model-proof wait, the Gmail page and the release — from the
 * request's arrival. The caller's HTTP timeout for this tool is 65 s (`toolHttpTimeoutMs`,
 * `packages/agent-cli/src/toolHttp.ts`); the 10 s left cover the commit and the response, so the server
 * answers before the caller gives up: a page the budget ended is 504 `gmail_upstream_timeout`, a release it
 * ended is withheld (503) with nothing committed.
 */
export const GMAIL_DIGEST_READ_BUDGET_MS = 55_000;
let budgetOverrideMs: number | null = null;
export function __setGmailDigestReadBudgetForTests(ms: number | null): void { budgetOverrideMs = ms; }

interface ReleaseFacts {
  v: 1;
  snapshot: GmailReadSnapshot;
  grantId: string;
  projectId: string;
  digestId: string;
  deliveryId: string;
  messageIds: string[];
  sentIds?: string[];
  /**
   * Frozen ids of the page found ineligible when fetched (`readGmailDigestPage`). Recorded only on the
   * automation's mail items as settled (`done`, `not_eligible`), never in the Agent-read log, so no fact or flag
   * can cite one. Absent in facts frozen before it existed.
   */
  excludedIds?: string[];
  /**
   * Frozen ids of the page Gmail answered with 404 (application updates): nothing was read. Settled on the
   * automation's mail items as given up (`failed`, `read_failed`), never in the Agent-read log, so no fact or flag
   * can cite one. Absent in facts frozen before it existed.
   */
  goneIds?: string[];
  pageIndex: number;
  complete: boolean;
  truncated: boolean;
  requestId: string;
  /** The launch the request came from (application updates); its release is withheld once it is not current. */
  launchId: string | null;
  /** The read's end-to-end deadline (epoch ms): the release waits, runs and commits only before it. */
  deadlineAt: number;
}

const withheld = () => new OperationError("operation_audit_unavailable", 503, true);
const MESSAGES: Partial<Record<string, string>> = {
  gmail_digest_unavailable: "This digest cannot read mail any more (the owner paused or ended it, or the connection changed). Tell the owner the digest could not be produced.",
  gmail_digest_audience_outside_project: "Someone who reads this conversation no longer works in its Project, so this digest cannot read mail here. Do not summarize anything; say the digest could not be produced.",
  gmail_digest_audience_not_owner: "This is not (or no longer) only the mailbox owner's private conversation, so the automatic application updates cannot read mail here. Record nothing; say the check could not be completed.",
  gmail_digest_read_limit: "This digest Run reached its read limit before the window was complete. Report that the digest could not be produced.",
  gmail_digest_model_fallback: "This Run's runtime reported that it answered with another model than the one the owner chose, so this round stops: no more mail is read and nothing more is recorded. Call no other tool; end your turn.",
  gmail_digest_rule_changed: "This Run was started for an earlier version of the owner's automation or its model, so it reads no mail. Record nothing; say the check could not be completed.",
  gmail_digest_runtime_changed: "This Run does not run on the Agent, runtime, Provider, model or session options the owner confirmed for this digest (for example its model was replaced), so it reads no mail. Do not summarize anything; say the digest could not be produced.",
  gmail_digest_agent_not_in_project: "This Agent is no longer on the Project's Agent list, so it reads no mail here. Record nothing; say the check could not be completed.",
  gmail_upstream_timeout: "Gmail did not answer within this read's time limit. Record nothing; say the check could not be completed.",
  gmail_cursor_invalid: "Start without a token, then pass exactly the next_page_token of the previous released page.",
};
const refuse = (status: 409 | 422 | 429, code: string) => new OperationRefusal(status, "sources", MESSAGES[code] ?? code.replaceAll("_", " "), { code });

/** A page the read's budget (or Gmail's own deadline) ended: 504 with its fixed code and what the Agent should say. */
class GmailDigestReadTimeout extends OperationError {
  constructor() { super("operation_temporarily_unavailable", 504, true, "sources"); }
  override body(requestId: string) {
    const body = super.body(requestId);
    body.error.message = MESSAGES.gmail_upstream_timeout!;
    body.error.metadata = { code: "gmail_upstream_timeout" };
    return body;
  }
}

function fromGmailError(error: GmailReadError): OperationError {
  if (error.code === "gmail_not_found") return hidden();
  if (error.code === "gmail_upstream_timeout") return new GmailDigestReadTimeout();
  if (error.status === 429) return refuse(429, error.code);
  if (error.status === 409 || error.status === 422) return refuse(error.status, error.code);
  return new OperationError("operation_temporarily_unavailable", 503, true, "sources");
}

/** The running delivery of this Run and its digest, or null. */
async function runDelivery(db: Queryable, actor: OperationActor): Promise<{ digest: DigestRow; delivery: DeliveryRow } | null> {
  const delivery = (await db.query<DeliveryRow>(`SELECT * FROM gmail_digest_deliveries WHERE run_id=$1 AND space_id=$2 AND status='running'`, [actor.run_id, actor.space_id])).rows[0];
  if (!delivery) return null;
  const digest = (await db.query<DigestRow>(`SELECT * FROM gmail_digests WHERE id=$1 AND owner_user_id=$2`, [delivery.digest_id, actor.on_behalf_of_user_id])).rows[0];
  return digest ? { digest, delivery } : null;
}

async function runSession(db: Queryable, actor: OperationActor): Promise<string | null> {
  return (await db.query<{ session_id: string | null }>(`SELECT session_id FROM runs WHERE id=$1 AND space_id=$2`, [actor.run_id, actor.space_id])).rows[0]?.session_id ?? null;
}

async function readsUsed(db: Queryable, actor: OperationActor): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE space_id=$1 AND run_id=$2 AND action_id=$3 AND resource_type='gmail_message'`,
    [actor.space_id, actor.run_id, GMAIL_DIGEST_READ_ACTION])).rows[0]?.n ?? 0;
}

export function gmailDigestReadRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>, config: ServerConfig): OperationRegistration {
  return {
    definition: definitions.get(GMAIL_DIGEST_READ_ACTION)!,
    readKind: "content",
    async resolve(db, _raw, actor) {
      const found = actor.principal.kind === "agent" && actor.on_behalf_of_user_id ? await runDelivery(db, actor) : null;
      return { authority: `gmail_digest_read:${actor.run_id ?? "none"}`, targets: { run_id: actor.run_id }, resourceType: "gmail_digest", resourceId: found?.digest.id ?? null };
    },
    async authorize(db, _raw, actor, scope) {
      if (actor.principal.kind !== "agent" || !actor.run_id || !actor.on_behalf_of_user_id) throw hidden();
      const facts = await pluginDataFacts(db, config, actor, GMAIL_DIGEST_READ_ACTION, false);
      if (!facts || facts === "pin_mismatch") throw new OperationError("operation_not_granted", 403);
      const available = await gmailDigestReadAvailable(db, { spaceId: actor.space_id, userId: actor.on_behalf_of_user_id, sessionId: await runSession(db, actor) });
      scope.policyFacts = {
        plugin_data_class: "sensitive",
        plugin_data_consent: available && facts.consent,
        // Given on the owner's confirmation card only; a digest Run never asks.
        plugin_data_requestable: false,
        ...(facts.isolated === false ? { plugin_data_isolated: false } : {}),
      };
    },
    policyContext(_input, _actor, scope) {
      return { ...scope.policyFacts };
    },
    async execute(db, raw, actor, invocation) {
      const input = raw as GmailDigestReadInput;
      const person = actor.on_behalf_of_user_id!;
      // The request's own launch and arrival (host-authored, from the caller's token), fixed for the whole read.
      const request = runToolRequest();
      const launchId = request?.launchId ?? null;
      const deadlineAt = (request?.startedAt ?? Date.now()) + (budgetOverrideMs ?? GMAIL_DIGEST_READ_BUDGET_MS);
      const facts = await pluginDataFacts(db, config, actor, GMAIL_DIGEST_READ_ACTION, false);
      if (!facts || facts === "pin_mismatch" || !facts.consent || !facts.grantId) throw hidden();
      const found = await runDelivery(db, actor);
      if (!found || found.digest.grant_id !== facts.grantId) throw hidden();
      const { digest, delivery } = found;
      // An automation's mail is fetched only for the request's own current launch, on the configuration its card froze,
      // and never once its runtime reported a response from another model (ADR 0037); the release gate checks it again
      // for the same launch. No proof of which model answers is waited for.
      if (digest.kind === "application") {
        const state = await applicationUpdateRunState(db, { spaceId: actor.space_id, runId: actor.run_id!, binding: digest.runtime_binding, launchId });
        if (state !== "ok") throw refuse(409, state === "fallback" ? "gmail_digest_model_fallback" : "gmail_digest_runtime_changed");
      }
      if (delivery.read_complete) throw refuse(409, "gmail_digest_unavailable");
      const pageIndex = await readsUsed(db, actor);
      if (pageIndex >= GMAIL_DIGEST_LIMITS.readsPerRun) throw refuse(429, "gmail_digest_read_limit");
      if (delivery.error_code) throw refuse(409, "gmail_digest_unavailable");
      const grantId = facts.grantId;
      const window = { start: new Date(delivery.window_start), end: new Date(delivery.window_end) };
      let cursor: GmailDigestCursor | undefined;
      if (input.page_token) {
        try { cursor = await openGmailCursor(config, input.page_token, "digest"); }
        catch (error) { if (error instanceof GmailCursorError) throw refuse(422, "gmail_cursor_invalid"); throw error; }
        if (cursor.delivery !== delivery.id || cursor.o !== person || cursor.s !== actor.space_id
          || cursor.c !== digest.gmail_connection_id || cursor.p !== digest.project_id || !await gmailCursorLive(db, cursor)) {
          throw refuse(422, "gmail_cursor_invalid");
        }
      }
      if ((cursor?.index ?? 0) !== pageIndex) throw refuse(422, "gmail_cursor_invalid");
      // A daily or rule digest's mail goes only to a Run on the configuration its card showed, as created and launched (ADR 0035 §3).
      if (digest.kind !== "application" && !await digestRunOnConfirmedRuntime(db, { spaceId: actor.space_id, runId: actor.run_id!, binding: digest.runtime_binding, requireLaunchBound: true }))
        throw refuse(409, "gmail_digest_runtime_changed");
      let page: Awaited<ReturnType<typeof readGmailDigestPage>>;
      try {
        page = await runHostWorkOutsideOperation(async () => {
          const pool = getDbPool(config.databaseUrl!);
          return readGmailDigestPage(config, pool, {
            spaceId: actor.space_id, ownerUserId: person, connectionId: digest.gmail_connection_id, kind: digest.kind, window, sentFrom: digest.runtime_binding?.sent_from,
            ids: Array.isArray(delivery.message_ids) ? delivery.message_ids : null, pageToken: cursor?.page ?? null,
            signal: invocation?.signal ?? new AbortController().signal, deadlineAt,
            // Ending or pausing the digest, a lost consent, or the Run or delivery ending stops the read before its next send.
            authorizeSend: async (db) => {
              const live = (await db.query(`SELECT 1 FROM runs r JOIN gmail_digest_deliveries dl ON dl.run_id=r.id AND dl.id=$3 AND dl.status='running'
                  JOIN gmail_digests d ON d.id=dl.digest_id AND d.status='active' WHERE r.id=$1 AND r.space_id=$2 AND r.status='running'`,
                [actor.run_id, actor.space_id, delivery.id])).rows.length > 0;
              if (!live) throw new GmailReadError(409, "gmail_digest_unavailable");
              // The consent and the conversation's whole audience, by the rule the claim and settlement use.
              const admitted = await gmailDigestRunAdmits(db, { spaceId: actor.space_id, ownerUserId: person, runId: actor.run_id! });
              if (!admitted.ok) throw new GmailReadError(409, admitted.code);
              if (admitted.grantId !== grantId) throw new GmailReadError(409, "gmail_digest_unavailable");
              // An automation's next send only while the request's own launch is still the Run's current one on its frozen
              // configuration and no fallback was reported: a relaunch or a reported fallback stops the read here, before
              // Gmail is asked for another message, not only at the release (ADR 0034, 0037).
              if (digest.kind === "application") {
                const state = await applicationUpdateRunState(db, { spaceId: actor.space_id, runId: actor.run_id!, binding: digest.runtime_binding, launchId });
                if (state !== "ok") throw new GmailReadError(409, state === "fallback" ? "gmail_digest_model_fallback" : "gmail_digest_runtime_changed");
              }
              // A summary's Run whose model, Provider or session options were switched since (a quota switch, a dropped
              // saved option) stops before its next send.
              if (digest.kind !== "application" && !await digestRunOnConfirmedRuntime(db, {
                spaceId: actor.space_id, runId: actor.run_id!, binding: digest.runtime_binding, requireLaunchBound: true })) throw new GmailReadError(409, "gmail_digest_runtime_changed");
            },
          });
        });
      } catch (error) {
        if (error instanceof GmailReadError) throw fromGmailError(error);
        throw error;
      }
      if (cursor && cursor.g !== page.snapshot.generation) throw refuse(422, "gmail_cursor_invalid");
      const next = page.nextPageToken === null ? null : await signGmailCursor(config, {
        v: 1, k: "digest", o: person, s: actor.space_id, c: digest.gmail_connection_id, p: digest.project_id,
        g: page.snapshot.generation, e: await gmailCursorExpiry(db), delivery: delivery.id, page: page.nextPageToken, index: pageIndex + 1,
      });
      const output: GmailDigestReadOutput = {
        mailbox_email: page.snapshot.mailboxEmail, kind: digest.kind, window_start: window.start.toISOString(), window_end: window.end.toISOString(),
        gap_before: delivery.gap_before, items: page.items, next_page_token: next, more_in_window: next !== null,
        truncated: page.truncated,
      };
      Object.defineProperty(output, FACTS, {
        enumerable: false,
        value: {
          v: 1, snapshot: page.snapshot, grantId, projectId: digest.project_id, digestId: digest.id, deliveryId: delivery.id,
          messageIds: page.items.map((item) => item.id), sentIds: page.items.filter((item) => item.direction === "sent").map((item) => item.id), excludedIds: page.excludedIds, goneIds: page.goneIds, pageIndex, complete: page.nextPageToken === null,
          truncated: page.truncated, requestId: invocation?.requestId ?? "", launchId, deadlineAt,
        } satisfies ReleaseFacts,
      });
      return output;
    },
    releaseFacts(raw) {
      return raw && typeof raw === "object" ? (raw as { [FACTS]?: ReleaseFacts })[FACTS] ?? null : null;
    },
    async releaseGate(audit, release) {
      await releaseGmailDigestRead(audit, config, release.actor, release.facts as ReleaseFacts | null);
    },
  };
}

/** The release of one digest read, in the audit transaction (lock order in the module comment). */
export async function releaseGmailDigestRead(db: Queryable, config: ServerConfig, actor: OperationActor, facts: ReleaseFacts | null): Promise<void> {
  const person = actor.on_behalf_of_user_id;
  if (actor.principal.kind !== "agent" || !person || !facts || facts.v !== 1) throw withheld();
  const bound = await boundRelease(db, config, facts.deadlineAt, runToolRequest()?.signal);
  try {
    const kind = await releaseWithin(bound.db, config, actor, person, facts);
    // An automation's mail is handed out only by this commit: a fallback report this process receives from here on —
    // while a statement above waited, or before COMMIT is issued — withholds it (`stopAtCommitOnModelFallback`).
    if (kind === "application") stopAtCommitOnModelFallback(db, { spaceId: actor.space_id, runId: actor.run_id! }, withheld);
    // Nothing is committed for a caller that went away or a read past its budget: the transaction rolls back.
    // No await separates this check from `close` (which disarms the deadline and the abort) and the gate's
    // return to the COMMIT of `withTransaction`, so no cancel is ever sent to a committing transaction.
    bound.assertLive();
  } finally {
    await bound.close();
  }
}

/** How long a cancel sent for the release may take to be answered before its connection is discarded. */
const RELEASE_CANCEL_ANSWER_MS = 2_000;

/**
 * Bounds the release transaction to the read's absolute deadline up to its commit boundary (the gate's return):
 *
 * - Every statement runs with `lock_timeout` and `statement_timeout` cut to the time left *when it starts*, so
 *   a sequence of lock waits can never add up past the deadline inside PostgreSQL, whether or not a cancel
 *   reaches it; once the deadline has passed or the caller has gone away no further statement is sent.
 * - At the deadline, or when the request is aborted — including an abort that came while the backend marker was
 *   being read, before any listener existed — the statement in progress is cancelled through the Gmail read
 *   control pool (`pg_cancel_backend`, identified by pid and `backend_start` while this transaction holds the
 *   connection), so a lock wait ends at once instead of at its timeout.
 * - `close` disarms both, then waits for a cancel already sent; one not answered within its bound (or not
 *   delivered) poisons the transaction, so its connection is destroyed instead of pooled and a late cancel can
 *   never reach the connection's next transaction.
 *
 * `assertLive` refuses once either has ended: the transaction rolls back with no taint, read log, audit row or
 * read progress for a caller that no longer waits.
 */
async function boundRelease(client: Queryable, config: ServerConfig, deadlineAt: number, signal: AbortSignal | undefined) {
  const expired = () => signal?.aborted === true || Date.now() >= deadlineAt;
  const timeouts = () => { const ms = `${Math.max(1, deadlineAt - Date.now())}ms`; return [ms, ms]; };
  if (expired()) throw withheld();
  const marker = (await client.query<{ pid: number; started: string }>(
    `SELECT a.pid, a.backend_start::text AS started, set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)
       FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`, timeouts())).rows[0];
  if (!marker) throw withheld();
  let cancellation: Promise<boolean> | undefined;
  let disarmed = false;
  const cancel = () => {
    if (cancellation || disarmed) return;
    cancellation = getGmailReadControlPool(config.databaseUrl!).query<{ sent: boolean }>(
      `SELECT pg_cancel_backend(pid) AS sent FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz`, [marker.pid, marker.started])
      .then((result) => result.rows[0]?.sent === true, () => false);
  };
  const timer = setTimeout(cancel, Math.max(0, deadlineAt - Date.now()));
  signal?.addEventListener("abort", cancel, { once: true });
  // An abort during the marker query fired before the listener existed.
  if (expired()) cancel();
  const db: Queryable = {
    async query(sql, params) {
      if (expired()) throw withheld();
      await client.query(`SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)`, timeouts());
      if (expired()) throw withheld();
      return client.query(sql, params);
    },
  };
  return {
    db,
    assertLive() { if (expired()) throw withheld(); },
    async close() {
      disarmed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (!cancellation) return;
      let wait: NodeJS.Timeout | undefined;
      const answered = await Promise.race([cancellation, new Promise<boolean>((resolve) => { wait = setTimeout(() => resolve(false), RELEASE_CANCEL_ANSWER_MS); })]);
      clearTimeout(wait);
      if (!answered) poisonTransaction(client);
    },
  };
}

/** The release's checks and writes; returns the digest's kind. */
async function releaseWithin(db: Queryable, config: ServerConfig, actor: OperationActor, person: string, facts: ReleaseFacts): Promise<string> {
  try { await assertProjectReadableLocked(db, actor.space_id, facts.projectId, person); } catch { throw withheld(); }
  try { await lockActivePeople(db, actor.space_id, [person]); } catch { throw withheld(); }
  const run = (await db.query<{ id: string; visibility: "private" | "selected_users" | "space_shared"; session_id: string | null; agent_id: string | null }>(
    `SELECT id,visibility,session_id,agent_id FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE`, [actor.run_id, actor.space_id])).rows[0];
  if (!run) throw withheld();
  try { await assertCurrentActor(db, actor); } catch { throw withheld(); }
  // The delivery conversation's readers: the owner alone in their private conversation, or a Room's or the
  // mainline's roster, Project readers and the Run's own audience, every one of whom still reads the digest's
  // Project (ADR 0033 phase B) — the one rule of `gmailDigestConversationAdmits`.
  const digestRow = (await db.query<{ kind: string; runtime_binding: GmailDigestRuntimeBinding | null }>(`SELECT kind,runtime_binding FROM gmail_digests WHERE id=$1 AND space_id=$2`, [facts.digestId, actor.space_id])).rows[0];
  const kind = digestRow?.kind;
  if (facts.sentIds?.length && (kind !== "application" || !digestRow.runtime_binding?.sent_from)) throw withheld();
  const conversation = kind && run.session_id ? await gmailDigestConversationAdmits(db, {
    spaceId: actor.space_id, ownerUserId: person, projectId: facts.projectId, sessionId: run.session_id, runId: run.id, ownerOnly: kind === "application" }) : null;
  if (!conversation) throw withheld();
  // An application automation's Agent is one the Project admits at this release (its list or its Assistant), held until
  // commit so a removal waits: mail never reaches an Agent removed from the Project since the Run started.
  if (kind === "application" && !await gmailDigestAgentAdmitted(db, { spaceId: actor.space_id, projectId: facts.projectId, agentId: run.agent_id, lock: true })) throw withheld();
  // An automation's mail reaches only the Run on the Agent, runtime and model its owner chose: never one whose model
  // option was dropped for the runtime's default, another provider, or a Run whose runtime reported a fallback — and
  // only the launch that asked for it, while it is still the current one (held until commit, so a relaunch waits).
  if (kind === "application" && (facts.launchId === null || runToolRequest()?.launchId !== facts.launchId
    || await applicationUpdateRunState(db, { spaceId: actor.space_id, runId: run.id, binding: digestRow.runtime_binding, launchId: facts.launchId, lock: true }) !== "ok")) throw withheld();
  if (kind !== "application" && !await digestRunOnConfirmedRuntime(db, { spaceId: actor.space_id, runId: run.id, binding: digestRow.runtime_binding, requireLaunchBound: true })) throw withheld();
  try { await recheckGmailRead(db, facts.snapshot); } catch { throw withheld(); }
  if (!await gmailDigestReadAvailable(db, { spaceId: actor.space_id, userId: person, sessionId: run.session_id })) throw withheld();
  const consent = await pluginDataFacts(db, config, actor, GMAIL_DIGEST_READ_ACTION, true);
  if (!consent || consent === "pin_mismatch" || !consent.consent || consent.grantId !== facts.grantId) throw withheld();
  const delivery = (await db.query<{ id: string }>(`SELECT dl.id FROM gmail_digest_deliveries dl JOIN gmail_digests d ON d.id=dl.digest_id
      WHERE dl.id=$1 AND dl.run_id=$2 AND dl.status='running' AND NOT dl.read_complete AND dl.error_code IS NULL AND d.id=$3 AND d.grant_id=$4 AND d.status='active' FOR UPDATE OF dl`,
    [facts.deliveryId, run.id, facts.digestId, facts.grantId])).rows[0];
  if (!delivery) throw withheld();
  // A cursor can only advance the release it was issued for. A concurrent
  // call that read the same page loses here before the model sees any data.
  if (facts.pageIndex >= GMAIL_DIGEST_LIMITS.readsPerRun || await readsUsed(db, actor) !== facts.pageIndex) throw withheld();
  await persistRunContextTaint(db, {
    runId: run.id, spaceId: actor.space_id, instructingUserId: person, runVisibility: run.visibility,
    items: [{ ownerUserId: person, visibility: "private" }],
    pluginReads: [{ plugin_id: GMAIL_DIGEST_CONSENT_ID, data_class: "sensitive", owner_user_id: person }],
  });
  await recordAgentDataRead(db, {
    spaceId: actor.space_id, ownerUserId: person, runId: run.id, agentId: actor.agent_id, actionId: GMAIL_DIGEST_READ_ACTION,
    resourceType: "gmail_message", resourceIds: facts.messageIds.filter((id) => !facts.sentIds?.includes(id)), dataClass: "sensitive", grantId: facts.grantId,
    // An automation's mail is released to one launch; only that launch's facts and flags may cite it (ADR 0034).
    launchId: kind === "application" ? facts.launchId : null,
  });
  // Attest direction for fact validation, using the same release log for both.
  if (facts.sentIds?.length) {
    await recordAgentDataRead(db, {
      spaceId: actor.space_id, ownerUserId: person, runId: run.id, agentId: actor.agent_id, actionId: GMAIL_DIGEST_READ_ACTION,
      resourceType: "gmail_sent_message", resourceIds: facts.sentIds, dataClass: "sensitive", grantId: facts.grantId, launchId: facts.launchId,
    });
  }
  await db.query(
    `INSERT INTO gmail_read_audit_events (id,space_id,owner_user_id,actor_user_id,gmail_connection_id,project_id,selection_id,operation,
       google_thread_id,item_count,truncated,request_id,run_id,agent_id,accessed_at)
     VALUES (gen_random_uuid()::text,$1,$2,$2,$3,$9,NULL,'digest_read',NULL,$4,$5,$6,$7,$8,clock_timestamp())`,
    [actor.space_id, person, facts.snapshot.connectionId, facts.messageIds.length, facts.truncated, facts.requestId.slice(0, 128) || run.id, run.id, actor.agent_id ?? actor.principal.id, facts.projectId],
  );
  // A frozen message that turned ineligible (spam, trash, sent, draft, chat) before it was read was examined and
  // withheld: it is settled here, with this release, so no later delivery waits on it — and only here, never as a
  // released id, so it stays uncitable (ADR 0034 §7). Only still-waiting items of this delivery's frozen ids.
  const excluded = kind === "application" && Array.isArray(facts.excludedIds) ? facts.excludedIds.filter((id) => !facts.messageIds.includes(id)) : [];
  if (excluded.length) {
    await db.query(`UPDATE gmail_digest_mail_items i SET status='done',reason='not_eligible',updated_at=clock_timestamp()
        FROM gmail_digest_deliveries dl
       WHERE dl.id=$2 AND i.digest_id=$1 AND i.status='pending' AND i.google_message_id=ANY($3::varchar[])
         AND jsonb_typeof(dl.message_ids)='array' AND dl.message_ids ? i.google_message_id`,
      [facts.digestId, delivery.id, excluded]);
  }
  // A frozen message Gmail no longer has (404) can never be read: it is given up here, with this release, as a
  // read that failed for good, so it neither waits for another delivery nor counts toward the digest's pause —
  // and, never released, it is uncitable (ADR 0034 §7).
  const gone = kind === "application" && Array.isArray(facts.goneIds) ? facts.goneIds.filter((id) => !facts.messageIds.includes(id)) : [];
  if (gone.length) {
    await db.query(`UPDATE gmail_digest_mail_items i SET status='failed',reason='read_failed',updated_at=clock_timestamp()
        FROM gmail_digest_deliveries dl
       WHERE dl.id=$2 AND i.digest_id=$1 AND i.status='pending' AND i.google_message_id=ANY($3::varchar[])
         AND jsonb_typeof(dl.message_ids)='array' AND dl.message_ids ? i.google_message_id`,
      [facts.digestId, delivery.id, gone]);
  }
  const hitLimit = !facts.complete && facts.pageIndex + 1 === GMAIL_DIGEST_LIMITS.readsPerRun;
  await db.query(`UPDATE gmail_digest_deliveries SET message_count=message_count+$2,read_complete=$3,error_code=$4 WHERE id=$1`,
    [delivery.id, facts.messageIds.length, facts.complete, hitLimit ? "gmail_digest_read_limit" : null]);
  return kind;
}
