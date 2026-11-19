import { createHash } from "node:crypto";
import type { OperationActor, OperationInput, RegisteredSystemActionDefinition } from "@rainver/protocol";
import { lockActivePerson } from "../../access/activePerson.js";
import { assertProjectReadable, assertProjectReadableLocked, lockProjectAudience, projectReaders } from "../../projects/access.js";
import { roomAudience } from "../../rooms/threadReferences.js";
import type { Queryable } from "../../routeUtils/common.js";
import { PgSessionRepository } from "../../sessions/repository.js";
import { hidden, OperationError, OperationRefusal } from "../../systemActions/operations/errors.js";
import { runSensitiveReads, SENSITIVE_READS_VERSION } from "../../runs/contextTaint.js";
import type { OperationRegistration } from "../../systemActions/operations/types.js";

const ACTION = "source.gmail.summary.share";
const PREVIEW = "source.gmail.summary.preview";
type Input = OperationInput<typeof ACTION>;
type Target = OperationInput<typeof PREVIEW>;

function shareTargetRegistration() {
  return {
    domainAuthorizationFirst: true,
    async resolve(_db: Queryable, raw: unknown) {
      const input = raw as Target;
      return {
        authority: `gmail_summary_share:${input.source_message_id}:${input.session_id}`,
        targets: { source_message_id: input.source_message_id, room_id: input.room_id, session_id: input.session_id },
        resourceType: "room", resourceId: input.room_id,
      };
    },
    policyContext(raw: unknown) {
      const input = raw as Target;
      return { source_message_id: input.source_message_id, destination_session_id: input.session_id };
    },
  } as const;
}

export function gmailSummaryPreviewRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration {
  return {
    ...shareTargetRegistration(),
    definition: definitions.get(PREVIEW)!,
    readKind: "metadata",
    authorize: (db, raw, actor) => authorizeShare(db, raw as Target, actor, false),
    async execute(db, raw, actor) {
      const input = raw as Target;
      const audience = await shareAudience(db, input, actor);
      await authorizeShare(db, input, actor, false);
      return audience;
    },
  };
}

/** Reuse the attributed Room writer without routing the shared text to an Agent. */
export function gmailSummaryShareRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration {
  return {
    ...shareTargetRegistration(),
    definition: definitions.get(ACTION)!,
    authorize: (db, raw, actor) => authorizeShare(db, raw as Target, actor, true),
    authorizeResult: (db, raw, actor) => authorizeShare(db, raw as Target, actor, true),
    async execute(db, raw, actor) {
      const input = raw as Input;
      const audience = await shareAudience(db, input, actor);
      if (input.audience_version !== audience.audience_version) throw new OperationError("operation_conflict", 409);
      // The shared text came from the owner's mail, so the Room keeps that read's constraints: its later Runs
      // inherit the source Run's sensitive reads (`sensitiveConversationReads`) — no Memory, nothing
      // materialized, no outward writes — and the Project stays the boundary (ADR 0033 §6, C).
      const sensitiveReads = await sourceSensitiveReads(db, actor, input.source_message_id);
      const project = await sourceProject(db, actor, input.source_message_id);
      const message = await new PgSessionRepository(db).addRoomUserMessage(actor.space_id, actor.on_behalf_of_user_id!,
        input.room_id, input.session_id, { content: input.content, metadata: {
          shared_from: "private_gmail_summary",
          ...(project ? { source_project_id: project } : {}),
          sensitive_reads: sensitiveReads,
          sensitive_reads_version: SENSITIVE_READS_VERSION,
        } });
      if (!message) throw hidden();
      return { message_id: message.id, source_message_id: input.source_message_id, room_id: input.room_id, session_id: input.session_id };
    },
  };
}

async function authorizeShare(db: Queryable, input: Target, actor: OperationActor, lock: boolean): Promise<void> {
  if (actor.principal.kind !== "user" || !actor.on_behalf_of_user_id) throw hidden();
  const owner = actor.on_behalf_of_user_id;
  const project = await sourceProject(db, actor, input.source_message_id);
  if (!project) throw hidden();
  if (lock) {
    await assertProjectReadableLocked(db, actor.space_id, project, owner).catch(() => { throw hidden(); });
    await lockProjectAudience(db, actor.space_id, project);
    await lockActivePerson(db, actor.space_id, owner);
    await db.query(`SELECT id FROM rooms WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR SHARE`,
      [input.room_id, actor.space_id, project]);
  } else {
    await assertProjectReadable(db, actor.space_id, project, owner).catch(() => { throw hidden(); });
  }
  const destination = await db.query(
    `SELECT 1 FROM rooms r JOIN room_user_members m ON m.room_id=r.id AND m.space_id=r.space_id
        JOIN sessions s ON s.room_id=r.id AND s.space_id=r.space_id AND s.project_id=r.project_id
      WHERE r.id=$1 AND s.id=$2 AND r.project_id=$3 AND r.space_id=$4 AND m.user_id=$5
        AND r.status='active' AND s.status='active' AND m.status='active'
      ${lock ? "FOR SHARE OF r,m FOR UPDATE OF s" : ""}`,
    [input.room_id, input.session_id, project, actor.space_id, owner],
  );
  if (!destination.rows.length || await sourceProject(db, actor, input.source_message_id, lock) !== project) throw hidden();
}

/** Project and Room locks protect the comparison during a share command. */
async function shareAudience(db: Queryable, input: Target, actor: OperationActor) {
  const room = (await db.query<{ id: string; project_id: string; is_mainline: boolean }>(
    `SELECT id,project_id,is_mainline FROM rooms WHERE id=$1 AND space_id=$2`, [input.room_id, actor.space_id],
  )).rows[0];
  if (!room) throw hidden();
  const audienceIds = new Set(await roomAudience(db, actor.space_id, room));
  const readers = (await projectReaders(db, actor.space_id, room.project_id))
    .filter(reader => audienceIds.has(reader.user_id));
  const readersById = readers.map(reader => reader.user_id).sort();
  const audienceVersion = createHash("sha256")
    .update(JSON.stringify([input.source_message_id, input.room_id, input.session_id, readersById])).digest("hex");
  return { audience_version: audienceVersion, readers: readers.map(({ display_name }) => ({ display_name })) };
}

/**
 * The sensitive reads of the private Run whose reply is being shared (never empty: the source read Gmail),
 * each with its real owner, judged as every reference, inheritance and reflection judges them
 * (`runSensitiveReads`): an entry from before owners were recorded is the sharer's only when provable,
 * and malformed metadata is not read as none. Text carrying anybody else's data, an unknown owner's, or
 * reads that cannot all be determined is not shared: only the owner may widen their own mail's audience
 * (ADR 0033 C).
 */
async function sourceSensitiveReads(db: Queryable, actor: OperationActor, sourceId: string): Promise<{ plugin_id: string; owner_user_id: string }[]> {
  const sharer = actor.on_behalf_of_user_id!;
  const runId = (await db.query<{ run_id: string }>(
    `SELECT run_id FROM messages WHERE id=$1 AND space_id=$2 AND run_id IS NOT NULL`, [sourceId, actor.space_id],
  )).rows[0]?.run_id;
  if (!runId) throw hidden();
  const held = await runSensitiveReads(db, actor.space_id, runId);
  if (!held.complete || held.reads.some((read) => read.ownerUserId !== sharer)) {
    throw new OperationRefusal(409, "sources", "This reply holds data that is not provably your own mail, so it cannot be shared", { code: "gmail_summary_share_foreign_data" });
  }
  const reads = new Map(held.reads.map((read) => [read.pluginId, { plugin_id: read.pluginId, owner_user_id: sharer }]));
  // A read log without a taint entry still names Gmail as the source (`sourceProject` requires the sharer's).
  if (reads.size === 0) reads.set("core:gmail", { plugin_id: "core:gmail", owner_user_id: sharer });
  return [...reads.values()].sort((a, b) => a.plugin_id.localeCompare(b.plugin_id));
}

async function sourceProject(db: Queryable, actor: OperationActor, sourceId: string, lock = false): Promise<string | null> {
  const result = await db.query<{ project_id: string }>(
    `SELECT s.project_id FROM messages m JOIN sessions s ON s.id=m.session_id AND s.space_id=m.space_id
       JOIN runs r ON r.id=m.run_id AND r.space_id=m.space_id AND r.session_id=s.id
      WHERE m.id=$1 AND m.space_id=$2 AND m.role='assistant' AND s.user_id=$3 AND s.room_id IS NULL
        AND s.status='active' AND s.project_id IS NOT NULL AND r.owner_user_id=$3 AND r.visibility='private'
        AND EXISTS (SELECT 1 FROM agent_data_read_logs l WHERE l.space_id=r.space_id AND l.run_id=r.id AND l.owner_user_id=$3
          AND l.action_id IN ('source.gmail.mail.read','source.gmail.digest.read'))${lock ? ' FOR SHARE OF m,s' : ''}`,
    [sourceId, actor.space_id, actor.on_behalf_of_user_id],
  );
  return result.rows[0]?.project_id ?? null;
}
