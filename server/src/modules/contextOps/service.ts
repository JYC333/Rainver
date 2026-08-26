import type {
  ContextOpsArtifactSummary,
  ContextOpsCountMap,
  ContextOpsDrilldown,
  ContextOpsDrilldownObject,
  ContextOpsDrilldownSection,
  ContextOpsPacketSummary,
  ContextOpsSourceWarningDetail,
  ContextOpsSummary,
  RetrievalObjectType,
} from "@agent-space/protocol";
import type { ServerConfig } from "../../config.js";
import { dbPool, type Queryable } from "../routeUtils/common.js";
import type { RetrievalRegistry } from "../retrieval/registry.js";
import type { RevalidatedObject } from "../retrieval/types.js";
import {
  contentOwnerFilterSql,
  contentReadSql,
  contentVisibilityFilterSql,
} from "../access/contentAccessSql.js";
import {
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourceConnectionIdsFromJson,
  sourcePolicyAllowsRead,
} from "../retrieval/sourcePolicy.js";

export interface ContextOpsSummaryInput {
  spaceId: string;
  userId: string;
  windowDays: number;
  limit: number;
  includeSpaceOpsReports?: boolean;
  now?: Date;
}

export interface ContextOpsDrilldownInput {
  spaceId: string;
  userId: string;
  section: ContextOpsDrilldownSection;
  limit: number;
  /** Generic retrieval registry used to revalidate listed objects (the route injects the Knowledge registry). */
  registry: RetrievalRegistry;
  /** Owners/admins may see every active source connection's warnings; others only their own. */
  includeAllSources: boolean;
  /** Allow the artifact sections to also surface shared `space_ops` reports/packets when the reviewer is permitted. */
  includeSpaceOpsReports?: boolean;
  now?: Date;
}

/** Drill-down lookback for the artifact sections (report/packet history). */
const DRILLDOWN_ARTIFACT_WINDOW_DAYS = 365;

const ARTIFACT_DRILLDOWN_SECTIONS = [
  "maintenance_reports",
  "diagnostics_reports",
  "explain_reports",
  "recent_briefs",
] as const;

type ArtifactDrilldownSection = (typeof ARTIFACT_DRILLDOWN_SECTIONS)[number];

function isArtifactSection(section: ContextOpsDrilldownSection): section is ArtifactDrilldownSection {
  return (ARTIFACT_DRILLDOWN_SECTIONS as readonly string[]).includes(section);
}

interface DrilldownObjectRow {
  object_type: RetrievalObjectType;
  object_id: string;
  indexed_at: unknown;
  source_updated_at: unknown;
  missing_chunk_count: number | string | null;
}

interface SourceWarningRow {
  id: string;
  name: string;
  owner_user_id: string;
  status: string;
  consent_json: unknown;
  policy_json: unknown;
}

interface IndexFreshnessRow {
  object_type: string;
  total: number | string;
  stale_projection_count: number | string;
  source_connected_object_count: number | string;
  oldest_indexed_at: unknown;
  newest_indexed_at: unknown;
  newest_source_updated_at: unknown;
}

interface EmbeddingBacklogRow {
  total_chunks: number | string;
  embedded_chunks: number | string;
  missing_embedding_chunks: number | string;
  claimed_chunks: number | string;
  attempted_chunks: number | string;
}

interface MissingEmbeddingByTypeRow {
  object_type: string;
  total: number | string;
}

interface SourcePolicyWarningsRow {
  active_source_connections: number | string;
  missing_consent_version_count: number | string;
  reader_restricted_source_count: number | string;
  external_egress_disabled_source_count: number | string;
  derived_writes_disabled_source_count: number | string;
}

interface ArtifactRow {
  id: string;
  artifact_type: string;
  title: string;
  created_at: unknown;
  metadata_json: unknown;
}

interface ProposalRow {
  id: string;
  proposal_type: string;
  status: string;
  title: string;
  created_at: unknown;
  payload_json: unknown;
}

interface CountRow {
  key: string | null;
  total: number | string;
}

interface AccessCountRow {
  recent_access_count: number | string;
  context_injection_count: number | string;
  maintenance_scan_count: number | string;
}

const MAINTENANCE_ARTIFACT_TYPES = [
  "retrieval_maintenance_report",
  "memory_maintenance_report",
] as const;

const CONTEXT_BRIEF_ARTIFACT_TYPE = "retrieval_brief";
const DIAGNOSTICS_ARTIFACT_TYPE = "retrieval_eval_report";
const EXPLAIN_ARTIFACT_TYPE = "retrieval_explain_report";
const MAINTENANCE_PACKET_TYPES = [
  "retrieval_maintenance_packet",
  "memory_maintenance_packet",
] as const;

export class ContextOpsService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): ContextOpsService {
    return new ContextOpsService(dbPool(config));
  }

  async getSummary(input: ContextOpsSummaryInput): Promise<ContextOpsSummary> {
    const now = input.now ?? new Date();
    const windowStart = new Date(now.getTime() - input.windowDays * 24 * 60 * 60 * 1000);
    const [indexFreshness, embeddingBacklog, sourcePolicyWarnings] = await Promise.all([
      this.loadIndexFreshness(input.spaceId),
      this.loadEmbeddingBacklog(input.spaceId),
      this.loadSourcePolicyWarnings(input.spaceId, input.userId),
    ]);
    const [
      maintenanceArtifacts,
      maintenancePackets,
      diagnosticsArtifacts,
      recentContextBriefs,
      retrievalFeedback,
      memoryProvenance,
    ] = await Promise.all([
      this.loadMaintenanceArtifacts(input.spaceId, input.userId, windowStart, input.limit, Boolean(input.includeSpaceOpsReports)),
      this.loadMaintenancePackets(input.spaceId, input.userId, windowStart, input.limit, Boolean(input.includeSpaceOpsReports)),
      this.loadDiagnosticsArtifacts(input.spaceId, input.userId, windowStart, input.limit, Boolean(input.includeSpaceOpsReports)),
      this.loadRecentContextBriefs(input.spaceId, input.userId, windowStart, input.limit),
      this.loadRetrievalFeedback(input.spaceId, input.userId, windowStart, input.windowDays),
      this.loadMemoryProvenance(input.spaceId, input.userId, windowStart),
    ]);

    return {
      generated_at: now.toISOString(),
      space_id: input.spaceId,
      owner_user_id: input.userId,
      window_days: input.windowDays,
      index_freshness: indexFreshness,
      embedding_backlog: embeddingBacklog,
      source_policy_warnings: sourcePolicyWarnings,
      maintenance: {
        recent_report_count: maintenanceArtifacts.length,
        finding_counts: aggregateMaintenanceFindings(maintenanceArtifacts),
        pending_packet_count: maintenancePackets.filter((packet) => packet.status === "pending").length,
        recent_packets: maintenancePackets.map(proposalSummary),
      },
      diagnostics: aggregateDiagnostics(diagnosticsArtifacts),
      recent_context_briefs: recentContextBriefs.map(artifactSummary),
      retrieval_feedback: retrievalFeedback,
      memory_provenance: memoryProvenance,
    };
  }

  /**
   * Drill from an aggregate summary section into a bounded, access-safe detail
   * list. Object-level sections list only objects that pass the registered
   * adapter's live read gate AND the source-connection read policy (mirroring
   * search), so an unreadable or source-restricted object never leaks its title
   * (invariant 3/7). Object-level drill-downs are scoped to the injected
   * (Knowledge) registry's object types — exactly the maintenance-scan posture —
   * so Memory/Project private rows are never enumerated here.
   */
  async getDrilldown(input: ContextOpsDrilldownInput): Promise<ContextOpsDrilldown> {
    const now = input.now ?? new Date();
    const base = {
      generated_at: now.toISOString(),
      space_id: input.spaceId,
      section: input.section,
      limit: input.limit,
      objects: [] as ContextOpsDrilldownObject[],
      sources: [] as ContextOpsSourceWarningDetail[],
      artifacts: [] as ContextOpsArtifactSummary[],
      packets: [] as ContextOpsPacketSummary[],
    };
    if (input.section === "source_warnings") {
      const { sources, truncated } = await this.loadSourceWarningDetails(
        input.spaceId,
        input.userId,
        input.limit,
        input.includeAllSources,
      );
      return { ...base, truncated, sources };
    }
    if (isArtifactSection(input.section)) {
      const { artifacts, packets, truncated } = await this.loadArtifactDrilldown(
        input.spaceId,
        input.userId,
        input.section,
        input.limit,
        Boolean(input.includeSpaceOpsReports),
        now,
      );
      return { ...base, truncated, artifacts, packets };
    }
    const { objects, truncated } = await this.loadObjectDrilldown(
      input.spaceId,
      input.userId,
      input.section,
      input.limit,
      input.registry,
    );
    return { ...base, truncated, objects };
  }

  /**
   * Artifact-section drill-down: the viewer's own (plus allowed `space_ops`)
   * report/packet summaries for triage. These reuse the same access-scoped
   * queries as the summary read model, so they never expose another user's
   * private reports. Aggregate-safe summaries only — no raw findings cross here.
   */
  private async loadArtifactDrilldown(
    spaceId: string,
    userId: string,
    section: ArtifactDrilldownSection,
    limit: number,
    includeSpaceOpsReports: boolean,
    now: Date,
  ): Promise<{ artifacts: ContextOpsArtifactSummary[]; packets: ContextOpsPacketSummary[]; truncated: boolean }> {
    const windowStart = new Date(now.getTime() - DRILLDOWN_ARTIFACT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // Over-fetch by one to detect truncation without leaking exact totals.
    const fetch = limit + 1;
    if (section === "maintenance_reports") {
      const [artifactRows, packetRows] = await Promise.all([
        this.loadMaintenanceArtifacts(spaceId, userId, windowStart, fetch, includeSpaceOpsReports),
        this.loadMaintenancePackets(spaceId, userId, windowStart, fetch, includeSpaceOpsReports),
      ]);
      const truncated = artifactRows.length > limit || packetRows.length > limit;
      return {
        artifacts: artifactRows.slice(0, limit).map(artifactSummary),
        packets: packetRows.slice(0, limit).map(proposalSummary),
        truncated,
      };
    }
    const rows = section === "diagnostics_reports"
      ? await this.loadDiagnosticsArtifacts(spaceId, userId, windowStart, fetch, includeSpaceOpsReports)
      : section === "explain_reports"
        ? await this.loadExplainArtifacts(spaceId, userId, windowStart, fetch)
        : await this.loadRecentContextBriefs(spaceId, userId, windowStart, fetch);
    return {
      artifacts: rows.slice(0, limit).map(artifactSummary),
      packets: [],
      truncated: rows.length > limit,
    };
  }

  private async loadObjectDrilldown(
    spaceId: string,
    userId: string,
    section: Exclude<ContextOpsDrilldownSection, "source_warnings">,
    limit: number,
    registry: RetrievalRegistry,
  ): Promise<{ objects: ContextOpsDrilldownObject[]; truncated: boolean }> {
    const objectTypes = registry.objectTypes();
    if (objectTypes.length === 0) return { objects: [], truncated: false };
    // Over-fetch: candidates may be dropped by the read gate, and we still want a
    // full readable page when possible, so scan a bounded multiple before
    // revalidating. Capped so a large index cannot force an unbounded scan.
    const fetch = Math.min(500, Math.max(limit * 5, limit + 1));
    const rows = section === "index_freshness"
      ? await this.queryStaleObjects(spaceId, objectTypes, fetch)
      : await this.queryEmbeddingBacklogObjects(spaceId, objectTypes, fetch);
    const readable = await revalidateReadable(this.db, registry, spaceId, userId, rows);
    const objects: ContextOpsDrilldownObject[] = [];
    for (const row of rows) {
      const title = readable.get(`${row.object_type}:${row.object_id}`);
      if (title === undefined) continue; // not readable / source-restricted ⇒ never listed
      objects.push({
        object_type: row.object_type,
        object_id: row.object_id,
        title,
        indexed_at: dateIso(row.indexed_at),
        source_updated_at: dateIso(row.source_updated_at),
        missing_chunk_count: section === "embedding_backlog" ? intValue(row.missing_chunk_count) : null,
      });
      if (objects.length >= limit) break;
    }
    // Truncation reflects readable findings, not raw candidates, so the flag does
    // not leak the count of unreadable rows.
    const truncated = objects.length >= limit && rows.length > objects.length;
    return { objects, truncated };
  }

  private async queryStaleObjects(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    fetch: number,
  ): Promise<Array<DrilldownObjectRow & { source_connection_ids_json: unknown }>> {
    const result = await this.db.query<DrilldownObjectRow & { source_connection_ids_json: unknown }>(
      `SELECT object_type, object_id, indexed_at, source_updated_at,
              source_connection_ids_json,
              NULL::int AS missing_chunk_count
         FROM retrieval_objects
        WHERE space_id = $1
          AND status <> 'archived'
          AND object_type = ANY($2::retrieval_object_type[])
          AND source_updated_at IS NOT NULL
          AND indexed_at < source_updated_at
        ORDER BY (source_updated_at - indexed_at) DESC, object_id ASC
        LIMIT $3`,
      [spaceId, objectTypes, fetch],
    );
    return result.rows;
  }

  private async queryEmbeddingBacklogObjects(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    fetch: number,
  ): Promise<Array<DrilldownObjectRow & { source_connection_ids_json: unknown }>> {
    const result = await this.db.query<DrilldownObjectRow & { source_connection_ids_json: unknown }>(
      `SELECT ro.object_type, ro.object_id, ro.indexed_at, ro.source_updated_at,
              ro.source_connection_ids_json,
              count(rc.id)::int AS missing_chunk_count
         FROM retrieval_objects ro
         JOIN retrieval_chunks rc
           ON rc.retrieval_object_id = ro.id
          AND rc.space_id = ro.space_id
          AND rc.embedding IS NULL
        WHERE ro.space_id = $1
          AND ro.status <> 'archived'
          AND ro.object_type = ANY($2::retrieval_object_type[])
        GROUP BY ro.id, ro.object_type, ro.object_id, ro.indexed_at, ro.source_updated_at, ro.source_connection_ids_json
        ORDER BY count(rc.id) DESC, ro.object_id ASC
        LIMIT $3`,
      [spaceId, objectTypes, fetch],
    );
    return result.rows;
  }

  private async loadSourceWarningDetails(
    spaceId: string,
    userId: string,
    limit: number,
    includeAllSources: boolean,
  ): Promise<{ sources: ContextOpsSourceWarningDetail[]; truncated: boolean }> {
    const result = await this.db.query<SourceWarningRow>(
      `SELECT id, name, owner_user_id, status, consent_json, policy_json
         FROM source_connections
        WHERE space_id = $1
          AND status = 'active'
          AND deleted_at IS NULL
          AND ${contentReadSql("source_connection", "source_connections", "$2")}
          AND ($3::boolean
            OR ${contentOwnerFilterSql("source_connection", "source_connections", "$2")}
            OR ${contentVisibilityFilterSql("source_connections", ["selected_users"])})
        ORDER BY updated_at DESC, id ASC
        LIMIT $4`,
      [spaceId, userId, includeAllSources, limit + 1],
    );
    const truncated = result.rows.length > limit;
    const sources = result.rows.slice(0, limit).map((row) => ({
      source_connection_id: row.id,
      name: row.name,
      owner_user_id: row.owner_user_id,
      status: row.status,
      warnings: sourceWarningLabels(row),
    }));
    return { sources, truncated };
  }

  private async loadIndexFreshness(spaceId: string): Promise<ContextOpsSummary["index_freshness"]> {
    const result = await this.db.query<IndexFreshnessRow>(
      `SELECT object_type,
              count(*)::int AS total,
              count(*) FILTER (
                WHERE source_updated_at IS NOT NULL
                  AND indexed_at < source_updated_at
              )::int AS stale_projection_count,
              count(*) FILTER (
                WHERE jsonb_array_length(source_connection_ids_json) > 0
              )::int AS source_connected_object_count,
              min(indexed_at) AS oldest_indexed_at,
              max(indexed_at) AS newest_indexed_at,
              max(source_updated_at) AS newest_source_updated_at
         FROM retrieval_objects
        WHERE space_id = $1
          AND status <> 'archived'
        GROUP BY object_type
        ORDER BY object_type`,
      [spaceId],
    );
    const objectCounts: ContextOpsCountMap = {};
    let stale = 0;
    let sourceConnected = 0;
    let oldestIndexedAt: string | null = null;
    let newestIndexedAt: string | null = null;
    let newestSourceUpdatedAt: string | null = null;
    for (const row of result.rows) {
      const total = intValue(row.total);
      objectCounts[safeKey(row.object_type)] = total;
      stale += intValue(row.stale_projection_count);
      sourceConnected += intValue(row.source_connected_object_count);
      oldestIndexedAt = minIso(oldestIndexedAt, dateIso(row.oldest_indexed_at));
      newestIndexedAt = maxIso(newestIndexedAt, dateIso(row.newest_indexed_at));
      newestSourceUpdatedAt = maxIso(newestSourceUpdatedAt, dateIso(row.newest_source_updated_at));
    }
    return {
      object_counts: objectCounts,
      stale_projection_count: stale,
      source_connected_object_count: sourceConnected,
      oldest_indexed_at: oldestIndexedAt,
      newest_indexed_at: newestIndexedAt,
      newest_source_updated_at: newestSourceUpdatedAt,
    };
  }

  private async loadEmbeddingBacklog(spaceId: string): Promise<ContextOpsSummary["embedding_backlog"]> {
    const [summary, byType] = await Promise.all([
      this.db.query<EmbeddingBacklogRow>(
        `SELECT count(*)::int AS total_chunks,
                count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded_chunks,
                count(*) FILTER (WHERE embedding IS NULL)::int AS missing_embedding_chunks,
                count(*) FILTER (WHERE embedding IS NULL AND embedding_claim_id IS NOT NULL)::int AS claimed_chunks,
                count(*) FILTER (WHERE embedding IS NULL AND embedding_attempts > 0)::int AS attempted_chunks
           FROM retrieval_chunks
          WHERE space_id = $1`,
        [spaceId],
      ),
      this.db.query<MissingEmbeddingByTypeRow>(
        `SELECT object_type, count(*)::int AS total
           FROM retrieval_chunks
          WHERE space_id = $1
            AND embedding IS NULL
          GROUP BY object_type
          ORDER BY object_type`,
        [spaceId],
      ),
    ]);
    const row = summary.rows[0];
    return {
      total_chunks: intValue(row?.total_chunks),
      embedded_chunks: intValue(row?.embedded_chunks),
      missing_embedding_chunks: intValue(row?.missing_embedding_chunks),
      claimed_chunks: intValue(row?.claimed_chunks),
      attempted_chunks: intValue(row?.attempted_chunks),
      missing_by_object_type: countMap(byType.rows),
    };
  }

  private async loadSourcePolicyWarnings(spaceId: string, userId: string): Promise<ContextOpsSummary["source_policy_warnings"]> {
    const result = await this.db.query<SourcePolicyWarningsRow>(
      `SELECT count(*)::int AS active_source_connections,
              count(*) FILTER (
                WHERE consent_json->>'version' IS NULL
                  AND NOT coalesce(consent_json ? 'schema_version', false)
              )::int AS missing_consent_version_count,
              count(*) FILTER (
                WHERE jsonb_array_length(CASE
                        WHEN jsonb_typeof(policy_json->'allowed_reader_user_ids') = 'array'
                        THEN policy_json->'allowed_reader_user_ids'
                        ELSE '[]'::jsonb
                      END) > 0
                   OR jsonb_array_length(CASE
                        WHEN jsonb_typeof(consent_json->'allowed_reader_user_ids') = 'array'
                        THEN consent_json->'allowed_reader_user_ids'
                        ELSE '[]'::jsonb
                      END) > 0
                   OR jsonb_array_length(CASE
                        WHEN jsonb_typeof(policy_json->'allowed_agent_ids') = 'array'
                        THEN policy_json->'allowed_agent_ids'
                        ELSE '[]'::jsonb
                      END) > 0
                   OR jsonb_array_length(CASE
                        WHEN jsonb_typeof(consent_json->'allowed_agent_ids') = 'array'
                        THEN consent_json->'allowed_agent_ids'
                        ELSE '[]'::jsonb
                      END) > 0
                   OR policy_json->>'allow_space_admins' = 'false'
                   OR consent_json->>'allow_space_admins' = 'false'
              )::int AS reader_restricted_source_count,
              count(*) FILTER (
                WHERE consent_json->>'allow_external_model_egress' IS DISTINCT FROM 'true'
                   OR policy_json->>'source_egress_class' IS DISTINCT FROM 'external_provider_allowed'
              )::int AS external_egress_disabled_source_count,
              count(*) FILTER (
                WHERE policy_json->>'derived_write_policy' = 'disabled'
              )::int AS derived_writes_disabled_source_count
         FROM source_connections
        WHERE space_id = $1
          AND status = 'active'
          AND deleted_at IS NULL
          AND ${contentReadSql("source_connection", "source_connections", "$2")}`,
      [spaceId, userId],
    );
    const row = result.rows[0];
    const warningCounts: ContextOpsCountMap = {
      missing_consent_version: intValue(row?.missing_consent_version_count),
      reader_restricted_source: intValue(row?.reader_restricted_source_count),
      external_egress_disabled_source: intValue(row?.external_egress_disabled_source_count),
      derived_writes_disabled_source: intValue(row?.derived_writes_disabled_source_count),
    };
    return {
      active_source_connections: intValue(row?.active_source_connections),
      missing_consent_version_count: warningCounts.missing_consent_version ?? 0,
      reader_restricted_source_count: warningCounts.reader_restricted_source ?? 0,
      external_egress_disabled_source_count: warningCounts.external_egress_disabled_source ?? 0,
      derived_writes_disabled_source_count: warningCounts.derived_writes_disabled_source ?? 0,
      warning_counts: warningCounts,
    };
  }

  private async loadMaintenanceArtifacts(
    spaceId: string,
    userId: string,
    windowStart: Date,
    limit: number,
    includeSpaceOpsReports: boolean,
  ): Promise<ArtifactRow[]> {
    const result = await this.db.query<ArtifactRow>(
      `SELECT id, artifact_type, title, created_at, metadata_json
         FROM artifacts
        WHERE space_id = $1
          AND ${contentReadSql("artifact", "artifacts", "$2")}
          AND (
            (${contentVisibilityFilterSql("artifacts", ["private", "selected_users"])})
            OR (
              $6::boolean
              AND ${contentVisibilityFilterSql("artifacts", ["space_shared"])}
              AND metadata_json->>'review_scope' = 'space_ops'
            )
          )
          AND artifact_type = ANY($3::varchar[])
          AND created_at >= $4
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [spaceId, userId, [...MAINTENANCE_ARTIFACT_TYPES], windowStart.toISOString(), limit, includeSpaceOpsReports],
    );
    return result.rows;
  }

  private async loadMaintenancePackets(
    spaceId: string,
    userId: string,
    windowStart: Date,
    limit: number,
    includeSpaceOpsReports: boolean,
  ): Promise<ProposalRow[]> {
    const result = await this.db.query<ProposalRow>(
      `SELECT id, proposal_type, status, title, created_at, payload_json
         FROM proposals
        WHERE space_id = $1
          AND ${contentReadSql("proposal", "proposals", "$2")}
          AND (
            (${contentVisibilityFilterSql("proposals", ["private", "selected_users"])})
            OR (
              $6::boolean
              AND ${contentVisibilityFilterSql("proposals", ["space_shared"])}
              AND payload_json->>'review_scope' = 'space_ops'
            )
          )
          AND proposal_type = ANY($3::varchar[])
          AND created_at >= $4
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [spaceId, userId, [...MAINTENANCE_PACKET_TYPES], windowStart.toISOString(), limit, includeSpaceOpsReports],
    );
    return result.rows;
  }

  private async loadDiagnosticsArtifacts(
    spaceId: string,
    userId: string,
    windowStart: Date,
    limit: number,
    includeSpaceOpsReports: boolean,
  ): Promise<ArtifactRow[]> {
    const result = await this.db.query<ArtifactRow>(
      `SELECT id, artifact_type, title, created_at, metadata_json
         FROM artifacts
        WHERE space_id = $1
          AND ${contentReadSql("artifact", "artifacts", "$2")}
          AND (
            (${contentVisibilityFilterSql("artifacts", ["private", "selected_users"])})
            OR (
              $6::boolean
              AND ${contentVisibilityFilterSql("artifacts", ["space_shared"])}
              AND metadata_json->>'review_scope' = 'space_ops'
            )
          )
          AND artifact_type = $3
          AND metadata_json->>'suite' = 'retrieval_quality_feedback_loop'
          AND created_at >= $4
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [spaceId, userId, DIAGNOSTICS_ARTIFACT_TYPE, windowStart.toISOString(), limit, includeSpaceOpsReports],
    );
    return result.rows;
  }

  private async loadRecentContextBriefs(
    spaceId: string,
    userId: string,
    windowStart: Date,
    limit: number,
  ): Promise<ArtifactRow[]> {
    const result = await this.db.query<ArtifactRow>(
      `SELECT id, artifact_type, title, created_at, metadata_json
         FROM artifacts
        WHERE space_id = $1
          AND ${contentReadSql("artifact", "artifacts", "$2")}
          AND ${contentOwnerFilterSql("artifact", "artifacts", "$2")}
          AND ${contentVisibilityFilterSql("artifacts", ["private"])}
          AND artifact_type = $3
          AND created_at >= $4
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [spaceId, userId, CONTEXT_BRIEF_ARTIFACT_TYPE, windowStart.toISOString(), limit],
    );
    return result.rows;
  }

  private async loadExplainArtifacts(
    spaceId: string,
    userId: string,
    windowStart: Date,
    limit: number,
  ): Promise<ArtifactRow[]> {
    const result = await this.db.query<ArtifactRow>(
      `SELECT id, artifact_type, title, created_at, metadata_json
         FROM artifacts
        WHERE space_id = $1
          AND ${contentReadSql("artifact", "artifacts", "$2")}
          AND ${contentOwnerFilterSql("artifact", "artifacts", "$2")}
          AND ${contentVisibilityFilterSql("artifacts", ["private"])}
          AND artifact_type = $3
          AND created_at >= $4
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [spaceId, userId, EXPLAIN_ARTIFACT_TYPE, windowStart.toISOString(), limit],
    );
    return result.rows;
  }

  private async loadRetrievalFeedback(
    spaceId: string,
    userId: string,
    windowStart: Date,
    windowDays: number,
  ): Promise<ContextOpsSummary["retrieval_feedback"]> {
    const [signalRows, surfaceRows] = await Promise.all([
      this.db.query<CountRow>(
        `SELECT signal_type AS key, count(*)::int AS total
           FROM retrieval_feedback_events
          WHERE space_id = $1
            AND actor_user_id = $2
            AND created_at >= $3
          GROUP BY signal_type`,
        [spaceId, userId, windowStart.toISOString()],
      ),
      this.db.query<CountRow>(
        `SELECT surface AS key, count(*)::int AS total
           FROM retrieval_feedback_events
          WHERE space_id = $1
            AND actor_user_id = $2
            AND created_at >= $3
          GROUP BY surface`,
        [spaceId, userId, windowStart.toISOString()],
      ),
    ]);
    const signalCounts = countMap(signalRows.rows);
    return {
      recent_event_count: sumCounts(signalCounts),
      signal_counts: signalCounts,
      surface_counts: countMap(surfaceRows.rows),
      window_days: windowDays,
    };
  }

  private async loadMemoryProvenance(
    spaceId: string,
    userId: string,
    windowStart: Date,
  ): Promise<ContextOpsSummary["memory_provenance"]> {
    const result = await this.db.query<AccessCountRow>(
      `SELECT count(*)::int AS recent_access_count,
              count(*) FILTER (WHERE access_type = 'context_injection')::int AS context_injection_count,
              count(*) FILTER (WHERE access_type = 'maintenance_scan')::int AS maintenance_scan_count
         FROM content_access_logs
        WHERE space_id = $1
          AND resource_type = 'memory'
          AND viewer_user_id = $2
          AND accessed_at >= $3`,
      [spaceId, userId, windowStart.toISOString()],
    );
    const row = result.rows[0];
    return {
      recent_access_count: intValue(row?.recent_access_count),
      context_injection_count: intValue(row?.context_injection_count),
      maintenance_scan_count: intValue(row?.maintenance_scan_count),
      inspector_available: true,
    };
  }
}

function aggregateMaintenanceFindings(rows: ArtifactRow[]): ContextOpsCountMap {
  const counts: ContextOpsCountMap = {};
  for (const row of rows) {
    const metadata = record(row.metadata_json);
    const directCounts = record(metadata.counts);
    let usedDirectCounts = false;
    for (const [key, value] of Object.entries(directCounts)) {
      const count = intValue(value);
      if (count <= 0) continue;
      counts[safeKey(key)] = (counts[safeKey(key)] ?? 0) + count;
      usedDirectCounts = true;
    }
    if (usedDirectCounts) continue;
    for (const finding of arrayValue(metadata.findings).map(record)) {
      const kind = stringValue(finding.kind) ?? "unknown";
      counts[safeKey(kind)] = (counts[safeKey(kind)] ?? 0) + 1;
    }
  }
  return counts;
}

function aggregateDiagnostics(rows: ArtifactRow[]): ContextOpsSummary["diagnostics"] {
  const diagnosticCodeCounts: ContextOpsCountMap = {};
  const metricSums: Record<string, number> = {};
  const metricCounts: Record<string, number> = {};
  let latestReportArtifactId: string | null = null;
  let latestGeneratedAt: string | null = null;
  let insufficientTrendSample = false;

  for (const row of rows) {
    const metadata = record(row.metadata_json);
    if (!latestReportArtifactId) latestReportArtifactId = row.id;
    latestGeneratedAt = maxIso(latestGeneratedAt, dateIso(metadata.generated_at) ?? dateIso(row.created_at));
    for (const code of stringArray(metadata.diagnostic_codes)) {
      const safe = safeKey(code);
      diagnosticCodeCounts[safe] = (diagnosticCodeCounts[safe] ?? 0) + 1;
      if (safe === "insufficient_trend_sample") insufficientTrendSample = true;
    }
    const metrics = record(metadata.metrics);
    for (const [key, value] of Object.entries(metrics)) {
      if (!isTrendMetric(key)) continue;
      const numeric = numberValue(value);
      if (numeric === null) continue;
      const safe = safeKey(key);
      metricSums[safe] = (metricSums[safe] ?? 0) + numeric;
      metricCounts[safe] = (metricCounts[safe] ?? 0) + 1;
    }
  }

  const trendMetricDeltas: Record<string, number> = {};
  for (const [key, total] of Object.entries(metricSums)) {
    trendMetricDeltas[key] = Number((total / Math.max(1, metricCounts[key] ?? 1)).toFixed(4));
  }

  return {
    recent_report_count: rows.length,
    diagnostic_code_counts: diagnosticCodeCounts,
    latest_report_artifact_id: latestReportArtifactId,
    latest_generated_at: latestGeneratedAt,
    trend_metric_deltas: trendMetricDeltas,
    insufficient_trend_sample: insufficientTrendSample,
  };
}

function artifactSummary(row: ArtifactRow): ContextOpsArtifactSummary {
  const metadata = record(row.metadata_json);
  const counts = record(metadata.counts);
  const findingCount =
    sumCounts(countMapFromRecord(counts)) ||
    (Array.isArray(metadata.findings) ? metadata.findings.length : null);
  return {
    artifact_id: row.id,
    artifact_type: row.artifact_type,
    title: row.title,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    surface: stringValue(metadata.surface),
    diagnostic_codes: stringArray(metadata.diagnostic_codes),
    finding_count: typeof findingCount === "number" ? findingCount : null,
  };
}

function proposalSummary(row: ProposalRow): ContextOpsPacketSummary {
  const payload = record(row.payload_json);
  return {
    proposal_id: row.id,
    proposal_type: row.proposal_type,
    status: row.status,
    title: row.title,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    report_artifact_id: stringValue(payload.report_artifact_id),
  };
}

function countMap(rows: CountRow[] | MissingEmbeddingByTypeRow[]): ContextOpsCountMap {
  const result: ContextOpsCountMap = {};
  for (const row of rows) {
    const key = "key" in row ? row.key : row.object_type;
    if (!key) continue;
    result[safeKey(key)] = intValue(row.total);
  }
  return result;
}

function countMapFromRecord(recordValue: Record<string, unknown>): ContextOpsCountMap {
  const result: ContextOpsCountMap = {};
  for (const [key, value] of Object.entries(recordValue)) {
    const count = intValue(value);
    if (count > 0) result[safeKey(key)] = count;
  }
  return result;
}

function sumCounts(counts: ContextOpsCountMap): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function isTrendMetric(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.endsWith("_delta") || normalized.includes("trend");
}

function intValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return 0;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function dateIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function minIso(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate < current ? candidate : current;
}

function maxIso(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate > current ? candidate : current;
}

function safeKey(key: string): string {
  const normalized = key.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return normalized || "unknown";
}

/**
 * Revalidate the candidate rows through the registered adapter read gate AND the
 * source-connection read policy, returning `type:id -> revalidated title` for
 * only the rows the viewer may fully read. Mirrors the search pipeline's two
 * gates so a drill-down never lists a canonical-invisible or source-restricted
 * object (invariant 3/7).
 */
async function revalidateReadable(
  db: Queryable,
  registry: RetrievalRegistry,
  spaceId: string,
  userId: string,
  rows: ReadonlyArray<{
    object_type: RetrievalObjectType;
    object_id: string;
    source_connection_ids_json: unknown;
  }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rows.length === 0) return out;

  const byType = new Map<RetrievalObjectType, string[]>();
  for (const row of rows) {
    const ids = byType.get(row.object_type) ?? [];
    ids.push(row.object_id);
    byType.set(row.object_type, ids);
  }
  const revalidated = new Map<string, RevalidatedObject>();
  for (const [objectType, objectIds] of byType) {
    const adapter = registry.adapterFor(objectType);
    if (!adapter) continue;
    if (adapter.revalidateMany) {
      const readable = await adapter.revalidateMany(db, spaceId, objectType, objectIds, userId);
      for (const [id, value] of readable) revalidated.set(`${objectType}:${id}`, value);
    } else {
      for (const id of objectIds) {
        const value = await adapter.revalidate(db, spaceId, objectType, id, userId);
        if (value) revalidated.set(`${objectType}:${id}`, value);
      }
    }
  }

  const allSourceIds = new Set<string>();
  for (const row of rows) {
    for (const id of sourceConnectionIdsFromJson(row.source_connection_ids_json)) allSourceIds.add(id);
  }
  const [snapshots, viewerSpaceRole] = allSourceIds.size
    ? await Promise.all([
        loadSourcePolicySnapshots(db, spaceId, [...allSourceIds]),
        loadViewerSpaceRole(db, spaceId, userId),
      ])
    : [new Map(), null as string | null];

  for (const row of rows) {
    const key = `${row.object_type}:${row.object_id}`;
    const value = revalidated.get(key);
    if (!value) continue;
    const sourceIds = sourceConnectionIdsFromJson(row.source_connection_ids_json);
    const allowed = sourceIds.every((sourceId) => {
      const snapshot = snapshots.get(sourceId);
      return snapshot
        ? sourcePolicyAllowsRead(snapshot, { viewerUserId: userId, viewerSpaceRole })
        : false;
    });
    if (!allowed) continue;
    out.set(key, value.title);
  }
  return out;
}

/** Warning labels for one source connection — policy posture only, never payloads. */
function sourceWarningLabels(row: SourceWarningRow): string[] {
  const consent = record(row.consent_json);
  const policy = record(row.policy_json);
  const warnings: string[] = [];
  if (stringValue(consent.version) === null && consent.schema_version === undefined) {
    warnings.push("missing_consent_version");
  }
  const restrictedReaders =
    arrayValue(policy.allowed_reader_user_ids).length > 0 ||
    arrayValue(consent.allowed_reader_user_ids).length > 0 ||
    arrayValue(policy.allowed_agent_ids).length > 0 ||
    arrayValue(consent.allowed_agent_ids).length > 0 ||
    consent.allow_space_admins === false ||
    policy.allow_space_admins === false;
  if (restrictedReaders) warnings.push("reader_restricted");
  if (
    consent.allow_external_model_egress !== true ||
    stringValue(policy.source_egress_class) !== "external_provider_allowed"
  ) {
    warnings.push("external_egress_disabled");
  }
  if (stringValue(policy.derived_write_policy) === "disabled") warnings.push("derived_writes_disabled");
  return warnings;
}
