import type { RetrievalEvalReportCase, RetrievalEvalReportRequest } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import {
  contentOwnerFilterSql,
  contentReadSql,
  contentVisibilityFilterSql,
} from "../access/contentAccessSql.js";

interface BriefArtifactRow {
  artifact_type: string;
  metadata_json: unknown;
}

interface BuildRetrievalEvalDiagnosticsInput {
  spaceId: string;
  ownerUserId: string;
  windowDays: number;
  limit: number;
  reportLabel?: string;
  includeMaintenanceReports?: boolean;
  comparePreviousWindow?: boolean;
}

interface BriefAggregate {
  totalBriefs: number;
  synthesized: number;
  totalSources: number;
  lowCoverage: number;
  staleRefs: number;
  thinRefs: number;
  uncitedClaims: number;
  contradictions: number;
  missingTopics: number;
  surfaceCounts: Record<string, number>;
  objectTypeCounts: Record<string, number>;
  matchedFieldCounts: Record<string, number>;
  scoreBuckets: Record<string, number>;
  maintenanceReports: number;
  maintenanceFindings: number;
  maintenanceCounts: Record<string, number>;
  evalReports: number;
  evalDiagnosticCounts: Record<string, number>;
  evalMetricSums: Record<string, number>;
  evalMetricCounts: Record<string, number>;
}

const MIN_TREND_BRIEFS = 2;
const MIN_TREND_MAINTENANCE_REPORTS = 2;

export async function buildRetrievalEvalDiagnosticsReport(
  db: Queryable,
  input: BuildRetrievalEvalDiagnosticsInput,
): Promise<RetrievalEvalReportRequest> {
  const artifactTypes = input.includeMaintenanceReports === false
    ? ["retrieval_brief", "retrieval_eval_report"]
    : ["retrieval_brief", "retrieval_maintenance_report", "retrieval_eval_report"];
  const rows = await db.query<BriefArtifactRow>(
    `SELECT artifact_type, metadata_json
       FROM artifacts a
      WHERE a.space_id = $1
        AND ${contentReadSql("artifact", "a", "$2")}
        AND ${contentOwnerFilterSql("artifact", "a", "$2")}
        AND ${contentVisibilityFilterSql("a", ["private"])}
        AND a.artifact_type = ANY($5::varchar[])
        AND NOT (
          artifact_type = 'retrieval_eval_report'
          AND (
            metadata_json->>'suite' = 'retrieval_quality_feedback_loop'
            OR metadata_json->>'source' = 'product_diagnostic'
          )
        )
        AND created_at >= now() - ($3::int * interval '1 day')
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [input.spaceId, input.ownerUserId, input.windowDays, input.limit, artifactTypes],
  );
  const previousRows = input.comparePreviousWindow === false
    ? []
    : (await db.query<BriefArtifactRow>(
        `SELECT artifact_type, metadata_json
           FROM artifacts a
          WHERE a.space_id = $1
            AND ${contentReadSql("artifact", "a", "$2")}
            AND ${contentOwnerFilterSql("artifact", "a", "$2")}
            AND ${contentVisibilityFilterSql("a", ["private"])}
            AND a.artifact_type = ANY($5::varchar[])
            AND NOT (
              artifact_type = 'retrieval_eval_report'
              AND (
                metadata_json->>'suite' = 'retrieval_quality_feedback_loop'
                OR metadata_json->>'source' = 'product_diagnostic'
              )
            )
            AND created_at < now() - ($3::int * interval '1 day')
            AND created_at >= now() - (($3::int * 2) * interval '1 day')
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [input.spaceId, input.ownerUserId, input.windowDays, input.limit, artifactTypes],
      )).rows;

  return buildRetrievalEvalDiagnosticsReportFromArtifactMetadata(
    rows.rows.map((row) => ({ artifactType: row.artifact_type, metadata: row.metadata_json })),
    input,
    previousRows.map((row) => ({ artifactType: row.artifact_type, metadata: row.metadata_json })),
  );
}

export function buildRetrievalEvalDiagnosticsReportFromMetadata(
  metadata: unknown[],
  input: BuildRetrievalEvalDiagnosticsInput,
): RetrievalEvalReportRequest {
  return buildRetrievalEvalDiagnosticsReportFromArtifactMetadata(
    metadata.map((item) => ({ artifactType: "retrieval_brief", metadata: item })),
    input,
  );
}

export function buildRetrievalEvalDiagnosticsReportFromArtifactMetadata(
  metadata: Array<{ artifactType?: string; metadata: unknown }>,
  input: BuildRetrievalEvalDiagnosticsInput,
  previousMetadata: Array<{ artifactType?: string; metadata: unknown }> = [],
): RetrievalEvalReportRequest {
  const aggregate = aggregateArtifactMetadata(metadata);
  const previous = previousMetadata.length > 0 ? aggregateArtifactMetadata(previousMetadata) : null;
  const counts = buildCounts(aggregate, input, previous);
  const metrics = buildMetrics(aggregate, previous);
  const diagnosticCodes = diagnosticCodesForAggregate(aggregate, previous);
  return {
    source: "product_diagnostic",
    suite: "retrieval_quality_feedback_loop",
    report_label: input.reportLabel ?? `Retrieval brief diagnostics ${input.windowDays}d`,
    metrics,
    counts,
    cases: buildCases(aggregate),
    rank_attribution: {
      evidence_kind_counts: {},
      matched_field_counts: aggregate.matchedFieldCounts,
      score_buckets: aggregate.scoreBuckets,
    },
    diagnostic_codes: diagnosticCodes,
  };
}

function aggregateArtifactMetadata(metadata: Array<{ artifactType?: string; metadata: unknown }>): BriefAggregate {
  const aggregate: BriefAggregate = {
    totalBriefs: 0,
    synthesized: 0,
    totalSources: 0,
    lowCoverage: 0,
    staleRefs: 0,
    thinRefs: 0,
    uncitedClaims: 0,
    contradictions: 0,
    missingTopics: 0,
    surfaceCounts: {},
    objectTypeCounts: {},
    matchedFieldCounts: {},
    scoreBuckets: {},
    maintenanceReports: 0,
    maintenanceFindings: 0,
    maintenanceCounts: {},
    evalReports: 0,
    evalDiagnosticCounts: {},
    evalMetricSums: {},
    evalMetricCounts: {},
  };

  for (const entry of metadata) {
    const raw = entry.metadata;
    const brief = record(raw);
    const kind = stringValue(brief.kind) ?? entry.artifactType ?? "unknown";
    if (kind === "retrieval_maintenance_report") {
      aggregate.maintenanceReports += 1;
      const counts = record(brief.counts);
      let total = 0;
      for (const [key, value] of Object.entries(counts)) {
        const count = integerValue(value) ?? 0;
        if (count <= 0) continue;
        total += count;
        incrementBy(aggregate.maintenanceCounts, safeKey(key), count);
      }
      if (total === 0) {
        total = arrayValue(brief.findings).length;
      }
      aggregate.maintenanceFindings += total;
      continue;
    }
    if (kind === "retrieval_eval_report") {
      if (isFeedbackLoopDiagnosticsReport(brief)) continue;
      aggregate.evalReports += 1;
      for (const code of stringArray(brief.diagnostic_codes)) {
        increment(aggregate.evalDiagnosticCounts, safeKey(code));
      }
      const metrics = record(brief.metrics);
      for (const [key, value] of Object.entries(metrics)) {
        const metric = numberValue(value);
        if (metric === null) continue;
        const safe = safeKey(key);
        aggregate.evalMetricSums[safe] = (aggregate.evalMetricSums[safe] ?? 0) + metric;
        aggregate.evalMetricCounts[safe] = (aggregate.evalMetricCounts[safe] ?? 0) + 1;
      }
      continue;
    }
    if (kind !== "retrieval_brief") continue;
    aggregate.totalBriefs += 1;
    if (brief.synthesized === true) aggregate.synthesized += 1;
    increment(aggregate.surfaceCounts, safeKey(stringValue(brief.surface) ?? "unknown"));

    const itemRefs = arrayValue(brief.item_refs).map(record);
    const sourceCount = integerValue(brief.source_count) ?? itemRefs.length;
    aggregate.totalSources += sourceCount;
    for (const ref of itemRefs) {
      increment(aggregate.objectTypeCounts, safeKey(stringValue(ref.object_type) ?? "unknown"));
      for (const field of stringArray(ref.matched_fields)) {
        increment(aggregate.matchedFieldCounts, safeKey(field));
      }
      increment(aggregate.scoreBuckets, scoreBucket(numberValue(ref.score)));
    }

    const gap = record(brief.gap_analysis);
    if (gap.low_coverage === true) aggregate.lowCoverage += 1;
    aggregate.staleRefs += arrayValue(gap.stale).length;
    aggregate.thinRefs += arrayValue(gap.thin).length;
    aggregate.uncitedClaims += arrayValue(gap.uncited_claims).length;
    aggregate.contradictions += arrayValue(gap.contradictions).length;
    aggregate.missingTopics += arrayValue(gap.missing_topics).length;
  }

  return aggregate;
}

function buildMetrics(aggregate: BriefAggregate, previous: BriefAggregate | null): Record<string, number> {
  const metrics: Record<string, number> = {
    synthesis_rate: ratio(aggregate.synthesized, aggregate.totalBriefs),
    sources_per_brief: ratio(aggregate.totalSources, aggregate.totalBriefs),
    low_coverage_rate: ratio(aggregate.lowCoverage, aggregate.totalBriefs),
    uncited_claims_per_brief: ratio(aggregate.uncitedClaims, aggregate.totalBriefs),
    contradictions_per_brief: ratio(aggregate.contradictions, aggregate.totalBriefs),
    missing_topics_per_brief: ratio(aggregate.missingTopics, aggregate.totalBriefs),
    maintenance_findings_per_report: ratio(aggregate.maintenanceFindings, aggregate.maintenanceReports),
  };
  for (const [key, sum] of Object.entries(aggregate.evalMetricSums)) {
    metrics[`eval_avg.${key}`] = ratio(sum, aggregate.evalMetricCounts[key] ?? 0);
  }
  if (previous && briefTrendSampleSufficient(aggregate, previous)) {
    metrics["trend.low_coverage_rate_delta"] = delta(
      metrics.low_coverage_rate,
      ratio(previous.lowCoverage, previous.totalBriefs),
    );
    metrics["trend.contradictions_per_brief_delta"] = delta(
      metrics.contradictions_per_brief,
      ratio(previous.contradictions, previous.totalBriefs),
    );
    metrics["trend.missing_topics_per_brief_delta"] = delta(
      metrics.missing_topics_per_brief,
      ratio(previous.missingTopics, previous.totalBriefs),
    );
  }
  if (previous && maintenanceTrendSampleSufficient(aggregate, previous)) {
    metrics["trend.maintenance_findings_per_report_delta"] = delta(
      metrics.maintenance_findings_per_report,
      ratio(previous.maintenanceFindings, previous.maintenanceReports),
    );
  }
  return metrics;
}

function buildCounts(
  aggregate: BriefAggregate,
  input: BuildRetrievalEvalDiagnosticsInput,
  previous: BriefAggregate | null,
): Record<string, number> {
  const counts: Record<string, number> = {
    window_days: input.windowDays,
    artifact_limit: input.limit,
    briefs_total: aggregate.totalBriefs,
    synthesized_briefs: aggregate.synthesized,
    sources_total: aggregate.totalSources,
    low_coverage_briefs: aggregate.lowCoverage,
    stale_refs_total: aggregate.staleRefs,
    thin_refs_total: aggregate.thinRefs,
    uncited_claims_total: aggregate.uncitedClaims,
    contradictions_total: aggregate.contradictions,
    missing_topics_total: aggregate.missingTopics,
    maintenance_reports_total: aggregate.maintenanceReports,
    maintenance_findings_total: aggregate.maintenanceFindings,
    eval_reports_total: aggregate.evalReports,
  };
  if (previous) {
    counts.previous_briefs_total = previous.totalBriefs;
    counts.previous_maintenance_reports_total = previous.maintenanceReports;
    counts["trend.min_briefs"] = MIN_TREND_BRIEFS;
    counts["trend.brief_sample_sufficient"] = briefTrendSampleSufficient(aggregate, previous) ? 1 : 0;
    counts["trend.min_maintenance_reports"] = MIN_TREND_MAINTENANCE_REPORTS;
    counts["trend.maintenance_sample_sufficient"] = maintenanceTrendSampleSufficient(aggregate, previous) ? 1 : 0;
    counts["trend.briefs_delta"] = aggregate.totalBriefs - previous.totalBriefs;
    counts["trend.maintenance_findings_delta"] = aggregate.maintenanceFindings - previous.maintenanceFindings;
  }
  for (const [key, value] of Object.entries(aggregate.surfaceCounts)) {
    counts[`surface.${key}`] = value;
  }
  for (const [key, value] of Object.entries(aggregate.objectTypeCounts)) {
    counts[`object_type.${key}`] = value;
  }
  for (const [key, value] of Object.entries(aggregate.maintenanceCounts)) {
    counts[`maintenance.${key}`] = value;
  }
  for (const [key, value] of Object.entries(aggregate.evalDiagnosticCounts)) {
    counts[`eval_code.${key}`] = value;
  }
  return counts;
}

function buildCases(aggregate: BriefAggregate): RetrievalEvalReportCase[] {
  if (aggregate.totalBriefs === 0) return [];
  return [
    diagnosticCase("brief.low_coverage", aggregate.lowCoverage, aggregate.totalBriefs, "low_coverage"),
    diagnosticCase("brief.uncited_claims", aggregate.uncitedClaims, aggregate.totalBriefs, "uncited_claims"),
    diagnosticCase("brief.contradictions", aggregate.contradictions, aggregate.totalBriefs, "contradictions"),
    diagnosticCase("brief.missing_topics", aggregate.missingTopics, aggregate.totalBriefs, "missing_topics"),
    diagnosticCase("brief.stale_sources", aggregate.staleRefs, aggregate.totalBriefs, "stale_sources"),
    diagnosticCase("brief.thin_sources", aggregate.thinRefs, aggregate.totalBriefs, "thin_sources"),
    diagnosticCase("maintenance.findings", aggregate.maintenanceFindings, Math.max(1, aggregate.maintenanceReports), "maintenance_findings_present"),
  ];
}

function diagnosticCase(
  caseLabel: string,
  count: number,
  totalBriefs: number,
  diagnosticCode: string,
): RetrievalEvalReportCase {
  return {
    case_label: caseLabel,
    metrics: {
      rate: ratio(count, totalBriefs),
    },
    expected_count: totalBriefs,
    returned_count: count,
    diagnostic_codes: count > 0 ? [diagnosticCode] : [],
  };
}

function diagnosticCodesForAggregate(aggregate: BriefAggregate, previous: BriefAggregate | null): string[] {
  if (aggregate.totalBriefs === 0 && aggregate.maintenanceReports === 0 && aggregate.evalReports === 0) {
    return ["no_diagnostic_artifacts"];
  }
  const codes: string[] = [];
  if (aggregate.lowCoverage > 0) codes.push("low_coverage");
  if (aggregate.uncitedClaims > 0) codes.push("uncited_claims");
  if (aggregate.contradictions > 0) codes.push("contradictions");
  if (aggregate.missingTopics > 0) codes.push("missing_topics");
  if (aggregate.staleRefs > 0) codes.push("stale_sources");
  if (aggregate.thinRefs > 0) codes.push("thin_sources");
  if (aggregate.maintenanceFindings > 0) codes.push("maintenance_findings_present");
  for (const key of Object.keys(aggregate.evalDiagnosticCounts)) {
    if (!key.startsWith("no_")) codes.push(`eval_${key}`);
  }
  if (previous) {
    const briefTrendApplicable = briefTrendSignalApplicable(aggregate, previous);
    const maintenanceTrendApplicable = maintenanceTrendSignalApplicable(aggregate, previous);
    const briefTrendSufficient = briefTrendSampleSufficient(aggregate, previous);
    const maintenanceTrendSufficient = maintenanceTrendSampleSufficient(aggregate, previous);
    if ((briefTrendApplicable && !briefTrendSufficient)
      || (maintenanceTrendApplicable && !maintenanceTrendSufficient)) {
      codes.push("insufficient_trend_sample");
    }
    if (briefTrendApplicable && briefTrendSufficient) {
      if (ratio(aggregate.lowCoverage, aggregate.totalBriefs) > ratio(previous.lowCoverage, previous.totalBriefs)) {
        codes.push("trend_low_coverage_worse");
      }
      if (ratio(aggregate.contradictions, aggregate.totalBriefs) > ratio(previous.contradictions, previous.totalBriefs)) {
        codes.push("trend_contradictions_worse");
      }
      if (ratio(aggregate.missingTopics, aggregate.totalBriefs) > ratio(previous.missingTopics, previous.totalBriefs)) {
        codes.push("trend_missing_topics_worse");
      }
    }
    if (maintenanceTrendApplicable
      && maintenanceTrendSufficient
      && ratio(aggregate.maintenanceFindings, aggregate.maintenanceReports) > ratio(previous.maintenanceFindings, previous.maintenanceReports)) {
      codes.push("trend_maintenance_findings_worse");
    }
  }
  if (!codes.length) codes.push("no_gap_signals");
  return [...new Set(codes)].slice(0, 50);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(6));
}

function delta(current: number, previous: number): number {
  return Number((current - previous).toFixed(6));
}

function isFeedbackLoopDiagnosticsReport(recordValue: Record<string, unknown>): boolean {
  return stringValue(recordValue.source) === "product_diagnostic"
    || stringValue(recordValue.suite) === "retrieval_quality_feedback_loop";
}

function briefTrendSampleSufficient(current: BriefAggregate, previous: BriefAggregate): boolean {
  return current.totalBriefs >= MIN_TREND_BRIEFS && previous.totalBriefs >= MIN_TREND_BRIEFS;
}

function briefTrendSignalApplicable(current: BriefAggregate, previous: BriefAggregate): boolean {
  return current.totalBriefs > 0 || previous.totalBriefs > 0;
}

function maintenanceTrendSampleSufficient(current: BriefAggregate, previous: BriefAggregate): boolean {
  return current.maintenanceReports >= MIN_TREND_MAINTENANCE_REPORTS
    && previous.maintenanceReports >= MIN_TREND_MAINTENANCE_REPORTS;
}

function maintenanceTrendSignalApplicable(current: BriefAggregate, previous: BriefAggregate): boolean {
  return current.maintenanceReports > 0 || previous.maintenanceReports > 0;
}

function scoreBucket(score: number | null): string {
  if (score === null) return "unknown";
  if (score >= 0.75) return "ge_0_75";
  if (score >= 0.5) return "ge_0_50";
  if (score >= 0.25) return "ge_0_25";
  return "lt_0_25";
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function incrementBy(target: Record<string, number>, key: string, count: number): void {
  target[key] = (target[key] ?? 0) + count;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function safeKey(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80);
  return normalized || "unknown";
}
