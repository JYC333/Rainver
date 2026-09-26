import {
  parseAgentMentions,
  ROOM_DISCUSSION_DEFAULT_ROUND_CAP,
  ROOM_DISCUSSION_DEFAULT_SPEND_CAP_USD,
  ROOM_DISCUSSION_MAX_PARTICIPANTS,
  type OpenRoomDiscussionRequest,
  type RoomDiscussionDetail,
  type RoomDiscussionHeldMention,
  type RoomDiscussionNotice,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Pool, PoolClient } from "../../db/pool.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { assertProjectWriter } from "../projects/access.js";
import { HttpError, withDbTransaction } from "../routeUtils/common.js";
import { conversationTurnTaken, ConversationTurnInProgressError, isConversationTurnInProgressError } from "../sessions/conversationRuntimeSessionRepository.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { discussionOut, PgRoomDiscussionRepository, type DiscussionRecord } from "./discussionRepository.js";
import { PgRoomRepository, roomConversationOut, type RoomAgentMemberRecord } from "./repository.js";
import { PgAgentGroupRepository } from "../agentGroups/repository.js";
import { RoomService, type RoomDelegationBudget, type RoomDispatchDiscussion, type RoomIdentity } from "./service.js";
import { hasQueuedRoomMessage, isTransientDatabaseError, lockRoomConversationQueue, RoomMessageQueue } from "./messageQueue.js";
import { admitTurnParkedRuns, discussionQuotaHold } from "./quotaGate.js";
import { accountLabel, cachedQuotaReading, refusedWindow, subscriptionLoginOfRun } from "./subscriptionLogins.js";
import { SUBSCRIPTION_QUOTA_EXHAUSTED } from "../runs/retryPolicy.js";
import type { AgentGroupMessageRecipientSegment } from "../agentGroups/service.js";

/**
 * Bounded discussion among a Room conversation's Agents
 * (`modules/rooms.md`, "Discussions among a conversation's Agents").
 *
 * Every Agent-triggered turn is charged to a container. The default container
 * is the person's message that started the turn: when an Agent's reply
 * addresses another Agent with `@Name`, the first wave opens an **emergent**
 * discussion on that message, bounded by the per-turn fan-out ceiling. A
 * person opens an **explicit** one with its own round and spend caps. Either
 * way one row, one timeline: every message and task group in it carries
 * `discussion_id`.
 *
 * A wave is one task group: the message that dispatched it and its
 * recipients' replies. When the last Run of a wave has finished its chat turn,
 * `advance` reads the Agents its replies addressed and dispatches them as the
 * next wave — or, when nobody was addressed, a cap was reached or a person
 * stopped it, dispatches the Manager's closing turn. Each wave is an ordinary
 * domain-event continuation executed as the container's owner, so the
 * serialization, identity, prompt and authority of a person's own message
 * apply unchanged (B8A).
 */
export const DISCUSSION_FANOUT_CEILING = ROOM_DISCUSSION_MAX_PARTICIPANTS;
/** An emergent discussion: the person's own round, plus one the Agents opened. */
const EMERGENT_ROUND_CAP = 2;
export const ROOM_DISCUSSION_ADVANCE_RETRY_JOB = "room_discussion_advance_retry";
const ADVANCE_RETRY_DELAY_MS = 4_000;

export class RoomDiscussionService {
  constructor(
    private readonly config: ServerConfig,
    private readonly pool: Pool,
  ) {}

  // -------------------------------------------------------------------------
  // Person-facing operations
  // -------------------------------------------------------------------------

  async open(identity: RoomIdentity, roomId: string, sessionId: string, request: OpenRoomDiscussionRequest) {
    return withDbTransaction(this.pool, async (client) => {
      const room = await this.requireWriter(client, identity, roomId);
      const discussions = new PgRoomDiscussionRepository(client);
      await lockSession(client, identity.spaceId, sessionId);
      const current = await discussions.getOpenForSession(identity.spaceId, sessionId, { forUpdate: true });
      if (current?.status === "active") {
        const detail = `Another discussion is running in this conversation (${current.id}); stop it or wait for it to end`;
        throw new HttpError(409, detail, {
          detail,
          code: "room_discussion_active",
          discussion_id: current.id,
        });
      }
      if (current) {
        await discussions.update(identity.spaceId, current.id, { status: "closed" });
        // Nor would the closed one's closing turn, still waiting for the window, once the new one runs.
        await cancelHeldClosing(client, identity.spaceId, current.id);
      }
      const roster = await new PgRoomRepository(client).listAgentMembers(identity.spaceId, room.id, identity.userId);
      const participants = request.participant_agent_ids === "all"
        ? roster.map((member) => member.agent_id)
        : [...new Set(request.participant_agent_ids)];
      if (participants.length > ROOM_DISCUSSION_MAX_PARTICIPANTS) {
        throw new HttpError(422, `A discussion seats at most ${ROOM_DISCUSSION_MAX_PARTICIPANTS} Agents; this Room has ${participants.length}. Choose who takes part.`);
      }
      const rosterIds = new Set(roster.map((member) => member.agent_id));
      if (participants.length === 0 || participants.some((agentId) => !rosterIds.has(agentId))) {
        throw new HttpError(422, "Discussion participants must be active Agents of this Room");
      }
      const roundCap = request.round_cap ?? ROOM_DISCUSSION_DEFAULT_ROUND_CAP[request.shape];
      const dispatched = await new RoomService(this.config, this.pool).sendMessageInTransaction(client, identity, roomId, sessionId, {
        content: request.topic,
        discussion_intent: "join",
        recipient_segments: [{
          recipient_agent_ids: participants,
          content: firstRoundInstruction(request.topic, request.shape, roundCap),
        }],
      });
      const discussion = await discussions.insert({
        spaceId: identity.spaceId,
        roomId,
        sessionId,
        openedByUserId: identity.userId,
        originMessageId: dispatched.message.id,
        kind: "explicit",
        shape: request.shape,
        topic: request.topic,
        participantAgentIds: participants,
        roundCap,
        roundsUsed: 1,
        turnsUsed: 0,
        spendCapUsd: request.spend_cap_usd ?? ROOM_DISCUSSION_DEFAULT_SPEND_CAP_USD,
      });
      await discussions.stampGroup(identity.spaceId, dispatched.task_group_ids[0]!, discussion.id);
      await discussions.stampMessages({
        spaceId: identity.spaceId, sessionId, discussionId: discussion.id, wave: 0, messageIds: [dispatched.message.id],
      });
      return {
        ...dispatched,
        conversation: roomConversationOut(dispatched.conversation),
        message: {
          ...dispatched.message,
          discussion_id: discussion.id,
          metadata_json: { ...(dispatched.message.metadata_json ?? {}), wave: 0 },
        },
        discussion: discussionOut(discussion),
      };
    });
  }

  async list(identity: RoomIdentity, roomId: string, sessionId: string) {
    return withDbTransaction(this.pool, async (client) => {
      await this.requireMember(client, identity, roomId, sessionId);
      const items = await new PgRoomDiscussionRepository(client).listForSession(identity.spaceId, sessionId);
      return { items: items.map(discussionOut) };
    });
  }

  async get(identity: RoomIdentity, roomId: string, sessionId: string, discussionId: string): Promise<RoomDiscussionDetail> {
    return withDbTransaction(this.pool, async (client) => {
      await this.requireMember(client, identity, roomId, sessionId);
      const discussions = new PgRoomDiscussionRepository(client);
      const discussion = await discussions.get(identity.spaceId, discussionId);
      if (!discussion || discussion.session_id !== sessionId || discussion.room_id !== roomId) {
        throw new HttpError(404, "Discussion not found in this conversation");
      }
      const waves = await client.query<{
        group_id: string;
        trigger_message_id: string;
        wave: string | null;
        closing: boolean | null;
        run_ids: string[] | null;
      }>(
        `SELECT grp.id AS group_id, grp.trigger_message_id,
                message.metadata_json->>'wave' AS wave,
                (message.metadata_json->>'discussion_closing')::boolean AS closing,
                ARRAY(
                  SELECT run.id FROM runs run
                   WHERE run.space_id = grp.space_id AND run.run_group_id = grp.id
                     AND COALESCE(run.model_override_json->'chat_turn'->>'kind', '') <> 'handoff'
                   ORDER BY run.created_at, run.id
                ) AS run_ids
           FROM agent_run_groups grp
           JOIN messages message ON message.space_id = grp.space_id AND message.id = grp.trigger_message_id
          WHERE grp.space_id = $1 AND grp.discussion_id = $2
          ORDER BY grp.created_at, grp.id`,
        [identity.spaceId, discussion.id],
      );
      return {
        discussion: discussionOut(discussion),
        waves: waves.rows.map((row) => ({
          wave: Number(row.wave ?? 0),
          group_id: row.group_id,
          trigger_message_id: row.trigger_message_id,
          run_ids: row.run_ids ?? [],
          closing: row.closing === true,
        })),
        usage: await discussions.usage(identity.spaceId, discussion.id),
        quota_hold: await discussionQuotaHold(client, identity.spaceId, discussion.id, identity.userId),
      };
    });
  }

  /**
   * No further waves. The turn already running finishes; the Manager then
   * writes the conclusion. Any member may stop a discussion — stopping spends
   * nothing.
   */
  async stop(identity: RoomIdentity, roomId: string, sessionId: string, discussionId: string) {
    const stopped = await withDbTransaction(this.pool, async (client) => {
      await this.requireMember(client, identity, roomId, sessionId);
      const discussions = new PgRoomDiscussionRepository(client);
      await lockSession(client, identity.spaceId, sessionId);
      const discussion = await requireDiscussion(discussions, identity.spaceId, roomId, sessionId, discussionId);
      if (discussion.status === "cap_reached") {
        // Its closing turn went out when it reached the cap; stopping gives up
        // the rounds on offer and ends it for good: a closing still waiting
        // for the subscription window is cancelled rather than concluding it
        // hours later. A person who wants a conclusion asks for one.
        await cancelHeldClosing(client, identity.spaceId, discussion.id);
        return { discussion: await discussions.update(identity.spaceId, discussion.id, { status: "closed", heldMentions: [] }), close: false };
      }
      if (discussion.status !== "active") return { discussion, close: false };
      const updated = await discussions.update(identity.spaceId, discussion.id, {
        status: "stopped",
        stopReason: "stopped_by_person",
      });
      return { discussion: updated, close: true };
    });
    if (stopped.close) {
      // When no wave is running the closing turn goes out now; otherwise the
      // wave that is running dispatches it when it ends.
      const idle = await withDbTransaction(this.pool, (client) => this.latestGroupIdle(client, stopped.discussion));
      if (idle) await this.advanceGroup(stopped.discussion.space_id, idle);
    }
    return discussionOut(await this.reload(stopped.discussion));
  }

  /**
   * More rounds for a discussion stopped at its cap. On an emergent discussion
   * this is "open a discussion": it becomes explicit, with the rounds asked
   * for. The Agents it held back are dispatched as the next wave.
   */
  async extend(identity: RoomIdentity, roomId: string, sessionId: string, discussionId: string, rounds: number) {
    return withDbTransaction(this.pool, async (client) => {
      await this.requireWriter(client, identity, roomId);
      const discussions = new PgRoomDiscussionRepository(client);
      await lockSession(client, identity.spaceId, sessionId);
      const discussion = await requireDiscussion(discussions, identity.spaceId, roomId, sessionId, discussionId);
      if (discussion.status === "active") {
        if (discussion.opened_by_user_id !== identity.userId) {
          throw new HttpError(409, "A running discussion is given more rounds by the person it runs for; add them once it stops at its cap");
        }
        return discussionOut(await discussions.update(identity.spaceId, discussion.id, {
          roundCap: discussion.round_cap + rounds,
          extension: { user_id: identity.userId, rounds },
        }));
      }
      if (discussion.status !== "cap_reached") {
        throw new HttpError(409, "Only a running discussion, or one stopped at its cap, can be given more rounds");
      }
      const debateContinues = discussion.shape === "debate";
      if (discussion.held_mentions.length === 0 && !debateContinues) {
        throw new HttpError(409, "Nothing is waiting to continue in this discussion");
      }
      // The closing turn dispatched at the cap and still waiting for the
      // subscription window concludes nothing now: it would run first once
      // the window resets, mid-discussion, and spend it.
      await cancelHeldClosing(client, identity.spaceId, discussion.id);
      // Adding rounds is a new decision to spend, so what follows runs for
      // the person who made it (B8A): their authority, their subscription,
      // their spend bound — another budget of the same size on top of what
      // was already spent, the default when there was none.
      const spendCap = discussion.spend_usd + (discussion.spend_cap_usd ?? ROOM_DISCUSSION_DEFAULT_SPEND_CAP_USD);
      // An explicit discussion's turn count keeps only what Agents started on
      // their own; the emergent waves it counted are its rounds now.
      await client.query(
        `UPDATE room_discussions
            SET spend_cap_usd = $3, opened_by_user_id = $4::varchar,
                turns_used = CASE WHEN kind = 'emergent' THEN 0 ELSE turns_used END,
                -- Another person's "continue anyway" was their decision, not this one's.
                quota_override_by_user_id = CASE WHEN opened_by_user_id = $4::varchar THEN quota_override_by_user_id END,
                quota_override_at = CASE WHEN opened_by_user_id = $4::varchar THEN quota_override_at END
          WHERE space_id = $1 AND id = $2`,
        [identity.spaceId, discussion.id, spendCap, identity.userId],
      );
      let extended = await discussions.update(identity.spaceId, discussion.id, {
        kind: "explicit",
        status: "active",
        stopReason: null,
        roundCap: Math.max(discussion.round_cap, discussion.rounds_used - discussion.round_base) + rounds,
        extension: { user_id: identity.userId, rounds },
      });
      const roster = await this.roster(client, extended);
      const lastWave = Math.max(0, extended.rounds_used - 1);
      const candidates = debateContinues
        ? critiqueTargets(extended, roster, await waveReplies(client, identity.spaceId, await waveGroupIdsOf(client, identity.spaceId, extended.id, lastWave)))
        : extended.held_mentions.map((held) => ({ ...held }));
      const admitted = await this.admissible(client, extended, roster, candidates, lastWave);
      if (admitted.targets.length === 0) {
        throw new HttpError(409, "None of the Agents waiting to continue can be set working by you");
      }
      extended = await discussions.update(identity.spaceId, extended.id, { heldMentions: admitted.held });
      await this.dispatchWave(client, extended, roster, {
        wave: extended.rounds_used,
        targets: admitted.targets,
        debateCritique: debateContinues,
      });
      return discussionOut(await discussions.get(identity.spaceId, discussion.id) ?? extended);
    });
  }

  // -------------------------------------------------------------------------
  // Advancing after a turn
  // -------------------------------------------------------------------------

  /**
   * Called once a Room Run's chat turn is complete. Advances the Run's wave
   * when it was the last one of it; a conversation that is momentarily busy
   * (a person's message won the turn) is retried by a job.
   */
  async afterTurnFinalized(run: { space_id: string; session_id?: string | null; run_group_id?: string | null; model_override_json?: unknown }): Promise<void> {
    if (!run.run_group_id) return;
    const chatTurn = record(record(run.model_override_json).chat_turn);
    if (chatTurn.kind === "handoff" || !record(run.model_override_json).chat_turn) return;
    await this.advanceGroup(run.space_id, run.run_group_id);
    // Then a person's message that waited for this turn boundary, when the
    // advance did not already post it.
    const sessionId = run.session_id ?? (typeof chatTurn.session_id === "string" ? chatTurn.session_id : null);
    if (sessionId) {
      await this.releaseQueued(run.space_id, sessionId);
      // And an Agent's Run parked for this turn to be over (`enqueueWhenTurnFree`).
      await admitTurnParkedRuns(this.pool, { spaceId: run.space_id, sessionId });
    }
  }

  /**
   * Post a conversation's waiting messages once its turn is free. A running
   * discussion posts them itself, between its waves, when its latest wave
   * advances — so here that wave is advanced, in the same transaction (a
   * no-op unless it completed without advancing); anything else is posted
   * directly. A turn still taken is "busy": the caller's job retries.
   */
  async releaseQueued(spaceId: string, sessionId: string, afterFailedAdvance = false): Promise<"released" | "busy" | "empty"> {
    let failedAdvance: { groupId: string; error: unknown } | null = null;
    const outcome = await withDbTransaction(this.pool, async (client) => {
      await lockRoomConversationQueue(client, spaceId, sessionId);
      if (!await hasQueuedRoomMessage(client, spaceId, sessionId)) return "empty" as const;
      const discussion = await new PgRoomDiscussionRepository(client).getOpenForSession(spaceId, sessionId);
      if (discussion?.status !== "active") {
        return new RoomMessageQueue(this.config, this.pool).releaseNext(client, spaceId, sessionId);
      }
      const latest = await waveDispatchGroupId(client, spaceId, discussion.id, Math.max(0, discussion.rounds_used - 1));
      if (latest) {
        await client.query("SAVEPOINT release_advance");
        try {
          await this.advanceInTransaction(client, spaceId, latest);
          await client.query("RELEASE SAVEPOINT release_advance");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT release_advance");
          if (!isConversationTurnInProgressError(error) && !isTurnBusyHttpError(error) && !isTransientDatabaseError(error)) {
            failedAdvance = { groupId: latest, error };
          }
          return "busy" as const;
        }
      }
      if (!await hasQueuedRoomMessage(client, spaceId, sessionId)) return "released" as const;
      // A quota-held wave may give up the conversation turn. Ordinary sends
      // can proceed; an explicitly joined send remains queued until that
      // discussion wave advances, as RoomService checks before stamping it.
      if (!await conversationTurnTaken(client, spaceId, sessionId)) {
        return new RoomMessageQueue(this.config, this.pool).releaseNext(client, spaceId, sessionId);
      }
      return "busy" as const;
    });
    // Anything else ends the discussion, visibly, as a failed advance does.
    const failed = failedAdvance as { groupId: string; error: unknown } | null;
    if (failed) {
      await withDbTransaction(this.pool, (client) => this.failAdvance(client, spaceId, failed.groupId, failed.error));
      // The discussion has ended: what waited for it is posted now (once).
      if (!afterFailedAdvance) return this.releaseQueued(spaceId, sessionId, true);
    }
    return outcome;
  }

  async advanceGroup(
    spaceId: string,
    groupId: string,
    options: { enqueueRetry?: boolean } = {},
  ): Promise<"advanced" | "busy" | "failed"> {
    try {
      await withDbTransaction(this.pool, (client) => this.advanceInTransaction(client, spaceId, groupId));
      return "advanced";
    } catch (error) {
      if (isConversationTurnInProgressError(error) || isTurnBusyHttpError(error) || isTransientDatabaseError(error)) {
        if (options.enqueueRetry === false) return "busy";
        await withDbTransaction(this.pool, (client) => new PgJobQueueRepository(client).enqueue({
          job_type: ROOM_DISCUSSION_ADVANCE_RETRY_JOB,
          space_id: spaceId,
          user_id: null,
          payload: { group_id: groupId },
          scheduled_at: new Date(Date.now() + ADVANCE_RETRY_DELAY_MS),
        }));
        return "busy";
      }
      // Anything else would leave the discussion running with no wave behind
      // it, holding the conversation's one open slot. It ends, visibly.
      await withDbTransaction(this.pool, (client) => this.failAdvance(client, spaceId, groupId, error));
      return "failed";
    }
  }

  async advanceInTransaction(client: PoolClient, spaceId: string, groupId: string): Promise<void> {
    const sessionRow = (await client.query<{ session_id: string | null }>(
      `SELECT session_id FROM agent_run_groups WHERE space_id = $1 AND id = $2`,
      [spaceId, groupId],
    )).rows[0];
    if (!sessionRow?.session_id) return;
    await lockSession(client, spaceId, sessionRow.session_id);
    const loaded = await loadWaveGroup(client, spaceId, groupId);
    if (!loaded?.room_id || !loaded.session_id || !loaded.trigger_message_id) return;
    // A group's turn advances once, whichever completion, retry or release
    // reaches it first; a repeat would announce, merge or dispatch again.
    if (loaded.advanced_at) return;
    // A delegation result inside a discussion is stamped with its source's
    // wave: that wave advances once, from the group that dispatched it, over
    // the replies of every group in it.
    const group = loaded.discussion_id && !loaded.closing
      ? await loadWaveGroup(client, spaceId, await waveDispatchGroupId(client, spaceId, loaded.discussion_id, loaded.wave) ?? loaded.id) ?? loaded
      : loaded;
    const wave = group.wave;
    const waveGroupIds = group.discussion_id && !group.closing
      ? await waveGroupIdsOf(client, spaceId, group.discussion_id, wave)
      : [group.id];
    for (const id of waveGroupIds) {
      if (!await waveComplete(client, spaceId, id)) return;
    }
    const unadvanced = (await client.query<{ id: string }>(
      `UPDATE agent_run_groups SET advanced_at = now() WHERE space_id = $1 AND id = ANY($2::varchar[]) AND advanced_at IS NULL
       RETURNING id`,
      [spaceId, [...new Set([...waveGroupIds, loaded.id])]],
    )).rows.map((row) => row.id);
    const replies = await waveReplies(client, spaceId, waveGroupIds);
    const discussions = new PgRoomDiscussionRepository(client);
    let discussion = group.discussion_id ? await discussions.get(spaceId, group.discussion_id, { forUpdate: true }) : null;
    if (discussion) {
      await discussions.stampMessages({
        spaceId, sessionId: group.session_id!, discussionId: discussion.id, wave,
        messageIds: replies.map((reply) => reply.id),
      });
      discussion = await discussions.update(spaceId, discussion.id, {
        spendUsd: await discussions.pricedUsd(spaceId, discussion.id),
      });
    }

    if (group.closing) {
      if (!discussion) return;
      // Only the closing turn this discussion is waiting for: a late one from
      // before more rounds were added concludes nothing.
      if (group.event_key !== closingKey(discussion)) return;
      const conclusion = replies.find((reply) => reply.role === "assistant" && !reply.failed);
      await discussions.update(spaceId, discussion.id, {
        conclusionMessageId: conclusion?.id ?? null,
        // A discussion stopped at its cap stays open to more rounds.
        ...(discussion.status === "converged" || discussion.status === "stopped" ? { status: "closed" as const } : {}),
      });
      return;
    }

    const roster = await new PgRoomRepository(client).listAgentMembers(spaceId, group.room_id!, discussion?.opened_by_user_id ?? group.manager_user_id);
    let targets = discussion?.shape === "debate"
      ? critiqueTargets(discussion, roster, replies)
      : addressedTargets(replies, roster);
    // What late groups (delegation results after their wave advanced) are
    // answered for is only what their own replies asked — every one not yet
    // answered, not only the group that completed last.
    const lateTargets = loaded.id === group.id || discussion?.shape === "debate"
      ? targets
      : addressedTargets(await waveReplies(client, spaceId, unadvanced), roster);
    // Agents addressed earlier and held back — behind a person's message, or
    // past the fan-out budget — are still waiting to be set working.
    if (discussion?.status === "active" && discussion.shape !== "debate") {
      targets = mergeHeld(discussion.held_mentions, targets);
    }

    // A wave of a discussion that already ended (a person stopped it, or an
    // earlier wave dispatched its closing) only closes it; Agents a late
    // reply addressed are named, never set working.
    if (discussion && discussion.status !== "active") {
      if (discussion.status === "stopped" && !await hasClosingTurn(client, spaceId, discussion)) {
        await this.dispatchClosing(client, discussion, wave);
      }
      if (discussion.shape !== "debate") {
        // A person stopped it while Agents were held: they are named with
        // the rest, once, rather than dropped.
        const releasesHeld = discussion.status === "stopped" && loaded.id === group.id && discussion.held_mentions.length > 0;
        await this.unheard(client, discussion, roster, releasesHeld ? mergeHeld(discussion.held_mentions, lateTargets) : lateTargets,
          wave, "the discussion had already ended");
        if (releasesHeld) await discussions.update(spaceId, discussion.id, { heldMentions: [] });
      }
      return;
    }

    // Anything dispatched from an earlier wave than the newest one has
    // already been superseded by a later advance: count it, do not fork.
    if (discussion && wave + 1 < discussion.rounds_used) {
      if (discussion.shape !== "debate") await this.unheard(client, discussion, roster, lateTargets, wave, "the discussion had already moved on to a later round");
      return;
    }

    // A vendor CLI refused this wave for an exhausted subscription: the
    // discussion stops as at a cap, never silently. The Manager's
    // closing turn is Agent-triggered and passes the quota gate like any
    // other, so it waits for the window when it runs on the exhausted login.
    const exhausted = discussion ? await quotaExhaustion(client, spaceId, waveGroupIds) : null;
    if (discussion && exhausted) {
      await client.query(
        `UPDATE room_discussions SET quota_override_by_user_id = NULL, quota_override_at = NULL
          WHERE space_id = $1 AND id = $2`,
        [spaceId, discussion.id],
      );
      // The recipients the CLI refused are what adding rounds continues with,
      // beside the Agents the wave's other replies addressed.
      const held = discussion.shape === "debate" ? [] : mergeHeld(targets, await refusedRecipients(client, spaceId, waveGroupIds));
      await this.end(client, discussion, "cap_reached", "quota_exhausted", wave, held, exhausted);
      return;
    }

    if (!discussion) {
      if (targets.length === 0) return;
      // The person's message is the container: its recipients' replies
      // addressed other Agents, so this becomes an emergent discussion.
      const prior = await discussions.getOpenForSession(spaceId, group.session_id!, { forUpdate: true });
      if (prior?.status === "active") {
        const source = (await client.query<{ discussion_intent: string | null }>(
          `SELECT metadata_json->>'discussion_intent' AS discussion_intent
             FROM messages WHERE space_id = $1 AND id = $2`,
          [spaceId, group.trigger_message_id],
        )).rows[0];
        if (source?.discussion_intent === "separate") {
          // A person chose an ordinary message. Its reply must not turn a
          // later Agent mention into an implicit participant of this discussion.
          await new PgSessionRepository(client).addRoomConversationNotice(spaceId, group.session_id!, {
            content: `${targets.map((target) => agentName(roster, target.agent_id)).join(", ")} ${targets.length === 1 ? "was" : "were"} addressed, but this message was sent outside the current discussion. Open a discussion to continue with them.`,
          });
          return;
        }
        // Legacy unmarked sends can still feed an active discussion while
        // its wave waits; the explicit ordinary-message choice cannot.
        if (prior.shape !== "debate") {
          await discussions.update(spaceId, prior.id, { heldMentions: mergeHeld(prior.held_mentions, targets) });
          return;
        }
        await this.unheard(client, prior, roster, targets, prior.rounds_used - 1, "another discussion was already running");
        return;
      }
      if (prior) await discussions.update(spaceId, prior.id, { status: "closed" });
      discussion = await discussions.insert({
        spaceId,
        roomId: group.room_id!,
        sessionId: group.session_id!,
        openedByUserId: group.manager_user_id,
        originMessageId: group.trigger_message_id!,
        kind: "emergent",
        shape: "open",
        topic: null,
        participantAgentIds: [...new Set([...replies.flatMap((reply) => reply.sender_agent_id ? [reply.sender_agent_id] : []), ...targets.map((target) => target.agent_id)])],
        roundCap: EMERGENT_ROUND_CAP,
        roundsUsed: wave + 1,
        turnsUsed: await containerTurns(client, spaceId, group.id, group.budget_json),
        spendCapUsd: null,
      });
      await discussions.stampGroup(spaceId, group.id, discussion.id);
      await discussions.stampMessages({
        spaceId, sessionId: group.session_id!, discussionId: discussion.id, wave,
        messageIds: [group.trigger_message_id!, ...replies.map((reply) => reply.id)],
      });
    }

    // A person spoke while this wave ran: their message goes first, as the
    // discussion's new first round, and the Agents this wave addressed wait
    // behind it. Only a message actually posted holds them; a turn taken by
    // something else retries this advance.
    const released = await new RoomMessageQueue(this.config, this.pool).releaseNext(client, spaceId, group.session_id!);
    if (released === "busy") throw new ConversationTurnInProgressError();
    if (released === "released") {
      if (targets.length > 0 && discussion.shape !== "debate") {
        await discussions.update(spaceId, discussion.id, { heldMentions: targets });
      }
      return;
    }
    if (targets.length === 0) {
      await this.end(client, discussion, "converged", null, wave, []);
      return;
    }
    if (roundOf(discussion, wave + 1) > discussion.round_cap) {
      // A debate that finished its rounds addressed nobody; its next round
      // is every participant again if the person adds rounds.
      await this.end(client, discussion, "cap_reached", "round_cap", wave, discussion.shape === "debate" ? [] : targets);
      return;
    }
    if (discussion.spend_cap_usd !== null && discussion.spend_usd >= discussion.spend_cap_usd) {
      await this.end(client, discussion, "cap_reached", "spend_cap", wave, discussion.shape === "debate" ? [] : targets);
      return;
    }
    const admitted = await this.admissible(client, discussion, roster, targets, wave);
    targets = admitted.targets;
    if (targets.length === 0 && admitted.held.length === 0) {
      await this.end(client, discussion, "converged", null, wave, []);
      return;
    }
    if (targets.length === 0) {
      await this.end(client, discussion, "cap_reached", "fanout_budget", wave, admitted.held);
      return;
    }
    // What still waits is what was admitted but past the fan-out budget; an
    // Agent the owner may not trigger was named in a notice and is dropped,
    // not re-announced every wave.
    if (admitted.held.length > 0 || discussion.held_mentions.length > 0) {
      discussion = await discussions.update(spaceId, discussion.id, { heldMentions: admitted.held });
    }
    await this.dispatchWave(client, discussion, roster, { wave: wave + 1, targets, debateCritique: discussion.shape === "debate" });
  }

  /**
   * The next wave or closing turn could not be dispatched for a reason other
   * than a busy turn — the Host went offline, the container's owner lost
   * access to the Room. The discussion closes with a notice saying why, so
   * the conversation's one open slot is not held by nothing; when the
   * failure came before a discussion existed, the notice alone says what the
   * Agent's reply asked for and why it did not happen.
   */
  private async failAdvance(client: PoolClient, spaceId: string, groupId: string, error: unknown): Promise<void> {
    // The session lock first, then the group, as `advanceInTransaction` takes them.
    const sessionRow = (await client.query<{ session_id: string | null }>(
      `SELECT session_id FROM agent_run_groups WHERE space_id = $1 AND id = $2`,
      [spaceId, groupId],
    )).rows[0];
    if (!sessionRow?.session_id) return;
    await lockSession(client, spaceId, sessionRow.session_id);
    const group = await loadWaveGroup(client, spaceId, groupId);
    if (!group?.room_id || !group.session_id) return;
    const reason = error instanceof Error ? error.message : String(error);
    const discussions = new PgRoomDiscussionRepository(client);
    const discussion = group.discussion_id ? await discussions.get(spaceId, group.discussion_id, { forUpdate: true }) : null;
    if (discussion && discussion.status !== "closed") {
      const closed = await discussions.update(spaceId, discussion.id, { status: "closed", stopReason: "dispatch_failed" });
      await this.notice(client, closed, group.wave, { kind: "failed", reason, agent_ids: [] },
        `The discussion could not continue and has ended: ${reason}`);
      return;
    }
    if (discussion) return;
    // No discussion yet: only a reply that actually addressed Agents was
    // asking for something, and only then is there anything to report.
    const roster = await new PgRoomRepository(client).listAgentMembers(spaceId, group.room_id, group.manager_user_id);
    const targets = addressedTargets(await waveReplies(client, spaceId, [group.id]), roster);
    if (targets.length === 0) return;
    await new PgSessionRepository(client).addRoomConversationNotice(spaceId, group.session_id, {
      content: `${targets.map((target) => agentName(roster, target.agent_id)).join(", ")} ${targets.length === 1 ? "was" : "were"} addressed but could not be set working: ${reason}`,
    });
  }

  /**
   * Which addressed Agents may be triggered, as the container's owner would
   * trigger them directly (B8A), and within the fan-out budget of an
   * emergent discussion. The rest are named in a notice.
   */
  private async admissible(
    client: PoolClient,
    discussion: DiscussionRecord,
    roster: RoomAgentMemberRecord[],
    targets: RoomDiscussionHeldMention[],
    wave: number,
  ): Promise<{ targets: RoomDiscussionHeldMention[]; held: RoomDiscussionHeldMention[] }> {
    const allowed: RoomDiscussionHeldMention[] = [];
    const refused: Array<{ target: RoomDiscussionHeldMention; reason: string }> = [];
    for (const target of targets) {
      const reason = await triggerRefusal(client, discussion, roster, target.agent_id);
      if (reason) refused.push({ target, reason });
      else allowed.push(target);
    }
    for (const entry of refused) {
      await this.notice(client, discussion, wave, {
        kind: "not_admitted",
        reason: entry.reason,
        agent_ids: [entry.target.agent_id],
      }, `${agentName(roster, entry.target.from_agent_ids[0])} wanted ${agentName(roster, entry.target.agent_id)} to take part, but ${entry.reason}.`);
    }
    if (discussion.kind !== "emergent") return { targets: allowed, held: [] };
    const remaining = Math.max(0, DISCUSSION_FANOUT_CEILING - discussion.turns_used);
    return { targets: allowed.slice(0, remaining), held: allowed.slice(remaining) };
  }

  private async dispatchWave(
    client: PoolClient,
    discussion: DiscussionRecord,
    roster: RoomAgentMemberRecord[],
    input: { wave: number; targets: RoomDiscussionHeldMention[]; debateCritique: boolean },
  ): Promise<void> {
    const discussions = new PgRoomDiscussionRepository(client);
    const round = roundOf(discussion, input.wave);
    const segments: AgentGroupMessageRecipientSegment[] = input.targets.map((target) => ({
      recipient_agent_ids: [target.agent_id],
      content: input.debateCritique
        ? critiqueInstruction(round, discussion.round_cap, target.content)
        : waveInstruction(round, discussion.round_cap, target, roster),
    }));
    // An emergent discussion's waves are its budget; an explicit one's are
    // bounded by its rounds, and its turn count keeps only what Agents
    // started on their own (delegations and their results).
    const turnsUsed = discussion.turns_used + (discussion.kind === "emergent" ? input.targets.length : 0);
    await new RoomService(this.config, this.pool).continueAfterDomainEventInTransaction(
      client,
      { spaceId: discussion.space_id, userId: discussion.opened_by_user_id },
      discussion.room_id,
      discussion.session_id,
      {
        kind: "agent_mention",
        key: `${discussion.id}:${input.wave}`,
        payload: {
          discussion_id: discussion.id,
          round,
          round_cap: discussion.round_cap,
          addressed: input.targets.map((target) => ({
            agent_id: target.agent_id,
            agent_name: agentName(roster, target.agent_id),
            from_names: target.from_agent_ids.map((id) => agentName(roster, id)),
          })),
        },
        recipient_segments: segments,
        discussion: { id: discussion.id, wave: input.wave },
        delegation_budget: overSpend(discussion) ? { max_depth: 1, max_fanout: 0 } : delegationBudget(turnsUsed),
      },
    );
    await discussions.update(discussion.space_id, discussion.id, {
      roundsUsed: Math.max(discussion.rounds_used, input.wave + 1),
      turnsUsed,
      participantAgentIds: [...new Set([...discussion.participant_agent_ids, ...input.targets.map((target) => target.agent_id)])],
      heldMentions: input.targets.some((target) => discussion.held_mentions.some((held) => held.agent_id === target.agent_id))
        ? discussion.held_mentions.filter((held) => !input.targets.some((target) => target.agent_id === held.agent_id))
        : undefined,
    });
  }

  private async end(
    client: PoolClient,
    discussion: DiscussionRecord,
    status: "converged" | "cap_reached",
    reason: string | null,
    wave: number,
    held: RoomDiscussionHeldMention[],
    quota: QuotaExhaustion | null = null,
  ): Promise<void> {
    const discussions = new PgRoomDiscussionRepository(client);
    const ended = await discussions.update(discussion.space_id, discussion.id, {
      status,
      stopReason: reason,
      // The callers pass what waits in full: an active discussion's held
      // Agents are already merged into this wave's targets.
      heldMentions: status === "cap_reached" ? held : [],
    });
    if (status === "cap_reached") {
      const roster = await this.roster(client, ended);
      const names = held.map((target) => agentName(roster, target.agent_id));
      await this.notice(client, ended, wave, {
        kind: "cap_reached",
        reason: reason ?? "round_cap",
        agent_ids: held.map((target) => target.agent_id),
        ...(quota ? { resets_at: quota.resets_at } : {}),
      }, capNoticeText(ended, reason, names, quota));
    }
    // An emergent discussion whose first addressed Agents were all refused or
    // held never ran an Agent-triggered turn: there is nothing to conclude,
    // and the notice is the whole answer.
    if (ended.kind === "emergent" && ended.rounds_used <= 1) {
      if (status === "converged") await discussions.update(ended.space_id, ended.id, { status: "closed" });
      return;
    }
    await this.dispatchClosing(client, ended, wave);
  }

  private async dispatchClosing(client: PoolClient, discussion: DiscussionRecord, wave: number): Promise<void> {
    const roster = await this.roster(client, discussion);
    const silent = await listNonResponders(client, discussion, roster);
    await new RoomService(this.config, this.pool).continueAfterDomainEventInTransaction(
      client,
      { spaceId: discussion.space_id, userId: discussion.opened_by_user_id },
      discussion.room_id,
      discussion.session_id,
      {
        kind: "agent_discussion_closing",
        key: closingKey(discussion),
        payload: {
          discussion_id: discussion.id,
          status: discussion.status,
          stop_reason: discussion.stop_reason,
          participant_names: discussion.participant_agent_ids.map((id) => agentName(roster, id)),
          non_responders: silent,
          held_names: discussion.held_mentions.map((held) => agentName(roster, held.agent_id)),
        },
        recipient_segments: null,
        discussion: { id: discussion.id, wave: wave + 1, closing: true },
        delegation_budget: { max_depth: 1, max_fanout: 0 },
      },
    );
  }

  private async notice(
    client: PoolClient,
    discussion: DiscussionRecord,
    wave: number,
    notice: Omit<RoomDiscussionNotice, "discussion_id">,
    content: string,
  ): Promise<void> {
    const message = await new PgSessionRepository(client).addRoomConversationNotice(
      discussion.space_id,
      discussion.session_id,
      { content, metadata: { discussion_notice: { discussion_id: discussion.id, ...notice } } },
    );
    if (message) {
      await new PgRoomDiscussionRepository(client).stampMessages({
        spaceId: discussion.space_id,
        sessionId: discussion.session_id,
        discussionId: discussion.id,
        wave,
        messageIds: [message.id],
      });
      // A reader counts a discussion as read once its record is no older
      // than the newest message naming it; the notice is written after the
      // transaction's `now()`, so the record follows it.
      await client.query(
        `UPDATE room_discussions SET updated_at = GREATEST(updated_at, $3::timestamptz) WHERE space_id = $1 AND id = $2`,
        [discussion.space_id, discussion.id, message.created_at],
      );
    }
  }

  /** Agents a reply addressed that will not be set working, and why — never silently. */
  private async unheard(
    client: PoolClient,
    discussion: DiscussionRecord,
    roster: RoomAgentMemberRecord[],
    targets: RoomDiscussionHeldMention[],
    wave: number,
    reason: string,
  ): Promise<void> {
    if (targets.length === 0) return;
    const names = targets.map((target) => agentName(roster, target.agent_id)).join(", ");
    await this.notice(client, discussion, wave, {
      kind: "not_admitted",
      reason,
      agent_ids: targets.map((target) => target.agent_id),
    }, `${names} ${targets.length === 1 ? "was" : "were"} addressed, but ${reason}.`);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async roster(client: PoolClient, discussion: DiscussionRecord): Promise<RoomAgentMemberRecord[]> {
    return new PgRoomRepository(client).listAgentMembers(discussion.space_id, discussion.room_id, discussion.opened_by_user_id);
  }

  private async reload(discussion: DiscussionRecord): Promise<DiscussionRecord> {
    return withDbTransaction(this.pool, async (client) =>
      await new PgRoomDiscussionRepository(client).get(discussion.space_id, discussion.id) ?? discussion);
  }

  /** The newest group of a discussion when every Run in it is done; null while a wave runs. */
  private async latestGroupIdle(client: PoolClient, discussion: DiscussionRecord): Promise<string | null> {
    const latest = (await client.query<{ id: string }>(
      `SELECT id FROM agent_run_groups WHERE space_id = $1 AND discussion_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [discussion.space_id, discussion.id],
    )).rows[0];
    if (!latest) return null;
    return await waveComplete(client, discussion.space_id, latest.id) ? latest.id : null;
  }

  private async requireWriter(client: PoolClient, identity: RoomIdentity, roomId: string) {
    const room = await new PgRoomRepository(client).getVisibleRoom(identity.spaceId, identity.userId, roomId, true);
    if (!room) throw new HttpError(404, "Room not found in this space");
    await assertProjectWriter(client, identity.spaceId, room.project_id, identity.userId);
    return room;
  }

  private async requireMember(client: PoolClient, identity: RoomIdentity, roomId: string, sessionId: string) {
    const rooms = new PgRoomRepository(client);
    const room = await rooms.getVisibleRoom(identity.spaceId, identity.userId, roomId, false);
    if (!room) throw new HttpError(404, "Room not found in this space");
    const conversation = await rooms.getConversation(identity.spaceId, roomId, sessionId);
    if (!conversation) throw new HttpError(404, "Room conversation not found");
    return room;
  }
}

/**
 * The delegation budget of a turn inside a container that has already
 * charged `turnsUsed` Agent-triggered turns: never more than two per turn,
 * never past the fan-out ceiling. An Agent that delegated from every
 * completion turn with a fresh budget is the chain this closes.
 */
export function delegationBudget(turnsUsed: number): { max_depth: number; max_fanout: number } {
  return { max_depth: 1, max_fanout: Math.max(0, Math.min(2, DISCUSSION_FANOUT_CEILING - turnsUsed)) };
}

/**
 * What an Agent-origin continuation of `sourceGroupId` — a delegation
 * finishing after its parent's turn ended — belongs to, and what it may still
 * delegate. Inside a running discussion it joins the source's wave and is
 * charged one turn there. Otherwise it is charged to the source's container:
 * one counter on the task group of the person's message, shared by every
 * branch of the chain (`budget_json.container_group_id` points at it). Either
 * way a completion turn delegates only from what the container has left —
 * and nothing past a discussion's spend cap.
 */
export async function agentOriginContinuation(
  client: PoolClient,
  spaceId: string,
  sourceGroupId: string,
): Promise<{ discussion: RoomDispatchDiscussion | null; delegation_budget: RoomDelegationBudget }> {
  const source = (await client.query<{ discussion_id: string | null; budget_json: unknown; metadata_json: unknown }>(
    `SELECT grp.discussion_id, grp.budget_json, message.metadata_json
       FROM agent_run_groups grp
       LEFT JOIN messages message ON message.space_id = grp.space_id AND message.id = grp.trigger_message_id
      WHERE grp.space_id = $1 AND grp.id = $2`,
    [spaceId, sourceGroupId],
  )).rows[0];
  if (source?.discussion_id) {
    // Inside the source's discussion whatever its state: a result arriving
    // after it stopped or reached a cap still reports into it, but delegates
    // nothing and opens nothing new — its @-mentions meet the ended
    // discussion and are only named in a notice.
    const wave = record(source.metadata_json).wave;
    const discussion = { id: source.discussion_id, wave: typeof wave === "number" ? wave : 0 };
    const charged = (await client.query<{ turns_used: number; spend_usd: string; spend_cap_usd: string | null }>(
      `UPDATE room_discussions SET turns_used = turns_used + 1, updated_at = GREATEST(updated_at, now())
        WHERE space_id = $1 AND id = $2 AND status = 'active'
        RETURNING turns_used, spend_usd, spend_cap_usd`,
      [spaceId, source.discussion_id],
    )).rows[0];
    if (!charged) return { discussion, delegation_budget: { max_depth: 1, max_fanout: 0 } };
    const spent = charged.spend_cap_usd !== null && Number(charged.spend_usd) >= Number(charged.spend_cap_usd);
    return {
      discussion,
      delegation_budget: spent ? { max_depth: 1, max_fanout: 0 } : delegationBudget(charged.turns_used),
    };
  }
  const containerGroupId = containerGroupOf(sourceGroupId, source?.budget_json);
  const turns = await chargeContainer(client, spaceId, containerGroupId);
  return {
    discussion: null,
    delegation_budget: { ...delegationBudget(turns), container_group_id: containerGroupId },
  };
}

/** The group whose `container_turns_used` counts this group's chain. */
export function containerGroupOf(groupId: string, budgetJson: unknown): string {
  const pointer = record(budgetJson).container_group_id;
  return typeof pointer === "string" && pointer ? pointer : groupId;
}

/** Charge one Agent-triggered turn to a container group; the new count. */
export async function chargeContainer(client: Pick<PoolClient, "query">, spaceId: string, containerGroupId: string): Promise<number> {
  const result = await client.query<{ turns: number }>(
    `UPDATE agent_run_groups
        SET budget_json = COALESCE(budget_json, '{}'::jsonb) || jsonb_build_object(
              'container_turns_used', COALESCE((budget_json->>'container_turns_used')::int, 0) + 1),
            updated_at = now()
      WHERE space_id = $1 AND id = $2
      RETURNING (budget_json->>'container_turns_used')::int AS turns`,
    [spaceId, containerGroupId],
  );
  return result.rows[0]?.turns ?? DISCUSSION_FANOUT_CEILING;
}

async function containerTurns(client: PoolClient, spaceId: string, groupId: string, budgetJson: unknown): Promise<number> {
  const containerGroupId = containerGroupOf(groupId, budgetJson);
  if (containerGroupId === groupId) return containerTurnsUsed(budgetJson);
  const row = (await client.query<{ budget_json: unknown }>(
    `SELECT budget_json FROM agent_run_groups WHERE space_id = $1 AND id = $2`,
    [spaceId, containerGroupId],
  )).rows[0];
  return containerTurnsUsed(row?.budget_json);
}

export function containerTurnsUsed(budgetJson: unknown): number {
  const value = record(budgetJson).container_turns_used;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

interface QuotaExhaustion {
  account_label: string;
  window: "session" | "week";
  resets_at: string | null;
}

/**
 * A Run of the wave the vendor CLI refused for an exhausted subscription
 * (`runs/retryPolicy.ts`), with the login it ran on and when that window
 * resets. A refusal whose window has reset since — the wave's later turns
 * waited it out — ends nothing.
 */
async function quotaExhaustion(client: PoolClient, spaceId: string, groupIds: readonly string[]): Promise<QuotaExhaustion | null> {
  const run = (await client.query<{ id: string; refused_at: unknown }>(
    `SELECT id, updated_at AS refused_at FROM runs
      WHERE space_id = $1 AND run_group_id = ANY($2::varchar[])
        AND status = 'failed' AND error_json->>'error_code' = $3
      ORDER BY updated_at DESC
      LIMIT 1`,
    [spaceId, groupIds, SUBSCRIPTION_QUOTA_EXHAUSTED],
  )).rows[0];
  if (!run) return null;
  const login = await subscriptionLoginOfRun(client, spaceId, run.id);
  if (!login) return { account_label: "The subscription", window: "session", resets_at: null };
  const refusedAt = run.refused_at instanceof Date ? run.refused_at.toISOString() : String(run.refused_at);
  const window = refusedWindow(await cachedQuotaReading(client, login), refusedAt);
  if (!window) return null;
  return { account_label: accountLabel(login), window: window.kind, resets_at: window.resets_at };
}

/** A wave's recipients the vendor CLI refused for an exhausted subscription, to be set working again when rounds are added. */
async function refusedRecipients(client: PoolClient, spaceId: string, groupIds: readonly string[]): Promise<RoomDiscussionHeldMention[]> {
  const rows = (await client.query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id FROM runs
      WHERE space_id = $1 AND run_group_id = ANY($2::varchar[])
        AND status = 'failed' AND error_json->>'error_code' = $3`,
    [spaceId, groupIds, SUBSCRIPTION_QUOTA_EXHAUSTED],
  )).rows;
  return rows.map((row) => ({
    agent_id: row.agent_id,
    from_agent_ids: [],
    content: "Your turn in this discussion was refused because the subscription's usage limit was reached. Take it now.",
  }));
}

function overSpend(discussion: Pick<DiscussionRecord, "spend_cap_usd" | "spend_usd">): boolean {
  return discussion.spend_cap_usd !== null && discussion.spend_usd >= discussion.spend_cap_usd;
}

/**
 * The next wave could not claim the conversation's turn: another turn holds
 * it, or one Agent's host thread is still busy with the Run that just ended.
 */
function isTurnBusyHttpError(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 409
    && /turn|already handling/i.test(error.message);
}

async function lockSession(client: PoolClient, spaceId: string, sessionId: string): Promise<void> {
  await lockRoomConversationQueue(client, spaceId, sessionId);
}

async function requireDiscussion(
  discussions: PgRoomDiscussionRepository,
  spaceId: string,
  roomId: string,
  sessionId: string,
  discussionId: string,
): Promise<DiscussionRecord> {
  const discussion = await discussions.get(spaceId, discussionId, { forUpdate: true });
  if (!discussion || discussion.room_id !== roomId || discussion.session_id !== sessionId) {
    throw new HttpError(404, "Discussion not found in this conversation");
  }
  return discussion;
}

/** Every Run of the group has finished and completed its chat turn. */
async function waveComplete(client: PoolClient, spaceId: string, groupId: string): Promise<boolean> {
  const result = await client.query<{ pending: string }>(
    `SELECT count(*)::text AS pending
       FROM runs run
      WHERE run.space_id = $1 AND run.run_group_id = $2
        AND COALESCE(run.model_override_json->'chat_turn'->>'kind', '') <> 'handoff'
        AND run.model_override_json->'chat_turn' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM run_events event
           WHERE event.space_id = run.space_id AND event.run_id = run.id AND event.event_type = 'chat_completed'
        )`,
    [spaceId, groupId],
  );
  return Number(result.rows[0]?.pending ?? 1) === 0;
}

interface WaveReply {
  id: string;
  role: string;
  sender_agent_id: string | null;
  content: string;
  /** A reply the finalizer wrote for a failed turn, not an answer. */
  failed: boolean;
}

async function waveReplies(client: PoolClient, spaceId: string, groupIds: readonly string[]): Promise<WaveReply[]> {
  const result = await client.query<WaveReply>(
    `SELECT message.id, message.role, message.sender_agent_id, message.content,
            (message.metadata_json ? 'error_code') AS failed
       FROM messages message
       JOIN runs run ON run.space_id = message.space_id AND run.id = message.run_id
      WHERE message.space_id = $1 AND run.run_group_id = ANY($2::varchar[]) AND message.role = 'assistant'
      ORDER BY message.path_depth, message.created_at, message.id`,
    [spaceId, groupIds],
  );
  return result.rows;
}

interface WaveGroup {
  id: string;
  advanced_at: unknown;
  room_id: string | null;
  session_id: string | null;
  trigger_message_id: string | null;
  discussion_id: string | null;
  manager_user_id: string;
  budget_json: unknown;
  wave: number;
  closing: boolean;
  event_key: string | null;
}

async function loadWaveGroup(client: PoolClient, spaceId: string, groupId: string): Promise<WaveGroup | null> {
  const row = (await client.query<Omit<WaveGroup, "wave" | "closing" | "event_key"> & { metadata_json: unknown }>(
    `SELECT grp.id, grp.advanced_at, grp.room_id, grp.session_id, grp.trigger_message_id, grp.discussion_id,
            grp.manager_user_id, grp.budget_json, message.metadata_json
       FROM agent_run_groups grp
       LEFT JOIN messages message ON message.space_id = grp.space_id AND message.id = grp.trigger_message_id
      WHERE grp.space_id = $1 AND grp.id = $2
      FOR UPDATE OF grp`,
    [spaceId, groupId],
  )).rows[0];
  if (!row) return null;
  const metadata = record(row.metadata_json);
  const { metadata_json: _metadata, ...group } = row;
  return {
    ...group,
    wave: typeof metadata.wave === "number" ? metadata.wave : 0,
    closing: metadata.discussion_closing === true,
    event_key: typeof metadata.continuation_event_key === "string" ? metadata.continuation_event_key : null,
  };
}

/** The groups of one wave of a discussion, the dispatching one first; closing turns excluded. */
async function waveGroupIdsOf(client: PoolClient, spaceId: string, discussionId: string, wave: number): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT grp.id
       FROM agent_run_groups grp
       JOIN messages message ON message.space_id = grp.space_id AND message.id = grp.trigger_message_id
      WHERE grp.space_id = $1 AND grp.discussion_id = $2
        AND COALESCE((message.metadata_json->>'wave')::int, 0) = $3
        AND COALESCE((message.metadata_json->>'discussion_closing')::boolean, false) = false
      ORDER BY grp.created_at, grp.id`,
    [spaceId, discussionId, wave],
  );
  return result.rows.map((row) => row.id);
}

async function waveDispatchGroupId(client: PoolClient, spaceId: string, discussionId: string, wave: number): Promise<string | null> {
  return (await waveGroupIdsOf(client, spaceId, discussionId, wave))[0] ?? null;
}

/**
 * The round a wave is, counted from the discussion's latest person's message
 * (its round 1): a person's message restarts the rounds, never the spend.
 */
function roundOf(discussion: Pick<DiscussionRecord, "round_base">, wave: number): number {
  return wave - discussion.round_base + 1;
}

/**
 * Cancel a discussion's closing turn that is still waiting at the
 * subscription reserve line — every Run of its group that has not started
 * (the Manager's turn, and a handoff turn before it), so nothing of it is
 * left holding the conversation — and let go of their host threads (the
 * reconciler finalizes the cancelled Runs).
 */
async function cancelHeldClosing(client: PoolClient, spaceId: string, discussionId: string): Promise<void> {
  const cancelled = await client.query<{ id: string }>(
    `UPDATE runs run
        SET status = 'cancelled', output_json = run.output_json - 'waiting_for_quota' - 'waiting_for_turn',
            ended_at = now(), updated_at = now()
       FROM agent_run_groups grp
       JOIN messages trigger ON trigger.space_id = grp.space_id AND trigger.id = grp.trigger_message_id
      WHERE run.space_id = $1 AND run.run_group_id = grp.id AND grp.discussion_id = $2
        AND trigger.metadata_json->>'discussion_closing' = 'true'
        AND run.status IN ('queued', 'waiting_for_dependency')
        AND EXISTS (
          SELECT 1 FROM runs held
           WHERE held.space_id = grp.space_id AND held.run_group_id = grp.id AND held.status = 'queued'
             AND (held.output_json ? 'waiting_for_quota' OR held.output_json ? 'waiting_for_turn')
        )
      RETURNING run.id, run.host_task_thread_id`,
    [spaceId, discussionId],
  );
  if (cancelled.rows.length === 0) return;
  await client.query(
    `UPDATE host_threads SET dispatch_lock_id = NULL, updated_at = now()
      WHERE dispatch_lock_id = ANY($1::varchar[])`,
    [cancelled.rows.map((row) => row.id)],
  );
}

/** The closing turn a discussion is waiting for: one per time it ends. */
function closingKey(discussion: Pick<DiscussionRecord, "id" | "rounds_used">): string {
  return `${discussion.id}:closing:${discussion.rounds_used}`;
}

async function hasClosingTurn(client: PoolClient, spaceId: string, discussion: DiscussionRecord): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM messages
      WHERE space_id = $1 AND discussion_id = $2
        AND metadata_json->>'continuation_event_kind' = 'agent_discussion_closing'
        AND metadata_json->>'continuation_event_key' = $3
      LIMIT 1`,
    [spaceId, discussion.id, closingKey(discussion)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Agents addressed by a wave's replies, each with who addressed it and what they said. */
function addressedTargets(replies: WaveReply[], roster: RoomAgentMemberRecord[]): RoomDiscussionHeldMention[] {
  const entries = roster.map((member) => ({ agent_id: member.agent_id, label: member.agent_name }));
  const targets = new Map<string, RoomDiscussionHeldMention>();
  for (const reply of replies) {
    if (!reply.sender_agent_id || reply.failed) continue;
    const parsed = parseAgentMentions(reply.content, entries);
    for (const segment of parsed.segments) {
      for (const agentId of segment.recipient_agent_ids) {
        if (agentId === reply.sender_agent_id) continue;
        const target: RoomDiscussionHeldMention = targets.get(agentId) ?? { agent_id: agentId, from_agent_ids: [], content: "" };
        if (!target.from_agent_ids.includes(reply.sender_agent_id)) target.from_agent_ids.push(reply.sender_agent_id);
        const said = `${agentName(roster, reply.sender_agent_id)}: ${segment.content || reply.content}`;
        target.content = target.content ? `${target.content}\n\n${said}` : said;
        targets.set(agentId, target);
      }
    }
  }
  return [...targets.values()];
}

/**
 * In a debate every participant takes every round, and is handed every
 * answer of the round before: a participant's own window starts after its
 * own last reply, so without this it would never see the answers given
 * before it in that round.
 */
function critiqueTargets(
  discussion: DiscussionRecord,
  roster: RoomAgentMemberRecord[],
  replies: WaveReply[],
): RoomDiscussionHeldMention[] {
  const active = new Set(roster.map((member) => member.agent_id));
  const answers = replies
    .filter((reply) => reply.sender_agent_id && !reply.failed)
    .map((reply) => `${agentName(roster, reply.sender_agent_id!)}: ${reply.content}`)
    .join("\n\n");
  return discussion.participant_agent_ids
    .filter((agentId) => active.has(agentId))
    .map((agentId) => ({ agent_id: agentId, from_agent_ids: [], content: answers }));
}

/**
 * Why the container's owner could not trigger this Agent directly: an
 * owner-only specialist on someone else's machine, or a private Agent not
 * shared with them in this Room. Such an Agent gets a notice, never a Run.
 */
async function triggerRefusal(
  client: PoolClient,
  discussion: DiscussionRecord,
  roster: RoomAgentMemberRecord[],
  agentId: string,
): Promise<string | null> {
  const member = roster.find((entry) => entry.agent_id === agentId);
  if (!member) return "it is not an active Agent of this Room";
  // The visibility the dispatcher itself applies when it opens the wave's
  // task group — one authority, not a second description of it.
  const visible = await new PgAgentGroupRepository(client)
    .listAgentStatuses(discussion.space_id, discussion.opened_by_user_id, [agentId], discussion.room_id);
  if (!visible.some((row) => row.id === agentId)) {
    return "it is a private Agent not shared with the person whose message started this";
  }
  const host = (await client.query<{ kind: string; owner_user_id: string | null }>(
    `SELECT host.kind, host.owner_user_id
       FROM host_threads thread
       JOIN hosts host ON host.id = thread.execution_host_id
      WHERE thread.space_id = $1 AND thread.session_id = $2 AND thread.agent_id = $3
        AND thread.container_kind = 'conversation' AND thread.status IN ('active', 'session_reset')
      LIMIT 1`,
    [discussion.space_id, discussion.session_id, agentId],
  )).rows[0];
  if (host?.kind === "remote" && host.owner_user_id !== discussion.opened_by_user_id) {
    return "it runs on its owner's own machine and only its owner can set it working";
  }
  return null;
}

async function listNonResponders(
  client: PoolClient,
  discussion: DiscussionRecord,
  roster: RoomAgentMemberRecord[],
): Promise<Array<{ agent_name: string; reason: string }>> {
  const replied = new Set((await client.query<{ sender_agent_id: string }>(
    `SELECT DISTINCT sender_agent_id FROM messages
      WHERE space_id = $1 AND discussion_id = $2 AND role = 'assistant' AND sender_agent_id IS NOT NULL
        AND NOT (metadata_json ? 'error_code')`,
    [discussion.space_id, discussion.id],
  )).rows.map((row) => row.sender_agent_id));
  const notices = (await client.query<{ metadata_json: unknown }>(
    `SELECT metadata_json FROM messages
      WHERE space_id = $1 AND discussion_id = $2 AND metadata_json->'discussion_notice'->>'kind' = 'not_admitted'`,
    [discussion.space_id, discussion.id],
  )).rows.map((row) => record(record(row.metadata_json).discussion_notice));
  const reasons = new Map<string, string>();
  for (const notice of notices) {
    const ids = Array.isArray(notice.agent_ids) ? notice.agent_ids as string[] : [];
    for (const id of ids) reasons.set(id, String(notice.reason ?? "it could not be triggered"));
  }
  return discussion.participant_agent_ids
    .filter((agentId) => !replied.has(agentId))
    .map((agentId) => ({
      agent_name: agentName(roster, agentId),
      reason: reasons.get(agentId) ?? (discussion.held_mentions.some((held) => held.agent_id === agentId)
        ? "it was addressed after the discussion stopped"
        : "its turn failed or produced no reply"),
    }));
}

function mergeHeld(current: RoomDiscussionHeldMention[], next: RoomDiscussionHeldMention[]): RoomDiscussionHeldMention[] {
  const merged = new Map(current.map((held) => [held.agent_id, { ...held, from_agent_ids: [...held.from_agent_ids] }]));
  for (const held of next) {
    const existing = merged.get(held.agent_id);
    if (!existing) {
      merged.set(held.agent_id, { ...held, from_agent_ids: [...held.from_agent_ids] });
      continue;
    }
    existing.from_agent_ids = [...new Set([...existing.from_agent_ids, ...held.from_agent_ids])];
    existing.content = [existing.content, held.content].filter(Boolean).join("\n\n");
  }
  return [...merged.values()];
}

function firstRoundInstruction(topic: string, shape: "open" | "debate", roundCap: number): string {
  return [
    topic,
    shape === "debate"
      ? `[Debate · round 1 of ${roundCap}] Answer the person's topic directly with your own position and reasoning. Other participants' answers are withheld this round. Do not @-address or ask another Agent to respond; every participant already has a turn. Later rounds will share everyone's answers for critique.`
      : `[Discussion · round 1 of ${roundCap}] Answer, and address another Agent with @Name only when you need their answer. A round in which nobody addresses anyone ends the discussion, and the Room's Manager then writes the conclusion.`,
  ].join("\n\n");
}

function waveInstruction(
  round: number,
  roundCap: number,
  target: RoomDiscussionHeldMention,
  roster: RoomAgentMemberRecord[],
): string {
  const from = target.from_agent_ids.map((id) => agentName(roster, id)).join(", ") || "Another Agent";
  return [
    `[Discussion · round ${round} of ${roundCap}] ${from} addressed you:`,
    target.content,
    "Reply to them. Address another Agent with @Name only when you need their answer; a round in which nobody addresses anyone ends the discussion, and the Room's Manager then writes the conclusion.",
  ].filter(Boolean).join("\n\n");
}

function critiqueInstruction(round: number, roundCap: number, answers: string): string {
  return [
    `[Debate · round ${round} of ${roundCap}] The answers of the last round:`,
    answers || "(no answers were given)",
    "Compare the positions for the person: where you agree, where you disagree and why, and what you would change in your own answer. Do not @-address or ask another Agent to respond; the system sends each round to every participant.",
  ].join("\n\n");
}

function capNoticeText(discussion: DiscussionRecord, reason: string | null, names: string[], quota: QuotaExhaustion | null = null): string {
  const waiting = names.length > 0 ? ` ${names.join(", ")} ${names.length === 1 ? "was" : "were"} addressed and will take part if it continues.` : "";
  if (reason === "spend_cap") return `The discussion reached its spend cap.${waiting}`;
  if (reason === "quota_exhausted") {
    const resets = quota?.resets_at ? ` The window resets ${quota.resets_at.slice(11, 16)} UTC${quota.window === "week" ? ` on ${quota.resets_at.slice(0, 10)}` : ""}.` : "";
    return `${quota?.account_label ?? "The subscription"} refused: its usage limit is reached.${resets}${waiting}`;
  }
  if (reason === "fanout_budget") return `This turn's budget of Agent-triggered turns is spent.${waiting} Open a discussion to let them take part.`;
  return discussion.kind === "emergent"
    ? `The Agents want to keep talking.${waiting} Open a discussion to give them rounds of their own.`
    : `Round cap reached (${discussion.rounds_used - discussion.round_base} of ${discussion.round_cap}).${waiting}`;
}

function agentName(roster: RoomAgentMemberRecord[], agentId: string | undefined): string {
  if (!agentId) return "An Agent";
  return roster.find((member) => member.agent_id === agentId)?.agent_name ?? agentId;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
