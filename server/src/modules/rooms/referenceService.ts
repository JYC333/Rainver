/**
 * Copying picked content into a Room conversation.
 *
 * Split out of `RoomService` the way the roster service is: the reference
 * machinery has its own gates, its own cost (a model call per unsummarized
 * whole-session pick) and its own ordering rules, and shares nothing with the
 * rest of the service but the pool and the config. The public endpoint stays
 * on `RoomService`, which delegates the two halves here — the pre-transaction
 * preparation and the in-transaction copy — so the transaction boundary is
 * visible in one place.
 */

import type { ServerConfig } from "../../config.js";
import type { Pool, PoolClient } from "../../db/pool.js";
import type { ThreadReferencePick } from "@rainver/protocol";
import { ensureImportedHistorySummary } from "../importedSessions/summary.js";
import { HttpError } from "../routeUtils/common.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { PgRoomRepository, type RoomRecord } from "./repository.js";
import {
  REFERENCE_BATCH_TOKEN_BUDGET,
  assertDisclosureConfirmed,
  assertSameProject,
  disclosureGainedBy,
  readReferencedImportedSession,
  resolveThreadReference,
} from "./threadReferences.js";

type RoomIdentity = { spaceId: string; userId: string };

export class RoomReferenceService {
  constructor(
    private readonly config: ServerConfig,
    private readonly pool: Pool,
  ) {}

  /**
   * Writes any summary a whole-session pick will need, before the transaction.
   *
   * On the pool, deliberately: this makes a model call, and the attach path
   * holds the Room row lock. Doing it here is what keeps that call out of the
   * transaction while still letting the resolver treat the summary as
   * something that simply exists.
   *
   * The access gate runs first and under the attacher's own identity. A
   * summary is a metered call charged to the session's *owner*, so without
   * this anyone could spend a colleague's budget by naming their session id —
   * and would learn from the timing whether it exists. `includeOversight`
   * stays false for the same reason the copy does: oversight is audit, not a
   * licence to publish, still less to spend.
   */
  async prepareSummaries(
    identity: RoomIdentity,
    roomId: string,
    picks: readonly ThreadReferencePick[] | undefined,
  ): Promise<void> {
    const wanted = (picks ?? []).filter((pick) => pick.kind === "imported_session");
    if (wanted.length === 0) return;
    // The destination first. Reading a session is not licence to spend its
    // owner's budget on behalf of a Room the asker cannot reach: without this,
    // naming any Room id would generate — and bill — a summary per pick before
    // the transaction got as far as its 404.
    //
    // Not a second authority. `requireRoom` inside the caller's own
    // transaction still decides, and holds the row lock while it does; this is
    // the same function, unlocked, run early for the same reason
    // `prepareManagerIfMissing` runs its membership query early.
    const room = await new PgRoomRepository(this.pool).getVisibleRoom(identity.spaceId, identity.userId, roomId);
    if (!room) throw new HttpError(404, "Room not found in this space");
    for (const pick of wanted) {
      const read = await readReferencedImportedSession(this.pool, identity, pick.id);
      // The same rule the resolvers apply, and the same function. Checked
      // here because failing it *inside* the transaction means the session's
      // owner has already been billed for a copy the attach could never use.
      assertSameProject(read.session.project_id, room.project_id);
      await ensureImportedHistorySummary(this.pool, this.config, identity, pick.id);
    }
  }

  /**
   * Copy picked content into a conversation, as `reference` messages.
   *
   * Each pick is resolved under the attacher's identity — a person can only
   * copy what they can read, and not by oversight — and then it is the
   * target's own content. Crossing an audience boundary is refused until the
   * person confirms it, with the people who would gain access named.
   */
  async attach(
    client: PoolClient,
    room: RoomRecord,
    identity: RoomIdentity,
    conversationId: string,
    input: { references: ThreadReferencePick[]; confirm_disclosure?: boolean | readonly string[] },
  ): Promise<number> {
    // Split across the batch so the whole attach costs one budget, however
    // many pieces it was picked as.
    const budget = Math.max(1, Math.floor(REFERENCE_BATCH_TOKEN_BUDGET / input.references.length));
    const resolved = [];
    for (const pick of input.references) {
      resolved.push(await resolveThreadReference(client, identity, pick, room.project_id, budget));
    }
    // One check over the whole batch: attaching three references where two
    // disclose should ask once, naming everyone who gains access.
    const gained = await disclosureGainedBy(client, identity.spaceId, room, identity.userId, resolved);
    assertDisclosureConfirmed(gained, input.confirm_disclosure);

    // Stamped explicitly and increasing. Millisecond timestamps collide inside
    // one transaction, and the tiebreak is a random UUID — which would order
    // references among themselves at random, let one land after the message
    // that carried it, and at worst push it outside the replay window of the
    // very turn it was attached for.
    const latest = await client.query<{ created_at: unknown }>(
      `SELECT max(created_at) AS created_at FROM messages
        WHERE space_id = $1 AND session_id = $2`,
      [identity.spaceId, conversationId],
    );
    // Floored at what the conversation already holds: two attaches inside the
    // same few milliseconds would otherwise pick overlapping bases and the
    // later one would sort first.
    //
    // `new Date(...)`, not `Date.parse(...)`: pg decodes `timestamptz` to a
    // JS Date, and `Date.parse` on one round-trips through `toString()` and
    // drops the milliseconds — which floored the value to the whole second
    // and left the guard never engaging.
    const raw = latest.rows[0]?.created_at;
    const existing = raw ? new Date(raw as string | Date).getTime() : 0;
    const base = Math.max(Date.now(), existing + 1);
    const sessions = new PgSessionRepository(client);
    for (const [index, reference] of resolved.entries()) {
      const written = await sessions.addRoomReference(
        identity.spaceId,
        identity.userId,
        room.id,
        conversationId,
        {
          content: reference.content,
          provenance: reference.provenance,
          created_at: new Date(base + index).toISOString(),
        },
      );
      // `addRoomReference` returns null when the conversation is not readable
      // as this person. Answering 201 with nothing attached would be a lie.
      if (!written) throw new HttpError(404, "Conversation not found in this Room");
    }
    return base + resolved.length;
  }
}
