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
 *   (`gmailDigestRunAdmits`) rechecked before every Gmail send.
 * - **Release gate** (audit transaction): Project `FOR SHARE` with the
 *   owner's member row → person → Run `FOR UPDATE` → Gmail mutex →
 *   connection → consent `FOR SHARE`, as the on-demand read; then the taint,
 *   the Agent-read log (`gmail_message` ids, the consent), the owner's Gmail
 *   audit (`digest_read`, counts only) and the delivery's progress.
 *
 * The result reaches the model only; event logs carry neither arguments nor
 * result (`privateToolCalls.ts`); the reply is the delivery conversation's.
 */
import { GMAIL_DIGEST_LIMITS, type GmailDigestReadInput, type GmailDigestReadOutput, type OperationActor, type RegisteredSystemActionDefinition } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { runHostWorkOutsideOperation } from "../../../db/operationTransaction.js";
import { lockActivePeople } from "../../access/activePerson.js";
import { recordAgentDataRead } from "../../contentAccess/agentReads.js";
import { pluginDataFacts } from "../../plugins/dataAccess.js";
import { assertProjectReadableLocked } from "../../projects/access.js";
import type { Queryable } from "../../routeUtils/common.js";
import { persistRunContextTaint } from "../../runs/contextTaint.js";
import { assertCurrentActor } from "../../systemActions/operations/actor.js";
import { hidden, OperationError, OperationRefusal } from "../../systemActions/operations/errors.js";
import type { OperationRegistration } from "../../systemActions/operations/types.js";
import { GmailReadError, recheckGmailRead, type GmailReadSnapshot } from "./gmailReadAuthority.js";
import { GMAIL_DIGEST_CONSENT_ID, GMAIL_DIGEST_READ_ACTION, gmailDigestConversationAdmits, gmailDigestReadAvailable, gmailDigestRunAdmits, type DeliveryRow, type DigestRow } from "./gmailDigests.js";
import { GmailCursorError, gmailCursorExpiry, gmailCursorLive, openGmailCursor, signGmailCursor, type GmailDigestCursor } from "./gmailCursor.js";
import { readGmailDigestPage } from "./gmailDigestReads.js";

const FACTS = Symbol("rainver.gmail.digest_read_facts");

interface ReleaseFacts {
  v: 1;
  snapshot: GmailReadSnapshot;
  grantId: string;
  projectId: string;
  digestId: string;
  deliveryId: string;
  messageIds: string[];
  pageIndex: number;
  complete: boolean;
  truncated: boolean;
  requestId: string;
}

const withheld = () => new OperationError("operation_audit_unavailable", 503, true);
const MESSAGES: Partial<Record<string, string>> = {
  gmail_digest_unavailable: "This digest cannot read mail any more (the owner paused or ended it, or the connection changed). Tell the owner the digest could not be produced.",
  gmail_digest_audience_outside_project: "Someone who reads this conversation no longer works in its Project, so this digest cannot read mail here. Do not summarize anything; say the digest could not be produced.",
  gmail_digest_read_limit: "This digest Run reached its read limit before the window was complete. Report that the digest could not be produced.",
  gmail_cursor_invalid: "Start without a token, then pass exactly the next_page_token of the previous released page.",
};
const refuse = (status: 409 | 422 | 429, code: string) => new OperationRefusal(status, "sources", MESSAGES[code] ?? code.replaceAll("_", " "), { code });

function fromGmailError(error: GmailReadError): OperationError {
  if (error.code === "gmail_not_found") return hidden();
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
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE space_id=$1 AND run_id=$2 AND action_id=$3`,
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
      const facts = await pluginDataFacts(db, config, actor, GMAIL_DIGEST_READ_ACTION, false);
      if (!facts || facts === "pin_mismatch" || !facts.consent || !facts.grantId) throw hidden();
      const found = await runDelivery(db, actor);
      if (!found || found.digest.grant_id !== facts.grantId) throw hidden();
      const { digest, delivery } = found;
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
      let page: Awaited<ReturnType<typeof readGmailDigestPage>>;
      try {
        page = await runHostWorkOutsideOperation(async () => {
          const pool = getDbPool(config.databaseUrl!);
          return readGmailDigestPage(config, pool, {
            spaceId: actor.space_id, ownerUserId: person, connectionId: digest.gmail_connection_id, kind: digest.kind, window,
            ids: Array.isArray(delivery.message_ids) ? delivery.message_ids : null, pageToken: cursor?.page ?? null,
            signal: new AbortController().signal,
            // Ending or pausing the digest, a lost consent, or the Run or delivery ending stops the read before its next send.
            authorizeSend: async () => {
              const live = (await pool.query(`SELECT 1 FROM runs r JOIN gmail_digest_deliveries dl ON dl.run_id=r.id AND dl.id=$3 AND dl.status='running'
                  JOIN gmail_digests d ON d.id=dl.digest_id AND d.status='active' WHERE r.id=$1 AND r.space_id=$2 AND r.status='running'`,
                [actor.run_id, actor.space_id, delivery.id])).rows.length > 0;
              if (!live) throw new GmailReadError(409, "gmail_digest_unavailable");
              // The consent and the conversation's whole audience, by the rule the claim and settlement use.
              const admitted = await gmailDigestRunAdmits(pool, { spaceId: actor.space_id, ownerUserId: person, runId: actor.run_id! });
              if (!admitted.ok) throw new GmailReadError(409, admitted.code);
              if (admitted.grantId !== grantId) throw new GmailReadError(409, "gmail_digest_unavailable");
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
          messageIds: page.items.map((item) => item.id), pageIndex, complete: page.nextPageToken === null,
          truncated: page.truncated, requestId: invocation?.requestId ?? "",
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
  try { await assertProjectReadableLocked(db, actor.space_id, facts.projectId, person); } catch { throw withheld(); }
  try { await lockActivePeople(db, actor.space_id, [person]); } catch { throw withheld(); }
  const run = (await db.query<{ id: string; visibility: "private" | "selected_users" | "space_shared"; session_id: string | null }>(
    `SELECT id,visibility,session_id FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE`, [actor.run_id, actor.space_id])).rows[0];
  if (!run) throw withheld();
  try { await assertCurrentActor(db, actor); } catch { throw withheld(); }
  // The delivery conversation's readers: the owner alone in their private conversation, or a Room's or the
  // mainline's roster, Project readers and the Run's own audience, every one of whom still reads the digest's
  // Project (ADR 0033 phase B) — the one rule of `gmailDigestConversationAdmits`.
  if (!run.session_id || !await gmailDigestConversationAdmits(db, { spaceId: actor.space_id, ownerUserId: person, projectId: facts.projectId, sessionId: run.session_id, runId: run.id })) throw withheld();
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
    resourceType: "gmail_message", resourceIds: facts.messageIds, dataClass: "sensitive", grantId: facts.grantId,
  });
  await db.query(
    `INSERT INTO gmail_read_audit_events (id,space_id,owner_user_id,actor_user_id,gmail_connection_id,project_id,selection_id,operation,
       google_thread_id,item_count,truncated,request_id,run_id,agent_id,accessed_at)
     VALUES (gen_random_uuid()::text,$1,$2,$2,$3,$9,NULL,'digest_read',NULL,$4,$5,$6,$7,$8,clock_timestamp())`,
    [actor.space_id, person, facts.snapshot.connectionId, facts.messageIds.length, facts.truncated, facts.requestId.slice(0, 128) || run.id, run.id, actor.agent_id ?? actor.principal.id, facts.projectId],
  );
  const hitLimit = !facts.complete && facts.pageIndex + 1 === GMAIL_DIGEST_LIMITS.readsPerRun;
  await db.query(`UPDATE gmail_digest_deliveries SET message_count=message_count+$2,read_complete=$3,error_code=$4 WHERE id=$1`,
    [delivery.id, facts.messageIds.length, facts.complete, hitLimit ? "gmail_digest_read_limit" : null]);
}
