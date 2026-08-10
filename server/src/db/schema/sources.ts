import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, doublePrecision, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./auth";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { artifacts } from "./artifacts";
import { proposals } from "./proposals";
import { projects } from "./projects";
import { credentials } from "./providers";
import { sourceProviderConnectors } from "./sourceCatalog";

export const extractionJobs = pgTable("extraction_jobs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	connectionId: varchar("connection_id", { length: 36 }),
	sourceItemId: varchar("source_item_id", { length: 36 }),
	sourceSnapshotId: varchar("source_snapshot_id", { length: 36 }),
	// Capture origin only. Materialized Knowledge References live in the
	// FK-backed source_item_references bridge.
	sourceObjectType: varchar("source_object_type", { length: 64 }),
	sourceObjectId: varchar("source_object_id", { length: 36 }),
	jobType: varchar("job_type", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	itemsSeen: integer("items_seen"),
	itemsCreated: integer("items_created"),
	itemsUpdated: integer("items_updated"),
	errorCode: varchar("error_code", { length: 64 }),
	errorMessage: varchar("error_message", { length: 512 }),
	metadataJson: jsonb("metadata_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_extraction_jobs_connection_id").using("btree", table.connectionId.asc().nullsLast()),
	index("ix_extraction_jobs_source_item_id").using("btree", table.sourceItemId.asc().nullsLast()),
	index("ix_extraction_jobs_source_object").using("btree", table.spaceId.asc().nullsLast(), table.sourceObjectType.asc().nullsLast(), table.sourceObjectId.asc().nullsLast()),
	index("ix_extraction_jobs_source_object_id").using("btree", table.sourceObjectId.asc().nullsLast()),
	index("ix_extraction_jobs_source_object_type").using("btree", table.sourceObjectType.asc().nullsLast()),
	index("ix_extraction_jobs_source_snapshot_id").using("btree", table.sourceSnapshotId.asc().nullsLast()),
	index("ix_extraction_jobs_space_created").using("btree", table.spaceId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_extraction_jobs_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_extraction_jobs_space_status").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_extraction_jobs_status").using("btree", table.status.asc().nullsLast()),
	unique("uq_extraction_jobs_id_space_id").on(table.id, table.spaceId),
	foreignKey({
			columns: [table.connectionId],
			foreignColumns: [sourceConnections.id],
			name: "extraction_jobs_connection_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceItemId],
			foreignColumns: [sourceItems.id],
			name: "extraction_jobs_source_item_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceSnapshotId],
			foreignColumns: [sourceSnapshots.id],
			name: "extraction_jobs_source_snapshot_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "extraction_jobs_space_id_fkey"
		}),
	check("ck_extraction_jobs_job_type", sql`(job_type)::text = ANY (ARRAY[('connection_scan'::character varying)::text, ('manual_url'::character varying)::text, ('extract_text'::character varying)::text, ('snapshot'::character varying)::text, ('normalize_activity'::character varying)::text, ('normalize_artifact'::character varying)::text, ('normalize_run_event'::character varying)::text])`),
	check("ck_extraction_jobs_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text])`),
]);

export const sourceItems = pgTable("source_items", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	visibility: varchar({ length: 32 }).default('private').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	connectionId: varchar("connection_id", { length: 36 }),
	itemType: varchar("item_type", { length: 64 }).notNull(),
	sourceObjectType: varchar("source_object_type", { length: 64 }),
	sourceObjectId: varchar("source_object_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	title: varchar({ length: 1024 }).notNull(),
	sourceUri: text("source_uri"),
	canonicalUri: text("canonical_uri"),
	sourceDomain: varchar("source_domain", { length: 256 }),
	sourceExternalId: varchar("source_external_id", { length: 512 }),
	author: varchar({ length: 512 }),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).notNull(),
	contentHash: varchar("content_hash", { length: 128 }),
	excerpt: varchar({ length: 2048 }),
	contentState: varchar("content_state", { length: 64 }).notNull(),
	retentionPolicy: varchar("retention_policy", { length: 32 }).notNull(),
	relevanceScore: doublePrecision("relevance_score"),
	noveltyScore: doublePrecision("novelty_score"),
	rawArtifactId: varchar("raw_artifact_id", { length: 36 }),
	extractedArtifactId: varchar("extracted_artifact_id", { length: 36 }),
	summaryArtifactId: varchar("summary_artifact_id", { length: 36 }),
	searchIndexRef: varchar("search_index_ref", { length: 1024 }),
	embeddingIndexRef: varchar("embedding_index_ref", { length: 1024 }),
	metadataJson: jsonb("metadata_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_items_canonical_uri").using("btree", table.spaceId.asc().nullsLast(), table.canonicalUri.asc().nullsLast()),
	index("ix_source_items_connection_id").using("btree", table.connectionId.asc().nullsLast()),
	index("ix_source_items_content_hash").using("btree", table.contentHash.asc().nullsLast()),
	index("ix_source_items_created_by_user_id").using("btree", table.createdByUserId.asc().nullsLast()),
	index("ix_source_items_deleted_at").using("btree", table.deletedAt.asc().nullsLast()),
	index("ix_source_items_extracted_artifact_id").using("btree", table.extractedArtifactId.asc().nullsLast()),
	index("ix_source_items_item_type").using("btree", table.itemType.asc().nullsLast()),
	index("ix_source_items_occurred_at").using("btree", table.occurredAt.asc().nullsLast()),
	index("ix_source_items_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_source_items_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_source_items_raw_artifact_id").using("btree", table.rawArtifactId.asc().nullsLast()),
	index("ix_source_items_source_domain").using("btree", table.sourceDomain.asc().nullsLast()),
	index("ix_source_items_source_external_id").using("btree", table.sourceExternalId.asc().nullsLast()),
	index("ix_source_items_source_object").using("btree", table.spaceId.asc().nullsLast(), table.sourceObjectType.asc().nullsLast(), table.sourceObjectId.asc().nullsLast()),
	index("ix_source_items_source_object_id").using("btree", table.sourceObjectId.asc().nullsLast()),
	index("ix_source_items_source_object_type").using("btree", table.sourceObjectType.asc().nullsLast()),
	index("ix_source_items_space_connection").using("btree", table.spaceId.asc().nullsLast(), table.connectionId.asc().nullsLast()),
	index("ix_source_items_space_created_by_user_id").using("btree", table.spaceId.asc().nullsLast(), table.createdByUserId.asc().nullsLast()),
	index("ix_source_items_space_domain").using("btree", table.spaceId.asc().nullsLast(), table.sourceDomain.asc().nullsLast()),
	index("ix_source_items_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_source_items_summary_artifact_id").using("btree", table.summaryArtifactId.asc().nullsLast()),
	index("ix_source_items_visibility").using("btree", table.visibility.asc().nullsLast()),
	uniqueIndex("uq_source_items_active_canonical_uri_personal").using("btree", table.spaceId.asc().nullsLast(), table.canonicalUri.asc().nullsLast()).where(sql`canonical_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NULL`),
	uniqueIndex("uq_source_items_active_canonical_uri_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.canonicalUri.asc().nullsLast()).where(sql`canonical_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NOT NULL`),
	uniqueIndex("uq_source_items_active_source_uri_personal").using("btree", table.spaceId.asc().nullsLast(), table.sourceUri.asc().nullsLast()).where(sql`source_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NULL`),
	uniqueIndex("uq_source_items_active_source_uri_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.sourceUri.asc().nullsLast()).where(sql`source_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NOT NULL`),
	unique("uq_source_items_id_space").on(table.id, table.spaceId),
	foreignKey({
			columns: [table.extractedArtifactId],
			foreignColumns: [artifacts.id],
			name: "fk_source_items_extracted_artifact_id_artifacts"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.rawArtifactId],
			foreignColumns: [artifacts.id],
			name: "fk_source_items_raw_artifact_id_artifacts"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.summaryArtifactId],
			foreignColumns: [artifacts.id],
			name: "fk_source_items_summary_artifact_id_artifacts"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.connectionId],
			foreignColumns: [sourceConnections.id],
			name: "source_items_connection_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "source_items_created_by_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "source_items_owner_user_id_fkey"
		}),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "source_items_space_id_fkey"
	}),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "source_items_project_id_fkey"
	}),
	check("ck_source_items_content_state", sql`(content_state)::text = ANY (ARRAY[('metadata_only'::character varying)::text, ('excerpt_saved'::character varying)::text, ('content_queued'::character varying)::text, ('content_saved'::character varying)::text, ('snapshot_queued'::character varying)::text, ('snapshot_saved'::character varying)::text, ('extraction_failed'::character varying)::text, ('content_unavailable'::character varying)::text])`),
	check("ck_source_items_item_type", sql`(item_type)::text = ANY (ARRAY[('external_url'::character varying)::text, ('feed_entry'::character varying)::text, ('activity_record'::character varying)::text, ('artifact'::character varying)::text, ('run_event'::character varying)::text, ('file'::character varying)::text, ('document'::character varying)::text, ('log'::character varying)::text])`),
	check("ck_source_items_retention_policy", sql`(retention_policy)::text = ANY (ARRAY[('metadata_only'::character varying)::text, ('summary_only'::character varying)::text, ('full_text'::character varying)::text, ('full_snapshot'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_source_items_origin_pair", sql`(source_object_type IS NULL) = (source_object_id IS NULL)`),
	check("ck_source_items_origin_type", sql`source_object_type IS NULL OR source_object_type IN ('activity_record', 'artifact', 'run_event')`),
	check("ck_source_items_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_source_items_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_source_items_private_owner", sql`visibility = 'space_shared' OR owner_user_id IS NOT NULL`),
]);

export const sourceSnapshots = pgTable("source_snapshots", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	visibility: varchar({ length: 32 }).default('private').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	sourceItemId: varchar("source_item_id", { length: 36 }),
	connectionId: varchar("connection_id", { length: 36 }),
	snapshotType: varchar("snapshot_type", { length: 32 }).notNull(),
	artifactId: varchar("artifact_id", { length: 36 }),
	contentHash: varchar("content_hash", { length: 128 }),
	sourceUri: text("source_uri"),
	captureMethod: varchar("capture_method", { length: 64 }).notNull(),
	trustLevel: varchar("trust_level", { length: 32 }).notNull(),
	metadataJson: jsonb("metadata_json"),
	capturedAt: timestamp("captured_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_snapshots_artifact_id").using("btree", table.artifactId.asc().nullsLast()),
	index("ix_source_snapshots_connection_id").using("btree", table.connectionId.asc().nullsLast()),
	index("ix_source_snapshots_content_hash").using("btree", table.contentHash.asc().nullsLast()),
	index("ix_source_snapshots_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_source_snapshots_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_source_snapshots_snapshot_type").using("btree", table.snapshotType.asc().nullsLast()),
	index("ix_source_snapshots_source_item_id").using("btree", table.sourceItemId.asc().nullsLast()),
	index("ix_source_snapshots_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_source_snapshots_space_item").using("btree", table.spaceId.asc().nullsLast(), table.sourceItemId.asc().nullsLast()),
	index("ix_source_snapshots_visibility").using("btree", table.visibility.asc().nullsLast()),
	foreignKey({
			columns: [table.artifactId],
			foreignColumns: [artifacts.id],
			name: "source_snapshots_artifact_id_fkey"
		}),
	foreignKey({
			columns: [table.connectionId],
			foreignColumns: [sourceConnections.id],
			name: "source_snapshots_connection_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "source_snapshots_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceItemId],
			foreignColumns: [sourceItems.id],
			name: "source_snapshots_source_item_id_fkey"
		}),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "source_snapshots_space_id_fkey"
	}),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "source_snapshots_project_id_fkey"
	}),
	check("ck_source_snapshots_capture_method", sql`(capture_method)::text = ANY (ARRAY[('manual'::character varying)::text, ('connection_scan'::character varying)::text, ('full_text'::character varying)::text, ('snapshot'::character varying)::text, ('internal'::character varying)::text, ('custom_source_handler'::character varying)::text, ('source_recipe'::character varying)::text])`),
	check("ck_source_snapshots_snapshot_type", sql`(snapshot_type)::text = ANY (ARRAY[('metadata'::character varying)::text, ('raw'::character varying)::text, ('extracted'::character varying)::text, ('summary'::character varying)::text])`),
	check("ck_source_snapshots_trust_level", sql`(trust_level)::text = ANY (ARRAY[('trusted'::character varying)::text, ('normal'::character varying)::text, ('untrusted'::character varying)::text])`),
	check("ck_source_snapshots_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_source_snapshots_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_source_snapshots_private_owner", sql`visibility = 'space_shared' OR owner_user_id IS NOT NULL`),
]);

export const sourceConnections = pgTable("source_connections", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	providerConnectorId: varchar("provider_connector_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	credentialId: varchar("credential_id", { length: 36 }),
	visibility: varchar({ length: 32 }).default('private').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	name: varchar({ length: 512 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	capturePolicy: varchar("capture_policy", { length: 64 }).notNull(),
	trustLevel: varchar("trust_level", { length: 32 }).notNull(),
	topicHintsJson: jsonb("topic_hints_json"),
	consentJson: jsonb("consent_json").notNull(),
	policyJson: jsonb("policy_json").notNull(),
	configJson: jsonb("config_json").notNull(),
	handlerKind: varchar("handler_kind", { length: 32 }).default('built_in').notNull(),
	activeHandlerVersionId: varchar("active_handler_version_id", { length: 36 }),
	activeRecipeVersionId: varchar("active_recipe_version_id", { length: 36 }),
	repairStatus: varchar("repair_status", { length: 32 }).default('ok').notNull(),
	lastHandlerRunId: varchar("last_handler_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_connections_active_handler_version_id").using("btree", table.activeHandlerVersionId.asc().nullsLast()),
	index("ix_source_connections_active_recipe_version_id").using("btree", table.activeRecipeVersionId.asc().nullsLast()),
	index("ix_source_connections_provider_connector_id").using("btree", table.providerConnectorId.asc().nullsLast()),
	index("ix_source_connections_credential_id").using("btree", table.credentialId.asc().nullsLast()),
	index("ix_source_connections_deleted_at").using("btree", table.deletedAt.asc().nullsLast()),
	index("ix_source_connections_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_source_connections_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_source_connections_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_source_connections_space_status").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_source_connections_status").using("btree", table.status.asc().nullsLast()),
	index("ix_source_connections_visibility").using("btree", table.visibility.asc().nullsLast()),
	uniqueIndex("uq_source_connections_active_owner_mapping_personal").using("btree", table.spaceId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.providerConnectorId.asc().nullsLast(), table.name.asc().nullsLast()).where(sql`deleted_at IS NULL AND status <> 'archived' AND project_id IS NULL`),
	uniqueIndex("uq_source_connections_active_owner_mapping_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.providerConnectorId.asc().nullsLast(), table.name.asc().nullsLast()).where(sql`deleted_at IS NULL AND status <> 'archived' AND project_id IS NOT NULL`),
	unique("uq_source_connections_id_provider_connector_space").on(table.id, table.providerConnectorId, table.spaceId),
	foreignKey({
			columns: [table.providerConnectorId],
			foreignColumns: [sourceProviderConnectors.id],
			name: "source_connections_provider_connector_id_fkey"
		}),
	foreignKey({
			columns: [table.credentialId],
			foreignColumns: [credentials.id],
			name: "source_connections_credential_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "source_connections_owner_user_id_fkey"
		}),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "source_connections_space_id_fkey"
	}),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "source_connections_project_id_fkey"
	}),
	foreignKey({
			columns: [table.activeHandlerVersionId],
			foreignColumns: [sourceHandlerVersions.id],
			name: "source_connections_active_handler_version_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lastHandlerRunId],
			foreignColumns: [sourceHandlerRuns.id],
			name: "source_connections_last_handler_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.activeRecipeVersionId],
			foreignColumns: [sourceRecipeVersions.id],
			name: "source_connections_active_recipe_version_id_fkey"
		}).onDelete("set null"),
	unique("source_connections_id_space_id_key").on(table.id, table.spaceId),
	check("ck_source_connections_capture_policy", sql`(capture_policy)::text = ANY (ARRAY[('reference_only'::character varying)::text, ('extract_text'::character varying)::text, ('archive_original'::character varying)::text])`),
	check("ck_source_connections_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_source_connections_trust_level", sql`(trust_level)::text = ANY (ARRAY[('trusted'::character varying)::text, ('normal'::character varying)::text, ('untrusted'::character varying)::text])`),
	check("ck_source_connections_handler_kind", sql`(handler_kind)::text = ANY (ARRAY[('built_in'::character varying)::text, ('generated_custom'::character varying)::text, ('recipe'::character varying)::text])`),
	check("ck_source_connections_repair_status", sql`(repair_status)::text = ANY (ARRAY[('ok'::character varying)::text, ('repair_required'::character varying)::text, ('repair_pending'::character varying)::text, ('disabled'::character varying)::text])`),
	check("ck_source_connections_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_source_connections_access_level", sql`access_level IN ('full', 'summary')`),
]);

export const sourceItemUserStates = pgTable("source_item_user_states", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	libraryStatus: varchar("library_status", { length: 32 }).default('new').notNull(),
	readStatus: varchar("read_status", { length: 32 }).default('unread').notNull(),
	firstOpenedAt: timestamp("first_opened_at", { withTimezone: true, mode: 'string' }),
	lastOpenedAt: timestamp("last_opened_at", { withTimezone: true, mode: 'string' }),
	progressJson: jsonb("progress_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_item_user_states_item_user").using("btree", table.sourceItemId.asc().nullsLast(), table.userId.asc().nullsLast()),
	index("ix_source_item_user_states_user_status").using("btree", table.spaceId.asc().nullsLast(), table.userId.asc().nullsLast(), table.libraryStatus.asc().nullsLast(), table.readStatus.asc().nullsLast()),
	uniqueIndex("uq_source_item_user_states_space_item_user").using("btree", table.spaceId.asc().nullsLast(), table.sourceItemId.asc().nullsLast(), table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "source_item_user_states_space_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceItemId],
			foreignColumns: [sourceItems.id],
			name: "source_item_user_states_source_item_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "source_item_user_states_user_id_fkey"
		}),
	check("ck_source_item_user_states_library_status", sql`(library_status)::text = ANY (ARRAY[('new'::character varying)::text, ('triaged'::character varying)::text, ('selected'::character varying)::text, ('ignored'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_source_item_user_states_read_status", sql`(read_status)::text = ANY (ARRAY[('unread'::character varying)::text, ('skimmed'::character varying)::text, ('read'::character varying)::text, ('discussed'::character varying)::text])`),
	check("ck_source_item_user_states_progress_json", sql`jsonb_typeof(progress_json) = 'object'::text`),
]);

export const sourcePostProcessingRules = pgTable("source_post_processing_rules", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceChannelId: varchar("source_channel_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	name: varchar({ length: 256 }).notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	triggerType: varchar("trigger_type", { length: 32 }).default('items_materialized').notNull(),
	triggerConfigJson: jsonb("trigger_config_json").default({}).notNull(),
	inputConfigJson: jsonb("input_config_json").default({}).notNull(),
	actionsJson: jsonb("actions_json").default({"batch_digest":true}).notNull(),
	cursorJson: jsonb("cursor_json"),
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true, mode: 'string' }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_post_processing_rules_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_source_post_processing_rules_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_source_post_processing_rules_source_status").using("btree", table.spaceId.asc().nullsLast(), table.sourceChannelId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_source_post_processing_rules_trigger_status").using("btree", table.spaceId.asc().nullsLast(), table.triggerType.asc().nullsLast(), table.status.asc().nullsLast()),
	uniqueIndex("uq_source_post_processing_rules_active_name").using("btree", table.spaceId.asc().nullsLast(), table.sourceChannelId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.name.asc().nullsLast()).where(sql`((status)::text <> 'archived'::text)`),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "source_post_processing_rules_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "source_post_processing_rules_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "source_post_processing_rules_project_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "source_post_processing_rules_space_id_fkey"
		}),
	check("ck_source_post_processing_rules_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_source_post_processing_rules_trigger_type", sql`(trigger_type)::text = ANY (ARRAY[('items_materialized'::character varying)::text, ('schedule'::character varying)::text, ('manual'::character varying)::text])`),
]);

export const sourcePostProcessingRuns = pgTable("source_post_processing_runs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ruleId: varchar("rule_id", { length: 36 }),
	sourceChannelId: varchar("source_channel_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	agentRunId: varchar("agent_run_id", { length: 36 }),
	triggeredByUserId: varchar("triggered_by_user_id", { length: 36 }),
	triggerType: varchar("trigger_type", { length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	inputItemIdsJson: jsonb("input_item_ids_json").default([]).notNull(),
	inputEvidenceIdsJson: jsonb("input_evidence_ids_json").default([]).notNull(),
	outputArtifactIdsJson: jsonb("output_artifact_ids_json").default([]).notNull(),
	outputProposalIdsJson: jsonb("output_proposal_ids_json").default([]).notNull(),
	outputJobIdsJson: jsonb("output_job_ids_json").default([]).notNull(),
	cursorBeforeJson: jsonb("cursor_before_json"),
	cursorAfterJson: jsonb("cursor_after_json"),
	retrievalContextJson: jsonb("retrieval_context_json").default({}).notNull(),
	itemDecisionsJson: jsonb("item_decisions_json").default([]).notNull(),
	summary: text(),
	errorJson: jsonb("error_json"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	researchReconciledAt: timestamp("research_reconciled_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_post_processing_runs_agent_run_id").using("btree", table.agentRunId.asc().nullsLast()),
	index("ix_source_post_processing_runs_rule_created").using("btree", table.spaceId.asc().nullsLast(), table.ruleId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("ix_source_post_processing_runs_source_created").using("btree", table.spaceId.asc().nullsLast(), table.sourceChannelId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("ix_source_post_processing_runs_status").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_source_post_processing_runs_research_reconciliation").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast(), table.researchReconciledAt.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "source_post_processing_runs_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.agentRunId],
			foreignColumns: [runs.id],
			name: "source_post_processing_runs_agent_run_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "source_post_processing_runs_project_id_fkey"
		}),
	foreignKey({
			columns: [table.ruleId],
			foreignColumns: [sourcePostProcessingRules.id],
			name: "source_post_processing_runs_rule_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "source_post_processing_runs_space_id_fkey"
		}),
	foreignKey({
			columns: [table.triggeredByUserId],
			foreignColumns: [users.id],
			name: "source_post_processing_runs_triggered_by_user_id_fkey"
		}),
	check("ck_source_post_processing_runs_status", sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text])`),
	check("ck_source_post_processing_runs_trigger_type", sql`(trigger_type)::text = ANY (ARRAY[('items_materialized'::character varying)::text, ('schedule'::character varying)::text, ('manual'::character varying)::text])`),
]);

export const sourcePostProcessingItemDecisions = pgTable("source_post_processing_item_decisions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceChannelId: varchar("source_channel_id", { length: 36 }).notNull(),
	ruleId: varchar("rule_id", { length: 36 }),
	runId: varchar("run_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
	researchQuestionVersion: integer("research_question_version").default(1).notNull(),
	relevance: varchar({ length: 32 }).notNull(),
	confidence: doublePrecision(),
	reason: text(),
	matchedContextRefsJson: jsonb("matched_context_refs_json").default([]).notNull(),
	reviewStatus: varchar("review_status", { length: 32 }).default('pending').notNull(),
	actionJson: jsonb("action_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_post_processing_item_decisions_connection_review").using("btree", table.spaceId.asc().nullsLast(), table.sourceChannelId.asc().nullsLast(), table.reviewStatus.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("ix_source_post_processing_item_decisions_item").using("btree", table.spaceId.asc().nullsLast(), table.sourceItemId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("ix_source_post_processing_item_decisions_question_version").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.researchQuestionVersion.desc().nullsFirst(), table.sourceItemId.asc().nullsLast()),
	index("ix_source_post_processing_item_decisions_project_review").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.reviewStatus.asc().nullsLast(), table.relevance.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("ix_source_post_processing_item_decisions_rule_run").using("btree", table.spaceId.asc().nullsLast(), table.ruleId.asc().nullsLast(), table.runId.asc().nullsLast()),
	uniqueIndex("uq_source_post_processing_item_decisions_run_item").using("btree", table.spaceId.asc().nullsLast(), table.runId.asc().nullsLast(), table.sourceItemId.asc().nullsLast()),
	unique("uq_source_post_processing_item_decisions_id_space").on(table.id, table.spaceId),
	foreignKey({
			columns: [table.sourceItemId],
			foreignColumns: [sourceItems.id],
			name: "source_post_processing_item_decisions_source_item_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "source_post_processing_item_decisions_project_id_fkey"
		}),
	foreignKey({
			columns: [table.ruleId],
			foreignColumns: [sourcePostProcessingRules.id],
			name: "source_post_processing_item_decisions_rule_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [sourcePostProcessingRuns.id],
			name: "source_post_processing_item_decisions_run_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "source_post_processing_item_decisions_space_id_fkey"
		}),
	check("ck_source_post_processing_item_decisions_action_object", sql`jsonb_typeof(action_json) = 'object'::text`),
	check("ck_source_post_processing_item_decisions_confidence", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("ck_source_post_processing_item_decisions_question_version", sql`research_question_version >= 1`),
	check("ck_source_post_processing_item_decisions_refs_array", sql`jsonb_typeof(matched_context_refs_json) = 'array'::text`),
	check("ck_source_post_processing_item_decisions_relevance", sql`(relevance)::text = ANY (ARRAY[('relevant'::character varying)::text, ('maybe'::character varying)::text, ('not_relevant'::character varying)::text])`),
	check("ck_source_post_processing_item_decisions_review_status", sql`(review_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('ignored'::character varying)::text, ('queued'::character varying)::text, ('proposed'::character varying)::text, ('rerun'::character varying)::text, ('dismissed'::character varying)::text])`),
]);

export const readerAnnotations = pgTable("reader_annotations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	documentType: varchar("document_type", { length: 32 }).notNull(),
	documentId: varchar("document_id", { length: 36 }).notNull(),
	annotationType: varchar("annotation_type", { length: 32 }).notNull(),
	quoteText: text("quote_text").notNull(),
	anchorJson: jsonb("anchor_json").notNull(),
	color: varchar({ length: 32 }),
	label: varchar({ length: 128 }),
	visibility: varchar({ length: 32 }).default('private').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	anchorState: varchar("anchor_state", { length: 32 }).default('unverified').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_reader_annotations_space_document").using("btree", table.spaceId.asc().nullsLast(), table.documentType.asc().nullsLast(), table.documentId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_reader_annotations_space_user").using("btree", table.spaceId.asc().nullsLast(), table.createdByUserId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_reader_annotations_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_reader_annotations_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_reader_annotations_space_visibility").using("btree", table.spaceId.asc().nullsLast(), table.visibility.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
		columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "reader_annotations_space_id_fkey"
	}),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "reader_annotations_project_id_fkey"
	}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "reader_annotations_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "reader_annotations_owner_user_id_fkey"
		}),
	check("ck_reader_annotations_annotation_type", sql`(annotation_type)::text = ANY (ARRAY[('highlight'::character varying)::text, ('comment'::character varying)::text, ('excerpt'::character varying)::text, ('bookmark'::character varying)::text])`),
	check("ck_reader_annotations_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_reader_annotations_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_reader_annotations_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_reader_annotations_anchor_state", sql`(anchor_state)::text = ANY (ARRAY[('verified'::character varying)::text, ('unverified'::character varying)::text])`),
	check("ck_reader_annotations_document_type", sql`document_type IN ('source_item', 'source_snapshot', 'research_report', 'research_notebook')`),
	check("ck_reader_annotations_anchor_json", sql`jsonb_typeof(anchor_json) = 'object'::text`),
]);

export const readerCommentThreads = pgTable("reader_comment_threads", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	annotationId: varchar("annotation_id", { length: 36 }).notNull(),
	status: varchar({ length: 32 }).default('open').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_reader_comment_threads_space_annotation").using("btree", table.spaceId.asc().nullsLast(), table.annotationId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_reader_comment_threads_space_user").using("btree", table.spaceId.asc().nullsLast(), table.createdByUserId.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "reader_comment_threads_space_id_fkey"
		}),
	foreignKey({
			columns: [table.annotationId],
			foreignColumns: [readerAnnotations.id],
			name: "reader_comment_threads_annotation_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "reader_comment_threads_created_by_user_id_fkey"
		}),
	check("ck_reader_comment_threads_status", sql`(status)::text = ANY (ARRAY[('open'::character varying)::text, ('resolved'::character varying)::text, ('archived'::character varying)::text])`),
]);

export const readerComments = pgTable("reader_comments", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	body: text().notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_reader_comments_space_thread").using("btree", table.spaceId.asc().nullsLast(), table.threadId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_reader_comments_space_user").using("btree", table.spaceId.asc().nullsLast(), table.createdByUserId.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "reader_comments_space_id_fkey"
		}),
	foreignKey({
			columns: [table.threadId],
			foreignColumns: [readerCommentThreads.id],
			name: "reader_comments_thread_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "reader_comments_created_by_user_id_fkey"
		}),
	check("ck_reader_comments_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
]);

export const sourceHandlerVersions = pgTable("source_handler_versions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceConnectionId: varchar("source_connection_id", { length: 36 }).notNull(),
	versionNumber: integer("version_number").notNull(),
	language: varchar({ length: 32 }).notNull(),
	entrypoint: varchar({ length: 512 }).notNull(),
	handlerArtifactId: varchar("handler_artifact_id", { length: 36 }),
	manifestJson: jsonb("manifest_json").notNull(),
	inputSchemaJson: jsonb("input_schema_json"),
	outputSchemaJson: jsonb("output_schema_json"),
	policyEnvelopeJson: jsonb("policy_envelope_json").notNull(),
	requestedCapabilitiesJson: jsonb("requested_capabilities_json"),
	checksum: varchar({ length: 128 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByRunId: varchar("created_by_run_id", { length: 36 }),
	proposalId: varchar("proposal_id", { length: 36 }),
	testResultJson: jsonb("test_result_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	activatedAt: timestamp("activated_at", { withTimezone: true, mode: 'string' }),
	supersededAt: timestamp("superseded_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_handler_versions_source_connection_id").using("btree", table.sourceConnectionId.asc().nullsLast()),
	index("ix_source_handler_versions_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_source_handler_versions_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "source_handler_versions_space_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceConnectionId],
			foreignColumns: [sourceConnections.id],
			name: "source_handler_versions_source_connection_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.handlerArtifactId],
			foreignColumns: [artifacts.id],
			name: "source_handler_versions_handler_artifact_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "source_handler_versions_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByRunId],
			foreignColumns: [runs.id],
			name: "source_handler_versions_created_by_run_id_fkey"
		}),
	foreignKey({
			columns: [table.proposalId],
			foreignColumns: [proposals.id],
			name: "source_handler_versions_proposal_id_fkey"
		}),
	unique("uq_source_handler_versions_connection_version").on(table.sourceConnectionId, table.versionNumber),
	check("ck_source_handler_versions_language", sql`(language)::text = ANY (ARRAY[('typescript_node'::character varying)::text, ('declarative_pipeline_v1'::character varying)::text])`),
	check("ck_source_handler_versions_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('test_failed'::character varying)::text, ('pending_approval'::character varying)::text, ('active'::character varying)::text, ('superseded'::character varying)::text, ('disabled'::character varying)::text])`),
	check("ck_source_handler_versions_version_number", sql`version_number > 0`),
]);

export const sourceRecipeVersions = pgTable("source_recipe_versions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceConnectionId: varchar("source_connection_id", { length: 36 }).notNull(),
	versionNumber: integer("version_number").notNull(),
	recipeJson: jsonb("recipe_json").notNull(),
	policyEnvelopeJson: jsonb("policy_envelope_json").notNull(),
	primitiveVersionsJson: jsonb("primitive_versions_json"),
	status: varchar({ length: 32 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	proposalId: varchar("proposal_id", { length: 36 }),
	testResultJson: jsonb("test_result_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	activatedAt: timestamp("activated_at", { withTimezone: true, mode: 'string' }),
	supersededAt: timestamp("superseded_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_recipe_versions_connection").using("btree", table.sourceConnectionId.asc().nullsLast()),
	index("ix_source_recipe_versions_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "source_recipe_versions_space_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceConnectionId],
			foreignColumns: [sourceConnections.id],
			name: "source_recipe_versions_source_connection_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "source_recipe_versions_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.proposalId],
			foreignColumns: [proposals.id],
			name: "source_recipe_versions_proposal_id_fkey"
		}),
	unique("uq_source_recipe_versions_connection_version").on(table.sourceConnectionId, table.versionNumber),
	check("ck_source_recipe_versions_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('test_failed'::character varying)::text, ('pending_approval'::character varying)::text, ('active'::character varying)::text, ('superseded'::character varying)::text, ('disabled'::character varying)::text])`),
	check("ck_source_recipe_versions_version_number", sql`version_number > 0`),
]);

export const sourceHandlerRuns = pgTable("source_handler_runs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceConnectionId: varchar("source_connection_id", { length: 36 }).notNull(),
	handlerVersionId: varchar("handler_version_id", { length: 36 }).notNull(),
	extractionJobId: varchar("extraction_job_id", { length: 36 }),
	status: varchar({ length: 32 }).notNull(),
	inputArtifactId: varchar("input_artifact_id", { length: 36 }),
	outputArtifactId: varchar("output_artifact_id", { length: 36 }),
	logsArtifactId: varchar("logs_artifact_id", { length: 36 }),
	failureClass: varchar("failure_class", { length: 64 }),
	failureDetailJson: jsonb("failure_detail_json"),
	validationResultJson: jsonb("validation_result_json"),
	resourceUsageJson: jsonb("resource_usage_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_handler_runs_handler_version_id").using("btree", table.handlerVersionId.asc().nullsLast()),
	index("ix_source_handler_runs_source_connection_id").using("btree", table.sourceConnectionId.asc().nullsLast()),
	index("ix_source_handler_runs_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_source_handler_runs_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "source_handler_runs_space_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceConnectionId],
			foreignColumns: [sourceConnections.id],
			name: "source_handler_runs_source_connection_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.handlerVersionId],
			foreignColumns: [sourceHandlerVersions.id],
			name: "source_handler_runs_handler_version_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.extractionJobId],
			foreignColumns: [extractionJobs.id],
			name: "source_handler_runs_extraction_job_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.inputArtifactId],
			foreignColumns: [artifacts.id],
			name: "source_handler_runs_input_artifact_id_fkey"
		}),
	foreignKey({
			columns: [table.outputArtifactId],
			foreignColumns: [artifacts.id],
			name: "source_handler_runs_output_artifact_id_fkey"
		}),
	foreignKey({
			columns: [table.logsArtifactId],
			foreignColumns: [artifacts.id],
			name: "source_handler_runs_logs_artifact_id_fkey"
		}),
	check("ck_source_handler_runs_status", sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('validation_failed'::character varying)::text, ('blocked'::character varying)::text])`),
]);
