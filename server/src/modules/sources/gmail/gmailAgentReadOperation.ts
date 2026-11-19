/**
 * `source.gmail.mail.read` — the one Agent read of mail (ADR 0032, ADR 0033 §6):
 * the newest inbox messages or a Gmail search, with
 * their plain-text bodies, through the server's Gmail broker:
 *
 * - **Offered** in any ordinary conversation of a Project — the mailbox
 *   owner's private conversation, a Room or the Project mainline — after the
 *   owner turned Agent reads on for an active connection
 *   (`gmailAgentReadAvailability.ts`); otherwise absent from the snapshot.
 *   The Agent calls it on the conversation's own selected runtime (CLI,
 *   Host, native login, model): the Gmail credential never leaves the
 *   server, and the runtime receives only the bounded result.
 * - **Authorize** (call time and every replay): the frozen pin, the live
 *   scenario (the owner's own `manual` turn; delegated, scheduled and system
 *   Runs are refused), the mailbox the call reads, the owner's standing
 *   consent for this conversation's Project and that connection
 *   (`gmailAgentReadGrants.ts`), and an audience whose every reader reads
 *   that Project. A missing consent is the requestable
 *   `operation_consent_required` naming the connection: the owner confirms
 *   once on the card in this same conversation (`authorization.request`,
 *   data-owner approver) and the waiting turn continues; the consent then
 *   serves every conversation of that Project — never another Project's —
 *   until revoked, turned off or the connection changes. One Run makes at
 *   most `GMAIL_AGENT_READ_LIMITS.readsPerRun` reads.
 * - **Execute**: the bounded Gmail read (`gmailAgentReads.ts`) with the
 *   consent, the owner's current Project access, connection generation and
 *   running Run rechecked before every physical send.
 * - **Release gate** (separate audit transaction, must commit before the
 *   result leaves): rechecks the owner's Project access, person, Run, the
 *   audience (every reader reads the consent's Project), connection authority
 *   and opt-in, the conversation and consent under one lock order, merges the
 *   read into the Run's taint (outward writes of that Run are then refused:
 *   mail is untrusted input), writes the content-free Agent-read log and the
 *   owner's Gmail read audit.
 *
 * Nothing stores the result server-side: a query has no receipt and the Run's
 * event logs carry neither arguments nor result (`privateToolCalls.ts`). The
 * reply the Agent writes from it belongs to the conversation and its audience.
 */
import { GMAIL_AGENT_READ_LIMITS, type GmailAgentReadInput, type GmailAgentReadOutput, type OperationActor, type RegisteredSystemActionDefinition } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { runHostWorkOutsideOperation } from "../../../db/operationTransaction.js";
import { lockActivePeople } from "../../access/activePerson.js";
import { recordAgentDataRead } from "../../contentAccess/agentReads.js";
import { audienceWithinProject, pluginDataFacts } from "../../plugins/dataAccess.js";
import { actorReaders } from "../../plugins/releaseGate.js";
import type { Queryable } from "../../routeUtils/common.js";
import { persistRunContextTaint } from "../../runs/contextTaint.js";
import { assertCurrentActor } from "../../systemActions/operations/actor.js";
import { hidden, OperationError, OperationRefusal } from "../../systemActions/operations/errors.js";
import type { OperationRegistration } from "../../systemActions/operations/types.js";
import { gmailAgentReadAvailable } from "./gmailAgentReadAvailability.js";
import { runCarriesWithdrawnPrivateReadBinding } from "./gmailPrivateReadBinding.js";
import { readGmailForAgent } from "./gmailAgentReads.js";
import { GmailReadError, recheckGmailRead, type GmailReadSnapshot } from "./gmailReadAuthority.js";
import { GMAIL_CONSENT_ID, gmailAgentReadConsentLive, gmailAgentReadConsentProject } from "./gmailAgentReadGrants.js";
import { assertProjectReadableLocked } from "../../projects/access.js";

export const GMAIL_AGENT_READ_ACTION = "source.gmail.mail.read" as const;
const CONSENT_ID = GMAIL_CONSENT_ID;
const FACTS = Symbol("rainver.gmail.agent_read_facts");

interface ReleaseFacts {
  v: 1;
  snapshot: GmailReadSnapshot;
  grantId: string;
  /** The consent's Project, locked first at release. */
  projectId: string;
  messageIds: string[];
  truncated: boolean;
  requestId: string;
}

const withheld = () => new OperationError("operation_audit_unavailable", 503, true);

const MESSAGES: Partial<Record<string, string>> = {
  gmail_agent_read_unavailable: "Gmail reading is not available in this conversation any more (the owner revoked it or turned it off, or the connection changed).",
  gmail_agent_read_audience_outside_project: "Someone who can read this conversation does not work in this Project, so mail is not read here. Ask in a conversation of the Project whose readers all work in it.",
  gmail_agent_read_limit: "This turn has made the maximum number of mail reads; answer with what was read, and the owner can ask again in a new message.",
  gmail_agent_read_mailbox_ambiguous: "The owner has several Gmail connections that allow Agent reads; ask which mailbox and pass mailbox_email.",
  gmail_not_connected: "No Gmail connection here allows Agent reads. The owner connects Gmail and turns on Agent reads under Sources → Gmail.",
};

function refuse(status: 409 | 422 | 429, code: string, extra: Record<string, unknown> = {}): OperationRefusal {
  return new OperationRefusal(status, "sources", MESSAGES[code] ?? code.replaceAll("_", " "), { code, ...extra });
}

/** A fixed-code refusal the model may see; never a query, id, header, body or upstream text. */
function fromGmailError(error: GmailReadError): OperationError {
  if (error.code === "gmail_not_found") return hidden();
  if (error.status === 429) return refuse(429, error.code, error.retryAt ? { retry_at: error.retryAt } : {});
  if (error.status === 409 || error.status === 422) return refuse(error.status, error.code);
  return new OperationError("operation_temporarily_unavailable", 503, true, "sources");
}

async function runSession(db: Queryable, actor: OperationActor): Promise<string | null> {
  return (await db.query<{ session_id: string | null }>(`SELECT session_id FROM runs WHERE id=$1 AND space_id=$2`, [actor.run_id, actor.space_id])).rows[0]?.session_id ?? null;
}

/** Where the call may read: the Run's conversation. */
async function readPlace(db: Queryable, actor: OperationActor): Promise<{ spaceId: string; userId: string; sessionId: string | null; runId: string | null }> {
  return { spaceId: actor.space_id, userId: actor.on_behalf_of_user_id!, sessionId: await runSession(db, actor), runId: actor.run_id ?? null };
}

/** The owner's opted-in active connections the call may read, narrowed by `mailbox_email`. */
async function candidateConnections(db: Queryable, spaceId: string, person: string, mailbox: string | undefined) {
  const rows = (await db.query<{ id: string; mailbox_email: string }>(
    `SELECT id,mailbox_email FROM gmail_connections WHERE space_id=$1 AND owner_user_id=$2 AND status='active' AND agent_read_enabled ORDER BY connected_at,id`,
    [spaceId, person])).rows;
  return mailbox ? rows.filter((row) => row.mailbox_email.toLowerCase() === mailbox) : rows;
}

/**
 * The one connection the call reads, or a fixed refusal the model may see. Its reply reaches the whole
 * conversation, so the owner's mailbox addresses are listed only when the audience is the owner alone; a
 * Room or the mainline gets the fixed code without them. A Run a withdrawn private-read card started reads
 * nothing (`gmailPrivateReadBinding.ts`).
 */
async function chooseConnection(db: Queryable, actor: OperationActor, input: GmailAgentReadInput, audience: readonly string[] | null): Promise<{ id: string; mailbox_email: string }> {
  if (await runCarriesWithdrawnPrivateReadBinding(db, actor)) throw refuse(409, "gmail_agent_read_unavailable");
  const chosen = await candidateConnections(db, actor.space_id, actor.on_behalf_of_user_id!, input.mailbox_email);
  if (!chosen.length) throw refuse(409, "gmail_not_connected");
  if (chosen.length > 1) {
    const ownerOnly = !!audience && audience.length === 1 && audience[0] === actor.on_behalf_of_user_id;
    throw refuse(409, "gmail_agent_read_mailbox_ambiguous", ownerOnly ? { mailboxes: chosen.map((row) => row.mailbox_email) } : {});
  }
  return chosen[0]!;
}

/** Released reads of this Run (the per-Run bound stays under a standing consent). */
async function readsUsed(db: Queryable, actor: OperationActor): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE space_id=$1 AND run_id=$2 AND action_id=$3`,
    [actor.space_id, actor.run_id, GMAIL_AGENT_READ_ACTION])).rows[0]?.n ?? 0;
}

export function gmailAgentReadRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>, config: ServerConfig): OperationRegistration {
  return {
    definition: definitions.get(GMAIL_AGENT_READ_ACTION)!,
    readKind: "content",
    async resolve(db, raw, actor) {
      // The connection the call reads is the resource a consent request names (ADR 0033); unresolved stays null.
      const person = actor.principal.kind === "agent" ? actor.on_behalf_of_user_id : null;
      const withdrawn = person ? await runCarriesWithdrawnPrivateReadBinding(db, actor) : false;
      const chosen = withdrawn || !person ? [] : await candidateConnections(db, actor.space_id, person, (raw as GmailAgentReadInput).mailbox_email);
      return { authority: `gmail_agent_read:${actor.run_id ?? "none"}`, targets: { run_id: actor.run_id }, resourceType: "gmail_connection", resourceId: chosen.length === 1 ? chosen[0]!.id : null };
    },
    async authorize(db, raw, actor, scope) {
      if (actor.principal.kind !== "agent" || !actor.run_id || !actor.on_behalf_of_user_id) throw hidden();
      const probe = await pluginDataFacts(db, config, actor, GMAIL_AGENT_READ_ACTION, false);
      if (!probe || probe === "pin_mismatch") throw new OperationError("operation_not_granted", 403);
      // Absent from the snapshot unless available; a later change (opt-out, conversation, connection) refuses.
      const available = await gmailAgentReadAvailable(db, await readPlace(db, actor));
      // The audience first, before any mailbox is chosen or named: a reader outside the Project is refused
      // with the fixed code whatever the connections are.
      if (available && probe.withinProject === false) throw refuse(409, "gmail_agent_read_audience_outside_project");
      // The consent is per mailbox: decide which one before asking whether the owner allowed it.
      const facts = available
        ? await pluginDataFacts(db, config, actor, GMAIL_AGENT_READ_ACTION, false, (await chooseConnection(db, actor, raw as GmailAgentReadInput, probe.audience)).id)
        : probe;
      if (!facts || facts === "pin_mismatch") throw new OperationError("operation_not_granted", 403);
      // A reader of this conversation is outside the consent's Project (or, with no consent yet, the conversation's
      // Project, which a new consent would bind): refused with a fixed code, never a new card.
      if (available && facts.withinProject === false) throw refuse(409, "gmail_agent_read_audience_outside_project");
      scope.policyFacts = {
        plugin_data_class: "sensitive",
        plugin_data_consent: available && facts.consent,
        plugin_data_requestable: available && facts.requestable,
        ...(facts.isolated === false ? { plugin_data_isolated: false } : {}),
      };
    },
    policyContext(_input, _actor, scope) {
      return { ...scope.policyFacts };
    },
    async execute(db, raw, actor, invocation) {
      const input = raw as GmailAgentReadInput;
      const person = actor.on_behalf_of_user_id!;
      const probe = await pluginDataFacts(db, config, actor, GMAIL_AGENT_READ_ACTION, false);
      if (!probe || probe === "pin_mismatch") throw hidden();
      if (probe.withinProject === false) throw refuse(409, "gmail_agent_read_audience_outside_project");
      const connection = await chooseConnection(db, actor, input, probe.audience);
      const facts = await pluginDataFacts(db, config, actor, GMAIL_AGENT_READ_ACTION, false, connection.id);
      if (!facts || facts === "pin_mismatch" || !facts.consent || !facts.grantId) throw hidden();
      const grantId = facts.grantId;
      const projectId = await gmailAgentReadConsentProject(db, { spaceId: actor.space_id, grantId });
      if (!projectId) throw hidden();
      if (await readsUsed(db, actor) >= GMAIL_AGENT_READ_LIMITS.readsPerRun) throw refuse(429, "gmail_agent_read_limit");
      let result: Awaited<ReturnType<typeof readGmailForAgent>>;
      try {
        // The Gmail read owns its own bounded transactions and sends, outside the query's transaction.
        result = await runHostWorkOutsideOperation(async () => {
          const pool = getDbPool(config.databaseUrl!);
          return readGmailForAgent(config, pool, {
            spaceId: actor.space_id, ownerUserId: person, connectionId: connection.id,
            query: input.query ?? null, max: input.max_messages ?? GMAIL_AGENT_READ_LIMITS.messagesPerCall,
            signal: new AbortController().signal,
            // Revocation, the opt-out, a changed connection, the owner losing the Project or the Run ending
            // stops the read before its next send. Order: each of those takes effect when its transaction
            // commits; every physical send is admitted by a fresh read of committed state immediately before
            // it leaves, and no lock is held across the network call. A change committed before that read
            // refuses the send; a send admitted just before such a commit may complete at Google, but its
            // result never leaves: the release gate below rechecks under locks that the change's writer also
            // takes, so it withholds it.
            authorizeSend: async () => {
              const running = (await pool.query(`SELECT 1 FROM runs WHERE id=$1 AND space_id=$2 AND status='running'`, [actor.run_id, actor.space_id])).rows.length > 0;
              if (!running || !await gmailAgentReadConsentLive(pool, { spaceId: actor.space_id, ownerUserId: person, grantId })) throw new GmailReadError(409, "gmail_agent_read_unavailable");
            },
          });
        });
      } catch (error) {
        if (error instanceof GmailReadError) throw fromGmailError(error);
        throw error;
      }
      const output: GmailAgentReadOutput = result.output;
      Object.defineProperty(output, FACTS, {
        enumerable: false,
        value: { v: 1, snapshot: result.snapshot, grantId, projectId, messageIds: output.items.map((item) => item.id), truncated: output.truncated, requestId: invocation?.requestId ?? "" } satisfies ReleaseFacts,
      });
      return output;
    },
    releaseFacts(raw) {
      return raw && typeof raw === "object" ? (raw as { [FACTS]?: ReleaseFacts })[FACTS] ?? null : null;
    },
    async releaseGate(audit, release) {
      await releaseGmailAgentRead(audit, config, release.actor, release.facts as ReleaseFacts | null);
    },
  };
}

/**
 * The release of one Agent mail read, in the audit transaction. Lock order:
 * the consent's Project (`FOR SHARE`, with the owner's member row) → person
 * (users → membership) → Run `FOR UPDATE` → owner + Space Gmail mutex →
 * connection `FOR SHARE` → consent `FOR SHARE`. A Project membership writer
 * takes the same Project first (`lockProjectAudienceForChange`, then ends the
 * person's consents, `endProjectDataConsents`); disconnect and the opt-in
 * writer take person → mutex → connection `FOR UPDATE`, revocation the
 * consent `FOR UPDATE`; none takes the Run, so each either commits first (this
 * release then withholds) or waits.
 */
export async function releaseGmailAgentRead(db: Queryable, config: ServerConfig, actor: OperationActor, facts: ReleaseFacts | null): Promise<void> {
  const person = actor.on_behalf_of_user_id;
  if (actor.principal.kind !== "agent" || !person || !facts || facts.v !== 1 || !facts.projectId) throw withheld();
  // The owner's current Project access, locked before anything else, as the membership writer takes it.
  try { await assertProjectReadableLocked(db, actor.space_id, facts.projectId, person); } catch { throw withheld(); }
  try { await lockActivePeople(db, actor.space_id, [person]); } catch { throw withheld(); }
  const run = (await db.query<{ id: string; visibility: "private" | "selected_users" | "space_shared"; session_id: string | null }>(
    `SELECT id,visibility,session_id FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE`, [actor.run_id, actor.space_id])).rows[0];
  if (!run) throw withheld();
  try { await assertCurrentActor(db, actor); } catch { throw withheld(); }
  // The conversation's audience, every one of whom still reads the consent's Project (ADR 0033 §6).
  const readers = (await actorReaders(db, actor)).readers;
  if (!readers.includes(person) || !await audienceWithinProject(db, actor.space_id, facts.projectId, readers)) throw withheld();
  try { await recheckGmailRead(db, facts.snapshot); } catch { throw withheld(); }
  if (await runCarriesWithdrawnPrivateReadBinding(db, actor)) throw withheld();
  if (!await gmailAgentReadAvailable(db, { spaceId: actor.space_id, userId: person, sessionId: run.session_id, runId: run.id })) throw withheld();
  const consent = await pluginDataFacts(db, config, actor, GMAIL_AGENT_READ_ACTION, true, facts.snapshot.connectionId);
  if (!consent || consent === "pin_mismatch" || !consent.consent || consent.grantId !== facts.grantId) throw withheld();
  if (await gmailAgentReadConsentProject(db, { spaceId: actor.space_id, grantId: facts.grantId }) !== facts.projectId) throw withheld();
  if (await readsUsed(db, actor) >= GMAIL_AGENT_READ_LIMITS.readsPerRun) throw withheld();
  // The read stays this Run's input: outward writes of the Run are refused (mail is untrusted data) and no
  // artifact, proposal or memory is derived from its output. Later turns of this Project conversation keep
  // its runtime: the Project-bound read does not mark the conversation for isolation.
  await persistRunContextTaint(db, {
    runId: run.id, spaceId: actor.space_id, instructingUserId: person, runVisibility: run.visibility,
    items: [{ ownerUserId: person, visibility: "private" }],
    pluginReads: [{ plugin_id: CONSENT_ID, data_class: "sensitive", owner_user_id: person }],
  });
  await recordAgentDataRead(db, {
    spaceId: actor.space_id, ownerUserId: person, runId: run.id, agentId: actor.agent_id, actionId: GMAIL_AGENT_READ_ACTION,
    resourceType: "gmail_message", resourceIds: facts.messageIds, dataClass: "sensitive", grantId: facts.grantId,
  });
  await db.query(
    `INSERT INTO gmail_read_audit_events (id,space_id,owner_user_id,actor_user_id,gmail_connection_id,project_id,selection_id,operation,
       google_thread_id,item_count,truncated,request_id,run_id,agent_id,accessed_at)
     VALUES (gen_random_uuid()::text,$1,$2,$2,$3,$9,NULL,'agent_read',NULL,$4,$5,$6,$7,$8,clock_timestamp())`,
    [actor.space_id, person, facts.snapshot.connectionId, facts.messageIds.length, facts.truncated, facts.requestId.slice(0, 128) || run.id, run.id, actor.agent_id ?? actor.principal.id, facts.projectId],
  );
}
