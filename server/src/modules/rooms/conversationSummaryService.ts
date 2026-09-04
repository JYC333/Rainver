import { randomUUID } from "node:crypto";
import type { MessageOut } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { withQueryableTransaction } from "../routeUtils/common.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { visibleMessagePathSql } from "../sessions/messagePath.js";
import {
  resolveProviderCommandStore,
  type ProviderCommandStore,
} from "../providers/commands/store.js";
import { completeProviderMessages } from "../providers/invocation/invocation.js";
import { ProviderCommandNotFoundError } from "../providers/commands/types.js";
import {
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
  type ProviderEligibilityRow,
} from "../providers/eligibility.js";
import { canWriteProject } from "../projects/access.js";
import {
  fitRoomSummaryToBudget,
  estimateRoomSummaryTokens,
  selectRoomCompactionBatch,
  type RoomCompactionBatch,
  type RoomSummaryCoverage,
} from "./conversationContext.js";

export const ROOM_CONVERSATION_SUMMARY_JOB = "room_conversation_summary";
const LEASE_MS = 5 * 60_000;
const MAX_RETRIES = 8;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const RETRY_JITTER_RATIO = 0.2;

export interface RoomConversationSummaryState {
  room_id: string;
  session_id: string;
  status: "idle" | "queued" | "running" | "waiting_provider" | "retry_wait" | "failed";
  active_summary_id: string | null;
  requested_through_message_id: string | null;
  requested_through_created_at: string | null;
  retry_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface RoomConversationSummaryDependencies {
  /** Injectable seams keep provider execution deterministic in service tests. */
  resolveProviderStore?: (config: ServerConfig) => ProviderCommandStore;
  completeProviderMessages?: typeof completeProviderMessages;
}

interface SummaryVersionRow {
  id: string;
  version: number;
  summary_text: string;
  covered_through_message_id: string;
  covered_through_created_at: Date | string;
  space_id: string;
  room_id: string;
  session_id: string;
  owner_user_id: string;
  covered_message_count: number;
  source_token_estimate: number;
  summary_token_estimate: number;
  project_id: string;
  system_prompt_version: string;
  schema_version: string;
  provider_id: string | null;
  model: string | null;
  usage_json: Record<string, unknown>;
  audit_json: Record<string, unknown>;
  created_at: Date | string;
}

interface MessageRow {
  id: string;
  session_id: string;
  space_id: string;
  user_id: string | null;
  sender_agent_id: string | null;
  role: string;
  content: string;
  metadata_json: unknown;
  created_at: Date | string;
}

/** Request a summary without doing model work in the send/finalization path. */
/**
 * Whether the incoming request names a message further along the conversation
 * than the one the watermark already holds.
 *
 * Position, not clock: `messages.path_depth` is the conversation's own order,
 * and attaching references stamps timestamps past the wall clock
 * (`referenceService`), so a later message can carry an earlier `created_at`.
 * The freshness sweep selects on this same key — the two must agree, or a
 * session is selected repeatedly without its watermark ever advancing.
 */
const summaryWatermarkAdvancedSql = `(
  SELECT incoming.path_depth > held.path_depth
    FROM messages incoming, messages held
   WHERE incoming.id = EXCLUDED.requested_through_message_id
     AND held.id = room_conversation_summary_states.requested_through_message_id
     AND incoming.space_id = EXCLUDED.space_id
     AND held.space_id = room_conversation_summary_states.space_id
)`;

export async function requestRoomConversationSummary(
  db: Queryable,
  input: {
    spaceId: string;
    roomId: string;
    sessionId: string;
    throughMessageId: string;
    throughCreatedAt: string;
  },
): Promise<void> {
  await withQueryableTransaction(db, async (client) => {
    const threshold = await client.query<{ source_token_estimate: string }>(
      `SELECT COALESCE(SUM(GREATEST(1, octet_length(message.content))), 0)::text AS source_token_estimate
         FROM messages message
        JOIN sessions session_row
           ON session_row.id=message.session_id AND session_row.space_id=message.space_id
        WHERE message.space_id=$1 AND message.session_id=$2
          AND session_row.room_id=$4
          AND ${visibleMessagePathSql({ alias: "message", spaceParam: "$1", sessionParam: "$2" })}
          AND message.content IS NOT NULL AND btrim(message.content) <> ''
          -- Bounded by position, like the sweep gate and the watermark
          -- advance. The through-message names a point on the path; its
          -- timestamp is not that point when a reference was stamped ahead.
          AND message.path_depth <= COALESCE((
                SELECT through.path_depth FROM messages through
                 WHERE through.id=$3 AND through.space_id=$1 AND through.session_id=$2
              ), -1)
          AND NOT EXISTS (
            SELECT 1
              FROM room_conversation_summary_versions summary
             WHERE summary.space_id=message.space_id
               AND summary.room_id=session_row.room_id
               AND summary.session_id=message.session_id
               AND summary.status='active'
               AND (message.created_at,message.id)
                   <= (summary.covered_through_created_at,summary.covered_through_message_id)
          )`,
      [input.spaceId, input.sessionId, input.throughMessageId, input.roomId],
    );
    // `estimateModelTokens` is the shared tokenizer fallback used by Room
    // context assembly. SQL uses byte length only to avoid loading a full
    // transcript before the threshold; the extra precision is harmless for
    // the scheduling gate and the provider path rechecks the exact batch.
    const sourceBytes = Number(threshold.rows[0]?.source_token_estimate ?? 0);
    if (sourceBytes < 6_000) return;
    const now = new Date().toISOString();
    const state = await client.query<{ status: string; retry_count: number }>(
      `INSERT INTO room_conversation_summary_states (
         id, space_id, room_id, session_id, status,
         requested_through_message_id, requested_through_created_at,
         retry_count, updated_at
       ) VALUES ($1,$2,$3,$4,'queued',$5,$6,0,$7)
       ON CONFLICT (session_id) DO UPDATE SET
         -- Advanced by position, on the same key the freshness sweep selects
         -- by. Comparing timestamps here while the sweep compares depth is
         -- what lets a request whose message is deeper but clock-earlier be
         -- selected forever without ever moving the watermark — a sweep loop
         -- that re-enqueues a billed summary job on every tick.
         requested_through_message_id = CASE
           WHEN room_conversation_summary_states.requested_through_message_id IS NULL
             OR ${summaryWatermarkAdvancedSql}
           THEN EXCLUDED.requested_through_message_id
           ELSE room_conversation_summary_states.requested_through_message_id
         END,
         requested_through_created_at = CASE
           WHEN room_conversation_summary_states.requested_through_message_id IS NULL
             OR ${summaryWatermarkAdvancedSql}
           THEN EXCLUDED.requested_through_created_at
           ELSE room_conversation_summary_states.requested_through_created_at
         END,
         status = CASE
           WHEN room_conversation_summary_states.status IN ('running','failed','retry_wait','waiting_provider')
             THEN room_conversation_summary_states.status
           ELSE 'queued'
         END,
         retry_count = room_conversation_summary_states.retry_count,
         next_attempt_at = room_conversation_summary_states.next_attempt_at,
         last_error = room_conversation_summary_states.last_error,
         updated_at = EXCLUDED.updated_at
       RETURNING status`,
      [randomUUID(), input.spaceId, input.roomId, input.sessionId, input.throughMessageId, input.throughCreatedAt, now],
    );
    const currentStatus = state.rows[0]?.status;
    if (currentStatus === "running" || currentStatus === "failed" || currentStatus === "retry_wait" || currentStatus === "waiting_provider") return;
    const activeJob = await client.query(
      `SELECT 1 FROM jobs
        WHERE space_id=$1 AND job_type=$2
          AND payload_json->>'session_id'=$3
          AND status IN ('pending','claimed','running')
        LIMIT 1`,
      [input.spaceId, ROOM_CONVERSATION_SUMMARY_JOB, input.sessionId],
    );
    if (activeJob.rows.length === 0 && currentStatus === "queued") {
      await new PgJobQueueRepository(client).enqueue({
        job_type: ROOM_CONVERSATION_SUMMARY_JOB,
        space_id: input.spaceId,
        user_id: null,
        payload: {
          room_id: input.roomId,
          session_id: input.sessionId,
        },
        max_attempts: 3,
      });
    }
  });
}

export class RoomConversationSummaryService {
  private readonly resolveProviderStore: (config: ServerConfig) => ProviderCommandStore;
  private readonly completeProviderMessages: typeof completeProviderMessages;

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Queryable,
    dependencies: RoomConversationSummaryDependencies = {},
  ) {
    this.resolveProviderStore = dependencies.resolveProviderStore ?? resolveProviderCommandStore;
    this.completeProviderMessages = dependencies.completeProviderMessages ?? completeProviderMessages;
  }

  async process(input: { spaceId: string; roomId: string; sessionId: string }): Promise<Record<string, unknown>> {
    const lease = await this.claimLease(input);
    if (!lease) return { status: "idle", reason: "lease_not_available" };
    const active = await this.loadActiveSummary(input.spaceId, input.roomId, input.sessionId);
    const messages = await this.loadMessages(input.spaceId, input.roomId, input.sessionId, active);
    const batch = selectRoomCompactionBatch({ messages, summary: active });
    if (!batch.should_compact) {
      await this.finishWithoutPublish(input, lease.token);
      return { status: "idle", reason: "below_threshold" };
    }

    const owner = await this.loadRoomOwner(input.spaceId, input.roomId);
    if (!owner) {
      await this.markProviderRequired(input, lease.token, "Room owner requires Project write authority");
      return { status: "waiting_provider", reason: "owner_authority_required" };
    }
    const ownerProviderId = await this.loadOwnerProviderId(input.spaceId, owner);
    if (!ownerProviderId) {
      await this.markProviderRequired(input, lease.token);
      return { status: "waiting_provider" };
    }
    const providerStore = this.resolveProviderStore(this.config);
    let target: Awaited<ReturnType<ProviderCommandStore["getInvocationTarget"]>>;
    try {
      target = await providerStore.getInvocationTarget(
        input.spaceId,
        ownerProviderId,
        owner,
      );
    } catch (error) {
      if (error instanceof ProviderCommandNotFoundError) {
        await this.markProviderRequired(input, lease.token);
        return { status: "waiting_provider" };
      }
      await this.failLease(input, lease.token, "Summary provider resolution failed", true);
      return { status: "failed", reason: "provider_resolution" };
    }

    let completion: Awaited<ReturnType<typeof completeProviderMessages>>;
    try {
      completion = await this.completeProviderMessages(
        providerStore,
        input.spaceId,
        {
          provider_id: target.provider.id,
          model: target.provider.default_model,
          system: SUMMARY_SYSTEM,
          messages: [{ role: "user", content: JSON.stringify({
            previous_summary: active?.summary_text ?? null,
            source_messages: batch.source_messages.map(messageForPrompt),
          }) }],
          max_tokens: 2_400,
          task: "room_conversation_summary",
          // A Room summary is charged to and must use the active owner's
          // configured API provider; task-chain fallback could otherwise
          // silently route through a Space-level provider.
          allow_provider_fallback: false,
          metering: {
            source_type: "local_run",
            execution_channel: "managed_api",
            meter_subject_type: "user",
            meter_subject_id: owner,
            subject_user_id: owner,
            session_id: input.sessionId,
            task: "room_conversation_summary",
          },
        },
      );
    } catch (error) {
      await this.failLease(input, lease.token, "Summary provider request failed", true);
      return { status: "failed", reason: "provider_completion" };
    }

    const summaryText = parseSummary(completion.text);
    if (!summaryText) {
      await this.failLease(input, lease.token, "Summary provider returned an invalid response", true);
      return { status: "failed", reason: "empty_summary" };
    }
    const published = await this.publish(input, lease.token, owner, target.provider.id, completion.model, summaryText, batch, completion.usage);
    return published;
  }

  async recoverExpiredLeases(now = new Date()): Promise<number> {
    const result = await this.db.query(
      `UPDATE room_conversation_summary_states
          SET status='queued', lease_token=NULL, lease_expires_at=NULL,
              next_attempt_at=$1, last_error='summary lease expired', updated_at=$1
        WHERE status='running' AND lease_expires_at < $1
        RETURNING space_id, room_id, session_id`,
      [now.toISOString()],
    );
    for (const row of result.rows as Array<{ space_id: string; room_id: string; session_id: string }>) {
      await this.enqueueStateJob(row.space_id, row.room_id, row.session_id);
    }
    return result.rowCount ?? 0;
  }

  async enqueueDueJobs(now = new Date()): Promise<number> {
    const result = await this.db.query<{ space_id: string; room_id: string; session_id: string }>(
      `SELECT state.space_id,state.room_id,state.session_id
         FROM room_conversation_summary_states state
        WHERE state.status IN ('queued','retry_wait','failed','waiting_provider')
          AND (state.status NOT IN ('failed','retry_wait') OR state.retry_count < 8)
          AND (
            state.status='waiting_provider'
            OR state.next_attempt_at IS NULL
            OR state.next_attempt_at <= $1
          )
        ORDER BY state.updated_at ASC
        LIMIT 100`,
      [now.toISOString()],
    );
    let enqueued = 0;
    for (const row of result.rows) {
      if (await this.isWaitingForEligibleOwnerProvider(row)) {
        enqueued += await this.enqueueStateJob(row.space_id, row.room_id, row.session_id);
      }
    }
    return enqueued;
  }

  /** Backfill a state row if a terminal turn could not enqueue one. */
  async reconcileMissingStates(limit = 100): Promise<number> {
    const result = await this.db.query<{
      space_id: string;
      room_id: string;
      session_id: string;
      message_id: string;
      created_at: Date | string;
    }>(
      `SELECT session_row.space_id,session_row.room_id,session_row.id AS session_id,
              latest.id AS message_id,latest.created_at
         FROM sessions session_row
         JOIN rooms room
           ON room.id=session_row.room_id AND room.space_id=session_row.space_id
         -- The conversation's head, which is its newest message on the
         -- visible path — not the newest row by clock, which after a branch
         -- could be one the transcript no longer shows.
         JOIN messages latest
           ON latest.id=session_row.head_message_id
          AND latest.space_id=session_row.space_id
          AND latest.session_id=session_row.id
         LEFT JOIN room_conversation_summary_states state
           ON state.space_id=session_row.space_id AND state.session_id=session_row.id
        WHERE room.status='active'
          AND (
            state.id IS NULL
            OR state.requested_through_created_at IS NULL
            OR state.requested_through_message_id IS NULL
            -- Compared by position, not by clock. The head is the newest
            -- message on the path, which is not always the newest by
            -- created_at: attaching references stamps them past the wall
            -- clock (see referenceService), so the message written after them
            -- can carry an earlier timestamp than the watermark. Comparing
            -- clocks there leaves the conversation permanently un-swept.
            OR latest.path_depth > COALESCE((
                 SELECT watermark.path_depth
                   FROM messages watermark
                  WHERE watermark.id=state.requested_through_message_id
                    AND watermark.space_id=session_row.space_id
                    AND watermark.session_id=session_row.id
               ), -1)
          )
        -- Oldest conversation first. path_depth is per-session, so it says
        -- nothing across sessions and would sort long conversations last
        -- every sweep — starving exactly the ones most in need of a summary
        -- whenever the backlog exceeds the limit.
        ORDER BY session_row.updated_at ASC,session_row.id ASC
        LIMIT $1`,
      [Math.max(1, Math.min(500, Math.floor(limit)))],
    );
    let reconciled = 0;
    for (const row of result.rows) {
      await requestRoomConversationSummary(this.db, {
        spaceId: row.space_id,
        roomId: row.room_id,
        sessionId: row.session_id,
        throughMessageId: row.message_id,
        throughCreatedAt: isoDate(row.created_at),
      });
      reconciled += 1;
    }
    return reconciled;
  }

  async getVisibleSummary(input: { spaceId: string; roomId: string; sessionId: string; userId: string }) {
    const state = await this.db.query<RoomConversationSummaryState & { owner_user_id: string | null; room_title: string }>(
      `SELECT state.room_id,state.session_id,state.status,state.active_summary_id,
              state.requested_through_message_id,state.requested_through_created_at,
              state.retry_count,state.next_attempt_at,state.last_error,state.updated_at,
              owner.user_id AS owner_user_id, room.title AS room_title
         FROM sessions session_row
         JOIN rooms room ON room.id=session_row.room_id AND room.space_id=session_row.space_id
         JOIN room_user_members member ON member.room_id=room.id AND member.user_id=$4 AND member.status='active'
         LEFT JOIN room_user_members owner ON owner.room_id=room.id AND owner.role='owner' AND owner.status='active'
         LEFT JOIN room_conversation_summary_states state ON state.session_id=session_row.id
        WHERE session_row.id=$1 AND session_row.space_id=$2 AND session_row.room_id=$3
        LIMIT 1`,
      [input.sessionId, input.spaceId, input.roomId, input.userId],
    );
    const row = state.rows[0];
    if (!row) return null;
    const active = row.active_summary_id
      ? await this.db.query<SummaryVersionRow>(
          `SELECT id,version,summary_text,covered_through_message_id,covered_through_created_at,
                  space_id,room_id,session_id,project_id,owner_user_id,covered_message_count,source_token_estimate,
                  summary_token_estimate,system_prompt_version,schema_version,
                  provider_id,model,usage_json,audit_json,created_at
             FROM room_conversation_summary_versions
            WHERE id=$1 AND space_id=$2 AND room_id=$3 AND session_id=$4 AND status='active'`,
          [row.active_summary_id, input.spaceId, input.roomId, input.sessionId],
        )
      : { rows: [] as SummaryVersionRow[] };
    const activeRow = active.rows[0] ?? null;
    return {
      state: row.status
        ? {
            ...row,
            owner_user_id: row.owner_user_id === input.userId ? row.owner_user_id : null,
            last_error: row.owner_user_id === input.userId
              ? row.last_error
              : row.last_error
                ? "Summary update is temporarily unavailable"
                : null,
          }
        : null,
      summary: activeRow ? summaryOut(activeRow, input.userId === row.owner_user_id) : null,
    };
  }

  private async claimLease(input: { spaceId: string; roomId: string; sessionId: string }): Promise<{ token: string } | null> {
    return withQueryableTransaction(this.db, async (client) => {
      const token = randomUUID();
      const attemptedAt = new Date();
      const leaseExpiresAt = new Date(attemptedAt.getTime() + LEASE_MS);
      const result = await client.query(
        `UPDATE room_conversation_summary_states
            SET status='running', lease_token=$4, lease_expires_at=$5,
                last_attempt_at=$6, updated_at=$6
          WHERE space_id=$1 AND room_id=$2 AND session_id=$3
            AND status IN ('queued','retry_wait','failed','waiting_provider')
            AND (status NOT IN ('failed','retry_wait') OR retry_count < $7)
            AND (
              status='waiting_provider'
              OR next_attempt_at IS NULL
              OR next_attempt_at <= $6
            )
          RETURNING id`,
        [input.spaceId, input.roomId, input.sessionId, token, leaseExpiresAt.toISOString(), attemptedAt.toISOString(), MAX_RETRIES],
      );
      return result.rows[0] ? { token } : null;
    });
  }

  private async enqueueStateJob(spaceId: string, roomId: string, sessionId: string): Promise<number> {
    return withQueryableTransaction(this.db, async (client) => {
      const active = await client.query(
        `SELECT 1 FROM jobs WHERE space_id=$1 AND job_type=$2 AND payload_json->>'session_id'=$3
           AND status IN ('pending','claimed','running') LIMIT 1`,
        [spaceId, ROOM_CONVERSATION_SUMMARY_JOB, sessionId],
      );
      if (active.rows.length) return 0;
      await new PgJobQueueRepository(client).enqueue({
        job_type: ROOM_CONVERSATION_SUMMARY_JOB,
        space_id: spaceId,
        user_id: null,
        payload: { room_id: roomId, session_id: sessionId },
        max_attempts: 3,
      });
      return 1;
    });
  }

  private async loadActiveSummary(spaceId: string, roomId: string, sessionId: string): Promise<RoomSummaryCoverage | null> {
    const result = await this.db.query<RoomSummaryCoverage>(
      `SELECT id,version,summary_text,covered_through_message_id,covered_through_created_at
         FROM room_conversation_summary_versions
        WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND status='active'
        ORDER BY version DESC LIMIT 1`,
      [spaceId, roomId, sessionId],
    );
    const row = result.rows[0];
    return row
      ? {
          ...row,
          covered_through_created_at: isoDate(row.covered_through_created_at),
        }
      : null;
  }

  private async loadMessages(
    spaceId: string,
    roomId: string,
    sessionId: string,
    summary: RoomSummaryCoverage | null,
  ): Promise<MessageOut[]> {
    const result = await this.db.query<MessageRow>(
      `SELECT message.id,message.session_id,message.space_id,message.user_id,message.sender_agent_id,
              message.role,message.content,message.metadata_json,message.path_depth,message.created_at
         FROM messages message
         JOIN sessions session_row
           ON session_row.id=message.session_id AND session_row.space_id=message.space_id
          AND session_row.room_id=$5
        WHERE message.space_id=$1 AND message.session_id=$2
          AND ${visibleMessagePathSql({ alias: "message", spaceParam: "$1", sessionParam: "$2" })}
          AND ($3::timestamptz IS NULL OR (message.created_at > $3 OR (message.created_at=$3 AND message.id>$4)))
        -- Ordered by the same key the coverage cursor is stored and compared
        -- on (covered_through_created_at, and isAfterCoverage in
        -- conversationContext). Ordering by path_depth here while paging by
        -- the clock would make the window's first row and the cursor's next
        -- row disagree. The path predicate above is what keeps an abandoned
        -- branch out; within one branch the two keys agree.
        ORDER BY message.created_at ASC,message.id ASC
        LIMIT 2048`,
      [spaceId, sessionId, summary?.covered_through_created_at ?? null,
        summary?.covered_through_message_id ?? null, roomId],
    );
    return result.rows.map(messageOut);
  }

  private async loadRoomOwner(spaceId: string, roomId: string): Promise<string | null> {
    const result = await this.db.query<{ user_id: string; project_id: string }>(
      `SELECT member.user_id, room.project_id
         FROM room_user_members member
         JOIN rooms room ON room.id=member.room_id AND room.space_id=member.space_id
        WHERE member.space_id=$1 AND member.room_id=$2 AND member.role='owner'
          AND member.status='active' AND room.status='active'
        LIMIT 1`,
      [spaceId, roomId],
    );
    const owner = result.rows[0];
    if (!owner) return null;
    return await canWriteProject(this.db, spaceId, owner.project_id, owner.user_id)
      ? owner.user_id
      : null;
  }

  private async loadOwnerProviderId(spaceId: string, ownerUserId: string): Promise<string | null> {
    const result = await this.db.query<ProviderEligibilityRow & { id: string }>(
      `SELECT provider.id,
              provider.provider_type,
              provider.enabled AS provider_enabled,
              grant_row.enabled AS provider_grant_enabled,
              provider.owner_user_id AS provider_owner_user_id,
              provider_credential.credential_type AS provider_credential_type,
              ${providerCredentialEligibilitySql("provider.id", "provider.credential_id", "provider_credential")}
                AS provider_has_eligible_credential
         FROM model_providers provider
         JOIN model_provider_space_grants grant_row ON grant_row.provider_id=provider.id
         LEFT JOIN credentials provider_credential ON provider_credential.id=provider.credential_id
        WHERE grant_row.space_id=$1
          AND grant_row.enabled=true AND provider.enabled=true
        ORDER BY grant_row.is_default DESC, provider.updated_at DESC, provider.id ASC`,
      [spaceId],
    );
    return result.rows.find((row) => isProviderEligibleForUser(row, ownerUserId))?.id ?? null;
  }

  private async isWaitingForEligibleOwnerProvider(row: {
    space_id: string;
    room_id: string;
    session_id: string;
  }): Promise<boolean> {
    const state = await this.db.query<{ status: string }>(
      `SELECT status
         FROM room_conversation_summary_states
        WHERE space_id=$1 AND room_id=$2 AND session_id=$3
        LIMIT 1`,
      [row.space_id, row.room_id, row.session_id],
    );
    if (state.rows[0]?.status !== "waiting_provider") return true;
    const owner = await this.loadRoomOwner(row.space_id, row.room_id);
    if (!owner) return false;
    return Boolean(await this.loadOwnerProviderId(row.space_id, owner));
  }

  private async finishWithoutPublish(input: { spaceId: string; roomId: string; sessionId: string }, token: string): Promise<void> {
    await this.db.query(
      `UPDATE room_conversation_summary_states
          SET status='idle', lease_token=NULL, lease_expires_at=NULL,
              retry_count=0, next_attempt_at=NULL, last_error=NULL, updated_at=now()
        WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND lease_token=$4`,
      [input.spaceId, input.roomId, input.sessionId, token],
    );
  }

  private async markProviderRequired(input: { spaceId: string; roomId: string; sessionId: string }, token: string, message = "Room owner has no eligible API provider"): Promise<void> {
    await this.db.query(
      `UPDATE room_conversation_summary_states
          SET status='waiting_provider', lease_token=NULL, lease_expires_at=NULL,
              next_attempt_at=$5, last_error=$6, updated_at=now()
        WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND lease_token=$4`,
      [input.spaceId, input.roomId, input.sessionId, token, new Date(Date.now() + 60 * 60_000).toISOString(), message],
    );
  }

  private async loadRoomProjectId(db: Queryable, roomId: string): Promise<string> {
    const result = await db.query<{ project_id: string }>(
      `SELECT project_id FROM rooms WHERE id=$1 AND status='active'`,
      [roomId],
    );
    const projectId = result.rows[0]?.project_id;
    if (!projectId) throw new Error("Room project scope is unavailable");
    return projectId;
  }

  private async failLease(input: { spaceId: string; roomId: string; sessionId: string }, token: string, error: string, retryable: boolean): Promise<void> {
    await withQueryableTransaction(this.db, async (client) => {
      const current = await client.query<{ retry_count: number }>(
        `SELECT retry_count FROM room_conversation_summary_states
          WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND lease_token=$4 FOR UPDATE`,
        [input.spaceId, input.roomId, input.sessionId, token],
      );
      if (!current.rows[0]) return;
      const nextRetryCount = retryable
        ? Math.min(MAX_RETRIES, Number(current.rows[0].retry_count ?? 0) + 1)
        : Number(current.rows[0].retry_count ?? 0);
      const exhausted = retryable && nextRetryCount >= MAX_RETRIES;
      const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, nextRetryCount - 1));
      const jitter = exponential * RETRY_JITTER_RATIO * (Math.random() * 2 - 1);
      const delay = Math.max(1_000, Math.min(RETRY_MAX_MS, Math.round(exponential + jitter)));
      const safeError = sanitizeSummaryError(error);
      await client.query(
        `UPDATE room_conversation_summary_states
            SET status=$5, lease_token=NULL, lease_expires_at=NULL,
                retry_count=$6,
                next_attempt_at=$7,
                last_error=$8, updated_at=now()
          WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND lease_token=$4`,
        [input.spaceId, input.roomId, input.sessionId, token,
          retryable ? (exhausted ? "failed" : "retry_wait") : "idle",
          nextRetryCount,
          retryable && !exhausted ? new Date(Date.now() + delay).toISOString() : null,
          safeError],
      );
    });
  }

  private async publish(
    input: { spaceId: string; roomId: string; sessionId: string },
    token: string,
    ownerUserId: string,
    providerId: string,
    model: string,
    text: string,
    batch: RoomCompactionBatch,
    usage: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return withQueryableTransaction(this.db, async (client) => {
      const state = await client.query<{ active_summary_id: string | null; retry_count: number }>(
        `SELECT active_summary_id,retry_count FROM room_conversation_summary_states
          WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND lease_token=$4 FOR UPDATE`,
        [input.spaceId, input.roomId, input.sessionId, token],
      );
      const row = state.rows[0];
      if (!row || !batch.covered_through_message) return { status: "stale", reason: "lease_lost" };
      const current = row.active_summary_id
        ? await client.query<{ version: number; covered_message_count: number }>(
            `SELECT version,covered_message_count
               FROM room_conversation_summary_versions
              WHERE id=$1 AND space_id=$2 AND room_id=$3 AND session_id=$4 FOR SHARE`,
            [row.active_summary_id, input.spaceId, input.roomId, input.sessionId],
          )
        : { rows: [] as Array<{ version: number; covered_message_count: number }> };
      const version = Number(current.rows[0]?.version ?? 0) + 1;
      const coveredMessageCount = Number(current.rows[0]?.covered_message_count ?? 0)
        + batch.source_messages.length;
      const id = randomUUID();
      if (row.active_summary_id) {
        await client.query(
          `UPDATE room_conversation_summary_versions
              SET status='superseded'
            WHERE id=$1 AND space_id=$2 AND room_id=$3 AND session_id=$4`,
          [row.active_summary_id, input.spaceId, input.roomId, input.sessionId],
        );
      }
      await client.query(
        `INSERT INTO room_conversation_summary_versions (
           id,space_id,room_id,session_id,version,status,summary_text,
           covered_through_message_id,covered_through_created_at,covered_message_count,
           source_token_estimate,summary_token_estimate,project_id,owner_user_id,provider_id,model,usage_json,audit_json,
           system_prompt_version,schema_version,supersedes_id,created_at
         ) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,now())`,
        [id,input.spaceId,input.roomId,input.sessionId,version,fitRoomSummaryToBudget(text),
          batch.covered_through_message.id,batch.covered_through_message.created_at,coveredMessageCount,
          batch.source_token_estimate,estimateRoomSummaryTokens(text),await this.loadRoomProjectId(client, input.roomId),ownerUserId,providerId,model,JSON.stringify(usage),JSON.stringify({
            source_message_ids: batch.source_messages.map((message) => message.id),
            context_contract: "room_conversation_context.v1",
            system_prompt_version: ROOM_SUMMARY_SYSTEM_PROMPT_VERSION,
            schema_version: ROOM_SUMMARY_SCHEMA_VERSION,
          }),ROOM_SUMMARY_SYSTEM_PROMPT_VERSION,ROOM_SUMMARY_SCHEMA_VERSION,row.active_summary_id],
      );
      // Restricted to the visible path, like `loadMessages` that answers the
      // follow-up. Asking over every row would count a message on an
      // abandoned branch as work remaining, and the next pass would find
      // nothing to compact and finish without publishing — one wasted job per
      // publish, forever.
      const remaining = await client.query(
        `SELECT 1 FROM messages m
          WHERE m.space_id=$1 AND m.session_id=$2
            AND ${visibleMessagePathSql({ alias: "m", spaceParam: "$1", sessionParam: "$2" })}
            AND (m.created_at,m.id) > ($3::timestamptz,$4::varchar)
          LIMIT 1`,
        [input.spaceId,input.sessionId,batch.covered_through_message.created_at,batch.covered_through_message.id],
      );
      if (remaining.rows.length > 0) {
        await client.query(
          `UPDATE room_conversation_summary_states
              SET status='queued',active_summary_id=$5,lease_token=NULL,lease_expires_at=NULL,
                  retry_count=0,next_attempt_at=NULL,last_error=NULL,updated_at=now()
            WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND lease_token=$4`,
          [input.spaceId,input.roomId,input.sessionId,token,id],
        );
        // The current job is still marked running while this transaction
        // publishes. Enqueue the follow-up explicitly so the queued state can
        // continue past the current batch instead of waiting for a scheduler
        // tick that will mistake the current job for the next one.
        await new PgJobQueueRepository(client).enqueue({
          job_type: ROOM_CONVERSATION_SUMMARY_JOB, space_id: input.spaceId, user_id: null,
          payload: { room_id: input.roomId, session_id: input.sessionId }, max_attempts: 3,
        });
      } else {
        await client.query(
          `UPDATE room_conversation_summary_states
              SET status='idle',active_summary_id=$5,lease_token=NULL,lease_expires_at=NULL,
                  retry_count=0,next_attempt_at=NULL,last_error=NULL,updated_at=now()
            WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND lease_token=$4`,
          [input.spaceId,input.roomId,input.sessionId,token,id],
        );
      }
      return { status: "published", summary_id: id, version };
    });
  }
}

export function summaryOut(row: SummaryVersionRow, owner: boolean): Record<string, unknown> {
  return {
    id: row.id,
    version: row.version,
    summary_text: row.summary_text,
    covered_through_message_id: row.covered_through_message_id,
    covered_through_created_at: isoDate(row.covered_through_created_at),
    covered_message_count: row.covered_message_count,
    source_token_estimate: row.source_token_estimate,
    summary_token_estimate: row.summary_token_estimate,
    project_id: row.project_id,
    created_at: isoDate(row.created_at),
    provider_id: owner ? row.provider_id : null,
    model: owner ? row.model : null,
    usage: owner ? row.usage_json : null,
    audit: owner ? row.audit_json : null,
  };
}

function messageForPrompt(message: MessageOut): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    speaker: message.sender_agent_id ? "agent" : message.user_id ? "user" : message.role,
    created_at: message.created_at,
    content: message.content,
  };
}

export function parseSummary(text: string): string | null {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(normalized) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || typeof record.summary !== "string") return null;
      return record.summary.trim() || null;
    }
  } catch { /* invalid provider output is a retryable generation failure */ }
  return null;
}

function messageOut(row: MessageRow): MessageOut {
  return {
    id: row.id, session_id: row.session_id, space_id: row.space_id,
    user_id: row.user_id, sender_agent_id: row.sender_agent_id, role: row.role,
    content: row.content,
    metadata_json: recordOrNull(row.metadata_json),
    created_at: isoDate(row.created_at),
  };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function sanitizeSummaryError(error: unknown): string {
  if (error instanceof ProviderCommandNotFoundError) return "Summary provider is unavailable";
  const name = error instanceof Error && error.name ? error.name : "ProviderError";
  if (/timeout/i.test(name)) return "Summary provider timed out";
  if (/abort|cancel/i.test(name)) return "Summary provider request was cancelled";
  return "Summary provider request failed";
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export const ROOM_SUMMARY_SYSTEM_PROMPT_VERSION = "room-summary-prompt.v1";
export const ROOM_SUMMARY_SCHEMA_VERSION = "room-summary-schema.v1";
const SUMMARY_SYSTEM = `You maintain a durable rolling summary for a shared Room conversation.
Return only JSON: {"summary":"..."}. Preserve decisions, constraints, unresolved questions,
tasks, important facts, and references needed to continue the conversation. Do not invent
facts or references. The summary is shared with all active Room members, so do not include
credentials or private material not present in the supplied messages.`;
