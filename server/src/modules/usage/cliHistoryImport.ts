import type { ServerConfig } from "../../config.js";
import { HttpError } from "../routeUtils/common.js";
import { CliCredentialBroker } from "../providers/cli/credentialBroker.js";
import {
  readClaudeUsageImportEvents,
  readCodexUsageImportEvents,
  type CliUsageImportEvent,
  type CliUsageImportScan,
} from "../providers/index.js";
import { normalizeUsageObservation } from "./normalizer.js";
import type { PgUsageRepository } from "./repository.js";
import type { UsageIdentity } from "./service.js";
import type { UsageObservation } from "./types.js";

const PRIVACY_NOTICE =
  "Imports read local CLI transcript metadata for token usage only. Prompts, completions, tool output, raw transcript lines, absolute paths, environment variables, and credential contents are not imported.";

export interface CliHistoryImportPreviewInput {
  runtime?: string | null;
  sourceKind?: string | null;
  credentialProfileId?: string | null;
  targetSpaceId?: string | null;
}

export interface CliHistoryImportCommitInput {
  importBatchId?: string | null;
  targetSpaceId?: string | null;
  confirmation?: boolean;
}

export class CliHistoryImportService {
  private readonly broker: CliCredentialBroker;

  constructor(
    config: ServerConfig,
    private readonly repository: PgUsageRepository,
    broker?: CliCredentialBroker,
  ) {
    this.broker = broker ?? new CliCredentialBroker(config);
  }

  async preview(
    identity: UsageIdentity,
    input: CliHistoryImportPreviewInput,
  ): Promise<Record<string, unknown>> {
    const resolved = await this.scanManagedProfile(identity, input);
    const instanceId = await this.repository.getOrCreateInstanceId();
    const existing = await this.repository.countExistingIdempotencyKeys(
      resolved.targetSpaceId,
      resolved.scan.events.map((event) => event.idempotency_key),
    );
    const summary = previewSummary(resolved, existing);
    const batch = await this.repository.createImportBatch({
      instanceId,
      targetSpaceId: resolved.targetSpaceId,
      ownerUserId: identity.userId,
      sourceType: sourceTypeForRuntime(resolved.runtime),
      sourceKind: "managed_profile",
      sourceFingerprint: resolved.sourceFingerprint,
      previewSummary: summary,
    });

    return {
      import_batch_id: batch.id,
      status: batch.status,
      ...summary,
      privacy_notice: PRIVACY_NOTICE,
      confirmation_required: true,
    };
  }

  async commit(
    identity: UsageIdentity,
    input: CliHistoryImportCommitInput,
  ): Promise<Record<string, unknown>> {
    if (input.confirmation !== true) {
      throw new HttpError(422, "confirmation=true is required to commit a CLI history import");
    }
    const targetSpaceId = targetSpaceForIdentity(identity, input.targetSpaceId);
    const batchId = nonEmpty(input.importBatchId);
    if (!batchId) throw new HttpError(422, "import_batch_id is required");
    const batch = await this.repository.getImportBatch(batchId, targetSpaceId);
    if (!batch) throw new HttpError(404, "Usage import batch not found");
    if (batch.owner_user_id !== identity.userId) {
      throw new HttpError(403, "Usage import batch belongs to another user");
    }
    if (batch.status === "completed") {
      return {
        import_batch_id: batch.id,
        status: batch.status,
        ...batch.import_summary_json,
        privacy_notice: PRIVACY_NOTICE,
      };
    }
    if (batch.status !== "previewed" && batch.status !== "failed") {
      throw new HttpError(409, `Usage import batch is ${batch.status}`);
    }

    const previewInput = recordValue(batch.preview_summary_json.input);
    const resolved = await this.scanManagedProfile(identity, {
      runtime: stringValue(previewInput.runtime),
      sourceKind: stringValue(previewInput.source_kind),
      credentialProfileId: stringValue(previewInput.credential_profile_id),
      targetSpaceId,
    });
    const existingBefore = await this.repository.countExistingIdempotencyKeys(
      resolved.targetSpaceId,
      resolved.scan.events.map((event) => event.idempotency_key),
    );

    await this.repository.markImportBatchImporting(batch.id);
    try {
      const instanceId = await this.repository.getOrCreateInstanceId();
      for (const event of resolved.scan.events) {
        const normalized = normalizeUsageObservation(
          observationFromImportEvent(resolved, event, batch.id, identity.userId),
          instanceId,
          {
            owner_user_id: identity.userId,
            visibility: "private",
            access_level: "full",
            source_resource_type: null,
            source_resource_id: null,
            project_folder_id: null,
            project_id: null,
            grant_snapshots: [],
          },
        );
        await this.repository.appendEvent(normalized);
      }
      const summary = {
        ...previewSummary(resolved, existingBefore),
        imported_event_count: Math.max(0, resolved.scan.events.length - existingBefore),
      };
      const completed = await this.repository.completeImportBatch(batch.id, summary);
      return {
        import_batch_id: completed.id,
        status: completed.status,
        ...summary,
        privacy_notice: PRIVACY_NOTICE,
      };
    } catch (error) {
      await this.repository.failImportBatch(batch.id, {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async scanManagedProfile(
    identity: UsageIdentity,
    input: CliHistoryImportPreviewInput,
  ): Promise<ResolvedCliHistoryScan> {
    const runtime = normalizeRuntime(input.runtime);
    const sourceKind = input.sourceKind ?? "managed_profile";
    if (sourceKind !== "managed_profile") {
      throw new HttpError(422, `CLI history source_kind '${sourceKind}' is not supported yet`);
    }
    const targetSpaceId = targetSpaceForIdentity(identity, input.targetSpaceId);
    const profile = await this.broker.resolveProfile(
      runtime,
      input.credentialProfileId ?? null,
      true,
      targetSpaceId,
      identity.userId,
    );
    if (!profile) {
      throw new HttpError(404, "No readable managed CLI credential profile was found");
    }
    const sourceFingerprint = `managed_profile:${runtime}:${profile.id}`;
    const scan = runtime === "claude_code"
      ? await readClaudeUsageImportEvents(profile.source_path, sourceFingerprint)
      : await readCodexUsageImportEvents(profile.source_path, sourceFingerprint);
    return {
      runtime,
      sourceKind: "managed_profile",
      targetSpaceId,
      credentialProfileId: profile.id,
      credentialProfileName: profile.name,
      sourceFingerprint,
      scan,
    };
  }
}

interface ResolvedCliHistoryScan {
  runtime: "claude_code" | "codex_cli";
  sourceKind: "managed_profile";
  targetSpaceId: string;
  credentialProfileId: string;
  credentialProfileName: string;
  sourceFingerprint: string;
  scan: CliUsageImportScan;
}

function previewSummary(
  resolved: ResolvedCliHistoryScan,
  existingEventCount: number,
): Record<string, unknown> {
  const modelBreakdown = breakdownByModel(resolved.scan.events);
  return {
    input: {
      runtime: resolved.runtime,
      source_kind: resolved.sourceKind,
      credential_profile_id: resolved.credentialProfileId,
      target_space_id: resolved.targetSpaceId,
    },
    detected_runtime: resolved.runtime,
    source_kind: resolved.sourceKind,
    source_fingerprint: resolved.sourceFingerprint,
    credential_profile_id: resolved.credentialProfileId,
    credential_profile_name: resolved.credentialProfileName,
    target_space_id: resolved.targetSpaceId,
    date_range: resolved.scan.date_range,
    totals: totalsForEvents(resolved.scan.events),
    model_breakdown: modelBreakdown,
    token_totals_by_accuracy: {
      transcript_lower_bound: totalsForEvents(resolved.scan.events),
    },
    session_count: resolved.scan.session_count,
    candidate_event_count: resolved.scan.candidate_event_count,
    duplicate_count: resolved.scan.duplicate_count + existingEventCount,
    existing_event_count: existingEventCount,
    unsupported_file_count: resolved.scan.unsupported_file_count,
    unreadable_file_count: resolved.scan.unreadable_file_count,
  };
}

function observationFromImportEvent(
  resolved: ResolvedCliHistoryScan,
  event: CliUsageImportEvent,
  importBatchId: string,
  userId: string,
): UsageObservation {
  return {
    space_id: resolved.targetSpaceId,
    event_type: "cli.history_usage",
    source_type: "cli_history_import",
    execution_channel: "local_cli_transcript",
    meter_subject_type: "session",
    meter_subject_id: event.external_session_id,
    subject_user_id: userId,
    adapter_type: event.runtime,
    vendor: event.runtime === "claude_code" ? "anthropic" : "openai",
    model: event.model,
    external_session_id: event.external_session_id,
    session_path: event.session_path,
    session_name: event.session_name,
    occurred_at: event.occurred_at,
    usage_details: event.usage_details,
    provider_usage: event.provider_usage,
    usage_accuracy: "transcript_lower_bound",
    dedupe_confidence: event.dedupe_confidence,
    import_batch_id: importBatchId,
    idempotency_key: event.idempotency_key,
    dimensions: {
      ...event.dimensions,
      source_kind: resolved.sourceKind,
      credential_profile_id: resolved.credentialProfileId,
    },
    metadata: event.metadata,
  };
}

function totalsForEvents(events: CliUsageImportEvent[]): Record<string, number> {
  const totals = {
    event_count: events.length,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
  };
  for (const event of events) {
    const input = intValue(event.usage_details.input);
    const output = intValue(event.usage_details.output);
    const cacheCreate = intValue(event.usage_details.input_cache_creation);
    const cacheRead = intValue(event.usage_details.input_cache_read);
    totals.input_tokens += input;
    totals.output_tokens += output;
    totals.cache_creation_input_tokens += cacheCreate;
    totals.cache_read_input_tokens += cacheRead;
    totals.total_tokens += input + output + cacheCreate + cacheRead;
  }
  return totals;
}

function breakdownByModel(events: CliUsageImportEvent[]): Array<Record<string, unknown>> {
  const byModel = new Map<string, { model: string; totals: Record<string, number> }>();
  for (const event of events) {
    const key = event.model ?? "unknown";
    let entry = byModel.get(key);
    if (!entry) {
      entry = { model: key, totals: totalsForEvents([]) };
      byModel.set(key, entry);
    }
    const totals = totalsForEvents([event]);
    for (const [field, value] of Object.entries(totals)) {
      entry.totals[field] = intValue(entry.totals[field]) + intValue(value);
    }
  }
  return [...byModel.values()].sort((a, b) =>
    intValue(b.totals.total_tokens) - intValue(a.totals.total_tokens),
  );
}

function normalizeRuntime(value: string | null | undefined): "claude_code" | "codex_cli" {
  if (value === "claude_code" || value === "codex_cli") return value;
  throw new HttpError(422, "runtime must be claude_code or codex_cli");
}

function sourceTypeForRuntime(runtime: "claude_code" | "codex_cli"): string {
  return runtime === "claude_code" ? "claude_code_history" : "codex_cli_history";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function targetSpaceForIdentity(identity: UsageIdentity, requested: string | null | undefined): string {
  const targetSpaceId = nonEmpty(requested) ?? identity.spaceId;
  if (targetSpaceId !== identity.spaceId) {
    throw new HttpError(403, "Switch to the target Space before importing usage");
  }
  return targetSpaceId;
}

function intValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}
