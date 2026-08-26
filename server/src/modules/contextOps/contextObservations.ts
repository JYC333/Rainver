import { randomUUID } from "node:crypto";
import type {
  ContextOpsContextObservationReport,
  ContextOpsContextObservationScanRequest,
  ContextObservationItem,
} from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import { ContextOpsService } from "./service.js";

export const CONTEXT_OBSERVATION_REPORT_ARTIFACT_TYPE = "context_observation_report";

export async function runContextObservationScan(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    request: ContextOpsContextObservationScanRequest;
  },
): Promise<{ report: ContextOpsContextObservationReport; artifact_id: string | null; canonical_write_performed: false }> {
  const summary = await new ContextOpsService(db).getSummary({
    spaceId: input.spaceId,
    userId: input.userId,
    windowDays: input.request.window_days,
    limit: input.request.limit,
    includeSpaceOpsReports: false,
  });
  const generatedAt = new Date().toISOString();
  const observations = buildObservations(summary);
  const counts = observations.reduce<Record<string, number>>((acc, item) => {
    acc[item.severity] = (acc[item.severity] ?? 0) + 1;
    return acc;
  }, { red: 0, yellow: 0, green: 0 });
  const sourceRefs = buildSourceRefs(summary);
  const report: ContextOpsContextObservationReport = {
    kind: "context_observation_report",
    version: 1,
    generated_at: generatedAt,
    space_id: input.spaceId,
    owner_user_id: input.userId,
    window_days: input.request.window_days,
    observations,
    counts,
    source_refs: sourceRefs,
    access_safety: {
      aggregate_or_review_refs_only: true,
      raw_private_content_included: false,
      canonical_write_performed: false,
    },
    canonical_write_performed: false,
  };
  const artifactId = input.request.persist_report
    ? await persistContextObservationReport(db, {
        spaceId: input.spaceId,
        ownerUserId: input.userId,
        report,
        createdAt: generatedAt,
      })
    : null;
  return { report, artifact_id: artifactId, canonical_write_performed: false };
}

function buildObservations(summary: Record<string, unknown>): ContextObservationItem[] {
  const observations: ContextObservationItem[] = [];
  const sourceWarnings = recordValue(summary.source_policy_warnings);
  const warningCounts = recordValue(sourceWarnings.warning_counts);
  const sourceWarningTotal = sumValues(warningCounts);
  if (sourceWarningTotal > 0) {
    observations.push({
      severity: "red",
      title: "Source policy warnings need review",
      summary: `${sourceWarningTotal} source policy warning(s) are present in the current Context Ops window.`,
      source_refs: [{ source_type: "context_health_summary", section: "source_policy_warnings" }],
      suggested_target: "review_only",
    });
  }

  const embedding = recordValue(summary.embedding_backlog);
  const missingChunks = numberValue(embedding.missing_embedding_chunks);
  if (missingChunks > 0) {
    observations.push({
      severity: missingChunks > 25 ? "red" : "yellow",
      title: "Retrieval embedding backlog",
      summary: `${missingChunks} retrieval chunk(s) are missing embeddings.`,
      source_refs: [{ source_type: "context_health_summary", section: "embedding_backlog" }],
      suggested_target: "review_only",
    });
  }

  const maintenance = recordValue(summary.maintenance);
  const pendingPackets = numberValue(maintenance.pending_packet_count);
  const findingTotal = sumValues(recordValue(maintenance.finding_counts));
  if (pendingPackets > 0 || findingTotal > 0) {
    observations.push({
      severity: pendingPackets > 0 ? "yellow" : "green",
      title: "Maintenance findings are waiting",
      summary: `${findingTotal} maintenance finding(s), ${pendingPackets} pending review packet(s).`,
      source_refs: [{ source_type: "context_health_summary", section: "maintenance" }],
      suggested_target: "review_only",
    });
  }

  const memory = recordValue(summary.memory_provenance);
  const contextInjectionCount = numberValue(memory.context_injection_count);
  const maintenanceScanCount = numberValue(memory.maintenance_scan_count);
  if (contextInjectionCount > 0 || maintenanceScanCount > 0) {
    observations.push({
      severity: "green",
      title: "Context loop has recent activity",
      summary: `${contextInjectionCount} context injection(s), ${maintenanceScanCount} maintenance scan(s) in the current window.`,
      source_refs: [{ source_type: "context_health_summary", section: "memory_provenance" }],
      suggested_target: "review_only",
    });
  }

  if (observations.length === 0) {
    observations.push({
      severity: "green",
      title: "No immediate context action",
      summary: "Context Ops did not find source warnings, embedding backlog, or pending maintenance work in this window.",
      source_refs: [{ source_type: "context_health_summary", section: "overview" }],
      suggested_target: "review_only",
    });
  }
  return observations;
}

async function persistContextObservationReport(
  db: Queryable,
  input: {
    spaceId: string;
    ownerUserId: string;
    report: ContextOpsContextObservationReport;
    createdAt: string;
  },
): Promise<string> {
  const id = randomUUID();
  const payload = { ...input.report, artifact_id: id };
  return insertArtifactRow(db, {
    id,
    spaceId: input.spaceId,
    ownerUserId: input.ownerUserId,
    artifactType: CONTEXT_OBSERVATION_REPORT_ARTIFACT_TYPE,
    title: "Context Observation Report",
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "context_observation_report.v1",
    visibility: "private",
    createdAt: input.createdAt,
  });
}

function buildSourceRefs(summary: Record<string, unknown>): Record<string, unknown>[] {
  const refs: Record<string, unknown>[] = [
    { source_type: "context_health_summary", generated_at: summary.generated_at ?? null },
  ];
  const briefs = Array.isArray(summary.recent_context_briefs)
    ? summary.recent_context_briefs
    : [];
  for (const brief of briefs.slice(0, 10)) {
    const record = recordValue(brief);
    const artifactId = stringValue(record.artifact_id);
    if (artifactId) refs.push({ source_type: "artifact", artifact_id: artifactId, artifact_type: record.artifact_type ?? "retrieval_brief" });
  }
  return refs;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sumValues(value: Record<string, unknown>): number {
  return Object.values(value).reduce<number>((sum, item) => sum + numberValue(item), 0);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
