import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { PgJobQueueRepository } from "../../jobs/repository.js";
import { writePolicyAudit } from "../../policy/auditWriter.js";
import type { JobHandlerRegistry } from "../../jobs/handlerRegistry.js";
import { resolveProviderCommandStore } from "../../providers/commands/store.js";
import { RetrievalEmbeddingStore } from "../index.js";
import { readSpaceRetrievalSettings } from "../settings.js";
import {
  DEFAULT_EMBED_BATCH,
  RETRIEVAL_EMBEDDING_JOB,
  RETRIEVAL_EMBEDDING_TASK,
} from "./config.js";
import { ProviderEmbedder } from "./providerEmbedder.js";
import { RetrievalEmbeddingBackfillService } from "./service.js";

type RetrievalEmbeddingBackfillQueue = Pick<PgJobQueueRepository, "enqueue" | "listJobs">;

export interface RetrievalEmbeddingBackfillEnqueueInput {
  spaceId: string;
  userId?: string | null;
  batchLimit?: number;
  priority?: number;
  maxAttempts?: number;
  trigger?: string | null;
  proposalId?: string | null;
}

export interface RetrievalEmbeddingBackfillEnqueueResult {
  jobId: string;
  /** True when an already-queued backfill for this space was reused. */
  deduped?: boolean;
}

export async function enqueueRetrievalEmbeddingBackfill(
  config: ServerConfig,
  input: RetrievalEmbeddingBackfillEnqueueInput,
): Promise<RetrievalEmbeddingBackfillEnqueueResult | null> {
  if (!config.databaseUrl) return null;
  return enqueueRetrievalEmbeddingBackfillWithQueue(
    new PgJobQueueRepository(getDbPool(config.databaseUrl)),
    input,
  );
}

export async function resetRetrievalEmbeddingsForSpace(
  config: ServerConfig,
  spaceId: string,
): Promise<number> {
  if (!config.databaseUrl) return 0;
  return new RetrievalEmbeddingStore(getDbPool(config.databaseUrl)).resetEmbeddingsForSpace(spaceId);
}

export async function enqueueRetrievalEmbeddingBackfillWithQueue(
  queue: RetrievalEmbeddingBackfillQueue,
  input: RetrievalEmbeddingBackfillEnqueueInput,
): Promise<RetrievalEmbeddingBackfillEnqueueResult> {
  // Debounce: a still-queued (unclaimed) backfill for this space is reused
  // rather than duplicated. A *running* job already claimed its batch, so
  // chunks written after it started still need a fresh job — only 'queued'
  // jobs coalesce. Race-tolerant: a rare double-insert just yields two jobs,
  // which the claim model handles safely.
  const existing = await queue.listJobs({
    space_id: input.spaceId,
    status: "queued",
    job_type: RETRIEVAL_EMBEDDING_JOB,
    limit: 1,
    offset: 0,
  });
  if (existing.length > 0 && existing[0]) {
    return { jobId: existing[0].id, deduped: true };
  }
  const job = await queue.enqueue({
    job_type: RETRIEVAL_EMBEDDING_JOB,
    space_id: input.spaceId,
    user_id: input.userId ?? null,
    priority: input.priority ?? -10,
    max_attempts: input.maxAttempts ?? 3,
    payload: {
      space_id: input.spaceId,
      batch_limit: input.batchLimit ?? DEFAULT_EMBED_BATCH,
      trigger: input.trigger ?? null,
      proposal_id: input.proposalId ?? null,
    },
  });
  return { jobId: job.id };
}

/**
 * Async embedding backfill handler. `space_id` is authoritative from the job
 * envelope (never the free-form payload); a mismatching payload space_id is a
 * boundary violation and fails closed. The external embedding call runs inside
 * the service with no open transaction, per the External Call Boundary.
 */
export function registerRetrievalEmbeddingHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  const db = getDbPool(config.databaseUrl);
  const store = resolveProviderCommandStore(config);
  registry.register(RETRIEVAL_EMBEDDING_JOB, async (job) => {
    const spaceId = job.space_id;
    if (!spaceId) throw new Error(`${RETRIEVAL_EMBEDDING_JOB} missing envelope space_id`);
    const payloadSpaceId = stringValue(job.payload.space_id);
    if (payloadSpaceId && payloadSpaceId !== spaceId) {
      throw new Error(`${RETRIEVAL_EMBEDDING_JOB} payload space_id does not match envelope space_id`);
    }
    const batchLimit = numberValue(job.payload.batch_limit) ?? DEFAULT_EMBED_BATCH;
    const retrievalSettings = await readSpaceRetrievalSettings(db, spaceId);
    const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
    const service = new RetrievalEmbeddingBackfillService(
      db,
      new ProviderEmbedder(store, null, egressPolicy, job.user_id
        ? { subject_user_id: job.user_id }
        : {
            meter_subject_type: "space_system",
            meter_subject_id: RETRIEVAL_EMBEDDING_JOB,
            space_system_task: true,
          }),
      async (event) => {
        await writePolicyAudit(config.databaseUrl!, {
          space_id: spaceId,
          actor_type: "job",
          actor_id: job.job_id,
          actor_ref_json: { job_type: RETRIEVAL_EMBEDDING_JOB },
          action: "retrieval.embedding",
          resource_type: "retrieval_chunks",
          resource_id: null,
          decision: "allow",
          risk_level: "low",
          required_approver_role: null,
          approval_capability: null,
          policy_rule_id: "retrieval_embedding_backfill",
          policy_source: "retrieval_embedding",
          policy_id: null,
          audit_code: "retrieval_embedding.backfill",
          run_id: null,
          proposal_id: stringValue(job.payload.proposal_id),
          metadata_json: {
            task: RETRIEVAL_EMBEDDING_TASK,
            model: event.model,
            dimensions: event.dimensions,
            scanned: event.scanned,
            input_count: event.inputCount,
            embedded: event.embedded,
            skipped: event.skipped,
            trigger: stringValue(job.payload.trigger),
          },
          created_at: new Date().toISOString(),
        });
      },
    );
    const result = await service.backfillSpace(spaceId, {
      batchLimit,
      embeddingDimensions: retrievalSettings.embeddingDimensions,
      // W9: skip provider egress entirely when the space disables it.
      externalEgressEnabled: retrievalSettings.externalEgressEnabled,
    });
    return result as unknown as Record<string, unknown>;
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Math.floor(Number(value));
  }
  return null;
}
