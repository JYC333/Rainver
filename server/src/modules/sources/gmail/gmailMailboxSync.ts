/**
 * Gmail V2 background sync: one persisted `history.list` cursor per
 * connection drives both push wake-ups and scheduled checks, so they cannot
 * disagree about what is new. Every sync is:
 *
 * 1. **Claim** (short transaction; lock order person → owner + Space mutex →
 *    connection `FOR SHARE` → sync row `FOR UPDATE`): only an active owner's
 *    active connection with at least one active monitor gets a lease
 *    (`lease_id`, 3 min). A live lease means another sync runs: this one ends
 *    (`busy`), and the pending request stays for the next. The claim consumes
 *    `sync_requested_at`; a push arriving later sets it again.
 * 2. **Fetch** outside every transaction, through a Sources broker built from
 *    `gmailSyncRequestPolicy` (exact URL per hop, no redirects, ≤ 50 sends,
 *    the account/owner quota plus a sync-only quota so syncs cannot starve the
 *    owner's own reads). Each send first rechecks person, connection,
 *    generation and the lease. Header-only metadata of each new message is
 *    matched against the claimed monitors in memory and then dropped.
 * 3. **Settle** (short transaction, same lock order): only while the lease and
 *    the connection generation are unchanged. Matches are inserted into the
 *    dedup ledger (`ON CONFLICT DO NOTHING`), and only newly inserted ones
 *    count, update the monitor and raise the owner's private Inbox pointer —
 *    all with the cursor in the same transaction. The cursor only moves
 *    forward (numeric compare), so a duplicate, late or out-of-order wake-up
 *    re-reads at most an overlap the ledger already holds.
 *
 * Cursor states: `baseline` (first enable or re-enable) takes the current
 * position from `users.getProfile` and scans only mail received since the
 * monitor was accepted (`after:`), so an inbox's old mail is never "new".
 * Google answering 404 for the cursor moves to `recovering`: the position is
 * read again first, then a bounded `after:` scan from the last success (≤ 7
 * days, ≤ one page); what does not fit is reported as `recovery_partial`.
 * A sync that hits its message bound stops at the last fully processed
 * history record and asks for a follow-up sync instead of skipping mail; a
 * bound inside one record persists that record's progress (sorted ids) beside
 * the unchanged cursor, which passes the record only once it is all checked.
 * Settlement and the cursor guard compare each monitor's id + exact
 * `active_since` with the claim, so a pause and resume during the sync neither
 * reminds from the old batch nor skips what the new version has not checked.
 *
 * A failure keeps the cursor and sets the durable retry floor
 * (`retry_not_before`: backoff, or the quota / Google retry time) that every
 * wake-up honours (`gmailSyncRequests.ts`); a failure of a sync a reconnect
 * superseded (new generation) only drops its lease. The `users.watch` renewal
 * runs after the increment is committed, with its own deadline, and records
 * its own outcome and retry time (Google's Retry-After kept, its timeout
 * `gmail_watch_timeout`); only lost authority in it fails the sync.
 * Reauth / disconnect / lost membership pause the connection's sync with the
 * cursor kept; a reconnect of the same account resumes from it (or recovers).
 */
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../../config.js";
import type { Pool } from "../../../db/pool.js";
import type { TransactionRunner } from "../../../db/tx.js";
import { lockActivePerson } from "../../access/activePerson.js";
import { OperationalAlertService } from "../../notifications/operationalAlerts.js";
import type { Queryable } from "../../routeUtils/common.js";
import { createSourceRequestBroker, SourceRequestError, type SourceRequestBroker } from "../sourceRequestBroker.js";
import { admitSourceRequestGroups, coolDownSourceRequests, sourceQuotaGroup } from "../sourceRequestQuota.js";
import type { OutboundGuard } from "../outboundUrlSafety.js";
import { GMAIL_AGENT_EXCLUDED_LABELS } from "./gmailAgentReadContract.js";
import { lockGmailOwnerSpace, type GmailConnectionRow } from "./gmailConnections.js";
import { GMAIL_ACCOUNT_QUOTA, GMAIL_OWNER_QUOTA, gmailQuotaGroups } from "./gmailQuota.js";
import { gmailPageRunner, gmailPageScope, withGmailReadTransaction, type GmailPageScope } from "./gmailReadDeadline.js";
import { GmailReadError } from "./gmailReadErrors.js";
import { GmailTokenError, resolveGmailAccessToken } from "./gmailTokenRefresh.js";
import { gmailId, headerValue } from "./gmailMessageText.js";
import { gmailMonitorMatches, parseGmailMonitorCriteria } from "./gmailMonitorCriteria.js";
import {
  createGmailSyncBudget, GMAIL_SYNC_LIMITS, gmailHistoryUrl, gmailMessageMetadataUrl, gmailProfileUrl, gmailRecoveryListUrl,
  gmailSyncRequestPolicy, historyIdGreater, isHistoryId,
} from "./gmailSyncContract.js";
import { startGmailWatch } from "./gmailWatch.js";
import type { GmailMonitorCriteria } from "@rainver/protocol";

/**
 * A sync-only window inside the account quota (60/min, 2000/day): one full
 * sync (≤ 50 sends incl. watch) fits a minute, and background sync never takes
 * the owner's whole minute or day. A follow-up beyond it waits for the window.
 */
export const GMAIL_SYNC_QUOTA = Object.freeze([{ window: "minute", limit: 50 }, { window: "day", limit: 1500 }] as const);

let guardOverride: OutboundGuard | undefined;
/** Tests inject a DNS-stubbed guard; production uses the strict instance guard. */
export function __setGmailSyncGuardForTests(guard: OutboundGuard | null): void { guardOverride = guard ?? undefined; }

export class GmailSyncError extends Error {
  constructor(readonly code: string, readonly retryAt?: string) {
    super(code);
    this.name = "GmailSyncError";
  }
}

export type GmailSyncOutcome =
  | { status: "synced"; newMatches: number; more: boolean }
  | { status: "busy" | "idle" | "inactive" | "gone" | "superseded" | "waiting" }
  | { status: "failed"; code: string };

interface SyncRow {
  gmail_connection_id: string;
  space_id: string;
  owner_user_id: string;
  history_id: string | null;
  state: "baseline" | "ok" | "recovering";
  recovery_after: string | Date | null;
  recovery_partial: boolean;
  lease_id: string | null;
  lease_until: string | Date | null;
  last_success_at: string | Date | null;
  sync_requested_at: string | Date | null;
  watch_expires_at: string | Date | null;
  failure_count: number;
  record_history_id: string | null;
  record_offset: number;
  retry_not_before: string | Date | null;
  watch_error_code: string | null;
  watch_retry_at: string | Date | null;
  watch_failure_count: number;
  now: string;
}

/**
 * A monitor as this sync saw it. `version` is `active_since` exactly as the
 * database holds it: a pause and resume while the sync runs gives the same id
 * a new version, and the old batch neither reminds for it nor moves the cursor.
 */
interface ClaimedRule { id: string; version: string; criteria: GmailMonitorCriteria; activeSinceMs: number }
/**
 * An active application-update automation (ADR 0034) as this sync saw it: it records every new inbox
 * message received since `covered_until` (its `version`, which a resume or a new card moves), with no
 * criteria — the Agent judges each message's meaning later.
 */
interface ClaimedAutomation { id: string; version: string; activeSinceMs: number; sentFromMs: number | null }
interface Claim {
  leaseId: string;
  connectionId: string;
  spaceId: string;
  ownerUserId: string;
  generation: number;
  googleSubject: string;
  state: SyncRow["state"];
  historyId: string | null;
  recoveryAfterMs: number | null;
  lastSuccessMs: number | null;
  /** In-record progress the previous sync left: messages of this record (sorted ids) already checked. */
  record: { historyId: string; offset: number } | null;
  /** The request mark this claim consumed; a failed sync puts it back. */
  consumedRequestAt: string | null;
  renewWatch: boolean;
  nowMs: number;
  rules: ClaimedRule[];
  automations: ClaimedAutomation[];
}

/** Codes that mean this sync lost its authority (not Google load): never swallowed by the watch step. */
const AUTHORITY_CODES: ReadonlySet<string> = new Set(["gmail_authority_revoked", "gmail_connection_changed", "gmail_sync_superseded", "gmail_reauth_required", "gmail_not_configured"]);
const backoffMs = (failures: number) => Math.min(60_000 * 2 ** Math.min(failures, 9), 6 * 60 * 60_000);

const ms = (value: string | Date | null) => value === null ? null : new Date(value).getTime();
const iso = (value: number) => new Date(value).toISOString();

/** Person → owner + Space mutex → connection → sync row: the one order every Gmail monitor writer uses. */
async function lockSync(db: Queryable, connectionId: string, mode: "UPDATE" | "SHARE"): Promise<{ row: SyncRow; connection: GmailConnectionRow | null; personActive: boolean } | null> {
  const pre = (await db.query<{ space_id: string; owner_user_id: string }>(
    `SELECT space_id,owner_user_id FROM gmail_mailbox_sync_states WHERE gmail_connection_id=$1`, [connectionId])).rows[0];
  if (!pre) return null;
  let personActive = true;
  try { await lockActivePerson(db, pre.space_id, pre.owner_user_id); } catch { personActive = false; }
  await lockGmailOwnerSpace(db, { spaceId: pre.space_id, userId: pre.owner_user_id });
  const connection = (await db.query<GmailConnectionRow>(
    `SELECT * FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR SHARE`,
    [connectionId, pre.space_id, pre.owner_user_id])).rows[0] ?? null;
  const row = (await db.query<SyncRow>(
    `SELECT *,clock_timestamp()::text AS now FROM gmail_mailbox_sync_states WHERE gmail_connection_id=$1 FOR ${mode}`, [connectionId])).rows[0];
  if (!row) return null;
  return { row, connection, personActive };
}

/**
 * The next scheduled check. Only a current, healthy watch (no renewal error)
 * earns the long catch-up interval, and never past the watch's expiry.
 */
function nextPollMs(config: ServerConfig, watch: { expiresMs: number | null; errorCode: string | null }, nowMs: number): number {
  const healthy = config.gmailPush !== null && watch.expiresMs !== null && watch.expiresMs > nowMs && watch.errorCode === null;
  return healthy ? Math.min(nowMs + GMAIL_SYNC_LIMITS.pushedPollIntervalMs, watch.expiresMs!) : nowMs + GMAIL_SYNC_LIMITS.pollIntervalMs;
}

async function claim(config: ServerConfig, db: Queryable, connectionId: string): Promise<Claim | Exclude<GmailSyncOutcome, { status: "synced" | "failed" }>> {
  const locked = await lockSync(db, connectionId, "UPDATE");
  if (!locked) return { status: "gone" };
  const { row, connection, personActive } = locked;
  const nowMs = ms(row.now)!;
  const leaseUntil = ms(row.lease_until);
  if (leaseUntil !== null && leaseUntil > nowMs) return { status: "busy" };
  // The durable retry floor holds for every wake-up (push, monitor change, schedule); the request mark stays.
  const retryFloor = ms(row.retry_not_before);
  if (retryFloor !== null && retryFloor > nowMs) return { status: "waiting" };
  const park = async (code: string | null, status: "idle" | "inactive") => {
    await db.query(
      `UPDATE gmail_mailbox_sync_states SET lease_id=NULL,lease_until=NULL,sync_requested_at=NULL,last_error_code=$2,
              next_poll_at=$3,updated_at=$4 WHERE gmail_connection_id=$1`,
      [connectionId, code, iso(nowMs + GMAIL_SYNC_LIMITS.pushedPollIntervalMs), iso(nowMs)]);
    return { status } as const;
  };
  if (!connection) return { status: "gone" };
  if (!personActive) return park("gmail_authority_revoked", "inactive");
  if (connection.status !== "active") return park(connection.status === "reauth_required" ? "gmail_reauth_required" : "gmail_connection_inactive", "inactive");
  if (!config.gmailOAuth) return park("gmail_not_configured", "inactive");
  const rules = (await db.query<{ id: string; criteria: unknown; active_since: string | Date; version: string }>(
    `SELECT id,criteria,active_since,active_since::text AS version FROM gmail_monitor_rules WHERE gmail_connection_id=$1 AND status='active' ORDER BY created_at,id`,
    [connectionId])).rows.flatMap((rule) => {
    const criteria = parseGmailMonitorCriteria(rule.criteria);
    return criteria ? [{ id: rule.id, version: rule.version, criteria, activeSinceMs: ms(rule.active_since)! }] : [];
  });
  const automations = (await db.query<{ id: string; covered_until: string | Date; version: string; sent_from: string | null }>(
    `SELECT d.id,d.covered_until,d.proposal_id || '/' || d.covered_until::text AS version,d.runtime_binding->>'sent_from' AS sent_from FROM gmail_digests d
       JOIN plugin_data_grants g ON g.id=d.grant_id AND g.status='active' AND g.connection_id=d.gmail_connection_id
      WHERE d.gmail_connection_id=$1 AND d.kind='application' AND d.status='active' ORDER BY d.created_at,d.id`,
    [connectionId])).rows.map((row) => ({ id: row.id, version: row.version, activeSinceMs: ms(row.covered_until)!, sentFromMs: ms(row.sent_from) }));
  if (!rules.length && !automations.length) return park(null, "idle");
  const leaseId = randomUUID();
  await db.query(
    `UPDATE gmail_mailbox_sync_states SET lease_id=$2,lease_until=$3,last_attempt_at=$4,sync_requested_at=NULL,updated_at=$4 WHERE gmail_connection_id=$1`,
    [connectionId, leaseId, iso(nowMs + GMAIL_SYNC_LIMITS.leaseMs), iso(nowMs)]);
  const watchExpires = ms(row.watch_expires_at);
  const watchRetry = ms(row.watch_retry_at);
  return {
    leaseId, connectionId, spaceId: row.space_id, ownerUserId: row.owner_user_id, generation: connection.generation,
    googleSubject: connection.google_subject, state: row.state, historyId: row.history_id,
    recoveryAfterMs: ms(row.recovery_after), lastSuccessMs: ms(row.last_success_at),
    record: row.state === "ok" && row.record_history_id !== null && row.record_offset > 0 ? { historyId: row.record_history_id, offset: row.record_offset } : null,
    consumedRequestAt: row.sync_requested_at === null ? null : new Date(row.sync_requested_at).toISOString(),
    // Renew when none is current, when it nears expiry, or after a failed renewal — but not before that failure's retry time.
    renewWatch: config.gmailPush !== null && (watchRetry === null || watchRetry <= nowMs)
      && (watchExpires === null || watchExpires - nowMs < GMAIL_SYNC_LIMITS.watchRenewBeforeMs || row.watch_error_code !== null),
    nowMs, rules, automations,
  };
}

/** The per-send recheck: same locks (shared), and the lease and generation this sync claimed. */
async function recheck(db: Queryable, current: Claim): Promise<void> {
  const locked = await lockSync(db, current.connectionId, "SHARE");
  if (!locked || !locked.personActive) throw new GmailSyncError("gmail_authority_revoked");
  if (!locked.connection || locked.connection.status !== "active" || locked.connection.generation !== current.generation) throw new GmailSyncError("gmail_connection_changed");
  if (locked.row.lease_id !== current.leaseId) throw new GmailSyncError("gmail_sync_superseded");
}

interface Fetched {
  nextState: "ok" | "recovering" | "baseline";
  historyId: string | null;
  recoveryAfterMs: number | null;
  recoveryPartial: boolean | null;
  more: boolean;
  /** In-record progress to persist: the record after the cursor that this sync only partly checked. */
  record: { historyId: string; offset: number } | null;
  matches: { ruleId: string; messageId: string }[];
  /** New inbox messages for the claimed application-update automations (ids and receipt times only). */
  mailItems: { digestId: string; messageId: string; receivedMs: number }[];
}

/** What the `users.watch` step did, recorded apart from the sync result. */
type WatchResult =
  | { kind: "ok"; expiresAt: string }
  | { kind: "failed"; code: string; retryAt: string | null };

function transport(config: ServerConfig, scope: GmailPageScope, current: Claim) {
  const pageRun = gmailPageRunner(scope);
  let refusal: GmailSyncError | null = null;
  const run: TransactionRunner = async (work) => {
    try { return await pageRun(work); } catch (error) {
      if (error instanceof GmailSyncError) refusal ??= error;
      throw error;
    }
  };
  const keys = gmailQuotaGroups({ googleSubject: current.googleSubject, ownerUserId: current.ownerUserId });
  const syncKey = sourceQuotaGroup(`gmail:sync:${current.googleSubject}`, "gmail-sync");
  const quotaGroups = [{ key: keys.account, windows: GMAIL_ACCOUNT_QUOTA }, { key: keys.owner, windows: GMAIL_OWNER_QUOTA }, { key: syncKey, windows: GMAIL_SYNC_QUOTA }];
  const tokenSnapshot = { connectionId: current.connectionId, ownerUserId: current.ownerUserId, spaceId: current.spaceId, generation: current.generation };
  const bearer = async () => {
    try { return await resolveGmailAccessToken(config, run, tokenSnapshot, scope.signal); } catch (error) {
      if (error instanceof GmailTokenError) {
        refusal ??= new GmailSyncError(error.code === "gmail_authority_revoked" ? "gmail_authority_revoked"
          : error.code === "gmail_reauth_required" ? "gmail_reauth_required"
          : error.code === "gmail_connection_changed" ? "gmail_connection_changed"
          : error.code === "gmail_not_configured" ? "gmail_not_configured" : "gmail_refresh_unavailable");
      }
      throw error;
    }
  };
  const authorize = async (signal?: AbortSignal) => {
    try { await withGmailReadTransaction(scope, (tx) => recheck(tx, current), signal ?? scope.signal); } catch (error) {
      refusal ??= error instanceof GmailSyncError ? error : new GmailSyncError("gmail_authority_busy");
      throw error;
    }
  };
  const broker: SourceRequestBroker = createSourceRequestBroker(run, {
    scopeId: `gmail-sync:${current.connectionId}`,
    quotaGroup: keys.account,
    quota: GMAIL_ACCOUNT_QUOTA,
    endpointQuotas: [{ key: keys.owner, windows: GMAIL_OWNER_QUOTA }, { key: syncKey, windows: GMAIL_SYNC_QUOTA }],
    authorize,
    ...gmailSyncRequestPolicy({ credentialHeaders: async () => ({ authorization: `Bearer ${await bearer()}` }), budget: createGmailSyncBudget() }),
  }, scope.signal, guardOverride);
  let sequence = 0;
  /** The scope's own deadline ended the step (not a client abort). */
  const timedOut = () => scope.signal.aborted && (scope.signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError";
  const failure = (error: unknown): GmailSyncError => {
    if (refusal) return refusal;
    if (error instanceof SourceRequestError) {
      if (error.code === "source_quota_exhausted") return new GmailSyncError("gmail_quota_exhausted", error.retryAt);
      if (error.code === "source_timeout" || error.code === "source_cancelled") return new GmailSyncError("gmail_upstream_timeout");
    }
    if (error instanceof GmailReadError) return new GmailSyncError(error.code === "gmail_upstream_timeout" || error.code === "gmail_cancelled" ? "gmail_upstream_timeout" : "gmail_authority_busy");
    return new GmailSyncError("gmail_upstream_error");
  };
  return {
    // Keep a full physical-send deadline and time to persist the exact cursor.
    canContinue: () => scope.deadlineAt - Date.now() > GMAIL_SYNC_LIMITS.perSendDeadlineMs + 5_000,
    async get(url: string): Promise<{ kind: "ok"; json: Record<string, unknown> } | { kind: "not_found" }> {
      sequence += 1;
      let response;
      try { response = await broker({ sequence, method: "GET", url }); } catch (error) { throw failure(error); }
      if (response.status === 404) return { kind: "not_found" };
      if (response.status === 429 || response.status === 503) throw new GmailSyncError("gmail_rate_limited", response.retry_at);
      if (response.status !== 200) throw new GmailSyncError("gmail_upstream_error");
      try {
        const json = JSON.parse(Buffer.from(response.body_base64, "base64").toString("utf8")) as unknown;
        if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("shape");
        return { kind: "ok", json: json as Record<string, unknown> };
      } catch { throw new GmailSyncError("gmail_upstream_error"); }
    },
    /**
     * Renew the watch. Loss of authority (a refusal from the per-send recheck or
     * the token) is thrown, never turned into a watch result; anything else —
     * quota, Google refusing or failing, an uncertain send — is a watch result
     * the sync records on its own fields while the increment still settles.
     */
    async watch(topicName: string): Promise<WatchResult> {
      let outcome;
      try {
        outcome = await startGmailWatch({
          topicName, signal: scope.signal, bearer,
          admit: async () => {
            await authorize();
            const admitted = await admitSourceRequestGroups(run, quotaGroups, scope.signal);
            if (!admitted.allowed) throw new GmailSyncError("gmail_quota_exhausted", admitted.retryAt);
          },
        });
      } catch (error) {
        const known = refusal ?? (error instanceof GmailSyncError ? error : null);
        if (known && AUTHORITY_CODES.has(known.code)) throw known;
        if (timedOut()) return { kind: "failed", code: "gmail_watch_timeout", retryAt: null };
        return { kind: "failed", code: known?.code === "gmail_quota_exhausted" ? "gmail_watch_quota_exhausted" : "gmail_watch_not_sent", retryAt: known?.retryAt ?? null };
      }
      if (refusal && AUTHORITY_CODES.has(refusal.code)) throw refusal;
      switch (outcome.kind) {
        case "ok": return { kind: "ok", expiresAt: outcome.expiresAt };
        case "refused": return { kind: "failed", code: "gmail_watch_refused", retryAt: null };
        case "unavailable": {
          // Google's Retry-After, as the broker keeps it for GETs: the account and sync groups cool down
          // and the renewal waits at least that long.
          let retryAt: string | null = null;
          if (outcome.status === 429 || (outcome.status === 503 && outcome.retryAfter !== null)) {
            try { retryAt = await coolDownSourceRequests(run, quotaGroups.map((group) => group.key), outcome.retryAfter); } catch { retryAt = null; }
          }
          return { kind: "failed", code: "gmail_watch_unavailable", retryAt };
        }
        case "timeout": return { kind: "failed", code: "gmail_watch_timeout", retryAt: null };
        case "uncertain": return { kind: "failed", code: timedOut() ? "gmail_watch_timeout" : "gmail_watch_uncertain", retryAt: null };
        default: return { kind: "failed", code: timedOut() ? "gmail_watch_timeout" : "gmail_watch_not_sent", retryAt: null };
      }
    },
  };
}

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const obj = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function fetchChanges(io: ReturnType<typeof transport>, current: Claim): Promise<Fetched> {
  const seen = new Set<string>();
  const matches: Fetched["matches"] = [];
  const mailItems: Fetched["mailItems"] = [];
  const readMetadata = async (messageId: string) => {
    const response = await io.get(gmailMessageMetadataUrl(messageId));
    seen.add(messageId);
    if (response.kind === "not_found") return;
    const message = response.json;
    const labelIds = list(message.labelIds).filter((label): label is string => typeof label === "string");
    const receivedMs = typeof message.internalDate === "string" && /^[0-9]{1,16}$/.test(message.internalDate) ? Number(message.internalDate) : null;
    const headers = obj(message.payload).headers;
    const header = { from: headerValue(headers, "From"), subject: headerValue(headers, "Subject"), labelIds };
    for (const rule of current.rules) {
      if (receivedMs !== null && receivedMs >= rule.activeSinceMs && gmailMonitorMatches(rule.criteria, header)) matches.push({ ruleId: rule.id, messageId });
    }
    if (receivedMs !== null && !labelIds.some((label) => GMAIL_AGENT_EXCLUDED_LABELS.has(label))) {
      const sent = labelIds.includes("SENT");
      for (const automation of current.automations) {
        const eligible = sent ? automation.sentFromMs !== null && receivedMs >= automation.sentFromMs : labelIds.includes("INBOX");
        if (eligible && receivedMs >= automation.activeSinceMs) mailItems.push({ digestId: automation.id, messageId, receivedMs });
      }
    }
  };
  let fetched: Omit<Fetched, "matches" | "mailItems">;
  if (current.state === "ok" && current.historyId) {
    let token: string | null = null;
    let pages = 0;
    let lastSafe = current.historyId;
    let more = false;
    let expired = false;
    let final: string = current.historyId;
    let record: Fetched["record"] = null;
    for (;;) {
      const page = await io.get(gmailHistoryUrl({ startHistoryId: current.historyId, pageToken: token }));
      if (page.kind === "not_found") { expired = true; break; }
      let stopped = false;
      for (const entry of list(page.json.history)) {
        const recordId = obj(entry).id;
        // A record's new mail in a stable order (sorted ids), so a partly checked record resumes where it stopped.
        const ids = [...new Set(list(obj(entry).messagesAdded).map((added) => gmailId(obj(obj(added).message).id)).filter((id): id is string => id !== null))].sort();
        const resume = isHistoryId(recordId) && current.record?.historyId === recordId ? Math.min(current.record.offset, ids.length) : 0;
        let position = resume;
        for (; position < ids.length; position += 1) {
          const id = ids[position]!;
          if (seen.has(id)) continue;
          if (seen.size >= GMAIL_SYNC_LIMITS.messagesPerSync || seen.size > 0 && !io.canContinue()) break;
          await readMetadata(id);
        }
        if (position < ids.length) {
          // The bound falls inside this record: the cursor stays before it and the record's progress is
          // persisted, so the follow-up checks the rest of it (the ledger absorbs any overlap on retry).
          if (isHistoryId(recordId) && position > 0) record = { historyId: recordId, offset: position };
          stopped = true;
          break;
        }
        if (isHistoryId(recordId) && historyIdGreater(recordId, lastSafe)) lastSafe = recordId;
      }
      if (stopped) { more = true; final = lastSafe; break; }
      pages += 1;
      token = typeof page.json.nextPageToken === "string" ? page.json.nextPageToken : null;
      if (!token) {
        const mailbox = page.json.historyId;
        final = isHistoryId(mailbox) && historyIdGreater(mailbox, lastSafe) ? mailbox : lastSafe;
        break;
      }
      if (pages >= GMAIL_SYNC_LIMITS.historyPagesPerSync || !io.canContinue()) { more = true; final = lastSafe; break; }
    }
    if (expired) {
      // Recovery starts at the last success (minus clock skew), never before the
      // oldest still-active monitor was accepted; the scan bound applies later.
      const oldest = Math.min(...current.rules.map((rule) => rule.activeSinceMs), ...current.automations.map((automation) => automation.activeSinceMs));
      const from = Math.max(oldest, (current.lastSuccessMs ?? current.nowMs) - 10 * 60_000);
      return { nextState: "recovering", historyId: current.historyId, recoveryAfterMs: from, recoveryPartial: null, more: true, record: null, matches: [], mailItems: [] };
    }
    fetched = { nextState: "ok", historyId: final, recoveryAfterMs: null, recoveryPartial: null, more, record };
  } else {
    // Baseline or recovery: the position first, so mail arriving during the scan is history the next sync reads.
    const profile = await io.get(gmailProfileUrl());
    if (profile.kind === "not_found" || !isHistoryId(profile.json.historyId)) throw new GmailSyncError("gmail_upstream_error");
    const oldest = Math.min(...current.rules.map((rule) => rule.activeSinceMs), ...current.automations.map((automation) => automation.activeSinceMs));
    const wanted = current.state === "recovering" && current.recoveryAfterMs !== null ? current.recoveryAfterMs : oldest;
    const floor = current.nowMs - GMAIL_SYNC_LIMITS.recoveryMaxDays * 86_400_000;
    let partial = wanted < floor;
    const after = Math.max(wanted, floor);
    // Gmail's `after:` has second granularity; the ledger and `active_since` absorb the overlap.
    const page = await io.get(gmailRecoveryListUrl({ afterEpochSeconds: Math.floor(after / 1000) - 1 }));
    if (page.kind === "ok") {
      for (const message of list(page.json.messages)) {
        const id = gmailId(obj(message).id);
        if (!id || seen.has(id)) continue;
        if (seen.size >= GMAIL_SYNC_LIMITS.messagesPerSync || seen.size > 0 && !io.canContinue()) { partial = true; break; }
        await readMetadata(id);
      }
      if (typeof page.json.nextPageToken === "string") partial = true;
    }
    const position = profile.json.historyId as string;
    fetched = {
      nextState: "ok",
      historyId: current.historyId && !historyIdGreater(position, current.historyId) ? current.historyId : position,
      recoveryAfterMs: null,
      recoveryPartial: partial,
      more: false,
      record: null,
    };
  }
  return { ...fetched, matches, mailItems };
}

/**
 * Settle the increment. `keepLease` (a watch renewal follows) keeps this
 * sync's lease, refreshed, so the renewal's per-send recheck still holds and
 * its outcome is settled under the same lease; the increment itself is
 * committed now and never waits for the renewal.
 */
async function settle(config: ServerConfig, db: Queryable, current: Claim, fetchedResult: Fetched, keepLease: boolean): Promise<GmailSyncOutcome> {
  let fetched = fetchedResult;
  const locked = await lockSync(db, current.connectionId, "UPDATE");
  if (!locked || locked.row.lease_id !== current.leaseId) return { status: "superseded" };
  const nowMs = ms(locked.row.now)!;
  // Lost authority is a failure of this sync (recorded by `settleFailure` with its code), never a settle.
  if (!locked.personActive) throw new GmailSyncError("gmail_authority_revoked");
  if (!locked.connection || locked.connection.status !== "active" || locked.connection.generation !== current.generation) throw new GmailSyncError("gmail_connection_changed");
  const versionOf = new Map(current.rules.map((rule) => [rule.id, rule.version]));
  let newMatches = 0;
  if (fetched.matches.length) {
    // Only a monitor still active *in the version this sync checked* counts: one paused and resumed
    // meanwhile has a new `active_since`, and this batch may hold mail from its paused period.
    // The ledger makes every message remind once per monitor.
    const inserted = (await db.query<{ rule_id: string; n: number }>(
      `WITH m AS (
         SELECT * FROM unnest($1::varchar[],$2::varchar[],$5::text[]) AS m(rule_id,message_id,version)
       ), ins AS (
         INSERT INTO gmail_monitor_matches (rule_id,google_message_id,space_id,owner_user_id,matched_at)
         SELECT r.id,m.message_id,r.space_id,r.owner_user_id,$4::timestamptz
           FROM m JOIN gmail_monitor_rules r ON r.id=m.rule_id AND r.gmail_connection_id=$3 AND r.status='active'
                AND r.active_since=m.version::timestamptz
         ON CONFLICT DO NOTHING RETURNING rule_id
       ) SELECT rule_id,count(*)::int AS n FROM ins GROUP BY rule_id ORDER BY rule_id`,
      [fetched.matches.map((m) => m.ruleId), fetched.matches.map((m) => m.messageId), current.connectionId, locked.row.now,
        fetched.matches.map((m) => versionOf.get(m.ruleId)!)])).rows;
    const alerts = new OperationalAlertService(db);
    for (const row of inserted) {
      newMatches += row.n;
      await db.query(`UPDATE gmail_monitor_rules SET match_count=match_count+$2,last_matched_at=$3,updated_at=$3 WHERE id=$1`, [row.rule_id, row.n, iso(nowMs)]);
      // One private, content-free pointer per monitor: no subject, sender, Project or count in the title.
      await alerts.emit({
        kind: "gmail_monitor_matches", spaceId: current.spaceId, userId: current.ownerUserId, projectId: null,
        title: "New mail matched your Gmail monitor", message: "Open Gmail monitoring in Sources to see it.",
        dedupeKey: `gmail_monitor:${row.rule_id}`,
        payload: { pointer_type: "gmail_monitor_matches", monitor_id: row.rule_id, connection_id: current.connectionId, new_matches: row.n },
      });
    }
  }
  const automationVersion = new Map(current.automations.map((automation) => [automation.id, automation.version]));
  if (fetched.mailItems.length) {
    // Only an automation still active in the version this sync checked records mail: one resumed or
    // reconfirmed meanwhile has a new `covered_until`. The primary key records each message once.
    const inserted = (await db.query<{ n: number }>(
      `WITH m AS (
         SELECT * FROM unnest($1::varchar[],$2::varchar[],$3::timestamptz[],$4::text[]) AS m(digest_id,message_id,received_at,version)
       ), ins AS (
         INSERT INTO gmail_digest_mail_items (digest_id,google_message_id,space_id,owner_user_id,received_at,recorded_at,status,attempts,updated_at)
         SELECT d.id,m.message_id,d.space_id,d.owner_user_id,m.received_at,$6::timestamptz,'pending',0,$6::timestamptz
           FROM m JOIN gmail_digests d ON d.id=m.digest_id AND d.gmail_connection_id=$5 AND d.kind='application' AND d.status='active'
                AND (d.proposal_id || '/' || d.covered_until::text)=m.version
         ON CONFLICT DO NOTHING RETURNING 1
       ) SELECT count(*)::int AS n FROM ins`,
      [fetched.mailItems.map((item) => item.digestId), fetched.mailItems.map((item) => item.messageId),
        fetched.mailItems.map((item) => iso(item.receivedMs)), fetched.mailItems.map((item) => automationVersion.get(item.digestId)!),
        current.connectionId, locked.row.now])).rows[0];
    newMatches += inserted?.n ?? 0;
  }
  const stored = locked.row.history_id;
  const storedRecord = locked.row.record_history_id !== null && locked.row.record_offset > 0
    ? { historyId: locked.row.record_history_id, offset: locked.row.record_offset } : null;
  // A monitor accepted, or paused and resumed (same id, new `active_since`), while this sync ran was
  // not checked in that version: keep the cursor and record progress (and a restarted baseline) so the
  // follow-up reads the same range with every monitor as it is now; the ledger keeps the monitors this
  // sync did check from reminding twice.
  const unseen = (await db.query<{ id: string; version: string }>(
    `SELECT id,active_since::text AS version FROM gmail_monitor_rules WHERE gmail_connection_id=$1 AND status='active'`,
    [current.connectionId])).rows.some((row) => versionOf.get(row.id) !== row.version)
    || (await db.query<{ id: string; version: string }>(
      `SELECT d.id,d.proposal_id || '/' || d.covered_until::text AS version FROM gmail_digests d JOIN plugin_data_grants g ON g.id=d.grant_id AND g.status='active'
        WHERE d.gmail_connection_id=$1 AND d.kind='application' AND d.status='active'`,
      [current.connectionId])).rows.some((row) => automationVersion.get(row.id) !== row.version);
  const restarted = locked.row.state === "baseline" && current.state !== "baseline";
  if (unseen || restarted) {
    // The row keeps the state it had; a range is read again rather than skipped.
    const keep = locked.row.state;
    fetched = { ...fetched, historyId: null, nextState: keep === "ok" ? "ok" : keep === "recovering" ? "recovering" : "baseline",
      recoveryAfterMs: keep === "recovering" ? ms(locked.row.recovery_after) : null, recoveryPartial: null, more: true,
      record: keep === "ok" ? storedRecord : null };
  }
  const history = fetched.historyId && (!stored || historyIdGreater(fetched.historyId, stored)) ? fetched.historyId : stored;
  // In-record progress belongs to the cursor it was read from; a cursor that moved past it drops it.
  const record = fetched.nextState === "ok" && fetched.record && history && historyIdGreater(fetched.record.historyId, history) ? fetched.record : null;
  const nextPoll = nextPollMs(config, { expiresMs: ms(locked.row.watch_expires_at), errorCode: locked.row.watch_error_code }, nowMs);
  const caughtUp = fetched.nextState === "ok" && !fetched.more;
  await db.query(
    `UPDATE gmail_mailbox_sync_states
        SET history_id=$2,state=$3::varchar,recovery_after=$4,recovery_partial=COALESCE($5,recovery_partial),
            lease_id=CASE WHEN $12 THEN lease_id ELSE NULL END,
            lease_until=CASE WHEN $12 THEN $13::timestamptz ELSE NULL END,
            retry_not_before=NULL,
            last_success_at=CASE WHEN $6 THEN $7::timestamptz ELSE last_success_at END,
            failure_count=0,last_error_code=CASE WHEN $3::varchar='recovering' THEN 'gmail_history_expired' ELSE NULL END,
            sync_requested_at=CASE WHEN $8 THEN $7::timestamptz ELSE sync_requested_at END,
            next_poll_at=$9,record_history_id=$10,record_offset=$11,
            updated_at=$7
      WHERE gmail_connection_id=$1`,
    [current.connectionId, history, fetched.nextState, fetched.recoveryAfterMs === null ? null : iso(fetched.recoveryAfterMs),
      fetched.recoveryPartial, caughtUp, iso(nowMs), fetched.more, iso(nextPoll),
      record?.historyId ?? null, record?.offset ?? 0, keepLease, iso(nowMs + GMAIL_SYNC_LIMITS.leaseMs)]);
  return { status: "synced", newMatches, more: fetched.more };
}

/**
 * The renewal's outcome, on the watch fields only, under the lease the
 * increment's settle kept (then released). Runs in its own bounded
 * transaction, so a renewal that used up its deadline is still recorded
 * (`gmail_watch_timeout`). A lease lost meanwhile (reconnect, a later sync)
 * records nothing; the next sync renews again.
 */
async function settleWatch(config: ServerConfig, db: Queryable, current: Claim, watch: WatchResult): Promise<void> {
  const locked = await lockSync(db, current.connectionId, "UPDATE");
  if (!locked || locked.row.lease_id !== current.leaseId) return;
  const nowMs = ms(locked.row.now)!;
  const failures = watch.kind === "ok" ? 0 : locked.row.watch_failure_count + 1;
  const error = watch.kind === "ok" ? null : watch.code;
  const retry = watch.kind === "ok" ? null
    : iso(Math.max(watch.retryAt ? Date.parse(watch.retryAt) || 0 : 0, nowMs + backoffMs(locked.row.watch_failure_count)));
  const expires = watch.kind === "ok" ? watch.expiresAt : locked.row.watch_expires_at === null ? null : new Date(locked.row.watch_expires_at).toISOString();
  const nextPoll = nextPollMs(config, { expiresMs: expires === null ? null : Date.parse(expires), errorCode: error }, nowMs);
  await db.query(
    `UPDATE gmail_mailbox_sync_states
        SET lease_id=NULL,lease_until=NULL,watch_expires_at=$2,watch_checked_at=$3,watch_error_code=$4,watch_retry_at=$5,
            watch_failure_count=$6,next_poll_at=$7,updated_at=$3
      WHERE gmail_connection_id=$1 AND lease_id=$8`,
    [current.connectionId, expires, iso(nowMs), error, retry, failures, iso(nextPoll), current.leaseId]);
}

/**
 * A failed sync keeps the cursor and its record progress, sets the durable
 * retry floor (backoff, or Google's / the quota's retry time if later) that
 * every wake-up honours, and puts back the request mark its claim consumed.
 */
async function settleFailure(db: Queryable, current: Claim, error: GmailSyncError): Promise<void> {
  const row = (await db.query<{ failure_count: number; now: string | Date }>(
    `SELECT failure_count,clock_timestamp() AS now FROM gmail_mailbox_sync_states WHERE gmail_connection_id=$1 AND lease_id=$2 FOR UPDATE`,
    [current.connectionId, current.leaseId])).rows[0];
  if (!row) return;
  // A reconnect (new generation) supersedes this sync: its failure describes the old authority and
  // must not put the reconnected connection behind a stale code or retry floor. Only the lease goes.
  const generation = (await db.query<{ generation: number }>(`SELECT generation FROM gmail_connections WHERE id=$1`, [current.connectionId])).rows[0]?.generation;
  if (generation !== undefined && generation !== current.generation) {
    await db.query(`UPDATE gmail_mailbox_sync_states SET lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE gmail_connection_id=$1 AND lease_id=$2`,
      [current.connectionId, current.leaseId]);
    return;
  }
  const nowMs = ms(row.now)!;
  const retry = error.retryAt ? Math.max(Date.parse(error.retryAt) || 0, nowMs + 60_000) : nowMs + backoffMs(row.failure_count);
  await db.query(
    `UPDATE gmail_mailbox_sync_states SET lease_id=NULL,lease_until=NULL,failure_count=failure_count+1,last_error_code=$2,
            next_poll_at=$3,retry_not_before=$3,sync_requested_at=COALESCE(sync_requested_at,$6::timestamptz),updated_at=$4
      WHERE gmail_connection_id=$1 AND lease_id=$5`,
    [current.connectionId, /^gmail_[a-z_]{1,58}$/.test(error.code) ? error.code : "gmail_upstream_error", iso(retry), iso(nowMs), current.leaseId, current.consumedRequestAt]);
}

/** One sync of one connection. Never throws for Google or authority failures: they are recorded on the row. */
export async function syncGmailMailbox(config: ServerConfig, pool: Pool, connectionId: string, signal: AbortSignal = new AbortController().signal): Promise<GmailSyncOutcome> {
  const scope = gmailPageScope(config, pool, signal);
  let claimed: Awaited<ReturnType<typeof claim>>;
  try {
    claimed = await withGmailReadTransaction(scope, (tx) => claim(config, tx, connectionId));
  } catch {
    return { status: "failed", code: "gmail_authority_busy" };
  }
  if (!("leaseId" in claimed)) return claimed;
  const current = claimed;
  const fresh = () => gmailPageScope(config, pool, new AbortController().signal);
  const fail = async (error: unknown): Promise<GmailSyncOutcome> => {
    const known = error instanceof GmailSyncError ? error : new GmailSyncError("gmail_upstream_error");
    try { await withGmailReadTransaction(fresh(), (tx) => settleFailure(tx, current, known)); } catch { /* the lease expires */ }
    return { status: "failed", code: known.code };
  };
  const topic = current.renewWatch && config.gmailPush ? config.gmailPush.topicName : null;
  let outcome: GmailSyncOutcome;
  try {
    const fetched = await fetchChanges(transport(config, scope, current), current);
    // The increment is committed first; a renewal that follows never delays or undoes it.
    outcome = await withGmailReadTransaction(scope, (tx) => settle(config, tx, current, fetched, topic !== null));
  } catch (error) {
    return fail(error);
  }
  if (topic === null || outcome.status !== "synced") return outcome;
  // The renewal has its own deadline (not what the increment left over) and its own settlement.
  let watch: WatchResult;
  try {
    watch = await transport(config, gmailPageScope(config, pool, signal), current).watch(topic);
  } catch (error) {
    // Lost authority in the renewal's recheck: recorded as this sync's failure (the increment stays committed).
    return fail(error);
  }
  try { await withGmailReadTransaction(fresh(), (tx) => settleWatch(config, tx, current, watch)); } catch { /* the lease expires; the next sync renews */ }
  return outcome;
}
