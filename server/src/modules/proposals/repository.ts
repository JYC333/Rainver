import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { assertProjectInSpace } from "../projects/access";
import type { ProposalOut, ProposalPage } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { contentReadSql, roomRunReadAccessSql } from "../access/contentAccessSql";
import { isProvenanceSourceType } from "../ontology/entities";

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface ProposalRow {
  id: string;
  space_id: string;
  created_by_user_id: string | null;
  owner_user_id: string | null;
  project_folder_id: string | null;
  created_by_run_id: string | null;
  proposal_type: string;
  status: string;
  risk_level: string;
  urgency: string;
  preview: boolean;
  title: string;
  payload_json: unknown;
  rationale: string | null;
  visibility: string;
  access_level: string;
  review_deadline: unknown;
  expires_at: unknown;
  created_at: unknown;
  reviewed_at: unknown;
  project_id: string | null;
  egress_approval_id: string | null;
  egress_approval_status: string | null;
}

export interface ProposalListFilters {
  status: string | null;
  proposalType?: string | null;
  urgency?: string | null;
  expired?: boolean | null;
  projectId?: string | null;
  createdByRunId?: string | null;
  agentId?: string | null;
  limit: number;
  offset: number;
  now?: Date;
}

export class PgProposalRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgProposalRepository {
    if (!config.databaseUrl) {
      throw new Error("Proposal repository requires SERVER_DATABASE_URL");
    }
    return new PgProposalRepository(getDbPool(config.databaseUrl));
  }

  async listVisible(
    spaceId: string,
    userId: string,
    filters: ProposalListFilters,
  ): Promise<ProposalPage> {
    await assertProjectInSpace(this.db, spaceId, filters.projectId);
    const built = buildVisibleWhere(spaceId, userId, filters);
    const totalResult = await this.db.query<{ total: string | number }>(
      `SELECT count(p.id)::text AS total
         FROM proposals p
         LEFT JOIN runs run_for_instructed
           ON run_for_instructed.id = p.created_by_run_id
          AND run_for_instructed.space_id = $1
        ${built.whereSql}`,
      built.params,
    );

    const limitParam = built.params.length + 1;
    const offsetParam = built.params.length + 2;
    const rowsResult = await this.db.query<ProposalRow>(
      `${proposalSelectSql()}
         LEFT JOIN runs run_for_instructed
           ON run_for_instructed.id = p.created_by_run_id
          AND run_for_instructed.space_id = $1
         ${activeEgressApprovalJoinSql()}
        ${built.whereSql}
        ${proposalOrderSql()}
        LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...built.params, filters.limit, filters.offset],
    );
    const now = filters.now ?? new Date();
    return {
      items: rowsResult.rows.map((row) => proposalToOut(row, now)),
      total: numberValue(totalResult.rows[0]?.total) ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async getVisible(
    spaceId: string,
    userId: string,
    proposalId: string,
    now: Date = new Date(),
  ): Promise<ProposalOut | null> {
    const result = await this.db.query<ProposalRow>(
      `${proposalSelectSql()}
         LEFT JOIN runs run_for_instructed
           ON run_for_instructed.id = p.created_by_run_id
          AND run_for_instructed.space_id = $1
         ${activeEgressApprovalJoinSql()}
        WHERE p.space_id = $1
          AND p.id = $2
          AND ${contentReadSql("proposal", "p", "$3")}
          AND ${roomRunReadAccessSql("p.created_by_run_id", "p.space_id", "$3")}`,
      [spaceId, proposalId, userId],
    );
    const row = result.rows[0];
    return row ? proposalToOut(row, now) : null;
  }
}

function buildVisibleWhere(
  spaceId: string,
  userId: string,
  filters: ProposalListFilters,
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [spaceId, userId];
  const clauses = [
    "p.space_id = $1",
    contentReadSql("proposal", "p", "$2"),
    roomRunReadAccessSql("p.created_by_run_id", "p.space_id", "$2"),
  ];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.projectId) clauses.push(`p.project_id = ${addParam(filters.projectId)}`);
  if (filters.createdByRunId) clauses.push(`p.created_by_run_id = ${addParam(filters.createdByRunId)}`);
  if (filters.agentId) {
    const ref = addParam(filters.agentId);
    clauses.push(`(p.created_by_agent_id = ${ref} OR (p.payload_json->>'agent_id') = ${ref})`);
  }
  if (filters.status) clauses.push(`p.status = ${addParam(filters.status)}`);
  if (filters.proposalType) clauses.push(`p.proposal_type = ${addParam(filters.proposalType)}`);
  if (filters.urgency) clauses.push(`p.urgency = ${addParam(filters.urgency)}`);
  if (filters.expired !== null && filters.expired !== undefined) {
    const nowParam = addParam((filters.now ?? new Date()).toISOString());
    const expiredSql = `(p.status = 'pending' AND p.expires_at IS NOT NULL AND p.expires_at < ${nowParam}::timestamptz)`;
    clauses.push(filters.expired ? expiredSql : `NOT ${expiredSql}`);
  }

  return { whereSql: `WHERE ${clauses.join("\n          AND ")}`, params };
}

function proposalSelectSql(): string {
  return `SELECT p.id,
                 p.space_id,
                 p.created_by_user_id,
                 p.owner_user_id,
                 p.project_folder_id,
                 p.created_by_run_id,
                 p.proposal_type,
                 p.status,
                 p.risk_level,
                 p.urgency,
                 p.preview,
                 p.title,
                 p.payload_json,
                 p.rationale,
                 p.visibility,
                 p.access_level,
                 p.review_deadline,
                 p.expires_at,
                 p.created_at,
                 p.reviewed_at,
                 p.project_id,
                 active_egress_approval.id AS egress_approval_id,
                 active_egress_approval.status AS egress_approval_status
            FROM proposals p`;
}

function activeEgressApprovalJoinSql(): string {
  return `LEFT JOIN LATERAL (
           SELECT pa.id, pa.status
             FROM proposal_approvals pa
            WHERE pa.proposal_id = p.id
              AND pa.approval_type = 'egress_granting_user'
              AND pa.status = 'approved'
              AND pa.revoked_at IS NULL
              AND (
                p.payload_json->>'requires_approval_type' IS DISTINCT FROM 'egress_content_owner'
                OR CASE
                  WHEN jsonb_typeof(p.payload_json->'required_egress_approver_user_ids') = 'array'
                    AND jsonb_array_length(p.payload_json->'required_egress_approver_user_ids') > 0
                  THEN NOT EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements_text(p.payload_json->'required_egress_approver_user_ids') required(user_id)
                     WHERE NOT EXISTS (
                       SELECT 1 FROM proposal_approvals owner_approval
                        WHERE owner_approval.proposal_id = p.id
                          AND owner_approval.approval_type = 'egress_granting_user'
                          AND owner_approval.approver_user_id = required.user_id
                          AND owner_approval.grant_id IS NULL
                          AND owner_approval.status = 'approved'
                          AND owner_approval.revoked_at IS NULL
                     )
                  )
                  ELSE false
                END
              )
            ORDER BY pa.created_at DESC
            LIMIT 1
         ) active_egress_approval ON true`;
}

function proposalOrderSql(): string {
  return `ORDER BY CASE
             WHEN p.urgency = 'critical' THEN 4
             WHEN p.urgency = 'high' THEN 3
             WHEN p.urgency = 'normal' THEN 2
             WHEN p.urgency = 'low' THEN 1
             ELSE 0
           END DESC,
           p.review_deadline ASC NULLS LAST,
           p.expires_at ASC NULLS LAST,
           p.created_at DESC`;
}

export function proposalToOut(row: ProposalRow, now: Date): ProposalOut {
  const payload = recordValue(row.payload_json);
  const provenanceEntries = provenanceEntriesFromPayload(payload);
  const requiredApprover = stringValue(payload.required_approver_user_id)
    ?? stringValue(payload.granting_user_id);
  const codePatchFields = codePatchProposalFields(row.proposal_type, payload);
  return {
    id: row.id,
    space_id: row.space_id,
    user_id: row.created_by_user_id ?? "",
    project_folder_id: row.project_folder_id,
    source_session_id: stringValue(payload.source_session_id),
    source_task_id: stringValue(payload.source_task_id),
    source_run_id: sourceRunId(payload),
    created_by_run_id: row.created_by_run_id,
    proposal_type: row.proposal_type,
    target_scope: stringValue(payload.target_scope) ?? "",
    target_namespace: stringValue(payload.target_namespace) ?? "",
    memory_type: stringValue(payload.memory_type) ?? "",
    proposed_title: row.title,
    proposed_content: stringValue(payload.proposed_content) ?? "",
    rationale: row.rationale ?? "",
    status: row.status,
    risk_level: row.risk_level,
    urgency: row.urgency,
    visibility: row.visibility,
    preview: Boolean(row.preview),
    review_deadline: dateValue(row.review_deadline),
    expires_at: dateValue(row.expires_at),
    expired: proposalExpired(row, now),
    created_at: dateValue(row.created_at) ?? new Date(0).toISOString(),
    decided_at: dateValue(row.reviewed_at),
    resulting_memory_id: stringValue(payload.resulting_memory_id),
    owner_user_id: stringValue(payload.owner_user_id),
    subject_user_id: stringValue(payload.subject_user_id),
    sensitivity_level: stringValue(payload.sensitivity_level),
    access_level: typeof payload.access_level === "string"
      ? payload.access_level
      : typeof payload.target_access_level === "string"
        ? payload.target_access_level
        : null,
    provenance_entries: provenanceEntries.length > 0 ? provenanceEntries : null,
    source_activity_id: sourceActivityId(payload, provenanceEntries),
    grant_id: stringValue(payload.grant_id),
    required_approver_user_id: requiredApprover,
    required_approver_user_ids: stringArray(payload.required_egress_approver_user_ids),
    requires_approval_type: stringValue(payload.requires_approval_type),
    egress_approval_status: row.egress_approval_status,
    egress_approval_id: row.egress_approval_id,
    project_id: row.project_id,
    ...codePatchFields,
  };
}

function proposalExpired(row: ProposalRow, now: Date): boolean {
  if (row.status !== "pending" || !row.expires_at) return false;
  const expiresAt = dateFrom(row.expires_at);
  return expiresAt ? expiresAt.getTime() < now.getTime() : false;
}

function provenanceEntriesFromPayload(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const add = (entry: Record<string, unknown> | null): void => {
    if (!entry) return;
    const key = `${entry.source_type}:${entry.source_id}:${entry.source_trust ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(entry);
  };

  if (Array.isArray(payload.provenance_entries)) {
    for (const item of payload.provenance_entries) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        add(normalizeProvenance(item as Record<string, unknown>));
      }
    }
  }

  const activityId = stringValue(payload.source_activity_id);
  if (activityId) {
    const evidence: Record<string, unknown> = {};
    if (payload.source_evidence !== undefined && payload.source_evidence !== null) {
      evidence.note = String(payload.source_evidence);
    }
    add(normalizeProvenance({
      source_type: "activity",
      source_id: activityId,
      source_trust: payload.activity_source_trust,
      evidence_json: Object.keys(evidence).length > 0 ? evidence : undefined,
    }));
  }

  const runId = stringValue(payload.source_run_id);
  if (runId) {
    add(normalizeProvenance({
      source_type: "run",
      source_id: runId,
      source_trust: "internal_system",
      evidence_json: { from_payload: "source_run_id" },
    }));
  }

  for (const key of ["source_memory_id", "derived_from_memory_id"]) {
    const memoryId = stringValue(payload[key]);
    if (memoryId) {
      add(normalizeProvenance({
        source_type: "memory",
        source_id: memoryId,
        source_trust: payload.memory_source_trust,
      }));
    }
  }

  return merged;
}

const SOURCE_TRUST_VALUES = new Set([
  "user_confirmed",
  "internal_system",
  "trusted_external",
  "untrusted_external",
  "agent_inferred",
]);

function normalizeProvenance(raw: Record<string, unknown>): Record<string, unknown> | null {
  const sourceType = stringValue(raw.source_type);
  const sourceId = stringValue(raw.source_id);
  if (!sourceType || !sourceId || !isProvenanceSourceType(sourceType)) return null;
  const out: Record<string, unknown> = { source_type: sourceType, source_id: sourceId };
  const trust = stringValue(raw.source_trust);
  if (trust && SOURCE_TRUST_VALUES.has(trust)) out.source_trust = trust;
  if (raw.evidence_json && typeof raw.evidence_json === "object" && !Array.isArray(raw.evidence_json)) {
    out.evidence_json = raw.evidence_json;
  }
  return out;
}

function sourceRunId(payload: Record<string, unknown>): string | null {
  const direct = stringValue(payload.source_run_id);
  if (direct) return direct;
  for (const entry of provenanceEntriesFromPayload(payload)) {
    if (entry.source_type === "run") return stringValue(entry.source_id);
  }
  return null;
}

function sourceActivityId(
  payload: Record<string, unknown>,
  provenanceEntries: Array<Record<string, unknown>>,
): string | null {
  const direct = stringValue(payload.source_activity_id);
  if (direct) return direct;
  for (const entry of provenanceEntries) {
    if (entry.source_type === "activity") return stringValue(entry.source_id);
  }
  return null;
}

function codePatchProposalFields(
  proposalType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (proposalType !== "code_patch") return {};
  const skippedChanges = arrayOfRecords(payload.skipped_changes)
    ?? arrayOfRecords(payload.skipped)
    ?? [];
  return {
    incomplete_patch: payload.incomplete_patch === true,
    skipped_changes: skippedChanges,
    skipped_count: numberValue(payload.skipped_count) ?? skippedChanges.length,
  };
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is Record<string, unknown> => (
    item !== null && typeof item === "object" && !Array.isArray(item)
  ));
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].sort();
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dateValue(value: unknown): string | null {
  const date = dateFrom(value);
  return date ? date.toISOString() : null;
}

function dateFrom(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
