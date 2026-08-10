import { pgTable, index, uniqueIndex, check, foreignKey, varchar, text, integer, doublePrecision, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { retrievalObjectType, tsVector, pgVector } from "./_types";
import { users } from "./auth";
import { spaces } from "./spaces";

export const retrievalObjects = pgTable("retrieval_objects", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	objectType: retrievalObjectType("object_type").notNull(),
	objectId: varchar("object_id", { length: 36 }).notNull(),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	visibility: varchar({ length: 32 }),
	accessLevel: varchar("access_level", { length: 16 }),
	status: varchar({ length: 32 }).notNull(),
	title: varchar({ length: 512 }).notNull(),
	slug: varchar({ length: 512 }),
	objectProfile: varchar("object_profile", { length: 64 }),
	contentHash: varchar("content_hash", { length: 64 }).notNull(),
	sourceConnectionIdsJson: jsonb("source_connection_ids_json").default([]).notNull(),
	indexedAt: timestamp("indexed_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_retrieval_objects_object").using("btree", table.objectType.asc().nullsLast(), table.objectId.asc().nullsLast()),
	index("ix_retrieval_objects_source_connections").using("gin", table.sourceConnectionIdsJson.asc().nullsLast()),
	index("ix_retrieval_objects_space_id").using("btree", table.spaceId.asc().nullsLast()),
	uniqueIndex("ix_retrieval_objects_space_object_unique").using("btree", table.spaceId.asc().nullsLast(), table.objectType.asc().nullsLast(), table.objectId.asc().nullsLast()),
	index("ix_retrieval_objects_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "retrieval_objects_space_id_fkey"
		}),
	check("ck_retrieval_objects_source_connections_array", sql`jsonb_typeof(source_connection_ids_json) = 'array'::text`),
	check("ck_retrieval_objects_visibility", sql`visibility IS NULL OR visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_retrieval_objects_access_level", sql`access_level IS NULL OR access_level IN ('full', 'summary')`),
]);

export const retrievalAliases = pgTable("retrieval_aliases", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	retrievalObjectId: varchar("retrieval_object_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	objectType: retrievalObjectType("object_type").notNull(),
	objectId: varchar("object_id", { length: 36 }).notNull(),
	alias: text().notNull(),
	normalizedAlias: text("normalized_alias").notNull(),
	aliasKind: varchar("alias_kind", { length: 32 }).notNull(),
	confidence: doublePrecision().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_retrieval_aliases_normalized_alias").using("btree", table.normalizedAlias.asc().nullsLast()),
	index("ix_retrieval_aliases_object").using("btree", table.objectType.asc().nullsLast(), table.objectId.asc().nullsLast()),
	index("ix_retrieval_aliases_space_id").using("btree", table.spaceId.asc().nullsLast()),
	uniqueIndex("ix_retrieval_aliases_unique").using("btree", table.spaceId.asc().nullsLast(), table.objectType.asc().nullsLast(), table.objectId.asc().nullsLast(), table.normalizedAlias.asc().nullsLast(), table.aliasKind.asc().nullsLast()),
	foreignKey({
			columns: [table.retrievalObjectId],
			foreignColumns: [retrievalObjects.id],
			name: "retrieval_aliases_retrieval_object_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "retrieval_aliases_space_id_fkey"
		}),
	check("ck_retrieval_aliases_confidence", sql`(confidence >= (0)::double precision) AND (confidence <= (1)::double precision)`),
]);

export const retrievalChunks = pgTable("retrieval_chunks", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	retrievalObjectId: varchar("retrieval_object_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	objectType: retrievalObjectType("object_type").notNull(),
	objectId: varchar("object_id", { length: 36 }).notNull(),
	chunkIndex: integer("chunk_index").notNull(),
	plainText: text("plain_text").notNull(),
	tsv: tsVector("tsv"),
	contentHash: varchar("content_hash", { length: 64 }).notNull(),
	embedding: pgVector("embedding"),
	embeddingModel: varchar("embedding_model", { length: 128 }),
	embeddingDimensions: integer("embedding_dimensions"),
	embeddingGeneratedAt: timestamp("embedding_generated_at", { withTimezone: true, mode: 'string' }),
	embeddingClaimId: varchar("embedding_claim_id", { length: 64 }),
	embeddingClaimedAt: timestamp("embedding_claimed_at", { withTimezone: true, mode: 'string' }),
	embeddingAttempts: integer("embedding_attempts").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_retrieval_chunks_embedding_filter").using("btree", table.spaceId.asc().nullsLast(), table.objectType.asc().nullsLast(), table.embeddingDimensions.asc().nullsLast()).where(sql`(embedding IS NOT NULL)`),
	// drizzle-kit's introspection drops the operator class for raw-expression
	// index elements; halfvec has no default opclass for hnsw, so it must be
	// explicit here or CREATE INDEX fails outright (verified against a live
	// container).
	index("ix_retrieval_chunks_embedding_hnsw_2560").using("hnsw", sql`(embedding::halfvec(2560)) halfvec_cosine_ops`).where(sql`((embedding IS NOT NULL) AND (embedding_dimensions = 2560))`),
	index("ix_retrieval_chunks_embedding_pending").using("btree", table.spaceId.asc().nullsLast(), table.embeddingClaimedAt.asc().nullsLast(), table.createdAt.asc().nullsLast(), table.id.asc().nullsLast()).where(sql`(embedding IS NULL)`),
	index("ix_retrieval_chunks_object").using("btree", table.objectType.asc().nullsLast(), table.objectId.asc().nullsLast()),
	uniqueIndex("ix_retrieval_chunks_object_chunk_unique").using("btree", table.retrievalObjectId.asc().nullsLast(), table.chunkIndex.asc().nullsLast()),
	index("ix_retrieval_chunks_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_retrieval_chunks_tsv").using("gin", table.tsv.asc().nullsLast()),
	foreignKey({
			columns: [table.retrievalObjectId],
			foreignColumns: [retrievalObjects.id],
			name: "retrieval_chunks_retrieval_object_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "retrieval_chunks_space_id_fkey"
		}),
	check("ck_retrieval_chunks_embedding_dimensions", sql`((embedding IS NULL) AND (embedding_dimensions IS NULL)) OR ((embedding IS NOT NULL) AND (embedding_dimensions = vector_dims(embedding)) AND (embedding_dimensions >= 1) AND (embedding_dimensions <= 4096))`),
]);

export const retrievalEdges = pgTable("retrieval_edges", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	fromObjectType: retrievalObjectType("from_object_type").notNull(),
	fromObjectId: varchar("from_object_id", { length: 36 }).notNull(),
	toObjectType: retrievalObjectType("to_object_type").notNull(),
	toObjectId: varchar("to_object_id", { length: 36 }).notNull(),
	linkType: varchar("link_type", { length: 64 }).notNull(),
	edgeOrigin: varchar("edge_origin", { length: 64 }).notNull(),
	edgeStatus: varchar("edge_status", { length: 32 }).notNull(),
	confidence: doublePrecision().notNull(),
	evidenceJson: jsonb("evidence_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_retrieval_edges_from").using("btree", table.fromObjectType.asc().nullsLast(), table.fromObjectId.asc().nullsLast()),
	index("ix_retrieval_edges_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_retrieval_edges_to").using("btree", table.toObjectType.asc().nullsLast(), table.toObjectId.asc().nullsLast()),
	uniqueIndex("ix_retrieval_edges_unique").using("btree", table.spaceId.asc().nullsLast(), table.fromObjectType.asc().nullsLast(), table.fromObjectId.asc().nullsLast(), table.toObjectType.asc().nullsLast(), table.toObjectId.asc().nullsLast(), table.linkType.asc().nullsLast(), table.edgeOrigin.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "retrieval_edges_space_id_fkey"
		}),
	check("ck_retrieval_edges_confidence", sql`(confidence >= (0)::double precision) AND (confidence <= (1)::double precision)`),
	check("ck_retrieval_edges_status", sql`(edge_status)::text = ANY (ARRAY[('derived'::character varying)::text, ('suggested'::character varying)::text])`),
]);

export const retrievalFeedbackEvents = pgTable("retrieval_feedback_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	actorUserId: varchar("actor_user_id", { length: 36 }).notNull(),
	surface: varchar({ length: 64 }).notNull(),
	queryHash: varchar("query_hash", { length: 64 }).notNull(),
	objectType: retrievalObjectType("object_type").notNull(),
	objectId: varchar("object_id", { length: 36 }).notNull(),
	signalType: varchar("signal_type", { length: 32 }).notNull(),
	dwellMs: integer("dwell_ms"),
	metadataJson: jsonb("metadata_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_retrieval_feedback_events_lookup").using("btree", table.spaceId.asc().nullsLast(), table.actorUserId.asc().nullsLast(), table.surface.asc().nullsLast(), table.queryHash.asc().nullsLast(), table.objectType.asc().nullsLast(), table.objectId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_retrieval_feedback_events_object").using("btree", table.spaceId.asc().nullsLast(), table.objectType.asc().nullsLast(), table.objectId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_retrieval_feedback_events_space_created").using("btree", table.spaceId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	foreignKey({
			columns: [table.actorUserId],
			foreignColumns: [users.id],
			name: "retrieval_feedback_events_actor_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "retrieval_feedback_events_space_id_fkey"
		}),
	check("ck_retrieval_feedback_events_dwell_ms", sql`(dwell_ms IS NULL) OR (dwell_ms >= 0)`),
	check("ck_retrieval_feedback_events_signal_type", sql`(signal_type)::text = ANY (ARRAY[('opened'::character varying)::text, ('dwell'::character varying)::text, ('used'::character varying)::text, ('explicit_relevant'::character varying)::text, ('accepted'::character varying)::text, ('pinned'::character varying)::text])`),
]);
