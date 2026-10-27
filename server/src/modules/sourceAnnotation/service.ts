import { consumeMonitoringBudget } from "../projects/monitoringControl.js";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import { createManagedExecutionPolicy } from "../policy/managedExecutionPolicy.js";
import { PgCodePatchCollector, PgRunSandboxManager } from "../projectFolders/index.js";
import { RunMaterializationService } from "../runs/materializationService.js";
import { RunOrchestrationService } from "../runs/orchestrationService.js";
import { runOutputResult } from "../runs/orchestrationResults.js";
import { sharedCliProcessRegistry } from "../runs/processRegistry.js";
import { PgRunRepository, type RunRecord } from "../runs/repository.js";
import { PgVerificationEngine } from "../runs/verification/index.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { CONNECTION_COLUMNS, type SourceConnectionRow } from "../sources/sourceRepositoryRows.js";
import { assertSourcePromptEgressAllowed, SOURCE_EGRESS_NOT_CONSENTED } from "../sources/sourcePromptEgress.js";
import { ensureSourceAnnotatorAgent, resolveSystemActorUserId } from "./agent.js";
import { renderAnnotationInstruction, type AnnotationPromptItem } from "./instruction.js";
import { SourceAnnotationRecoveryNotifier } from "./notifier.js";
import { PgSourceAnnotationRepository, type PendingAnnotationRow } from "./repository.js";
import { ANNOTATION_MANUAL_RETRY_LIMIT, type AnnotationWaitReason } from "./retryPolicy.js";
import {
  SOURCE_ANNOTATION_SCHEMA_ID,
  SourceAnnotationParseError,
  parseSourceAnnotationResult,
  sourceAnnotationOutputContract,
} from "./resultParser.js";

/**
 * How many items go into one annotation request.
 *
 * Larger batches make one provider hiccup cost more items and push the prompt
 * toward the context limit, where the model starts dropping entries from the
 * tail silently.
 */
const ANNOTATION_BATCH_SIZE = 10;

export interface AnnotationSweepResult {
  space_id: string;
  requested: number;
  annotated: number;
  skipped: number;
  failed: number;
  run_id: string | null;
  status: "ok" | "no_work" | "blocked";
  reason?: string;
}

export class SourceAnnotationService {
  private readonly pool: Pool | null;

  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {
    this.pool = config.databaseUrl ? getDbPool(config.databaseUrl) : null;
  }

  /**
   * Annotates one batch of pending items in a space.
   *
   * Returns rather than throws for the ordinary "nothing to do" and "cannot run
   * here" cases: annotation is a background pass over material the user already
   * has, and a space without a model provider is a normal state, not a fault
   * worth failing a job over and retrying forever.
   */
  async annotatePendingBatch(spaceId: string, monitoring?: {itemIds:string[];agentId:string;operationId:string;projectId:string;userId:string}): Promise<AnnotationSweepResult> {
    const repo = new PgSourceAnnotationRepository(this.db);
    const batch = await repo.loadPendingBatch(spaceId, ANNOTATION_BATCH_SIZE, monitoring?.itemIds);
    if (batch.length === 0) {
      return { space_id: spaceId, requested: 0, annotated: 0, skipped: 0, failed: 0, run_id: null, status: "no_work" };
    }
    const itemIds = batch.map((row) => row.id);

    let agentId: string;
    try {
      agentId = monitoring?.agentId ?? (await ensureSourceAnnotatorAgent(this.requirePool(), spaceId)).id;
    } catch {
      // Not the items' fault, so it must not spend their retry budget. A space
      // with no model provider yet is the ordinary cold-start state; these rows
      // wait on the condition — no countdown, no attempt — and the sweep
      // reopens them once a Provider is configured.
      await repo.markWaiting(spaceId, itemIds, "provider_unavailable", { detail: "annotator_agent_unavailable" });
      await this.notify(spaceId);
      return {
        space_id: spaceId,
        requested: itemIds.length,
        annotated: 0,
        skipped: 0,
        failed: 0,
        run_id: null,
        status: "blocked",
        reason: "annotator_agent_unavailable",
      };
    }

    // Consent is per connection, so every connection contributing to this batch
    // has to allow the destination. An item whose connection refuses is dropped
    // from the batch rather than failing it — one governed source must not stop
    // the rest of the space being annotated.
    let allowedItemIds: string[];
    try {
      allowedItemIds = await this.filterItemsByEgress(spaceId, itemIds, agentId, repo);
    } catch (error) {
      // A 409 means the annotator itself cannot be resolved to a destination
      // (no enabled runtime profile, provider not granted here). Like a missing
      // agent, that is the space's setup, not the items, so they keep waiting
      // with their retry budget intact.
      if (error instanceof HttpError && error.statusCode === 409) {
        await repo.markWaiting(spaceId, itemIds, "provider_unavailable", { detail: "annotator_profile_unavailable" });
        await this.notify(spaceId);
        return { space_id: spaceId, requested: itemIds.length, annotated: 0, skipped: 0, failed: 0, run_id: null, status: "blocked", reason: "annotator_profile_unavailable" };
      }
      throw error;
    }
    if (allowedItemIds.length === 0) {
      await this.notify(spaceId);
      // Every item now waits on its Source's condition and left the runnable
      // queue, so this batch made progress: the job goes on to the next batch
      // — items from sources that do allow egress — instead of ending here.
      return { space_id: spaceId, requested: itemIds.length, annotated: 0, skipped: itemIds.length, failed: 0, run_id: null, status: "ok", reason: "source_egress_denied" };
    }
    const allowed = new Set(allowedItemIds);
    const promptItems: AnnotationPromptItem[] = batch
      .filter((row) => allowed.has(row.id))
      .map(toPromptItem);

    // A quota refusal is not a failed model attempt and must not spend annotation retries.
    if(monitoring) await consumeMonitoringBudget(this.db,spaceId,monitoring.operationId,'model_runs',1);
    let run: RunRecord;
    try {
      run = await this.executeAnnotationRun(spaceId, agentId, promptItems, monitoring);
    } catch (error) {
      await repo.markAttemptFailed(
        spaceId,
        allowedItemIds,
        { error_code: "annotation_run_failed", message: errorMessage(error) },
        null,
      );
      await this.notify(spaceId);
      return { space_id: spaceId, requested: itemIds.length, annotated: 0, skipped: 0, failed: allowedItemIds.length, run_id: null, status: "blocked", reason: "annotation_run_failed" };
    }

    if (run.status !== "succeeded" && run.status !== "degraded") {
      await repo.markAttemptFailed(
        spaceId,
        allowedItemIds,
        { error_code: "agent_run_failed", agent_run_status: run.status, agent_run_id: run.id },
        run.id,
      );
      await this.notify(spaceId);
      return { space_id: spaceId, requested: itemIds.length, annotated: 0, skipped: 0, failed: allowedItemIds.length, run_id: run.id, status: "blocked", reason: "agent_run_failed" };
    }

    let parsed;
    try {
      parsed = parseSourceAnnotationResult(structuredRunOutput(run), allowedItemIds);
    } catch (error) {
      const code = error instanceof SourceAnnotationParseError ? error.code : "unparseable_output";
      await repo.markAttemptFailed(
        spaceId,
        allowedItemIds,
        { error_code: code, message: errorMessage(error) },
        run.id,
      );
      await this.notify(spaceId);
      return { space_id: spaceId, requested: itemIds.length, annotated: 0, skipped: 0, failed: allowedItemIds.length, run_id: run.id, status: "blocked", reason: code };
    }

    for (const annotation of parsed.annotations) {
      await repo.markSucceeded(spaceId, annotation, run.id);
    }
    // An item the model returned nothing usable for is parked rather than
    // retried: the same prompt would produce the same non-answer, and a
    // permanently pending row hides the item from every diagnostic.
    const annotatedIds = new Set(parsed.annotations.map((entry) => entry.source_item_id));
    const unanswered = allowedItemIds.filter((id) => !annotatedIds.has(id));
    await repo.markSkipped(spaceId, unanswered, "no_usable_annotation", run.id);
    // Items that succeeded leave their episode; the notice shrinks or clears.
    await this.notify(spaceId);

    return {
      space_id: spaceId,
      requested: itemIds.length,
      annotated: parsed.annotations.length,
      skipped: unanswered.length + (itemIds.length - allowedItemIds.length),
      failed: 0,
      run_id: run.id,
      status: "ok",
    };
  }

  private async filterItemsByEgress(
    spaceId: string,
    itemIds: readonly string[],
    agentId: string,
    repo: PgSourceAnnotationRepository,
  ): Promise<string[]> {
    const byConnection = await repo.connectionIdsForItems(spaceId, itemIds);
    // An item with no connection is a manually saved URL the user entered
    // themselves; there is no source consent record to consult and no third
    // party whose policy could be violated.
    const egressDenied: string[] = [];
    const consentMissing: string[] = [];
    if (byConnection.size > 0) {
      const connections = await this.loadConnections(spaceId, [...byConnection.keys()]);
      for (const [connectionId, connectionItemIds] of byConnection) {
        const connection = connections.get(connectionId);
        if (!connection) {
          // No readable connection, so no consent to ship its content.
          consentMissing.push(...connectionItemIds);
          continue;
        }
        try {
          await assertSourcePromptEgressAllowed(this.db, connection, agentId);
        } catch (error) {
          // Only the gate's refusal makes items wait. Anything else — a
          // profile that cannot be resolved, a failed query — is not a
          // decision about this source and must not park its items.
          if (!(error instanceof HttpError && error.statusCode === 403)) throw error;
          const code = (error.responseBody as { code?: unknown } | undefined)?.code;
          (code === SOURCE_EGRESS_NOT_CONSENTED ? consentMissing : egressDenied).push(...connectionItemIds);
        }
      }
    }
    // Refused for now, not forever: the Space egress setting or the Source's
    // consent that refused is the owner's to change, and the sweep and a
    // manual retry re-check it before any model call.
    await repo.markWaiting(spaceId, egressDenied, "egress_denied");
    await repo.markWaiting(spaceId, consentMissing, "consent_missing");
    const denied = new Set([...egressDenied, ...consentMissing]);
    return itemIds.filter((id) => !denied.has(id));
  }

  /**
   * Re-checks the conditions parked rows wait on and reopens the rows whose
   * condition now holds. No model call and no attempt spent: an annotator
   * that still cannot be resolved, or a Source whose egress is still refused,
   * leaves its rows exactly where they were. Returns how many rows reopened.
   */
  async recoverWaiting(
    spaceId: string,
    filter: { connectionId?: string | null; responsibleUserId?: string | null; limit?: number } = {},
  ): Promise<number> {
    const repo = new PgSourceAnnotationRepository(this.db);
    const limit = filter.limit ?? ANNOTATION_MANUAL_RETRY_LIMIT;
    let reopened = 0;
    let agentId: string | null = null;
    try {
      agentId = (await ensureSourceAnnotatorAgent(this.requirePool(), spaceId)).id;
    } catch {
      agentId = null;
    }
    if (agentId) {
      reopened += await repo.requeueParked(spaceId, {
        reasons: ["provider_unavailable"],
        connectionId: filter.connectionId,
        responsibleUserId: filter.responsibleUserId,
        limit: limit - reopened,
      });
      const waiting = await repo.waitingConnectionIds(spaceId, ["egress_denied", "consent_missing"]);
      const candidates = filter.connectionId ? waiting.filter((id) => id === filter.connectionId) : waiting;
      const connections = await this.loadConnections(spaceId, candidates);
      for (const [connectionId, connection] of connections) {
        if (reopened >= limit) break;
        let allowed = false;
        try {
          await assertSourcePromptEgressAllowed(this.db, connection, agentId);
          allowed = true;
        } catch (error) {
          // Still refused, or the profile is unresolved: the wait holds.
          if (!(error instanceof HttpError)) throw error;
        }
        if (allowed) {
          reopened += await repo.requeueParked(spaceId, {
            reasons: ["egress_denied", "consent_missing"],
            connectionId,
            responsibleUserId: filter.responsibleUserId,
            limit: limit - reopened,
          });
        }
      }
    }
    await this.notify(spaceId);
    return reopened;
  }

  /**
   * A person's retry of their own items: re-checks the conditions, reopens
   * paused rows with a fresh episode (the one way the attempt count starts
   * over) and scheduled ones now, at most `ANNOTATION_MANUAL_RETRY_LIMIT`
   * rows. The work itself is left to the queued job, which runs one space at
   * a time, so a retry beside a background pass does not annotate twice.
   */
  async manualRetry(
    spaceId: string,
    responsibleUserId: string,
    filter: { episodeId?: string | null; connectionId?: string | null } = {},
  ): Promise<{ reopened: number }> {
    const repo = new PgSourceAnnotationRepository(this.db);
    let reopened = await this.recoverWaiting(spaceId, { connectionId: filter.connectionId, responsibleUserId });
    const reasons: AnnotationWaitReason[] = ["budget_exhausted", "retry_scheduled"];
    reopened += await repo.requeueParked(spaceId, {
      reasons,
      episodeId: filter.episodeId,
      connectionId: filter.connectionId,
      responsibleUserId,
      limit: Math.max(0, ANNOTATION_MANUAL_RETRY_LIMIT - reopened),
    });
    await this.notify(spaceId);
    return { reopened };
  }

  private async notify(spaceId: string): Promise<void> {
    await new SourceAnnotationRecoveryNotifier(this.db).sync(spaceId);
  }

  private async loadConnections(spaceId: string, connectionIds: string[]): Promise<Map<string, SourceConnectionRow>> {
    if (connectionIds.length === 0) return new Map();
    const result = await this.db.query<SourceConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM source_connections
        WHERE space_id = $1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
      [spaceId, connectionIds],
    );
    return new Map(result.rows.map((row) => [row.id, row]));
  }

  private async executeAnnotationRun(
    spaceId: string,
    agentId: string,
    items: readonly AnnotationPromptItem[],
    monitoring?: {operationId:string;projectId:string;userId:string},
  ): Promise<RunRecord> {
    const pool = this.requirePool();
    const instruction = renderAnnotationInstruction(items);
    const runs = new PgRunRepository(pool);
    const run = await runs.createQueuedRun({
      execution_kind: "agent",
      space_id: spaceId,
      user_id: monitoring?.userId ?? await resolveSystemActorUserId(pool, spaceId),
      agent_id: agentId,
      project_id: monitoring?.projectId ?? null,
      project_folder_id: null,
      prompt: "Classify incoming source material.",
      instruction,
      // Sources-owned background job, like post-processing: the user's decision
      // to subscribe to the source is the authorization, and the run contract
      // carries it so the credential gate does not ask a second time.
      trigger_origin: "job",
      run_type: "agent",
      mode: "live",
      runtime_profile_id: null,
      contract_snapshot: {
        source: { kind: "direct", id: monitoring?.operationId ?? `source_annotation:${spaceId}` },
        ...(monitoring?{budget_sources:[{source:{kind:'direct',id:monitoring.operationId},max_attempts:1,max_duration_seconds:1800}]}:{}),
        project_id: monitoring?.projectId ?? null,
        structured_output_json: sourceAnnotationOutputContract(),
        policy_context_json: createManagedExecutionPolicy("source_annotation", true),
      },
    });
    const orchestration = new RunOrchestrationService(this.config, runs, {
      materializer: RunMaterializationService.fromConfig(this.config),
      workspaceManager: PgRunSandboxManager.fromConfig(this.config),
      codePatchCollector: PgCodePatchCollector.fromConfig(this.config),
      verificationEngine: PgVerificationEngine.fromConfig(this.config),
      processRegistry: sharedCliProcessRegistry,
    });
    await orchestration.executeRun({
      run_id: run.id,
      space_id: spaceId,
      worker_id: `source_annotation:${run.id}`,
      job_id: null,
      command_source: "internal",
      prompt: instruction,
      // The runtime prompt is the rendered batch; the run's goal is the query.
      retrieval_intent: run.prompt,
    });
    const finished = await runs.getRun(spaceId, run.id);
    if (!finished) throw new Error("Annotation run disappeared after execution");
    return finished;
  }

  private requirePool(): Pool {
    if (!this.pool) throw new HttpError(503, "Database is not configured");
    return this.pool;
  }
}

function toPromptItem(row: PendingAnnotationRow): AnnotationPromptItem {
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    author: row.author,
    source_domain: row.source_domain,
    occurred_at: row.occurred_at,
  };
}

/**
 * `canonicalRunOutput()` nests the model result under `.result` inside a
 * `run_output.v1` envelope. Reading `output_json` directly sees the envelope
 * and every field lookup below it comes back undefined.
 */
function structuredRunOutput(run: RunRecord): string {
  const output = runOutputResult(run.output_json);
  if (output.schema !== SOURCE_ANNOTATION_SCHEMA_ID) {
    throw new SourceAnnotationParseError(
      "unexpected_schema",
      `structured output schema must be ${SOURCE_ANNOTATION_SCHEMA_ID}`,
    );
  }
  return JSON.stringify(output);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
