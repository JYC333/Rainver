import type { ServerConfig } from "../../config";
import { getDbPool, type Pool } from "../../db/pool";
import { createManagedExecutionPolicy } from "../policy/managedExecutionPolicy";
import { PgCodePatchCollector, PgRunSandboxManager } from "../projectFolders";
import { RunMaterializationService } from "../runs/materializationService";
import { RunOrchestrationService } from "../runs/orchestrationService";
import { runOutputResult } from "../runs/orchestrationResults";
import { sharedCliProcessRegistry } from "../runs/processRegistry";
import { PgRunRepository, type RunRecord } from "../runs/repository";
import { PgVerificationEngine } from "../runs/verification";
import { HttpError, type Queryable } from "../routeUtils/common";
import { CONNECTION_COLUMNS, type SourceConnectionRow } from "../sources/sourceRepositoryRows";
import { assertSourcePromptEgressAllowed } from "../sources/sourcePromptEgress";
import { ensureSourceAnnotatorAgent, resolveSystemActorUserId } from "./agent";
import { renderAnnotationInstruction, type AnnotationPromptItem } from "./instruction";
import { PgSourceAnnotationRepository, type PendingAnnotationRow } from "./repository";
import {
  SOURCE_ANNOTATION_SCHEMA_ID,
  SourceAnnotationParseError,
  parseSourceAnnotationResult,
  sourceAnnotationOutputContract,
} from "./resultParser";

/**
 * How many items go into one annotation request.
 *
 * Matches the batch size Project Research screening settled on. Larger batches
 * make one provider hiccup cost more items and push the prompt toward the
 * context limit, where the model starts dropping entries from the tail
 * silently.
 */
export const ANNOTATION_BATCH_SIZE = 10;

/** Attempts before an item is parked as `failed` rather than retried forever. */
export const ANNOTATION_MAX_ATTEMPTS = 3;

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
  async annotatePendingBatch(spaceId: string): Promise<AnnotationSweepResult> {
    const repo = new PgSourceAnnotationRepository(this.db);
    const batch = await repo.loadPendingBatch(spaceId, ANNOTATION_BATCH_SIZE);
    if (batch.length === 0) {
      return { space_id: spaceId, requested: 0, annotated: 0, skipped: 0, failed: 0, run_id: null, status: "no_work" };
    }
    const itemIds = batch.map((row) => row.id);

    let agentId: string;
    try {
      agentId = (await ensureSourceAnnotatorAgent(this.requirePool(), spaceId)).id;
    } catch {
      // Not the items' fault, so it must not spend their retry budget. A space
      // with no model provider yet is the ordinary cold-start state; these rows
      // wait, and get annotated once one is configured. Charging an attempt
      // here would park a new space's first three sweeps' worth of material as
      // permanently failed before the user finished setting up.
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
    const allowedItemIds = await this.filterItemsByEgress(spaceId, itemIds, agentId, repo);
    if (allowedItemIds.length === 0) {
      return { space_id: spaceId, requested: itemIds.length, annotated: 0, skipped: itemIds.length, failed: 0, run_id: null, status: "blocked", reason: "source_egress_denied" };
    }
    const allowed = new Set(allowedItemIds);
    const promptItems: AnnotationPromptItem[] = batch
      .filter((row) => allowed.has(row.id))
      .map(toPromptItem);

    let run: RunRecord;
    try {
      run = await this.executeAnnotationRun(spaceId, agentId, promptItems);
    } catch (error) {
      await repo.markAttemptFailed(
        spaceId,
        allowedItemIds,
        { error_code: "annotation_run_failed", message: errorMessage(error) },
        ANNOTATION_MAX_ATTEMPTS,
        null,
      );
      return { space_id: spaceId, requested: itemIds.length, annotated: 0, skipped: 0, failed: allowedItemIds.length, run_id: null, status: "blocked", reason: "annotation_run_failed" };
    }

    if (run.status !== "succeeded" && run.status !== "degraded") {
      await repo.markAttemptFailed(
        spaceId,
        allowedItemIds,
        { error_code: "agent_run_failed", agent_run_status: run.status, agent_run_id: run.id },
        ANNOTATION_MAX_ATTEMPTS,
        run.id,
      );
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
        ANNOTATION_MAX_ATTEMPTS,
        run.id,
      );
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
    const denied = new Set<string>();
    if (byConnection.size > 0) {
      const connections = await this.loadConnections(spaceId, [...byConnection.keys()]);
      for (const [connectionId, connectionItemIds] of byConnection) {
        const connection = connections.get(connectionId);
        if (!connection) {
          for (const id of connectionItemIds) denied.add(id);
          continue;
        }
        try {
          await assertSourcePromptEgressAllowed(this.db, connection, agentId);
        } catch {
          for (const id of connectionItemIds) denied.add(id);
        }
      }
    }
    if (denied.size > 0) {
      await repo.markSkipped(spaceId, [...denied], "source_egress_denied", null);
    }
    return itemIds.filter((id) => !denied.has(id));
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
  ): Promise<RunRecord> {
    const pool = this.requirePool();
    const instruction = renderAnnotationInstruction(items);
    const runs = new PgRunRepository(pool);
    const run = await runs.createQueuedRun({
      space_id: spaceId,
      user_id: await resolveSystemActorUserId(pool, spaceId),
      agent_id: agentId,
      project_id: null,
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
        source: { kind: "direct", id: `source_annotation:${spaceId}` },
        project_id: null,
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
