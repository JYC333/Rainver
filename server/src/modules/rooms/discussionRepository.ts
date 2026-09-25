import { randomUUID } from "node:crypto";
import type {
  RoomDiscussion,
  RoomDiscussionDetail,
  RoomDiscussionHeldMention,
  RoomDiscussionKind,
  RoomDiscussionShape,
  RoomDiscussionStatus,
} from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { discussionSubscriptionUsage } from "./subscriptionLogins.js";

/**
 * Storage for Room discussions (`db/schema/roomDiscussions.ts`). Owns the row
 * and the `discussion_id` stamps on the messages and task groups it spans;
 * what a discussion does next is `discussionService.ts`'s.
 */
interface DiscussionRow {
  id: string;
  space_id: string;
  room_id: string;
  session_id: string;
  opened_by_user_id: string;
  origin_message_id: string;
  kind: RoomDiscussionKind;
  shape: RoomDiscussionShape;
  topic: string | null;
  participant_agent_ids: unknown;
  round_cap: number;
  rounds_used: number;
  round_base: number;
  turns_used: number;
  spend_cap_usd: string | number | null;
  spend_usd: string | number;
  status: RoomDiscussionStatus;
  stop_reason: string | null;
  held_mentions_json: unknown;
  conclusion_message_id: string | null;
  quota_override_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const COLUMNS = `id, space_id, room_id, session_id, opened_by_user_id, origin_message_id, kind, shape,
  topic, participant_agent_ids, round_cap, rounds_used, round_base, turns_used, spend_cap_usd, spend_usd,
  status, stop_reason, held_mentions_json, conclusion_message_id, quota_override_by_user_id, created_at, updated_at`;

export type DiscussionRecord = RoomDiscussion & { space_id: string };

export class PgRoomDiscussionRepository {
  constructor(private readonly db: Queryable) {}

  async insert(input: {
    spaceId: string;
    roomId: string;
    sessionId: string;
    openedByUserId: string;
    originMessageId: string;
    kind: RoomDiscussionKind;
    shape: RoomDiscussionShape;
    topic: string | null;
    participantAgentIds: string[];
    roundCap: number;
    roundsUsed: number;
    turnsUsed: number;
    spendCapUsd: number | null;
  }): Promise<DiscussionRecord> {
    const now = new Date().toISOString();
    const result = await this.db.query<DiscussionRow>(
      `INSERT INTO room_discussions (
         id, space_id, room_id, session_id, opened_by_user_id, origin_message_id, kind, shape, topic,
         participant_agent_ids, round_cap, rounds_used, turns_used, spend_cap_usd, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,'active',$15,$15)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(), input.spaceId, input.roomId, input.sessionId, input.openedByUserId, input.originMessageId,
        input.kind, input.shape, input.topic, JSON.stringify(input.participantAgentIds), input.roundCap,
        input.roundsUsed, input.turnsUsed, input.spendCapUsd, now,
      ],
    );
    return toRecord(result.rows[0]!);
  }

  async get(spaceId: string, id: string, options: { forUpdate?: boolean } = {}): Promise<DiscussionRecord | null> {
    const result = await this.db.query<DiscussionRow>(
      `SELECT ${COLUMNS} FROM room_discussions WHERE space_id = $1 AND id = $2${options.forUpdate ? " FOR UPDATE" : ""}`,
      [spaceId, id],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  /** The conversation's discussion that is running or waiting at its cap, if any. */
  async getOpenForSession(spaceId: string, sessionId: string, options: { forUpdate?: boolean } = {}): Promise<DiscussionRecord | null> {
    const result = await this.db.query<DiscussionRow>(
      `SELECT ${COLUMNS} FROM room_discussions
        WHERE space_id = $1 AND session_id = $2 AND status IN ('active', 'cap_reached')
        LIMIT 1${options.forUpdate ? " FOR UPDATE" : ""}`,
      [spaceId, sessionId],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listForSession(spaceId: string, sessionId: string): Promise<DiscussionRecord[]> {
    const result = await this.db.query<DiscussionRow>(
      `SELECT ${COLUMNS} FROM room_discussions
        WHERE space_id = $1 AND session_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
      [spaceId, sessionId],
    );
    return result.rows.map(toRecord);
  }

  async update(spaceId: string, id: string, patch: {
    kind?: RoomDiscussionKind;
    status?: RoomDiscussionStatus;
    stopReason?: string | null;
    roundCap?: number;
    roundsUsed?: number;
    roundBase?: number;
    turnsUsed?: number;
    spendUsd?: number;
    participantAgentIds?: string[];
    heldMentions?: RoomDiscussionHeldMention[];
    conclusionMessageId?: string | null;
    extension?: { user_id: string; rounds: number };
  }): Promise<DiscussionRecord> {
    const result = await this.db.query<DiscussionRow>(
      `UPDATE room_discussions
          SET kind = COALESCE($3, kind),
              status = COALESCE($4, status),
              stop_reason = CASE WHEN $5::boolean THEN $6 ELSE stop_reason END,
              round_cap = COALESCE($7, round_cap),
              rounds_used = COALESCE($8, rounds_used),
              turns_used = COALESCE($9, turns_used),
              spend_usd = COALESCE($10, spend_usd),
              participant_agent_ids = COALESCE($11::jsonb, participant_agent_ids),
              held_mentions_json = COALESCE($12::jsonb, held_mentions_json),
              conclusion_message_id = CASE WHEN $13::boolean THEN $14 ELSE conclusion_message_id END,
              extensions_json = CASE WHEN $15::jsonb IS NULL THEN extensions_json
                ELSE extensions_json || jsonb_build_array($15::jsonb || jsonb_build_object('at', now())) END,
              round_base = COALESCE($16, round_base),
              -- Never behind a notice this transaction already wrote.
              updated_at = GREATEST(updated_at, now())
        WHERE space_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      [
        spaceId, id,
        patch.kind ?? null,
        patch.status ?? null,
        patch.stopReason !== undefined, patch.stopReason ?? null,
        patch.roundCap ?? null,
        patch.roundsUsed ?? null,
        patch.turnsUsed ?? null,
        patch.spendUsd ?? null,
        patch.participantAgentIds ? JSON.stringify(patch.participantAgentIds) : null,
        patch.heldMentions ? JSON.stringify(patch.heldMentions) : null,
        patch.conclusionMessageId !== undefined, patch.conclusionMessageId ?? null,
        patch.extension ? JSON.stringify(patch.extension) : null,
        patch.roundBase ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Room discussion ${id} disappeared while updating`);
    return toRecord(row);
  }

  /** Put messages into a discussion, recording the wave each belongs to. */
  async stampMessages(input: { spaceId: string; sessionId: string; discussionId: string; wave: number; messageIds: string[] }): Promise<void> {
    if (input.messageIds.length === 0) return;
    await this.db.query(
      `UPDATE messages
          SET discussion_id = $3,
              metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('wave', $4::int)
        WHERE space_id = $1 AND session_id = $2 AND id = ANY($5::varchar[])`,
      [input.spaceId, input.sessionId, input.discussionId, input.wave, input.messageIds],
    );
  }

  async stampGroup(spaceId: string, groupId: string, discussionId: string): Promise<void> {
    await this.db.query(
      `UPDATE agent_run_groups SET discussion_id = $3, updated_at = now() WHERE space_id = $1 AND id = $2`,
      [spaceId, groupId, discussionId],
    );
  }

  /** What priced Runs of this discussion cost: the spend its cap bounds. */
  async pricedUsd(spaceId: string, discussionId: string): Promise<number> {
    const result = await this.db.query<{ priced_usd: string | null }>(
      `SELECT COALESCE(sum(event.estimated_cost_usd) FILTER (WHERE event.cost_accuracy = 'catalog'), 0)::text AS priced_usd
         FROM token_usage_events event
         JOIN runs run ON run.space_id = event.space_id AND run.id = event.run_id
         JOIN agent_run_groups grp ON grp.space_id = run.space_id AND grp.id = run.run_group_id
        WHERE event.space_id = $1 AND grp.discussion_id = $2`,
      [spaceId, discussionId],
    );
    return Number(result.rows[0]?.priced_usd ?? 0);
  }

  /**
   * The discussion's cost lines, one per funding source:
   * money on priced Runs, and per subscription login its tokens here with the
   * account's latest window.
   */
  async usage(spaceId: string, discussionId: string): Promise<RoomDiscussionDetail["usage"]> {
    return {
      priced_usd: await this.pricedUsd(spaceId, discussionId),
      subscription: await discussionSubscriptionUsage(this.db, spaceId, discussionId),
    };
  }
}

function toRecord(row: DiscussionRow): DiscussionRecord {
  return {
    id: row.id,
    space_id: row.space_id,
    room_id: row.room_id,
    session_id: row.session_id,
    kind: row.kind,
    shape: row.shape,
    status: row.status,
    stop_reason: row.stop_reason,
    topic: row.topic,
    opened_by_user_id: row.opened_by_user_id,
    origin_message_id: row.origin_message_id,
    participant_agent_ids: stringArray(row.participant_agent_ids),
    round_cap: row.round_cap,
    rounds_used: row.rounds_used,
    round_base: row.round_base,
    turns_used: row.turns_used,
    spend_cap_usd: row.spend_cap_usd === null ? null : Number(row.spend_cap_usd),
    spend_usd: Number(row.spend_usd),
    held_mentions: Array.isArray(row.held_mentions_json) ? row.held_mentions_json as RoomDiscussionHeldMention[] : [],
    conclusion_message_id: row.conclusion_message_id,
    quota_override_by_user_id: row.quota_override_by_user_id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** The API shape: everything but the Space, which the route already scoped. */
export function discussionOut(record: DiscussionRecord): RoomDiscussion {
  const { space_id: _space, ...discussion } = record;
  return discussion;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
