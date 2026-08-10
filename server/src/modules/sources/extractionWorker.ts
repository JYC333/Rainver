import { createHash, randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ServerConfig } from "../../config";
import type { Queryable } from "../routeUtils/common";
import { HttpError } from "../routeUtils/common";
import { type SourceConnectionRow } from "./sourceRepositoryRows";
import {
  extractStructuredReaderContent,
  type StructuredReaderContent,
} from "./contentParsing";
import { extractPdfReaderContent } from "./pdfExtract";
import { arxivHtmlUrl, arxivPdfUrl, parseArxivReference } from "./connectors/arxiv";
import { acquireArxivRequestSlot } from "./connectors/arxivThrottle";
import { fetchSource, type SourceFetchResult } from "./sourceFetch";
import { normalizeUrl, sourceDomain } from "./sourceRepositoryMappers";
import { projectSourceRoutingHook } from "../projects/projectSourceRoutingRegistry";
import {
  emitSourcePostProcessingDeepAnalysisEvent,
  emitSourcePostProcessingEvent,
} from "./postProcessing/eventEmitter";
import { enqueueItemsForAnnotation } from "../sourceAnnotation";
import {
  reindexExtractedEvidenceAndParentForRetrieval,
  reindexSourceItemAndEvidenceForRetrieval,
} from "./retrievalIndexing";
import { computeNextCheckAt } from "./sourceScanCadence";
import {
  fetchSourceConnection,
  SourceFetchFailure,
  type SourceFetchFailureDiagnostics,
} from "./sourceConnectionFetch";
import {
  getSourceChannelScanTask,
  upsertSourceChannelScanTask,
} from "./sourceConnectionScheduler";
import {
  enforceSourceRetentionPolicy,
  normalizeSourceConnectionReadGovernance,
} from "./sourceConsent";
import { PgCustomSourceHandlerRepository } from "./customSources/customSourceHandlerRepository";
import { capturePolicyScanState } from "./capturePolicy";
import { inheritContentAccessGrants } from "../access/contentAccessInheritance";
import { sourceConnectorRegistry, type SourceConnectorHandler } from "./catalog/sourceConnectorRegistry";
import { ProjectResearchPipelineService } from "../projectResearch/pipeline/researchPipelineService";
import { CustomSourceCredentialService } from "./customSources/customSourceCredentialService";
import { upsertCanonicalEvidence } from "./evidenceIdentity";

interface ExtractionJobRow {
  id: string;
  space_id: string;
  connection_id: string | null;
  source_item_id: string | null;
  source_object_type: string | null;
  source_object_id: string | null;
  job_type: string;
  status: string;
  metadata_json: Record<string, unknown> | null;
}

interface SourceItemRow {
  id: string;
  space_id: string;
  project_id: string | null;
  connection_id: string | null;
  source_uri: string | null;
  canonical_uri: string | null;
  source_external_id: string | null;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  occurred_at: unknown;
  content_state: string;
  visibility: string;
}

const JOB_COLUMNS = `
  id, space_id, connection_id, source_item_id, source_object_type, source_object_id,
  job_type, status, metadata_json
`;

const CONNECTION_SCAN_CHILD_JOB_LIMIT = 25;

interface ConnectionWithConnectorRow extends SourceConnectionRow {
  connector_key: string;
  provider_key: string;
  provider_display_name: string;
  channel_type: string | null;
  endpoint_url: string | null;
  fetch_frequency: string;
  schedule_rule_json: unknown;
  provider_query_json: unknown;
  channel_id: string | null;
}

interface ScanCursor {
  etag?: string;
  last_modified?: string;
  last_guid?: string;
  last_published_at?: string;
  cursor?: string;
  offset?: number;
  overlap_hours?: number;
}

export class SourceExtractionWorker {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  async runPendingJob(jobId: string, spaceId: string): Promise<ExtractionJobRow> {
    const now = new Date().toISOString();
    const claimed = await this.db.query<ExtractionJobRow>(
      `UPDATE extraction_jobs
          SET status = 'running',
              started_at = $3
        WHERE id = $1
          AND space_id = $2
          AND status = 'pending'
        RETURNING ${JOB_COLUMNS}`,
      [jobId, spaceId, now],
    );
    const job = claimed.rows[0];
    if (!job) {
      const current = await this.getJob(jobId, spaceId);
      if (!current) throw new HttpError(404, "Extraction job not found");
      if (current.status === "running") throw new HttpError(409, `ExtractionJob ${jobId} is already running`);
      if (["succeeded", "failed", "skipped"].includes(current.status)) return current;
      throw new HttpError(409, `Unexpected ExtractionJob status ${current.status}`);
    }

    let runChildrenAfterSuccess = false;
    let connectionScanResult: { seen: number; page_size: number } | null = null;
    try {
      if (job.job_type === "connection_scan") {
        connectionScanResult = await this.executeConnectionScan(job);
      } else if (job.job_type === "manual_url" || job.job_type === "extract_text") {
        await this.executeTextExtraction(job);
        await emitSourcePostProcessingDeepAnalysisEvent(this.db, {
          spaceId: job.space_id,
          sourceChannelId: stringValue(record(job.metadata_json).source_channel_id),
          sourceItemId: job.source_item_id,
          metadata: job.metadata_json,
        });
      } else if (job.job_type === "snapshot") {
        await this.executeSnapshot(job);
      } else if (
        ["normalize_activity", "normalize_artifact", "normalize_run_event"].includes(job.job_type)
      ) {
        await this.executeInternalNormalization(job);
      } else {
        throw new HttpError(422, `Unsupported pending job_type: ${job.job_type}`);
      }
      await this.finishJob(jobId, spaceId, "succeeded", null, null);
      runChildrenAfterSuccess = job.job_type === "connection_scan";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof HttpError ? String(error.statusCode) : "run_error";
      if (error instanceof SourceFetchFailure) {
        await this.recordJobFailureDiagnostics(job, error.diagnostics);
      }
      await this.finishJob(jobId, spaceId, "failed", code, message);
      if (job.job_type === "connection_scan" && job.connection_id) {
        await this.recordFailedConnectionScan(job);
      }
      if (job.source_item_id) {
        await this.db.query(
          `UPDATE source_items SET content_state = 'extraction_failed', updated_at = $3
           WHERE space_id = $1 AND id = $2`,
          [spaceId, job.source_item_id, new Date().toISOString()],
        );
      }
    }
    if (runChildrenAfterSuccess) {
      if (connectionScanResult) await this.queueBackfillContinuationIfNeeded(job, connectionScanResult);
      await this.runPendingConnectionScanChildren(job);
    }

    const updated = await this.getJob(jobId, spaceId);
    if (!updated) throw new HttpError(404, "Extraction job not found");
    return updated;
  }

  private async getJob(jobId: string, spaceId: string): Promise<ExtractionJobRow | null> {
    const result = await this.db.query<ExtractionJobRow>(
      `SELECT ${JOB_COLUMNS} FROM extraction_jobs WHERE id = $1 AND space_id = $2`,
      [jobId, spaceId],
    );
    return result.rows[0] ?? null;
  }

  private async runPendingConnectionScanChildren(job: ExtractionJobRow): Promise<void> {
    const children = await this.db.query<{ id: string }>(
      `SELECT id
         FROM extraction_jobs
        WHERE space_id = $1
          AND status = 'pending'
          AND metadata_json->>'parent_job_id' = $2
        ORDER BY created_at ASC, id ASC
        LIMIT $3`,
      [job.space_id, job.id, CONNECTION_SCAN_CHILD_JOB_LIMIT],
    );
    for (const child of children.rows) {
      try {
        await this.runPendingJob(child.id, job.space_id);
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 409) continue;
        throw error;
      }
    }
  }

  private async queueFailedFollowUpsForConnection(
    job: ExtractionJobRow,
    connection: ConnectionWithConnectorRow,
    createdAt: string,
  ): Promise<void> {
    if (!this.isManualScan(job)) return;
    const policy = capturePolicyScanState(connection.capture_policy);
    if (!policy.followUpJobType) return;
    if (policy.retention !== "metadata_only") {
      enforceSourceRetentionPolicy(
        normalizeSourceConnectionReadGovernance(connection).policy,
        policy.retention,
      );
    }
    const failedItems = await this.db.query<{ id: string }>(
      `SELECT id
         FROM source_items
        WHERE space_id = $1
          AND connection_id = $2
          AND content_state = 'extraction_failed'
          AND deleted_at IS NULL
        ORDER BY updated_at ASC, id ASC
        LIMIT $3`,
      [job.space_id, connection.id, CONNECTION_SCAN_CHILD_JOB_LIMIT],
    );
    for (const item of failedItems.rows) {
      const hasActiveFollowUp = await this.hasActiveFollowUpJob(job.space_id, item.id, policy.followUpJobType);
      if (hasActiveFollowUp) continue;
      await this.db.query(
        `UPDATE source_items
            SET content_state = $3,
                retention_policy = CASE
                  WHEN retention_policy IN ('metadata_only', 'summary_only') THEN $4
                  ELSE retention_policy
                END,
                updated_at = $5
          WHERE space_id = $1
            AND id = $2
            AND content_state = 'extraction_failed'`,
        [job.space_id, item.id, policy.contentState, policy.retention, createdAt],
      );
      await this.createExtractionJob({
        spaceId: job.space_id,
        connectionId: connection.id,
        sourceItemId: item.id,
        sourceSnapshotId: null,
        jobType: policy.followUpJobType,
        metadata: {
          created_by: "connection_scan_retry",
          parent_job_id: job.id,
          retry_reason: "previous_extraction_failed",
        },
        createdAt,
      });
    }
  }

  private async finishJob(
    jobId: string,
    spaceId: string,
    status: string,
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE extraction_jobs
          SET status = $3,
              completed_at = $4,
              error_code = $5,
              error_message = $6
        WHERE id = $1 AND space_id = $2`,
      [jobId, spaceId, status, now, errorCode, errorMessage],
    );
  }

  private async executeConnectionScan(job: ExtractionJobRow): Promise<{ seen: number; page_size: number }> {
    if (!job.connection_id) throw new HttpError(422, "connection_scan requires connection_id");
    const channelId = stringValue(record(job.metadata_json).source_channel_id);
    const connection = await this.getConnection(job.space_id, job.connection_id, channelId);
    if (connection.channel_type === "search" && !connection.provider_query_json) {
      throw new HttpError(422, "Search channel is missing its executable Search Spec");
    }
    if (connection.channel_type !== "search" && !connection.endpoint_url) {
      throw new HttpError(422, "Source connection is missing endpoint_url");
    }
    const schedulerTask = connection.channel_id
      ? await getSourceChannelScanTask(this.db, connection.channel_id)
      : null;
    const cursor = scanCursor(schedulerTask?.metadata_json);
    const headers: Record<string, string> = {};
    if (cursor.etag) headers["If-None-Match"] = cursor.etag;
    if (cursor.last_modified) headers["If-Modified-Since"] = cursor.last_modified;

    const handler = sourceConnectorRegistry.get(connection.connector_key);
    const executableChannel = {
      endpoint_url: connection.endpoint_url,
      compiled_query: connection.provider_query_json,
    };
    const request = isBackfillJob(job)
      ? handler.buildBackfillRequest(executableChannel, record(record(job.metadata_json).window), cursor as unknown as Record<string, unknown>)
      : handler.buildScanRequest(executableChannel, cursor as unknown as Record<string, unknown>);
    const credential = await new CustomSourceCredentialService(this.db, this.config)
      .resolveCredentialHeader(job.space_id, connection.credential_id);
    const requestHeaders = { ...headers, ...(request.headers ?? {}) };
    if (credential) requestHeaders[credential.header_name] = credential.header_value;
    const response = await fetchSourceConnection({
      handler,
      url: request.url,
      headers: requestHeaders,
      maxDownloadBytes: await this.maxDownloadBytes(job.space_id),
      backfill: isBackfillJob(job),
      provider: {
        providerKey: connection.provider_key,
        providerDisplayName: connection.provider_display_name,
        connectorKey: connection.connector_key,
      },
    });
    const completedAt = new Date().toISOString();
    if (response.notModified) {
      await this.queueFailedFollowUpsForConnection(job, connection, completedAt);
      if (!isBackfillJob(job)) await this.updateConnectionAfterScan(connection, cursor, completedAt, this.isManualScan(job));
      await this.updateJobStats(job, { seen: 0, created: 0, updated: 0, metadata: { not_modified: true } });
      if (!isBackfillJob(job)) {
        await this.notifyResearchScanCompleted(
          job,
          connection.channel_id,
          completedAt,
          cursor.last_published_at ?? null,
          cursor.last_published_at ?? null,
          0,
        );
      }
      return { seen: 0, page_size: backfillMaxItems(job.metadata_json) };
    }
    if (!response.isText || response.text === null) {
      throw new HttpError(415, `Source connection returned unsupported binary content (${response.contentType ?? "unknown"})`);
    }

    const raw = response.text;
    const nextCursor = {
      ...cursor,
      etag: response.headers.get("etag") ?? cursor.etag,
      last_modified: response.headers.get("last-modified") ?? cursor.last_modified,
    };
    const result = await this.scanWithConnector(job, connection, handler, raw, completedAt);
    if (!isBackfillJob(job)) {
      await this.updateConnectionAfterScan(connection, {
        ...nextCursor,
        ...result.cursor,
      }, completedAt, this.isManualScan(job));
    }
    await this.updateJobStats(job, {
      seen: result.seen,
      created: result.created,
      updated: result.updated,
      metadata: {
        connector_key: connection.connector_key,
        endpoint_url: request.url,
      },
    });
    await emitSourcePostProcessingEvent(this.db, {
      spaceId: job.space_id,
      sourceChannelId: connection.channel_id,
      newItemCount: result.created,
    });
    await enqueueItemsForAnnotation(this.db, {
      spaceId: job.space_id,
      sourceChannelId: connection.channel_id,
      sourceConnectionId: connection.id,
      newItemCount: result.created,
    });
    if (!isBackfillJob(job)) {
      await this.notifyResearchScanCompleted(
        job,
        connection.channel_id,
        completedAt,
        cursor.last_published_at ?? null,
        result.cursor.last_published_at ?? cursor.last_published_at ?? null,
        result.created,
      );
    }
    return { seen: result.seen, page_size: backfillMaxItems(job.metadata_json) };
  }

  private async recordJobFailureDiagnostics(
    job: ExtractionJobRow,
    diagnostics: SourceFetchFailureDiagnostics,
  ): Promise<void> {
    await this.db.query(
      `UPDATE extraction_jobs
          SET metadata_json = COALESCE(metadata_json, '{}'::jsonb)
            || jsonb_build_object('failure_diagnostics', $3::jsonb)
        WHERE id = $1 AND space_id = $2`,
      [job.id, job.space_id, JSON.stringify(diagnostics)],
    );
  }

  /** Best-effort research timeline projection; a failure here must never fail the scan itself. */
  private async notifyResearchScanCompleted(
    job: ExtractionJobRow,
    sourceChannelId: string | null,
    scannedAt: string,
    scanWindowStart: string | null,
    scanWindowEnd: string | null,
    newItemCount: number,
  ): Promise<void> {
    await new ProjectResearchPipelineService(this.db, this.config).onSourceScanCompleted({
      spaceId: job.space_id,
      sourceChannelId,
      scanJobId: job.id,
      scannedAt,
      scanWindowStart,
      scanWindowEnd,
      newItemCount,
    }).catch((error) => {
      process.stderr.write(
        `[research.scan-summary] scan projection failed (job ${job.id}): ${String((error as Error)?.message ?? error)}\n`,
      );
    });
  }

  /**
   * A date range is a logical window, not a single arXiv API page. Keep the
   * segment running and advance its saved page cursor until the API returns a
   * short page or the segment's max_items budget is exhausted.
   */
  private async queueBackfillContinuationIfNeeded(
    job: ExtractionJobRow,
    result: { seen: number; page_size: number },
  ): Promise<void> {
    const metadata = record(job.metadata_json);
    const segmentId = stringValue(metadata.source_backfill_segment_id);
    const planId = stringValue(metadata.source_backfill_plan_id);
    if (!segmentId || !planId) return;
    const segment = await this.db.query<{ window_json: unknown; status: string }>(
      `SELECT window_json,status FROM source_backfill_segments WHERE id=$1 AND space_id=$2 LIMIT 1`,
      [segmentId, job.space_id],
    );
    const current = segment.rows[0];
    if (!current || current.status !== "running") return;
    const window = record(current.window_json);
    const consumedItems = (integerValue(window.consumed_items) ?? 0) + result.seen;
    const budget = integerValue(window.max_items);
    const remaining = integerValue(window.remaining_items ?? window.max_items);
    if (result.seen < result.page_size) {
      await this.db.query(
        `UPDATE source_backfill_segments SET window_json=$3::jsonb WHERE id=$1 AND space_id=$2 AND status='running'`,
        [segmentId, job.space_id, JSON.stringify({ ...window, consumed_items: consumedItems, next_cursor: null, has_more: false, exhausted: true })],
      );
      return;
    }
    if (budget === null || remaining === null || remaining <= result.seen) {
      await this.db.query(
        `UPDATE source_backfill_segments SET window_json=$3::jsonb WHERE id=$1 AND space_id=$2 AND status='running'`,
        [segmentId, job.space_id, JSON.stringify({ ...window, consumed_items: consumedItems, next_cursor: (integerValue(window.cursor) ?? 0) + 1, has_more: true, exhausted: false, partial: true })],
      );
      return;
    }
    const nextRemaining = remaining - result.seen;
    const nextWindow = {
      ...window,
      cursor: (integerValue(window.cursor) ?? 0) + 1,
      remaining_items: nextRemaining,
      page_size: Math.min(100, nextRemaining),
      consumed_items: consumedItems,
    };
    const nextJobId = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO extraction_jobs (id,space_id,connection_id,job_type,status,metadata_json,created_at)
       VALUES ($1,$2,$3,'connection_scan','pending',$4::jsonb,$5)`,
      [nextJobId, job.space_id, job.connection_id, JSON.stringify({ ...metadata, source_backfill_plan_id: planId, source_backfill_segment_id: segmentId, window: nextWindow }), now],
    );
    await this.db.query(
      `UPDATE source_backfill_segments SET extraction_job_id=$3, window_json=$4::jsonb, next_eligible_at=NULL WHERE id=$1 AND space_id=$2 AND status='running'`,
      [segmentId, job.space_id, nextJobId, JSON.stringify({ ...nextWindow, next_cursor: nextWindow.cursor, has_more: true, exhausted: false })],
    );
  }

  private async scanWithConnector(
    job: ExtractionJobRow,
    connection: ConnectionWithConnectorRow,
    handler: SourceConnectorHandler,
    raw: string,
    capturedAt: string,
  ): Promise<{ seen: number; created: number; updated: number; cursor: ScanCursor }> {
    const items = handler.parseResponse(raw).slice(0, backfillMaxItems(job.metadata_json));
    let created = 0;
    let updated = 0;
    let lastGuid: string | undefined;
    let lastPublishedAt: string | undefined;
    const providerQuery = record(connection.provider_query_json);
    const monitoringField = providerQuery.monitoring_field === "lastUpdatedDate" ? "lastUpdatedDate" : "submittedDate";
    for (const item of items) {
      if (!lastGuid && item.externalId) lastGuid = item.externalId;
      const occurredAt = monitoringField === "lastUpdatedDate"
        ? stringValue(item.metadata.updated_at) ?? item.occurredAt
        : item.occurredAt;
      if (!lastPublishedAt && occurredAt) lastPublishedAt = occurredAt;
      const sourceUri = item.itemType === "external_url" ? connection.endpoint_url : item.sourceUri;
      const outcome = await this.upsertScannedItem({
        job,
        connection,
        itemType: item.itemType ?? "feed_entry",
        title: item.title,
        sourceUri,
        canonicalUri: safeNormalizeUrl(item.canonicalUri ?? sourceUri),
        sourceExternalId: item.sourceExternalId ?? item.externalId,
        author: item.author,
        occurredAt,
        contentHash: sha256([
          item.externalId ?? "",
          sourceUri ?? "",
          item.title,
          item.excerpt ?? "",
          occurredAt ?? "",
        ].join("\n")),
        excerpt: item.excerpt,
        metadata: item.metadata,
        capturedAt,
      });
      if (outcome.created) created += 1;
      else updated += 1;
    }
    return {
      seen: items.length,
      created,
      updated,
      cursor: {
        last_guid: lastGuid,
        last_published_at: lastPublishedAt,
        ...handler.parseCursor?.(raw),
      },
    };
  }

  private async upsertScannedItem(input: {
    job: ExtractionJobRow;
    connection: ConnectionWithConnectorRow;
    itemType: "feed_entry" | "external_url";
    title: string;
    sourceUri: string | null;
    canonicalUri: string | null;
    sourceExternalId: string | null;
    author: string | null;
    occurredAt: string | null;
    contentHash: string;
    excerpt: string | null;
    metadata: Record<string, unknown>;
    capturedAt: string;
  }): Promise<{ itemId: string; created: boolean }> {
    const now = input.capturedAt;
    const author = input.author?.slice(0, 512) ?? null;
    const excerpt = input.excerpt?.slice(0, 2048) ?? null;
    const arxivId = stringValue(input.metadata.arxiv_id);
    const doi = normalizeDoi(stringValue(input.metadata.doi));
    const existing = await this.db.query<{ id: string; content_state: string | null }>(
      `SELECT id, content_state
         FROM source_items
        WHERE space_id = $1
          AND deleted_at IS NULL
          AND project_id IS NOT DISTINCT FROM $12
          AND (
            ($2::text IS NOT NULL AND canonical_uri = $3::text)
            OR ($4::text IS NOT NULL AND metadata_json->>'arxiv_id' = $4::text)
            OR ($5::text IS NOT NULL AND lower(metadata_json->>'doi') = $5::text)
            OR ($6::varchar IS NOT NULL AND connection_id = $7::varchar AND source_external_id = $8::varchar)
            OR ($9::varchar IS NOT NULL AND connection_id = $10::varchar AND content_hash = $11::varchar)
          )
        LIMIT 1`,
      [
        input.job.space_id,
        input.canonicalUri,
        input.canonicalUri,
        arxivId,
        doi,
        input.sourceExternalId,
        input.connection.id,
        input.sourceExternalId,
        input.contentHash,
        input.connection.id,
        input.contentHash,
        input.connection.project_id,
      ],
    );
    const policy = capturePolicyScanState(input.connection.capture_policy);
    if (policy.retention !== "metadata_only") {
      enforceSourceRetentionPolicy(
        normalizeSourceConnectionReadGovernance(input.connection).policy,
        policy.retention,
      );
    }
    const metadata = {
      ...input.metadata,
      ...(arxivId ? { arxiv_id: arxivId } : {}),
      ...(doi ? { doi } : {}),
      capture_method: "connection_scan",
      job_id: input.job.id,
      connector_key: input.connection.connector_key,
      connection_id: input.connection.id,
      ...(input.connection.channel_id ? { source_channel_id: input.connection.channel_id } : {}),
      ...(stringValue(record(input.job.metadata_json).source_backfill_plan_id)
        ? { source_backfill_plan_id: stringValue(record(input.job.metadata_json).source_backfill_plan_id) }
        : {}),
    };
    const existingItem = existing.rows[0];
    let itemId = existingItem?.id;
    let created = false;
    if (!itemId) {
      itemId = randomUUID();
      await this.db.query(
        `INSERT INTO source_items (
           id, space_id, project_id, connection_id, item_type, title, source_uri, canonical_uri,
           source_domain, source_external_id, author, occurred_at, first_seen_at,
           last_seen_at, content_hash, excerpt, content_state,
           retention_policy, metadata_json, created_at, updated_at,
           owner_user_id, visibility, access_level
         ) VALUES (
           $1, $2, (SELECT project_id FROM source_connections WHERE space_id=$2 AND id=$3), $3, $4, $5, $6, $7,
           $8, $9, $10, $11::timestamptz, $12,
           $12, $13, $14, $15,
           $16, $17::jsonb, $12, $12,
           $18, $19, $20
         )`,
        [
          itemId,
          input.job.space_id,
          input.connection.id,
          input.itemType,
          input.title.slice(0, 1024),
          input.sourceUri,
          input.canonicalUri,
          sourceDomain(input.canonicalUri ?? input.sourceUri ?? ""),
          input.sourceExternalId,
          author,
          input.occurredAt,
          now,
          input.contentHash,
          excerpt,
          policy.contentState,
          policy.retention,
          JSON.stringify({
            ...metadata,
            ...(stringValue(record(input.job.metadata_json).source_backfill_plan_id)
              ? { source_backfill_created_plan_id: stringValue(record(input.job.metadata_json).source_backfill_plan_id) }
              : {}),
          }),
          input.connection.owner_user_id,
          input.connection.visibility,
          input.connection.access_level,
        ],
      );
      if (input.connection.visibility === "selected_users") await inheritContentAccessGrants(this.db, {
        spaceId: input.job.space_id,
        sourceResourceType: "source_connection",
        sourceResourceId: input.connection.id,
        targetResourceType: "source_item",
        targetResourceId: itemId,
        inheritedAt: now,
      });
      created = true;
    } else {
      await this.db.query(
        `UPDATE source_items
            SET title = $3,
                source_uri = COALESCE($4, source_uri),
                canonical_uri = COALESCE($5, canonical_uri),
                source_domain = COALESCE($6, source_domain),
                source_external_id = COALESCE($7, source_external_id),
                author = COALESCE($8, author),
                occurred_at = COALESCE($9::timestamptz, occurred_at),
                last_seen_at = $10,
                content_hash = $11,
                excerpt = COALESCE($12, excerpt),
                content_state = CASE
                  WHEN content_state IN ('metadata_only', 'excerpt_saved', 'extraction_failed') THEN $13
                  ELSE content_state
                END,
                retention_policy = CASE
                  WHEN retention_policy IN ('metadata_only', 'summary_only') THEN $14
                  ELSE retention_policy
                END,
                metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $15::jsonb,
                updated_at = $10
          WHERE space_id = $1 AND id = $2`,
        [
          input.job.space_id,
          itemId,
          input.title.slice(0, 1024),
          input.sourceUri,
          input.canonicalUri,
          sourceDomain(input.canonicalUri ?? input.sourceUri ?? ""),
          input.sourceExternalId,
          author,
          input.occurredAt,
          now,
          input.contentHash,
          excerpt,
          policy.contentState,
          policy.retention,
          JSON.stringify(metadata),
        ],
      );
    }

    const sourceSnapshotId = await this.createSourceSnapshot({
      spaceId: input.job.space_id,
      sourceItemId: itemId,
      connectionId: input.connection.id,
      snapshotType: "metadata",
      artifactId: null,
      contentHash: input.contentHash,
      sourceUri: input.sourceUri,
      captureMethod: "connection_scan",
      trustLevel: input.connection.trust_level,
      sourceVisibility: input.connection.visibility,
      metadata,
      capturedAt: now,
    });
    const channelId = input.connection.channel_id ?? stringValue(record(input.job.metadata_json).source_channel_id);
    if (channelId) {
      await this.db.query(
        `INSERT INTO source_channel_item_links (id, space_id, source_channel_id, source_item_id, status, matched_at, match_reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$5,$5)
         ON CONFLICT (source_channel_id, source_item_id) DO UPDATE SET status='active', matched_at=EXCLUDED.matched_at, match_reason=EXCLUDED.match_reason, updated_at=EXCLUDED.updated_at`,
        [randomUUID(), input.job.space_id, channelId, itemId, now, input.sourceExternalId ? `external_id:${input.sourceExternalId}` : "canonical_uri"],
      );
    }
    await projectSourceRoutingHook().routeMaterializedItem(this.db, {
      spaceId: input.job.space_id,
      sourceItemId: itemId,
    });
    await projectSourceRoutingHook().routeEvidence(
      this.db,
      { spaceId: input.job.space_id, sourceItemId: itemId },
      { materializeSourceItemLinks: false },
    );
    const needsFollowUp =
      Boolean(policy.followUpJobType) &&
      (
        created ||
        existingItem?.content_state === "metadata_only" ||
        existingItem?.content_state === "excerpt_saved" ||
        existingItem?.content_state === "extraction_failed"
      );
    const hasActiveFollowUp = policy.followUpJobType
      ? await this.hasActiveFollowUpJob(input.job.space_id, itemId, policy.followUpJobType)
      : false;
    if (needsFollowUp && policy.followUpJobType && !hasActiveFollowUp) {
      const backfillMetadata = isBackfillJob(input.job)
        ? {
            source_backfill_plan_id: stringValue(record(input.job.metadata_json).source_backfill_plan_id),
            source_backfill_segment_id: stringValue(record(input.job.metadata_json).source_backfill_segment_id),
          }
        : {};
      await this.createExtractionJob({
        spaceId: input.job.space_id,
        connectionId: input.connection.id,
        sourceItemId: itemId,
        sourceSnapshotId,
        jobType: policy.followUpJobType,
        metadata: { created_by: "connection_scan", parent_job_id: input.job.id, ...backfillMetadata },
        createdAt: now,
      });
    }
    await this.reindexItemForRetrieval(input.job.space_id, itemId, "source_connection_scan");
    return { itemId, created };
  }

  private async executeTextExtraction(job: ExtractionJobRow): Promise<void> {
    if (!job.source_item_id) throw new HttpError(422, "extract_text requires source_item_id");
    const item = await this.getItem(job.space_id, job.source_item_id);
    if (!item?.source_uri) throw new HttpError(422, "Source item is missing source_uri");
    await this.enforceItemRetentionPolicy(job.space_id, item, "full_text");

    const resolved = await this.fetchItemSourceContent(job.space_id, item.source_uri);
    const response = resolved.response;
    let rawSnapshotId: string | null = null;
    let rawArtifactId: string | null = null;
    if (response.isPdf) {
      if (!response.bytes) throw new HttpError(415, "PDF response did not include binary content");
      rawArtifactId = await this.writeRawArtifact(job.space_id, item.id, item.visibility, item.title ?? "snapshot", {
        content: response.bytes,
        mimeType: "application/pdf",
      });
      rawSnapshotId = await this.createSourceSnapshot({
        spaceId: job.space_id,
        sourceItemId: item.id,
        connectionId: item.connection_id,
        snapshotType: "raw",
        artifactId: rawArtifactId,
        contentHash: sha256(response.bytes),
        sourceUri: item.source_uri,
        captureMethod: "full_text",
        trustLevel: "normal",
        sourceVisibility: item.visibility,
        metadata: { job_id: job.id, ...resolved.contentMeta },
        capturedAt: new Date().toISOString(),
      });
    }
    const readerContent = resolved.readerContent
      ?? await this.readerContentFromFetched(response, item.source_uri);
    const text = readerContent.plain_text;
    const evidenceExtractionMethod = response.isPdf ? "pdf_text_v1" : "full_text";
    const artifactId = await this.writeReaderDocumentArtifact(
      job.space_id,
      item.id,
      item.visibility,
      item.title ?? readerContent.title ?? "extracted",
      readerContent,
      resolved.contentMeta,
    );
    const contentHash = sha256(text);
    const now = new Date().toISOString();
    const sourceSnapshotId = await this.createSourceSnapshot({
      spaceId: job.space_id,
      sourceItemId: item.id,
      connectionId: item.connection_id,
      snapshotType: "extracted",
      artifactId,
      contentHash,
      sourceUri: item.source_uri,
      captureMethod: "full_text",
      trustLevel: "normal",
      sourceVisibility: item.visibility,
      metadata: {
        job_id: job.id,
        ...(rawSnapshotId ? { raw_source_snapshot_id: rawSnapshotId } : {}),
        ...resolved.contentMeta,
      },
      capturedAt: now,
    });

    await this.db.query(
      `UPDATE source_items
          SET content_state = 'content_saved',
              retention_policy = 'full_text',
              raw_artifact_id = COALESCE($6, raw_artifact_id),
              extracted_artifact_id = $3,
              content_hash = $4,
              updated_at = $5
        WHERE space_id = $1 AND id = $2`,
      [job.space_id, item.id, artifactId, contentHash, now, rawArtifactId],
    );
    const access = await this.db.query<{ owner_user_id: string | null; access_level: string }>(
      `SELECT owner_user_id, access_level FROM source_items WHERE space_id=$1 AND id=$2`,
      [job.space_id, item.id],
    );
    if (!access.rows[0]) throw new Error("Evidence source item disappeared");
    const evidenceId = await upsertCanonicalEvidence(this.db, {
      spaceId: job.space_id,
      projectId: item.project_id ?? null,
      ownerUserId: access.rows[0].owner_user_id,
      visibility: item.visibility,
      accessLevel: access.rows[0].access_level,
      sourceItemId: item.id,
      extractionJobId: job.id,
      sourceSnapshotId,
      sourceObjectType: "source_item",
      sourceObjectId: item.id,
      evidenceType: "document",
      title: item.title ?? "Extracted text",
      contentExcerpt: text.slice(0, 4000),
      contentHash,
      artifactId,
      sourceUri: item.source_uri,
      sourceTitle: item.title,
      trustLevel: "normal",
      extractionMethod: evidenceExtractionMethod,
      confidence: 0.7,
      status: "candidate",
      metadata: {},
      observedAt: now,
    });
    if (item.visibility === "selected_users") await inheritContentAccessGrants(this.db, {
      spaceId: job.space_id,
      sourceResourceType: "source_item",
      sourceResourceId: item.id,
      targetResourceType: "extracted_evidence",
      targetResourceId: evidenceId,
      inheritedAt: now,
    });
    await projectSourceRoutingHook().routeEvidence(this.db, {
      spaceId: job.space_id,
      sourceItemId: item.id,
    });
    await this.reindexEvidenceForRetrieval(job.space_id, evidenceId, "source_text_extraction");

    await this.db.query(
      `UPDATE extraction_jobs SET source_snapshot_id = $3 WHERE id = $1 AND space_id = $2`,
      [job.id, job.space_id, sourceSnapshotId],
    );
  }

  private async executeSnapshot(job: ExtractionJobRow): Promise<void> {
    if (!job.source_item_id) throw new HttpError(422, "snapshot requires source_item_id");
    const item = await this.getItem(job.space_id, job.source_item_id);
    if (!item?.source_uri) throw new HttpError(422, "Source item is missing source_uri");
    await this.enforceItemRetentionPolicy(job.space_id, item, "full_snapshot");

    const resolved = await this.fetchItemSourceContent(job.space_id, item.source_uri);
    const response = resolved.response;
    const rawContent = this.rawContentFromFetched(response);
    const artifactId = await this.writeRawArtifact(job.space_id, item.id, item.visibility, item.title ?? "snapshot", rawContent);
    const contentHash = sha256(rawContent.content);
    const now = new Date().toISOString();
    const rawSnapshotId = await this.createSourceSnapshot({
      spaceId: job.space_id,
      sourceItemId: item.id,
      connectionId: item.connection_id,
      snapshotType: "raw",
      artifactId,
      contentHash,
      sourceUri: item.source_uri,
      captureMethod: "snapshot",
      trustLevel: "normal",
      sourceVisibility: item.visibility,
      metadata: { job_id: job.id, ...resolved.contentMeta },
      capturedAt: now,
    });
    await this.db.query(
      `UPDATE source_items
          SET content_state = 'snapshot_saved',
              retention_policy = 'full_snapshot',
              raw_artifact_id = $3,
              content_hash = $4,
              updated_at = $5
        WHERE space_id = $1 AND id = $2`,
      [job.space_id, item.id, artifactId, contentHash, now],
    );

    try {
      const readerContent = resolved.readerContent
        ?? await this.readerContentFromFetched(response, item.source_uri);
      const text = readerContent.plain_text;
      if (text || readerContent.content_json.content.length > 0) {
        const extractedId = await this.writeReaderDocumentArtifact(
          job.space_id,
          item.id,
          item.visibility,
          item.title ?? readerContent.title ?? "extracted",
          readerContent,
          resolved.contentMeta,
        );
        await this.createSourceSnapshot({
          spaceId: job.space_id,
          sourceItemId: item.id,
          connectionId: item.connection_id,
          snapshotType: "extracted",
          artifactId: extractedId,
          contentHash: sha256(text),
          sourceUri: item.source_uri,
          captureMethod: "snapshot",
          trustLevel: "normal",
          sourceVisibility: item.visibility,
          metadata: { job_id: job.id, raw_source_snapshot_id: rawSnapshotId, ...resolved.contentMeta },
          capturedAt: now,
        });
        await this.db.query(
          `UPDATE source_items
              SET extracted_artifact_id = $3,
                  content_state = 'content_saved',
                  retention_policy = 'full_snapshot',
                  content_hash = $4,
                  updated_at = $5
            WHERE space_id = $1 AND id = $2`,
          [job.space_id, item.id, extractedId, sha256(text), now],
        );
      }
    } catch {
      // Snapshot succeeded even when text extraction fails.
    }

    await this.db.query(
      `UPDATE extraction_jobs SET source_snapshot_id = $3 WHERE id = $1 AND space_id = $2`,
      [job.id, job.space_id, rawSnapshotId],
    );
  }

  private async executeInternalNormalization(job: ExtractionJobRow): Promise<void> {
    const sourceType = job.source_object_type;
    const sourceId = job.source_object_id;
    if (!sourceType || !sourceId) {
      throw new HttpError(422, "Internal normalization requires source_object_type/id");
    }
    const payload = await this.loadInternalSource(job.space_id, sourceType, sourceId);
    const now = new Date().toISOString();
    const itemId = randomUUID();
    await this.db.query(
      `INSERT INTO source_items (
         id, space_id, project_id, item_type, source_object_type, source_object_id,
         title, excerpt, content_state, retention_policy,
         metadata_json, created_at, updated_at, owner_user_id, visibility, access_level
       ) VALUES (
         $1, $2, $12, $3, $3, $4,
         $5, $6, 'excerpt_saved', 'summary_only',
         $7::jsonb, $8, $8, $9, $10, $11
       )
       ON CONFLICT DO NOTHING`,
      [
        itemId,
        job.space_id,
        sourceType,
        sourceId,
        payload.title,
        payload.excerpt,
        JSON.stringify({ capture_method: "internal", job_id: job.id }),
        now,
        payload.ownerUserId,
        payload.visibility,
        payload.accessLevel,
        payload.projectId,
      ],
    );
    if (payload.visibility === "selected_users") await inheritContentAccessGrants(this.db, {
      spaceId: job.space_id,
      sourceResourceType: payload.sourceResourceType,
      sourceResourceId: payload.sourceResourceId,
      targetResourceType: "source_item",
      targetResourceId: itemId,
      inheritedAt: now,
    });
    const evidenceId = await upsertCanonicalEvidence(this.db, {
      spaceId: job.space_id,
      projectId: payload.projectId,
      ownerUserId: payload.ownerUserId,
      visibility: payload.visibility,
      accessLevel: payload.accessLevel,
      sourceItemId: itemId,
      extractionJobId: job.id,
      sourceObjectType: sourceType,
      sourceObjectId: sourceId,
      evidenceType: payload.evidenceType,
      title: payload.title,
      contentExcerpt: payload.excerpt,
      contentHash: sha256(payload.excerpt),
      trustLevel: "normal",
      extractionMethod: "internal_normalization",
      confidence: 0.8,
      status: "candidate",
      metadata: {},
      observedAt: now,
    });
    if (payload.visibility === "selected_users") await inheritContentAccessGrants(this.db, {
      spaceId: job.space_id,
      sourceResourceType: "source_item",
      sourceResourceId: itemId,
      targetResourceType: "extracted_evidence",
      targetResourceId: evidenceId,
      inheritedAt: now,
    });
    await this.db.query(
      `UPDATE extraction_jobs
          SET source_item_id = $3,
              items_seen = 1,
              items_created = 1
        WHERE id = $1 AND space_id = $2`,
      [job.id, job.space_id, itemId],
    );
    await this.reindexItemForRetrieval(job.space_id, itemId, "source_internal_normalization");
  }

  private async loadInternalSource(
    spaceId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<{
    title: string;
    excerpt: string;
    evidenceType: string;
    ownerUserId: string | null;
    visibility: string;
    accessLevel: string;
    projectId: string | null;
    sourceResourceType: "activity" | "artifact" | "run";
    sourceResourceId: string;
  }> {
    if (sourceType === "activity_record") {
      const row = await this.db.query<{ title: string | null; content: string | null; project_id: string | null; owner_user_id: string | null; visibility: string; access_level: string }>(
        `SELECT title, content, project_id, owner_user_id, visibility, access_level FROM activity_records
          WHERE space_id = $1 AND id = $2 AND status NOT IN ('archived', 'failed')`,
        [spaceId, sourceId],
      );
      const activity = row.rows[0];
      if (!activity) throw new HttpError(404, "Activity record not found");
      return {
        title: activity.title ?? "Activity",
        excerpt: (activity.content ?? "").slice(0, 4000),
        evidenceType: "event",
        ownerUserId: activity.owner_user_id,
        visibility: activity.visibility,
        accessLevel: activity.access_level,
        projectId: activity.project_id,
        sourceResourceType: "activity",
        sourceResourceId: sourceId,
      };
    }
    if (sourceType === "artifact") {
      const row = await this.db.query<{ title: string | null; content: string | null; project_id: string | null; owner_user_id: string | null; visibility: string; access_level: string }>(
        `SELECT title, content, project_id, owner_user_id, visibility, access_level FROM artifacts WHERE space_id = $1 AND id = $2`,
        [spaceId, sourceId],
      );
      const artifact = row.rows[0];
      if (!artifact) throw new HttpError(404, "Artifact not found");
      return {
        title: artifact.title ?? "Artifact",
        excerpt: (artifact.content ?? "").slice(0, 4000),
        evidenceType: "artifact",
        ownerUserId: artifact.owner_user_id,
        visibility: artifact.visibility,
        accessLevel: artifact.access_level,
        projectId: artifact.project_id,
        sourceResourceType: "artifact",
        sourceResourceId: sourceId,
      };
    }
    if (sourceType === "run_event") {
      const row = await this.db.query<{ event_type: string | null; payload_json: unknown; run_id: string; project_id: string | null; owner_user_id: string | null; visibility: string; access_level: string }>(
        `SELECT re.event_type, re.payload_json, re.run_id, r.project_id, r.owner_user_id, r.visibility, r.access_level
           FROM run_events re
           JOIN runs r ON r.space_id = re.space_id AND r.id = re.run_id
          WHERE re.space_id = $1 AND re.id = $2`,
        [spaceId, sourceId],
      );
      const event = row.rows[0];
      if (!event) throw new HttpError(404, "Run event not found");
      return {
        title: event.event_type ?? "Run event",
        excerpt: JSON.stringify(event.payload_json ?? {}).slice(0, 4000),
        evidenceType: "event",
        ownerUserId: event.owner_user_id,
        visibility: event.visibility,
        accessLevel: event.access_level,
        projectId: event.project_id,
        sourceResourceType: "run",
        sourceResourceId: event.run_id,
      };
    }
    throw new HttpError(422, `Unsupported internal source_object_type: ${sourceType}`);
  }

  /**
   * Fetches an item's content for extraction/snapshot. Non-arXiv URLs keep the
   * existing single-fetch behavior. arXiv abs/pdf/html URLs resolve HTML-first
   * candidates (html -> pdf -> original URL) and pre-validate reader extraction
   * so extraction can fall back from HTML to PDF.
   */
  private async fetchItemSourceContent(
    spaceId: string,
    sourceUri: string,
  ): Promise<{
    response: SourceFetchResult;
    readerContent: StructuredReaderContent | null;
    contentMeta: Record<string, unknown>;
  }> {
    const maxDownloadBytes = await this.maxDownloadBytes(spaceId);
    const arxivRef = parseArxivReference(sourceUri);
    if (!arxivRef) {
      const response = await fetchSource(sourceUri, { maxDownloadBytes });
      if (!response.ok) {
        throw new HttpError(502, `Failed to fetch source URL (${response.status})`);
      }
      return { response, readerContent: null, contentMeta: {} };
    }

    const candidates: Array<{ url: string; format: "html" | "pdf" | "auto" }> = [
      { url: arxivHtmlUrl(arxivRef.baseId), format: "html" },
      { url: arxivPdfUrl(arxivRef.baseId), format: "pdf" },
    ];
    if (!candidates.some((candidate) => candidate.url === sourceUri)) {
      candidates.push({ url: sourceUri, format: "auto" });
    }

    let lastError: unknown = null;
    let htmlFallbackReason: string | null = null;
    for (const candidate of candidates) {
      await acquireArxivRequestSlot();
      try {
        const response = await fetchSource(candidate.url, { maxDownloadBytes });
        if (!response.ok) {
          throw new HttpError(502, `Failed to fetch source URL (${response.status})`);
        }
        const format = candidate.format === "auto"
          ? (response.isPdf ? "pdf" : "html")
          : candidate.format;
        let readerContent: StructuredReaderContent;
        if (format === "html") {
          if (!response.isText || response.text === null) {
            throw new HttpError(415, `Unsupported source content type (${response.contentType ?? "unknown"})`);
          }
          readerContent = extractStructuredReaderContent(response.text, candidate.url);
          if (!readerContent.plain_text.trim()) {
            throw new HttpError(422, "HTML extraction produced no text");
          }
        } else {
          if (!response.isPdf || !response.bytes) {
            throw new HttpError(415, `Unsupported source content type (${response.contentType ?? "unknown"})`);
          }
          // Copy the bytes: pdf.js detaches the buffer it parses, and the
          // caller still writes response.bytes as the raw artifact.
          readerContent = await extractPdfReaderContent(response.bytes.slice(), candidate.url);
        }
        return {
          response,
          readerContent,
          contentMeta: {
            content_source_format: format,
            content_source_url: candidate.url,
            arxiv_id: arxivRef.baseId,
            ...(htmlFallbackReason
              ? { fallback_from: "html", fallback_reason: htmlFallbackReason.slice(0, 300) }
              : {}),
          },
        };
      } catch (error) {
        lastError = error;
        if (htmlFallbackReason === null) {
          htmlFallbackReason = error instanceof Error ? error.message : String(error);
        }
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new HttpError(502, "Failed to fetch arXiv source content");
  }

  private async getItem(spaceId: string, itemId: string): Promise<SourceItemRow | null> {
    const result = await this.db.query<SourceItemRow>(
      `SELECT id, space_id, connection_id, source_uri, canonical_uri, source_external_id,
              title, excerpt, author, occurred_at, content_state, visibility
         FROM source_items
        WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [spaceId, itemId],
    );
    return result.rows[0] ?? null;
  }

  private async maxDownloadBytes(spaceId: string): Promise<number> {
    return (await new PgCustomSourceHandlerRepository(this.db, this.config).getRunnerSettingsForSpace(spaceId)).download_bytes_max;
  }

  private async enforceItemRetentionPolicy(
    spaceId: string,
    item: SourceItemRow,
    retention: "full_text" | "full_snapshot",
  ): Promise<void> {
    if (!item.connection_id) return;
    const result = await this.db.query<SourceConnectionRow>(
          `SELECT sc.*, c.connector_key
             FROM source_connections sc
             JOIN source_provider_connectors spc ON spc.id=sc.provider_connector_id
             JOIN source_connectors c ON c.id=spc.connector_id
            WHERE sc.space_id = $1 AND sc.id = $2 AND sc.deleted_at IS NULL`,
      [spaceId, item.connection_id],
    );
    const connection = result.rows[0]
      ? result.rows[0]
      : null;
    if (!connection) throw new HttpError(404, "Source connection not found");
    enforceSourceRetentionPolicy(normalizeSourceConnectionReadGovernance(connection).policy, retention);
  }

  private async getConnection(spaceId: string, connectionId: string, channelId: string | null = null): Promise<ConnectionWithConnectorRow> {
    const result = await this.db.query<ConnectionWithConnectorRow>(
      `SELECT sc.*, c.connector_key, p.provider_key, p.display_name AS provider_display_name,
              ch.id AS channel_id, ch.channel_type, ch.endpoint_url, ch.fetch_frequency,
              ch.schedule_rule_json,
              CASE WHEN ch.channel_type='search'
                THEN ss.compiled_provider_query_json
                ELSE ch.provider_query_json
              END AS provider_query_json
         FROM source_connections sc
         JOIN source_provider_connectors spc ON spc.id = sc.provider_connector_id
         JOIN source_providers p ON p.id = spc.provider_id
         JOIN source_connectors c ON c.id = spc.connector_id
         LEFT JOIN source_channels ch
           ON ch.source_connection_id = sc.id
          AND ch.status <> 'archived'
          AND ($3::varchar IS NULL OR ch.id = $3)
         LEFT JOIN source_search_specs ss
           ON ss.source_channel_id=ch.id AND ss.space_id=ch.space_id
        WHERE sc.space_id = $1
          AND sc.id = $2
          AND sc.deleted_at IS NULL
          AND c.status = 'active'`,
      [spaceId, connectionId, channelId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Source connection not found");
    return row;
  }

  private async updateConnectionAfterScan(
    connection: ConnectionWithConnectorRow,
    cursor: ScanCursor,
    completedAt: string,
    manualRun: boolean,
  ): Promise<void> {
    if (!connection.channel_id) return;
    const scheduleTask = await getSourceChannelScanTask(this.db, connection.channel_id);
    const nextCheckAt = computeNextCheckAt(connection.fetch_frequency, completedAt, {
      manualRun,
      existingNextCheckAt: scheduleTask?.next_run_at,
      scheduleRule: connection.schedule_rule_json,
    });
    await upsertSourceChannelScanTask(this.db, {
      channel: { id: connection.channel_id, space_id: connection.space_id, owner_user_id: connection.owner_user_id, status: connection.status, fetch_frequency: connection.fetch_frequency },
      nextRunAt: nextCheckAt,
      lastRunAt: completedAt,
      cursor: compactCursor(cursor) as Record<string, unknown>,
      ...(cursor.last_published_at ? { watermark: { value: cursor.last_published_at } } : {}),
      updatedAt: completedAt,
    });
  }

  private async recordFailedConnectionScan(job: ExtractionJobRow): Promise<void> {
    if (!job.connection_id) return;
    try {
      const connection = await this.getConnection(job.space_id, job.connection_id, stringValue(record(job.metadata_json).source_channel_id));
      await this.updateConnectionAfterScan(
        connection,
        scanCursor((await getSourceChannelScanTask(this.db, connection.channel_id ?? ""))?.metadata_json),
        new Date().toISOString(),
        this.isManualScan(job),
      );
    } catch {
      // Preserve the original extraction job failure.
    }
  }

  private async updateJobStats(
    job: ExtractionJobRow,
    input: { seen: number; created: number; updated: number; metadata: Record<string, unknown> },
  ): Promise<void> {
    await this.db.query(
      `UPDATE extraction_jobs
          SET items_seen = $3,
              items_created = $4,
              items_updated = $5,
              metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $6::jsonb
        WHERE id = $1 AND space_id = $2`,
      [
        job.id,
        job.space_id,
        input.seen,
        input.created,
        input.updated,
        JSON.stringify(input.metadata),
      ],
    );
  }

  private async createSourceSnapshot(input: {
    spaceId: string;
    sourceItemId: string | null;
    connectionId: string | null;
    snapshotType: "metadata" | "raw" | "extracted" | "summary";
    artifactId: string | null;
    contentHash: string | null;
    sourceUri: string | null;
    captureMethod: "manual" | "connection_scan" | "full_text" | "snapshot" | "internal";
    trustLevel: string;
    sourceVisibility: string;
    metadata: Record<string, unknown>;
    capturedAt: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO source_snapshots (
         id, space_id, project_id, source_item_id, connection_id, snapshot_type, artifact_id,
         content_hash, source_uri, capture_method, trust_level, metadata_json,
         captured_at, created_at, updated_at, owner_user_id, visibility, access_level
       ) VALUES (
         $1, $2, COALESCE(
           (SELECT project_id FROM source_items WHERE space_id=$2 AND id=$3),
           (SELECT project_id FROM source_connections WHERE space_id=$2 AND id=$4)
         ), $3, $4, $5, $6,
         $7, $8, $9, $10, $11::jsonb,
         $12, $13, $14,
         COALESCE(
           (SELECT owner_user_id FROM source_items WHERE space_id = $15::varchar AND id = $16::varchar),
           (SELECT owner_user_id FROM source_connections WHERE space_id = $17::varchar AND id = $18::varchar)
         ),
         COALESCE(
           (SELECT visibility FROM source_items WHERE space_id = $19::varchar AND id = $20::varchar),
           (SELECT visibility FROM source_connections WHERE space_id = $21::varchar AND id = $22::varchar)
         ),
         COALESCE(
           (SELECT access_level FROM source_items WHERE space_id = $23::varchar AND id = $24::varchar),
           (SELECT access_level FROM source_connections WHERE space_id = $25::varchar AND id = $26::varchar)
         )
       )`,
      [
        id,
        input.spaceId,
        input.sourceItemId,
        input.connectionId,
        input.snapshotType,
        input.artifactId,
        input.contentHash,
        input.sourceUri,
        input.captureMethod,
        input.trustLevel,
        JSON.stringify(input.metadata),
        input.capturedAt,
        input.capturedAt,
        input.capturedAt,
        input.spaceId,
        input.sourceItemId,
        input.spaceId,
        input.connectionId,
        input.spaceId,
        input.sourceItemId,
        input.spaceId,
        input.connectionId,
        input.spaceId,
        input.sourceItemId,
        input.spaceId,
        input.connectionId,
      ],
    );
    if (input.sourceVisibility === "selected_users") await inheritContentAccessGrants(this.db, {
      spaceId: input.spaceId,
      sourceResourceType: input.sourceItemId ? "source_item" : "source_connection",
      sourceResourceId: input.sourceItemId ?? input.connectionId!,
      targetResourceType: "source_snapshot",
      targetResourceId: id,
      inheritedAt: input.capturedAt,
    });
    return id;
  }

  private async createExtractionJob(input: {
    spaceId: string;
    connectionId: string | null;
    sourceItemId: string | null;
    sourceSnapshotId: string | null;
    jobType: "extract_text" | "snapshot";
    metadata: Record<string, unknown>;
    createdAt: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO extraction_jobs (
         id, space_id, connection_id, source_item_id, source_snapshot_id,
         job_type, status, metadata_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::jsonb, $8)`,
      [
        randomUUID(),
        input.spaceId,
        input.connectionId,
        input.sourceItemId,
        input.sourceSnapshotId,
        input.jobType,
        JSON.stringify(input.metadata),
        input.createdAt,
      ],
    );
  }

  private async hasActiveFollowUpJob(
    spaceId: string,
    sourceItemId: string,
    jobType: "extract_text" | "snapshot",
  ): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id
         FROM extraction_jobs
        WHERE space_id = $1
          AND source_item_id = $2
          AND job_type = $3
          AND status IN ('pending', 'running')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [spaceId, sourceItemId, jobType],
    );
    return Boolean(result.rows[0]);
  }

  private isManualScan(job: ExtractionJobRow): boolean {
    return record(job.metadata_json).created_by === "manual_scan";
  }

  private async writeReaderDocumentArtifact(
    spaceId: string,
    sourceItemId: string,
    sourceVisibility: string,
    title: string,
    content: StructuredReaderContent,
    extraMetadata: Record<string, unknown> = {},
  ): Promise<string> {
    const artifactId = randomUUID();
    const relPath = join(spaceId, `${artifactId}.reader.json`);
    const absPath = join(this.config.artifactStorageRoot, relPath);
    const payload = JSON.stringify(content);
    await mkdir(join(this.config.artifactStorageRoot, spaceId), { recursive: true });
    await writeFile(absPath, payload, "utf8");
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO artifacts (
         id, space_id, artifact_type, title, content, storage_path, mime_type,
         exportable, export_formats_json, canonical_format, preview, metadata_json,
         created_at, updated_at, visibility, access_level, owner_user_id, trust_level
       ) VALUES (
         $1, $2, 'source_reader_document', $3, $4, $5, 'application/json',
         true, $6::jsonb, 'reader_document_json', false, $7::jsonb,
         $8, $9,
         (SELECT visibility FROM source_items WHERE space_id = $10::varchar AND id = $11::varchar),
         (SELECT access_level FROM source_items WHERE space_id = $12::varchar AND id = $13::varchar),
         (SELECT owner_user_id FROM source_items WHERE space_id = $14::varchar AND id = $15::varchar),
         'medium'
       )`,
      [
        artifactId,
        spaceId,
        title.slice(0, 512),
        payload,
        relPath,
        JSON.stringify(["json"]),
        JSON.stringify({
          schema_version: content.schema_version,
          kind: content.kind,
          extraction_method: content.extraction_method,
          image_policy: content.image_policy,
          image_count: content.image_count,
          source_uri: content.source_uri,
          ...extraMetadata,
        }),
        now,
        now,
        spaceId,
        sourceItemId,
        spaceId,
        sourceItemId,
        spaceId,
        sourceItemId,
      ],
    );
    if (sourceVisibility === "selected_users") await inheritContentAccessGrants(this.db, {
      spaceId,
      sourceResourceType: "source_item",
      sourceResourceId: sourceItemId,
      targetResourceType: "artifact",
      targetResourceId: artifactId,
      inheritedAt: now,
    });
    return artifactId;
  }

  private async writeRawArtifact(
    spaceId: string,
    sourceItemId: string,
    sourceVisibility: string,
    title: string,
    input: { content: string | Uint8Array; mimeType: string },
  ): Promise<string> {
    const artifactId = randomUUID();
    const format = exportFormatForMime(input.mimeType);
    const relPath = join(spaceId, `${artifactId}.${format === "html" ? "raw" : format}`);
    const absPath = join(this.config.artifactStorageRoot, relPath);
    await mkdir(join(this.config.artifactStorageRoot, spaceId), { recursive: true });
    if (typeof input.content === "string") {
      await writeFile(absPath, input.content, "utf8");
    } else {
      await writeFile(absPath, input.content);
    }
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO artifacts (
         id, space_id, artifact_type, title, content, storage_path, mime_type,
         exportable, export_formats_json, canonical_format, preview,
         created_at, updated_at, visibility, access_level, owner_user_id, trust_level
       ) VALUES (
         $1, $2, 'source_raw_snapshot', $3, NULL, $4, $5,
         false, $6::jsonb, $7, false,
         $8, $9,
         (SELECT visibility FROM source_items WHERE space_id = $10::varchar AND id = $11::varchar),
         (SELECT access_level FROM source_items WHERE space_id = $12::varchar AND id = $13::varchar),
         (SELECT owner_user_id FROM source_items WHERE space_id = $14::varchar AND id = $15::varchar),
         'medium'
       )`,
      [
        artifactId,
        spaceId,
        title.slice(0, 512),
        relPath,
        input.mimeType,
        JSON.stringify([format]),
        format,
        now,
        now,
        spaceId,
        sourceItemId,
        spaceId,
        sourceItemId,
        spaceId,
        sourceItemId,
      ],
    );
    if (sourceVisibility === "selected_users") await inheritContentAccessGrants(this.db, {
      spaceId,
      sourceResourceType: "source_item",
      sourceResourceId: sourceItemId,
      targetResourceType: "artifact",
      targetResourceId: artifactId,
      inheritedAt: now,
    });
    return artifactId;
  }

  private async readerContentFromFetched(
    response: SourceFetchResult,
    sourceUri: string,
  ): Promise<StructuredReaderContent> {
    if (response.isPdf) {
      if (!response.bytes) throw new HttpError(415, "PDF response did not include binary content");
      return extractPdfReaderContent(response.bytes, sourceUri);
    }
    if (response.isText && response.text !== null) {
      return extractStructuredReaderContent(response.text, sourceUri);
    }
    throw new HttpError(415, `Unsupported source content type (${response.contentType ?? "unknown"})`);
  }

  private rawContentFromFetched(
    response: SourceFetchResult,
  ): { content: string | Uint8Array; mimeType: string } {
    if (response.isPdf) {
      if (!response.bytes) throw new HttpError(415, "PDF response did not include binary content");
      return { content: response.bytes, mimeType: "application/pdf" };
    }
    if (response.isText && response.text !== null) {
      return { content: response.text, mimeType: response.contentType ?? "text/html" };
    }
    if (response.bytes) {
      return { content: response.bytes, mimeType: response.contentType ?? "application/octet-stream" };
    }
    throw new HttpError(415, `Unsupported source content type (${response.contentType ?? "unknown"})`);
  }

  private async reindexItemForRetrieval(spaceId: string, itemId: string, trigger: string): Promise<void> {
    await reindexSourceItemAndEvidenceForRetrieval(this.db, { spaceId, itemId, trigger }).catch((error) => {
      process.stderr.write(
        `[source.retrieval] item reindex failed (${itemId}): ${String((error as Error)?.message ?? error)}\n`,
      );
    });
  }

  private async reindexEvidenceForRetrieval(spaceId: string, evidenceId: string, trigger: string): Promise<void> {
    await reindexExtractedEvidenceAndParentForRetrieval(this.db, { spaceId, evidenceId, trigger }).catch((error) => {
      process.stderr.write(
        `[source.retrieval] evidence reindex failed (${evidenceId}): ${String((error as Error)?.message ?? error)}\n`,
      );
    });
  }
}

function backfillMaxItems(metadata: unknown): number {
  const window = record(record(metadata).window);
  const value = Number(window.page_size ?? window.remaining_items ?? window.max_items ?? 100);
  return Number.isInteger(value) ? Math.min(100, Math.max(1, value)) : 100;
}

function isBackfillJob(job: ExtractionJobRow): boolean {
  const metadata = record(job.metadata_json);
  return Boolean(stringValue(metadata.source_backfill_plan_id));
}

function integerValue(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exportFormatForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim();
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/html" || normalized === "application/xhtml+xml") return "html";
  if (normalized === "application/json") return "json";
  if (normalized?.endsWith("+xml") || normalized === "application/xml") return "xml";
  if (normalized?.startsWith("text/")) return "txt";
  return "bin";
}

function scanCursor(configJson: unknown): ScanCursor {
  const metadata = record(configJson);
  const cursor = record(metadata.cursor ?? metadata.scan_cursor);
  return {
    etag: stringValue(cursor.etag),
    last_modified: stringValue(cursor.last_modified),
    last_guid: stringValue(cursor.last_guid),
    last_published_at: stringValue(cursor.last_published_at),
    overlap_hours: nonNegativeNumber(cursor.overlap_hours),
  };
}

function compactCursor(cursor: ScanCursor): ScanCursor {
  const out: ScanCursor = {};
  if (cursor.etag) out.etag = cursor.etag;
  if (cursor.last_modified) out.last_modified = cursor.last_modified;
  if (cursor.last_guid) out.last_guid = cursor.last_guid;
  if (cursor.last_published_at) out.last_published_at = cursor.last_published_at;
  if (cursor.overlap_hours !== undefined) out.overlap_hours = cursor.overlap_hours;
  return out;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function safeNormalizeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return normalizeUrl(value);
  } catch {
    return null;
  }
}

function normalizeDoi(value: string | undefined): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .replace(/^doi:/, "");
  return normalized || null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
