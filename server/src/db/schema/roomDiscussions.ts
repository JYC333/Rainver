import {
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { rooms } from "./rooms.js";
import { messages, sessions } from "./sessions.js";
import { spaces } from "./spaces.js";

/**
 * A bounded discussion among the Agents of one Room conversation
 * (`modules/rooms.md`, "Discussions"). The messages and task groups it spans
 * carry `discussion_id`; this row holds its container, caps and state.
 *
 * `opened_by_user_id` is the container's owner: every Agent-triggered turn in
 * the discussion executes as that person, with exactly the authority they
 * would have addressing that Agent directly (B8A). `held_mentions` keeps the
 * Agents addressed when a cap stopped the next wave, so adding rounds can
 * dispatch them. At most one discussion per conversation is active or
 * waiting at its cap.
 */
export const roomDiscussions = pgTable("room_discussions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	roomId: varchar("room_id", { length: 36 }).notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	openedByUserId: varchar("opened_by_user_id", { length: 36 }).notNull(),
	originMessageId: varchar("origin_message_id", { length: 36 }).notNull(),
	kind: varchar({ length: 16 }).notNull(),
	shape: varchar({ length: 16 }).notNull().default("open"),
	topic: text(),
	participantAgentIds: jsonb("participant_agent_ids").default([]).notNull(),
	roundCap: integer("round_cap").notNull(),
	roundsUsed: integer("rounds_used").default(0).notNull(),
	// The wave of the latest person's message in the discussion: the round
	// cap counts from it (a person's message restarts the rounds, never the
	// spend).
	roundBase: integer("round_base").default(0).notNull(),
	turnsUsed: integer("turns_used").default(0).notNull(),
	spendCapUsd: numeric("spend_cap_usd", { precision: 12, scale: 4 }),
	spendUsd: numeric("spend_usd", { precision: 18, scale: 8 }).default("0").notNull(),
	status: varchar({ length: 16 }).notNull().default("active"),
	stopReason: text("stop_reason"),
	heldMentionsJson: jsonb("held_mentions_json").default([]).notNull(),
	// Who added rounds, when, and how many — the record a person asked for
	// more spend under their own name.
	extensionsJson: jsonb("extensions_json").default([]).notNull(),
	conclusionMessageId: varchar("conclusion_message_id", { length: 36 }),
	// A person who chose to continue past the subscription reserve line for
	// this discussion's Agent-triggered turns, and when.
	quotaOverrideByUserId: varchar("quota_override_by_user_id", { length: 36 }),
	quotaOverrideAt: timestamp("quota_override_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_room_discussions_session").on(table.spaceId, table.sessionId, table.createdAt),
	uniqueIndex("uq_room_discussions_session_open")
		.on(table.sessionId)
		.where(sql`status IN ('active', 'cap_reached')`),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "room_discussions_space_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.roomId],
		foreignColumns: [rooms.id],
		name: "room_discussions_room_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.sessionId, table.spaceId],
		foreignColumns: [sessions.id, sessions.spaceId],
		name: "room_discussions_session_scope_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.openedByUserId],
		foreignColumns: [users.id],
		name: "room_discussions_opened_by_user_id_fkey",
	}),
	foreignKey({
		columns: [table.originMessageId],
		foreignColumns: [messages.id],
		name: "room_discussions_origin_message_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.conclusionMessageId],
		foreignColumns: [messages.id],
		name: "room_discussions_conclusion_message_id_fkey",
	}).onDelete("set null"),
	check("ck_room_discussions_kind", sql`kind IN ('emergent', 'explicit')`),
	check("ck_room_discussions_shape", sql`shape IN ('open', 'debate')`),
	check("ck_room_discussions_status", sql`status IN ('active', 'converged', 'cap_reached', 'stopped', 'closed')`),
	check("ck_room_discussions_caps", sql`round_cap > 0 AND rounds_used >= 0 AND round_base >= 0 AND turns_used >= 0 AND (spend_cap_usd IS NULL OR spend_cap_usd > 0) AND spend_usd >= 0`),
	check("ck_room_discussions_arrays", sql`jsonb_typeof(participant_agent_ids) = 'array' AND jsonb_typeof(held_mentions_json) = 'array' AND jsonb_typeof(extensions_json) = 'array'`),
]);

/**
 * A person's message sent while the conversation's turn was taken. It waits
 * here — outside the message tree, so no prompt, replay or summary sees it —
 * and is posted as an ordinary message at the next turn boundary
 * (`rooms/messageQueue.ts`). Released and withdrawn rows are kept as the
 * record of what happened to it.
 */
export const roomQueuedMessages = pgTable("room_queued_messages", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	roomId: varchar("room_id", { length: 36 }).notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	content: text().notNull(),
	// The send request as it was made: routing, recipient segments, backends,
	// focus. Replayed exactly when the message is released.
	requestJson: jsonb("request_json").default({}).notNull(),
	status: varchar({ length: 16 }).notNull().default("queued"),
	releasedMessageId: varchar("released_message_id", { length: 36 }),
	failureReason: text("failure_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_room_queued_messages_session").on(table.spaceId, table.sessionId, table.createdAt)
		.where(sql`status = 'queued'`),
	foreignKey({
		columns: [table.sessionId, table.spaceId],
		foreignColumns: [sessions.id, sessions.spaceId],
		name: "room_queued_messages_session_scope_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.roomId],
		foreignColumns: [rooms.id],
		name: "room_queued_messages_room_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.userId],
		foreignColumns: [users.id],
		name: "room_queued_messages_user_id_fkey",
	}),
	foreignKey({
		columns: [table.releasedMessageId],
		foreignColumns: [messages.id],
		name: "room_queued_messages_released_message_id_fkey",
	}).onDelete("set null"),
	check("ck_room_queued_messages_status", sql`status IN ('queued', 'released', 'withdrawn', 'failed')`),
	check("ck_room_queued_messages_request", sql`jsonb_typeof(request_json) = 'object'`),
]);
