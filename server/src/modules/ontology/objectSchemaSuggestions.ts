import { randomUUID } from "node:crypto";
import type {
  ObjectSchemaSuggestionReport,
  ObjectSchemaSuggestionScanRequest,
} from "@agent-space/protocol";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import type { Queryable } from "../routeUtils/common.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { reviewScopeValue, visibilityForReviewScope } from "../proposals/reviewPackets.js";
import { RETRIEVAL_OBJECT_TYPE_VALUES } from "../retrieval/objectTypes.js";
import {
  loadSourceConnectionIdsForTargets,
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourceConnectionIdsFromMetadata,
  sourcePolicyAllowsRead,
} from "../retrieval/sourcePolicy.js";

export const OBJECT_SCHEMA_SUGGESTION_REPORT_ARTIFACT_TYPE = "object_schema_suggestion_report";

interface RegistryKind {
  id: string;
  key: string;
  label: string;
  base_object_type: string;
  status: string;
  version: number | string;
}

interface UsageRow {
  base_object_type: string;
  object_profile: string;
  visible_usage_count: number | string;
}

interface UsageObjectRow {
  object_id: string;
  base_object_type: string;
  object_profile: string;
  source_connection_ids: string[];
}

function readableClause(userParam: string, alias = "so"): string {
  return contentReadSql("space_object", alias, userParam);
}

export async function scanObjectSchemaSuggestions(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    request: ObjectSchemaSuggestionScanRequest;
  },
): Promise<ObjectSchemaSuggestionReport> {
  const baseTypes = normalizedBaseTypes(input.request.base_object_types);
  const [registryRows, usageRows] = await Promise.all([
    loadRegistryKinds(db, input.spaceId, baseTypes),
    loadVisibleUsage(db, input.spaceId, input.userId, baseTypes),
  ]);
  const registry = new Map<string, RegistryKind>();
  for (const row of registryRows) registry.set(registryKey(row.base_object_type, row.key), row);

  const findings: ObjectSchemaSuggestionReport["findings"] = [];
  for (const usage of usageRows) {
    const key = registryKey(usage.base_object_type, usage.object_profile);
    const registered = registry.get(key);
    if (!registered) {
      findings.push({
        id: randomUUID(),
        kind: "missing_object_profile",
        base_object_type: usage.base_object_type as ObjectSchemaSuggestionReport["findings"][number]["base_object_type"],
        object_profile: usage.object_profile,
        title: `Create object kind draft: ${usage.object_profile}`,
        reason: `${usage.visible_usage_count} visible ${usage.base_object_type} row(s) use "${usage.object_profile}" without a registry definition.`,
        confidence_tier: "high",
        visible_usage_count: countValue(usage.visible_usage_count),
        proposed_action: {
          proposal_type: "object_profile_create",
          key: usage.object_profile,
          label: labelFromKind(usage.object_profile),
          base_object_type: usage.base_object_type,
          status: "draft",
          field_schema: {},
        },
        evidence_refs: [],
        markers: { deterministic: true, source: "visible_kind_usage" },
      });
    } else if (registered.status === "deprecated") {
      findings.push({
        id: randomUUID(),
        kind: "deprecated_profile_usage",
        base_object_type: usage.base_object_type as ObjectSchemaSuggestionReport["findings"][number]["base_object_type"],
        object_profile: usage.object_profile,
        title: `Review deprecated kind usage: ${usage.object_profile}`,
        reason: `${usage.visible_usage_count} visible ${usage.base_object_type} row(s) still use deprecated object kind "${usage.object_profile}".`,
        confidence_tier: "medium",
        visible_usage_count: countValue(usage.visible_usage_count),
        proposed_action: null,
        evidence_refs: [],
        markers: { deterministic: true, object_profile_id: registered.id, object_profile_version: countValue(registered.version) },
      });
    }
  }

  const usageKeys = new Set(usageRows.map((row) => registryKey(row.base_object_type, row.object_profile)));
  for (const row of registryRows) {
    if (row.status !== "active") continue;
    if (usageKeys.has(registryKey(row.base_object_type, row.key))) continue;
    findings.push({
      id: randomUUID(),
      kind: "unused_active_profile",
      base_object_type: row.base_object_type as ObjectSchemaSuggestionReport["findings"][number]["base_object_type"],
      object_profile: row.key,
      title: `Review unused active kind: ${row.key}`,
      reason: `No currently visible ${row.base_object_type} rows use active object kind "${row.key}".`,
      confidence_tier: "low",
      visible_usage_count: 0,
      proposed_action: null,
      evidence_refs: [],
      markers: { deterministic: true, object_profile_id: row.id, object_profile_version: countValue(row.version) },
    });
  }

  const capped = findings.slice(0, input.request.limit);
  return {
    findings: capped,
    counts: countsFor(capped),
    scanned: {
      visible_usage_rows: usageRows.length,
      registry_rows: registryRows.length,
    },
    truncated: findings.length > capped.length,
    access_safety: {
      only_visible_usage: true,
      raw_content_read: false,
      hidden_counts_included: false,
      provider_call_performed: false,
      canonical_write_performed: false,
    },
  };
}

export async function persistObjectSchemaSuggestionReportArtifact(
  db: Queryable,
  input: {
    spaceId: string;
    ownerUserId: string;
    report: ObjectSchemaSuggestionReport;
    request: ObjectSchemaSuggestionScanRequest;
  },
): Promise<string> {
  const now = new Date().toISOString();
  const payload = {
    kind: OBJECT_SCHEMA_SUGGESTION_REPORT_ARTIFACT_TYPE,
    version: 1,
    visibility: visibilityForReviewScope(input.request.review_scope),
    review_scope: reviewScopeValue(input.request.review_scope),
    space_id: input.spaceId,
    owner_user_id: input.ownerUserId,
    generated_at: now,
    findings: input.report.findings,
    counts: input.report.counts,
    scanned: input.report.scanned,
    truncated: input.report.truncated,
    scan_options: input.request,
    access_safety: input.report.access_safety,
    retention_policy: {
      class: "object_schema_suggestion_report",
      raw_private_content_included: false,
      hidden_counts_included: false,
    },
  };
  return insertArtifactRow(db, {
    spaceId: input.spaceId,
    ownerUserId: input.ownerUserId,
    artifactType: OBJECT_SCHEMA_SUGGESTION_REPORT_ARTIFACT_TYPE,
    title: `Object schema suggestions (${input.report.findings.length})`,
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "object_schema_suggestion_report.v1",
    visibility: visibilityForReviewScope(input.request.review_scope),
    createdAt: now,
  });
}

async function loadRegistryKinds(
  db: Queryable,
  spaceId: string,
  baseTypes: readonly string[],
): Promise<RegistryKind[]> {
  const result = await db.query<RegistryKind>(
    `SELECT id, key, label, base_object_type, status, version
       FROM space_object_profiles
      WHERE space_id = $1
        AND status <> 'archived'
        AND base_object_type = ANY($2::retrieval_object_type[])
      ORDER BY base_object_type ASC, key ASC`,
    [spaceId, baseTypes],
  );
  return result.rows;
}

async function loadVisibleUsage(
  db: Queryable,
  spaceId: string,
  userId: string,
  baseTypes: readonly string[],
): Promise<UsageRow[]> {
  const rows: UsageObjectRow[] = [];
  if (baseTypes.includes("knowledge_item")) rows.push(...await loadKnowledgeKindUsageObjects(db, spaceId, userId));
  if (baseTypes.includes("claim")) rows.push(...await loadClaimKindUsageObjects(db, spaceId, userId));
  if (baseTypes.includes("source")) rows.push(...await loadSourceKindUsageObjects(db, spaceId, userId));
  if (baseTypes.includes("note")) rows.push(...await loadNoteKindUsageObjects(db, spaceId, userId));
  if (baseTypes.includes("memory_entry")) rows.push(...await loadMemoryEntryKindUsageObjects(db, spaceId, userId));
  if (baseTypes.includes("project_public_summary")) rows.push(...await loadProjectPublicSummaryKindUsageObjects(db, spaceId));
  const filtered = await filterUsageRowsBySourcePolicy(db, spaceId, userId, rows);
  return aggregateUsage(filtered).sort((a, b) =>
    a.base_object_type.localeCompare(b.base_object_type) ||
    a.object_profile.localeCompare(b.object_profile)
  );
}

async function loadKnowledgeKindUsageObjects(db: Queryable, spaceId: string, userId: string): Promise<UsageObjectRow[]> {
  const result = await db.query<{ object_id: string; object_profile: string }>(
    `SELECT ki.object_id,
            ki.knowledge_kind AS object_profile
       FROM knowledge_items ki
       JOIN space_objects so
         ON so.id = ki.object_id
        AND so.space_id = ki.space_id
        AND so.object_type = 'knowledge_item'
      WHERE ki.space_id = $1
        AND so.deleted_at IS NULL
        AND ki.status = 'active'
        AND ${readableClause("$2")}
      ORDER BY ki.object_id ASC`,
    [spaceId, userId],
  );
  const sourceIds = await loadSourceConnectionIdsForTargets(
    db,
    spaceId,
    "knowledge",
    result.rows.map((row) => row.object_id),
  );
  return result.rows.map((row) => ({
    object_id: row.object_id,
    base_object_type: "knowledge_item",
    object_profile: row.object_profile,
    source_connection_ids: sourceIds.get(row.object_id) ?? [],
  }));
}

async function loadClaimKindUsageObjects(db: Queryable, spaceId: string, userId: string): Promise<UsageObjectRow[]> {
  const result = await db.query<{ object_id: string; object_profile: string }>(
    `SELECT c.object_id,
            c.claim_kind AS object_profile
       FROM claims c
       JOIN space_objects so
         ON so.id = c.object_id
        AND so.space_id = c.space_id
        AND so.object_type = 'claim'
      WHERE c.space_id = $1
        AND so.deleted_at IS NULL
        AND c.status = 'active'
        AND ${readableClause("$2")}
      ORDER BY c.object_id ASC`,
    [spaceId, userId],
  );
  const sourceIds = await loadClaimSourceConnectionIds(db, spaceId, result.rows.map((row) => row.object_id));
  return result.rows.map((row) => ({
    object_id: row.object_id,
    base_object_type: "claim",
    object_profile: row.object_profile,
    source_connection_ids: sourceIds.get(row.object_id) ?? [],
  }));
}

async function loadSourceKindUsageObjects(db: Queryable, spaceId: string, userId: string): Promise<UsageObjectRow[]> {
  const result = await db.query<{ object_id: string; object_profile: string; metadata_json: unknown }>(
    `SELECT s.object_id,
            s.source_type AS object_profile,
            s.metadata_json
       FROM sources s
       JOIN space_objects so
         ON so.id = s.object_id
        AND so.space_id = s.space_id
        AND so.object_type = 'source'
      WHERE s.space_id = $1
        AND so.deleted_at IS NULL
        AND s.status <> 'archived'
        AND ${readableClause("$2")}
      ORDER BY s.object_id ASC`,
    [spaceId, userId],
  );
  return result.rows.map((row) => ({
    object_id: row.object_id,
    base_object_type: "source",
    object_profile: row.object_profile,
    source_connection_ids: sourceConnectionIdsFromMetadata(row.metadata_json),
  }));
}

async function loadNoteKindUsageObjects(db: Queryable, spaceId: string, userId: string): Promise<UsageObjectRow[]> {
  const result = await db.query<{ object_id: string }>(
    `SELECT n.object_id
       FROM notes n
       JOIN space_objects so
         ON so.id = n.object_id
        AND so.space_id = n.space_id
        AND so.object_type = 'note'
      WHERE n.space_id = $1
        AND so.deleted_at IS NULL
        AND n.status = 'active'
        AND ${readableClause("$2")}
      ORDER BY n.object_id ASC`,
    [spaceId, userId],
  );
  const sourceIds = await loadSourceConnectionIdsForTargets(
    db,
    spaceId,
    "note",
    result.rows.map((row) => row.object_id),
  );
  return result.rows.map((row) => ({
    object_id: row.object_id,
    base_object_type: "note",
    object_profile: "note",
    source_connection_ids: sourceIds.get(row.object_id) ?? [],
  }));
}

async function loadMemoryEntryKindUsageObjects(db: Queryable, spaceId: string, userId: string): Promise<UsageObjectRow[]> {
  const result = await db.query<{ object_id: string; object_profile: string }>(
    `SELECT me.id AS object_id,
            me.memory_type AS object_profile
       FROM memory_entries me
      WHERE me.space_id = $1
        AND me.status = 'active'
        AND me.deleted_at IS NULL
        AND me.sensitivity_level <> 'highly_restricted'
        AND ${contentReadSql("memory", "me", "$2")}
      ORDER BY me.id ASC`,
    [spaceId, userId],
  );
  const sourceIds = await loadSourceConnectionIdsForTargets(
    db,
    spaceId,
    "memory",
    result.rows.map((row) => row.object_id),
  );
  return result.rows.map((row) => ({
    object_id: row.object_id,
    base_object_type: "memory_entry",
    object_profile: row.object_profile,
    source_connection_ids: sourceIds.get(row.object_id) ?? [],
  }));
}

async function loadProjectPublicSummaryKindUsageObjects(db: Queryable, spaceId: string): Promise<UsageObjectRow[]> {
  const result = await db.query<{ object_id: string }>(
    `SELECT ps.project_id AS object_id
       FROM project_public_summaries ps
       JOIN projects p
         ON p.id = ps.project_id
        AND p.space_id = ps.space_id
      WHERE ps.space_id = $1
        AND ps.review_status = 'approved'
        AND p.status = 'active'
        AND p.deleted_at IS NULL
      ORDER BY ps.project_id ASC`,
    [spaceId],
  );
  return result.rows.map((row) => ({
    object_id: row.object_id,
    base_object_type: "project_public_summary",
    object_profile: "project_public_summary",
    source_connection_ids: [],
  }));
}

async function loadClaimSourceConnectionIds(
  db: Queryable,
  spaceId: string,
  claimIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map(claimIds.map((id) => [id, [] as string[]]));
  if (claimIds.length === 0) return out;
  const rows = await db.query<{ claim_id: string; source_connection_id: string | null; source_metadata_json: unknown }>(
    `SELECT cs.claim_id, cs.source_connection_id, s.metadata_json AS source_metadata_json
       FROM claim_sources cs
       LEFT JOIN sources s
         ON s.object_id = cs.source_object_id
        AND s.space_id = cs.space_id
      WHERE cs.space_id = $1
        AND cs.claim_id = ANY($2::varchar[])`,
    [spaceId, claimIds],
  );
  for (const row of rows.rows) {
    const current = out.get(row.claim_id) ?? [];
    if (row.source_connection_id && !current.includes(row.source_connection_id)) current.push(row.source_connection_id);
    for (const id of sourceConnectionIdsFromMetadata(row.source_metadata_json)) {
      if (!current.includes(id)) current.push(id);
    }
    out.set(row.claim_id, current);
  }
  return out;
}

async function filterUsageRowsBySourcePolicy(
  db: Queryable,
  spaceId: string,
  userId: string,
  rows: readonly UsageObjectRow[],
): Promise<UsageObjectRow[]> {
  const sourceIds = [...new Set(rows.flatMap((row) => row.source_connection_ids))];
  if (sourceIds.length === 0) return [...rows];
  const [snapshots, viewerSpaceRole] = await Promise.all([
    loadSourcePolicySnapshots(db, spaceId, sourceIds),
    loadViewerSpaceRole(db, spaceId, userId),
  ]);
  return rows.filter((row) =>
    row.source_connection_ids.every((sourceId) => {
      const snapshot = snapshots.get(sourceId);
      return snapshot
        ? sourcePolicyAllowsRead(snapshot, { viewerUserId: userId, viewerSpaceRole })
        : false;
    }),
  );
}

function aggregateUsage(rows: readonly UsageObjectRow[]): UsageRow[] {
  const counts = new Map<string, UsageRow>();
  for (const row of rows) {
    const key = registryKey(row.base_object_type, row.object_profile);
    const current = counts.get(key);
    if (current) {
      current.visible_usage_count = countValue(current.visible_usage_count) + 1;
    } else {
      counts.set(key, {
        base_object_type: row.base_object_type,
        object_profile: row.object_profile,
        visible_usage_count: 1,
      });
    }
  }
  return [...counts.values()];
}

function normalizedBaseTypes(raw: readonly string[] | undefined): string[] {
  const values = raw && raw.length > 0
    ? raw
    : ["knowledge_item", "note", "source", "claim", "memory_entry", "project_public_summary", "source_item", "extracted_evidence"];
  return [...new Set(values.filter((value) => RETRIEVAL_OBJECT_TYPE_VALUES.includes(value as never)))];
}

function registryKey(baseObjectType: string, objectProfile: string): string {
  return `${baseObjectType}:${objectProfile}`;
}

function countValue(value: number | string): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function labelFromKind(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ") || value;
}

function countsFor(findings: readonly ObjectSchemaSuggestionReport["findings"][number][]): Record<string, number> {
  const counts: Record<string, number> = {
    missing_object_profile: 0,
    deprecated_profile_usage: 0,
    unused_active_profile: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of findings) {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
    counts[finding.confidence_tier] = (counts[finding.confidence_tier] ?? 0) + 1;
  }
  return counts;
}
