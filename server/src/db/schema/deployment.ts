import {
	pgTable,
	index,
	unique,
	check,
	foreignKey,
	varchar,
	text,
	integer,
	jsonb,
	timestamp,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";

/**
 * Instance update jobs (ADR 0020).
 *
 * The instance administrator creates a row; the privileged deployer polls for
 * it over the internal-token channel and executes it. Creating the row *is*
 * the human approval ADR 0017 §1 requires for a deployment, so the row is the
 * durable audit: who asked, when, which tag and digests, and how every stage
 * went. There is no space column — an update is instance-wide, not a space's.
 *
 * The server holds these rows and nothing else. It never talks to Docker, a
 * registry, or the deployer's socket.
 */
export const deploymentJobs = pgTable("deployment_jobs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	jobType: varchar("job_type", { length: 32 }).notNull(),
	status: varchar({ length: 16 }).default('queued').notNull(),
	requestedByUserId: varchar("requested_by_user_id", { length: 36 }).notNull(),
	requestedAt: timestamp("requested_at", { withTimezone: true, mode: 'string' }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	currentStage: varchar("current_stage", { length: 32 }),
	failureStage: varchar("failure_stage", { length: 32 }),
	errorText: text("error_text"),
	/** What the instance `.env` resolved to when the deployer picked the job up. */
	targetTag: varchar("target_tag", { length: 128 }),
	drainTimeoutSeconds: integer("drain_timeout_seconds").default(600).notNull(),
	/** Pulled digests per service, the pre-migration dump path, the health result. */
	resultJson: jsonb("result_json").default({}).notNull(),
	lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: 'string' }),
	/**
	 * The deployer that holds the job. Its identity is stable across a restart
	 * of the process inside one container, so a heartbeat carrying the same id
	 * as a `running` job proves that job's executor died — while a heartbeat
	 * from a second deployer proves nothing about the first one's job.
	 */
	claimedBy: varchar("claimed_by", { length: 128 }),
	/**
	 * `active` exactly while the job is queued or running, NULL once it is
	 * terminal. A plain unique index over it admits many NULLs and one
	 * `active`, which is how "at most one non-terminal job" survives two
	 * administrators pressing Update at the same moment. The check constraint
	 * keeps it from drifting out of step with `status`.
	 */
	activeLock: varchar("active_lock", { length: 8 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_deployment_jobs_requested_at").using("btree", table.requestedAt.desc().nullsLast()),
	index("ix_deployment_jobs_status").using("btree", table.status.asc().nullsLast()),
	unique("uq_deployment_jobs_active").on(table.activeLock),
	foreignKey({
		columns: [table.requestedByUserId],
		foreignColumns: [users.id],
		name: "deployment_jobs_requested_by_user_id_fkey",
	}),
	check("ck_deployment_jobs_job_type", sql`(job_type)::text = ANY (ARRAY[('update'::character varying)::text, ('check_update'::character varying)::text])`),
	check("ck_deployment_jobs_status", sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text])`),
	check("ck_deployment_jobs_active_lock", sql`(active_lock IS NOT NULL) = ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text]))`),
	check("ck_deployment_jobs_active_lock_value", sql`active_lock IS NULL OR active_lock = 'active'::character varying`),
	check("ck_deployment_jobs_drain_timeout", sql`drain_timeout_seconds > 0`),
]);

/**
 * One stage transition, appended and never updated. A failed stage ends the
 * job; nothing rolls back, so this stream plus the dump path in `result_json`
 * is what a person recovers from.
 */
export const deploymentJobEvents = pgTable("deployment_job_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	jobId: varchar("job_id", { length: 36 }).notNull(),
	/** The deployer's id for this report, held across its retries (idempotency). */
	eventId: varchar("event_id", { length: 64 }).notNull(),
	seq: integer().notNull(),
	stage: varchar({ length: 32 }).notNull(),
	status: varchar({ length: 16 }).notNull(),
	at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	/** Bounded when written; a stage's output is a diagnostic, not a log store. */
	logTail: text("log_tail"),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_deployment_job_events_job").using("btree", table.jobId.asc().nullsLast(), table.seq.asc().nullsLast()),
	unique("uq_deployment_job_events_seq").on(table.jobId, table.seq),
	unique("uq_deployment_job_events_event_id").on(table.jobId, table.eventId),
	foreignKey({
		columns: [table.jobId],
		foreignColumns: [deploymentJobs.id],
		name: "deployment_job_events_job_id_fkey",
	}).onDelete("cascade"),
	check("ck_deployment_job_events_status", sql`(status)::text = ANY (ARRAY[('started'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text])`),
]);

/**
 * What the deployer last saw through docker.sock, plus its last remote check.
 *
 * One row, upserted by the heartbeat. The server never contacts the registry
 * itself (ADR 0020 §7), so this table is the only place a remote digest can
 * come from, and "an update is available" is derived from it rather than
 * stored.
 */
export const deploymentObservations = pgTable("deployment_observations", {
	id: varchar({ length: 16 }).primaryKey().notNull(),
	/** `[{service, image_ref, digest, revision}]` for the compose services. */
	servicesJson: jsonb("services_json").default([]).notNull(),
	/** `{tag, digest, checked_at}`, or NULL before the first remote check. */
	remoteJson: jsonb("remote_json"),
	/**
	 * The Docker daemon the deployer talks to, not the deployer's own version:
	 * it reads `docker version --format {{.Server.Version}}`. Kept for
	 * diagnosis; which build the deployer itself runs is one of the rows in
	 * `services_json`.
	 */
	dockerVersion: varchar("docker_version", { length: 128 }),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	check("ck_deployment_observations_singleton", sql`(id)::text = 'instance'::text`),
	check("ck_deployment_observations_services", sql`jsonb_typeof(services_json) = 'array'::text`),
]);
