import { randomUUID } from "node:crypto";
import {
  HttpError,
  countFromRow,
  dateIso,
  numberValue,
  objectValue,
  optionalObject,
  optionalString,
  page,
  requiredString,
  stringArray,
  toDbDate,
  type SpaceUserIdentity,
  type Queryable,
} from "../routeUtils/common.js";
import { proposalToOut } from "../proposals/repository.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import { assertProjectReadable } from "../projects/access.js";
import type { ProposalOut } from "@rainver/protocol";
import { assessActivityMemoryDuplicate } from "./memoryDedup.js";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql.js";
import { recordDetailRead } from "../contentAccess/audit.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { isContentVisibility } from "../access/contentAccessTypes.js";
import { evidenceProvenanceReadableClause, sourceItemReadableClause } from "../sources/sourceItemAccess.js";
import { enforceSourceDerivedImportTarget } from "../sources/sourceConsent.js";

const ACTIVITY_SUMMARY_EVIDENCE_ACCESS = contentResourceDefinition("extracted_evidence")!;
const ACTIVITY_SUMMARY_SOURCE_ACCESS = contentResourceDefinition("source_item")!;
const ACTIVITY_SUMMARY_ACTIVITY_ACCESS = contentResourceDefinition("activity")!;

export interface ActivityRow {
  id: string;
  space_id: string;
  source_run_id: string | null;
  session_id: string | null;
  user_id: string | null;
  project_folder_id: string | null;
  agent_id: string | null;
  source_task_id: string | null;
  project_id: string | null;
  source_url: string | null;
  activity_type: string;
  title: string | null;
  content: string | null;
  payload_json: unknown;
  occurred_at: unknown;
  created_at: unknown;
  status: string;
  updated_at: unknown;
  source_kind: string | null;
  source_trust: string | null;
  source_integrity_json: unknown;
  entity_refs_json: unknown;
  subject_user_id: string | null;
  processed_at: unknown;
  discarded_at: unknown;
  visibility: string;
  access_level: string;
  owner_user_id: string | null;
  aggregate_key: string | null;
}

interface SummaryEvidenceRow {
  id: string;
  title: string;
  content_excerpt: string | null;
  source_uri: string | null;
  trust_level: string;
}

interface SummarySourceItemRow {
  id: string;
  title: string;
  excerpt: string | null;
  source_uri: string | null;
  content_state: string;
}

interface SummarySourceRef {
  source_type: "activity" | "extracted_evidence" | "source_item";
  source_id: string;
  source_trust: string;
  evidence_json?: Record<string, unknown>;
}

export interface ActivityListFilters {
  userId?: string | null;
  projectFolderId?: string | null;
  sourceType?: string | null;
  sourceRunId?: string | null;
  status?: string | null;
  projectId?: string | null;
  limit: number;
  offset: number;
}

export interface SummaryRunInput {
  activityIds: string[];
  evidenceIds: string[];
  sourceItemIds: string[];
  summaryGoal: string | null;
  createMemoryProposal: boolean;
  createKnowledgeProposal: boolean;
}

const ACTIVITY_COLUMNS = `
  id, space_id, source_run_id, session_id, user_id, project_folder_id, agent_id,
  source_task_id, project_id, source_url, activity_type, title, content,
  payload_json, occurred_at, created_at, status, updated_at, source_kind,
  source_trust, source_integrity_json, entity_refs_json, subject_user_id,
  processed_at, discarded_at, visibility, access_level, owner_user_id, aggregate_key
`;

const SOURCE_TYPE_ALIASES: Record<string, string> = {
  user_input: "user_capture",
  manual: "user_capture",
  imported_chat: "external_chat",
  agent_run: "run_event",
  task_log: "workspace_event",
  file_capture: "file_import",
  voice_capture: "file_import",
};

const SOURCE_TYPES = new Set([
  "user_capture",
  "chat_message",
  "external_chat",
  "file_import",
  "web_capture",
  "run_event",
  "workspace_event",
  "system_event",
  "external_source",
  "source",
]);

export const TRUST_BY_SOURCE_TYPE: Record<string, string> = {
  user_capture: "user_confirmed",
  chat_message: "user_confirmed",
  external_chat: "user_confirmed",
  file_import: "user_confirmed",
  web_capture: "untrusted_external",
  run_event: "internal_system",
  workspace_event: "internal_system",
  system_event: "internal_system",
  external_source: "untrusted_external",
  source: "internal_system",
};

export class PgActivityRepository {
  constructor(private readonly db: Queryable) {}

  async create(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestedUserId = optionalString(body.user_id);
    if (requestedUserId && requestedUserId !== identity.userId) {
      throw new HttpError(403, "user_id in body must match the authenticated user");
    }
    const sourceType = normalizeSourceType(requiredString(body.source_type, "source_type"));
    const content = requiredString(body.content, "content");
    const projectId = optionalString(body.project_id);
    if (projectId) {
      await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    }
    const now = new Date().toISOString();
    const visibility = optionalString(body.visibility) ?? "private";
    if (!isContentVisibility(visibility)) throw new HttpError(422, "Invalid visibility");
    const result = await this.db.query<ActivityRow>(
      `INSERT INTO activity_records (
         id, space_id, source_run_id, session_id, user_id, project_folder_id, agent_id,
         source_task_id, project_id, source_url, activity_type, title, content,
         payload_json, occurred_at, created_at, status, updated_at, source_kind,
         source_trust, visibility, owner_user_id
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13,
         $14::jsonb, COALESCE($15::timestamptz, $16::timestamptz), $16, 'raw', $16, $11,
         $17, $18, $5
       )
       RETURNING ${ACTIVITY_COLUMNS}`,
      [
        randomUUID(),
        identity.spaceId,
        optionalString(body.source_run_id),
        optionalString(body.source_session_id),
        identity.userId,
        optionalString(body.project_folder_id),
        optionalString(body.agent_id),
        optionalString(body.source_task_id),
        projectId,
        optionalString(body.source_url),
        sourceType,
        optionalString(body.title),
        content,
        JSON.stringify(optionalObject(body.metadata_json) ?? {}),
        toDbDate(body.occurred_at),
        now,
        TRUST_BY_SOURCE_TYPE[sourceType] ?? "untrusted_external",
        visibility,
      ],
    );
    return activityToOut(result.rows[0]!);
  }

  async list(
    identity: SpaceUserIdentity,
    filters: ActivityListFilters,
  ): Promise<Record<string, unknown>[]> {
    if (filters.projectId) {
      await assertProjectReadable(this.db, identity.spaceId, filters.projectId, identity.userId);
    }
    const built = buildActivityWhere(identity, filters);
    const result = await this.db.query<ActivityRow>(
      `SELECT ${ACTIVITY_COLUMNS}
         FROM activity_records ar
        ${built.where}
        ORDER BY occurred_at DESC, created_at DESC, id DESC
        LIMIT $${built.params.length + 1} OFFSET $${built.params.length + 2}`,
      [...built.params, filters.limit, filters.offset],
    );
    return result.rows.map(activityToOut);
  }

  async get(identity: SpaceUserIdentity, activityId: string): Promise<ActivityRow | null> {
    const result = await this.db.query<ActivityRow>(
      `SELECT ${ACTIVITY_COLUMNS}
         FROM activity_records ar
        WHERE id = $1 AND space_id = $2
          AND ${contentReadSql("activity", "ar", "$3")}`,
      [activityId, identity.spaceId, identity.userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    await recordDetailRead(this.db, {
      spaceId: identity.spaceId,
      viewerUserId: identity.userId,
      resourceType: "activity",
      resourceId: activityId,
    });
    return row;
  }

  async getOut(identity: SpaceUserIdentity, activityId: string): Promise<Record<string, unknown> | null> {
    const row = await this.get(identity, activityId);
    return row ? activityToOut(row) : null;
  }

  async setStatus(
    identity: SpaceUserIdentity,
    activityId: string,
    status: "processed" | "archived",
  ): Promise<Record<string, unknown>> {
    const current = await this.get(identity, activityId);
    if (!current) throw new HttpError(404, "Activity record not found");
    const now = new Date().toISOString();
    const result = await this.db.query<ActivityRow>(
      `UPDATE activity_records
          SET status = $3::varchar(32),
              processed_at = CASE WHEN $3::varchar(32) = 'processed' THEN $4::timestamptz ELSE processed_at END,
              discarded_at = CASE WHEN $3::varchar(32) = 'archived' THEN $4::timestamptz ELSE discarded_at END,
              updated_at = $4
        WHERE id = $1 AND space_id = $2
        RETURNING ${ACTIVITY_COLUMNS}`,
      [activityId, identity.spaceId, status, now],
    );
    return activityToOut(result.rows[0]!);
  }

  async consolidate(identity: SpaceUserIdentity, activityId: string): Promise<ProposalOut[]> {
    const activity = await this.get(identity, activityId);
    if (!activity) throw new HttpError(404, "Activity record not found");
    if (activity.aggregate_key) {
      throw new HttpError(422, "Activity pointer records cannot be consolidated");
    }
    if (!activity.content || !activity.content.trim()) {
      throw new HttpError(422, "Activity record has no content to consolidate");
    }
    const duplicate = await assessActivityMemoryDuplicate(this.db, {
      spaceId: identity.spaceId,
      viewerUserId: identity.userId,
      title: activity.title,
      content: activity.content,
    });
    if (duplicate.duplicate) {
      const now = new Date().toISOString();
      await this.db.query(
        `UPDATE activity_records
            SET status = 'processed',
                processed_at = $3,
                updated_at = $3
          WHERE id = $1 AND space_id = $2`,
        [activity.id, identity.spaceId, now],
      );
      return [];
    }
    const proposal = await this.insertMemoryProposalFromActivity(identity, activity);
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE activity_records
          SET status = 'proposals_generated',
              processed_at = $3,
              updated_at = $3
        WHERE id = $1 AND space_id = $2`,
      [activity.id, identity.spaceId, now],
    );
    return [proposal];
  }

  async createSummaryRun(identity: SpaceUserIdentity, input: SummaryRunInput): Promise<Record<string, unknown>> {
    if (!input.activityIds.length && !input.evidenceIds.length && !input.sourceItemIds.length) {
      throw new HttpError(
        422,
        "At least one of activity_ids, evidence_ids, or source_item_ids is required.",
      );
    }
    const activityRows = input.activityIds.length
      ? await this.db.query<ActivityRow>(
          `SELECT ${ACTIVITY_COLUMNS}
             FROM activity_records
            WHERE space_id = $1
              AND id::text = ANY($2::text[])
              AND ${contentReadSql("activity", "activity_records", "$3")}
              AND ${contentAccessLevelSql({ definition: ACTIVITY_SUMMARY_ACTIVITY_ACCESS, alias: "activity_records", userExpr: "$3" })} = 'full'`,
          [identity.spaceId, input.activityIds, identity.userId],
        )
      : { rows: [] };
    if (activityRows.rows.length !== input.activityIds.length) {
      throw new HttpError(403, "Summary input is not visible in this space");
    }
    const evidenceRows = input.evidenceIds.length
      ? await this.db.query<SummaryEvidenceRow>(
          `SELECT ee.id, ee.title, ee.content_excerpt, ee.source_uri, ee.trust_level
             FROM extracted_evidence ee
             LEFT JOIN source_items evidence_source
               ON evidence_source.id=COALESCE(ee.source_item_id,ee.origin_source_item_id)
              AND evidence_source.space_id=ee.space_id
              AND evidence_source.deleted_at IS NULL
            WHERE ee.space_id = $1 AND ee.id::text = ANY($2::text[]) AND ee.deleted_at IS NULL
              AND ${contentReadSql("extracted_evidence", "ee", "$3")}
              AND ${contentAccessLevelSql({ definition: ACTIVITY_SUMMARY_EVIDENCE_ACCESS, alias: "ee", userExpr: "$3" })} = 'full'
              AND ${evidenceProvenanceReadableClause("ee", "$3", true)}`,
          [identity.spaceId, input.evidenceIds, identity.userId],
        )
      : { rows: [] };
    const sourceRows = input.sourceItemIds.length
      ? await this.db.query<SummarySourceItemRow>(
          `SELECT id, title, excerpt, source_uri, content_state
            FROM source_items si
            WHERE si.space_id = $1 AND si.id::text = ANY($2::text[]) AND si.deleted_at IS NULL
              AND ${sourceItemReadableClause("si", "$3", false)}
              AND ${contentAccessLevelSql({ definition: ACTIVITY_SUMMARY_SOURCE_ACCESS, alias: "si", userExpr: "$3" })} = 'full'`,
          [identity.spaceId, input.sourceItemIds, identity.userId],
        )
      : { rows: [] };
    if (evidenceRows.rows.length !== input.evidenceIds.length || sourceRows.rows.length !== input.sourceItemIds.length) {
      throw new HttpError(403, "Summary input is not visible in this space");
    }
    await this.enforceSummarySourcePolicies(identity.spaceId, input.evidenceIds, input.sourceItemIds, "source_artifact");
    if (input.createMemoryProposal) {
      await this.enforceSummarySourcePolicies(identity.spaceId, input.evidenceIds, input.sourceItemIds, "memory_proposal");
    }
    if (input.createKnowledgeProposal) {
      await this.enforceSummarySourcePolicies(identity.spaceId, input.evidenceIds, input.sourceItemIds, "knowledge");
    }
    const sourceRefs: SummarySourceRef[] = [
      ...activityRows.rows.map((row) => ({
        source_type: "activity" as const,
        source_id: row.id,
        source_trust: row.source_trust ?? TRUST_BY_SOURCE_TYPE[row.activity_type] ?? "untrusted_external",
        evidence_json: { activity_type: row.activity_type, source_url: row.source_url },
      })),
      ...evidenceRows.rows.map((row) => ({
        source_type: "extracted_evidence" as const,
        source_id: row.id,
        source_trust: provenanceTrustFromEvidence(row.trust_level),
        evidence_json: { source_uri: row.source_uri },
      })),
      ...sourceRows.rows.map((row) => ({
        source_type: "source_item" as const,
        source_id: row.id,
        source_trust: "untrusted_external",
        evidence_json: { source_uri: row.source_uri, content_state: row.content_state },
      })),
    ];
    const summaryPreview = buildSummaryPreview(activityRows.rows, evidenceRows.rows, sourceRows.rows, input.summaryGoal);
    const artifactId = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, proposal_id, artifact_type, title, content,
         storage_ref, storage_path, mime_type, export_formats_json,
         canonical_format, preview, created_at, updated_at, metadata_json,
         visibility, owner_user_id, trust_level
       )
       VALUES (
         $1, $2, NULL, NULL, 'summary', $3, $4,
         NULL, NULL, 'text/markdown', $5::jsonb,
         'markdown', false, $6, $6, $7::jsonb,
         'private', $8, 'medium'
       )`,
      [
        artifactId,
        identity.spaceId,
        input.summaryGoal || "Input summary",
        summaryPreview,
        JSON.stringify(["markdown", "txt"]),
        now,
        JSON.stringify({
          activity_ids: input.activityIds,
          evidence_ids: input.evidenceIds,
          source_item_ids: input.sourceItemIds,
          summary_goal: input.summaryGoal,
          generated_by: "server",
        }),
        identity.userId,
      ],
    );
    const proposalIds: string[] = [];
    if (input.createMemoryProposal && summaryPreview.trim()) {
      const proposal = await this.insertSummaryMemoryProposal(identity, summaryPreview, artifactId, sourceRefs);
      proposalIds.push(proposal.id);
    }
    if (input.createKnowledgeProposal && summaryPreview.trim()) {
      const proposal = await this.insertSummaryKnowledgeProposal(identity, summaryPreview, artifactId, sourceRefs);
      proposalIds.push(proposal.id);
    }
    return {
      run_id: `summary:${artifactId}`,
      artifact_id: artifactId,
      proposal_ids: proposalIds,
      status: "succeeded",
      summary_preview: summaryPreview.slice(0, 500),
    };
  }

  private async enforceSummarySourcePolicies(
    spaceId: string,
    evidenceIds: string[],
    sourceItemIds: string[],
    target: "source_artifact" | "memory_proposal" | "knowledge",
  ): Promise<void> {
    const policies = await this.db.query<{ policy_json: unknown }>(
      `WITH referenced_connections AS (
         SELECT si.connection_id
           FROM source_items si
          WHERE si.space_id=$1 AND si.id::text=ANY($2::text[]) AND si.connection_id IS NOT NULL
         UNION
         SELECT evidence_source.connection_id
           FROM extracted_evidence ee
           JOIN source_items evidence_source
             ON evidence_source.id=COALESCE(ee.source_item_id,ee.origin_source_item_id)
            AND evidence_source.space_id=ee.space_id
          WHERE ee.space_id=$1 AND ee.id::text=ANY($3::text[]) AND evidence_source.connection_id IS NOT NULL
         UNION
         SELECT snapshot.connection_id
           FROM extracted_evidence ee
           JOIN source_snapshots snapshot
             ON snapshot.id=ee.source_snapshot_id AND snapshot.space_id=ee.space_id
          WHERE ee.space_id=$1 AND ee.id::text=ANY($3::text[]) AND snapshot.connection_id IS NOT NULL
       )
       SELECT connection.policy_json
         FROM source_connections connection
         JOIN referenced_connections referenced ON referenced.connection_id=connection.id
        WHERE connection.space_id=$1`,
      [spaceId, sourceItemIds, evidenceIds],
    );
    for (const row of policies.rows) enforceSourceDerivedImportTarget(row.policy_json, target);
  }

  private async insertMemoryProposalFromActivity(
    identity: SpaceUserIdentity,
    activity: ActivityRow,
  ): Promise<ProposalOut> {
    const payload = {
      operation: "create",
      proposed_content: activity.content ?? "",
      memory_type: "experience",
      target_scope: "user",
      target_namespace: "activity.consolidation",
      target_visibility: "private",
      owner_user_id: activity.owner_user_id ?? activity.user_id ?? identity.userId,
      subject_user_id: activity.subject_user_id ?? activity.user_id ?? identity.userId,
      source_activity_id: activity.id,
      activity_source_trust: activity.source_trust ?? TRUST_BY_SOURCE_TYPE[activity.activity_type] ?? "untrusted_external",
      provenance_entries: [
        {
          source_type: "activity",
          source_id: activity.id,
          source_trust: activity.source_trust ?? TRUST_BY_SOURCE_TYPE[activity.activity_type] ?? "untrusted_external",
          evidence_json: {
            activity_type: activity.activity_type,
            source_url: activity.source_url,
          },
        },
      ],
    };
    return this.insertProposal({
      identity,
      proposalType: "memory_create",
      title: activity.title || `Activity: ${(activity.content ?? "").slice(0, 80)}`,
      payload,
      rationale: "Activity consolidation generated a memory proposal.",
      projectFolderId: activity.project_folder_id,
      projectId: activity.project_id,
    });
  }

  private async insertSummaryMemoryProposal(
    identity: SpaceUserIdentity,
    summary: string,
    artifactId: string,
    sourceRefs: SummarySourceRef[],
  ): Promise<ProposalOut> {
    return this.insertProposal({
      identity,
      proposalType: "memory_create",
      title: "Summary memory",
      payload: {
        operation: "create",
        proposed_content: summary,
        memory_type: "summary",
        target_scope: "user",
        target_namespace: "input.summary",
        target_visibility: "private",
        owner_user_id: identity.userId,
        subject_user_id: identity.userId,
        provenance_entries: [
          {
            source_type: "artifact",
            source_id: artifactId,
            source_trust: "internal_system",
          },
          ...sourceRefs,
        ],
      },
      rationale: "Input summary requested a memory proposal.",
      projectFolderId: null,
      projectId: null,
    });
  }

  private async insertSummaryKnowledgeProposal(
    identity: SpaceUserIdentity,
    summary: string,
    artifactId: string,
    sourceRefs: SummarySourceRef[],
  ): Promise<ProposalOut> {
    return this.insertProposal({
      identity,
      proposalType: "knowledge_create",
      title: "Summary knowledge",
      payload: {
        operation: "create",
        knowledge_kind: "summary",
        title: "Input summary",
        content: summary,
        content_format: "markdown",
        visibility: "private",
        owner_user_id: identity.userId,
        tags: ["summary"],
        source_refs: [
          {
            source_type: "artifact",
            source_id: artifactId,
            source_trust: "internal_system",
          },
          ...sourceRefs,
        ],
      },
      rationale: "Input summary requested a knowledge proposal.",
      projectFolderId: null,
      projectId: null,
    });
  }

  private async insertProposal(input: {
    identity: SpaceUserIdentity;
    proposalType: string;
    title: string;
    payload: Record<string, unknown>;
    rationale: string;
    projectFolderId: string | null;
    projectId: string | null;
  }): Promise<ProposalOut> {
    const now = new Date();
    const row = await insertProposalRow(this.db, {
      spaceId: input.identity.spaceId,
      proposalType: input.proposalType,
      title: input.title,
      payload: input.payload,
      rationale: input.rationale,
      projectFolderId: input.projectFolderId,
      projectId: input.projectId,
      createdByUserId: input.identity.userId,
      visibility: "private",
      riskLevel: "low",
    });
    return proposalToOut(row, now);
  }
}

function buildActivityWhere(
  identity: SpaceUserIdentity,
  filters: ActivityListFilters,
): { where: string; params: unknown[] } {
  const params: unknown[] = [identity.spaceId, identity.userId];
  const clauses = ["space_id = $1", contentReadSql("activity", "ar", "$2")];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filters.userId) clauses.push(`user_id = ${add(filters.userId)}`);
  if (filters.projectFolderId) clauses.push(`project_folder_id = ${add(filters.projectFolderId)}`);
  if (filters.sourceType) clauses.push(`activity_type = ${add(normalizeSourceType(filters.sourceType))}`);
  if (filters.sourceRunId) clauses.push(`source_run_id = ${add(filters.sourceRunId)}`);
  if (filters.status) clauses.push(`status = ${add(filters.status)}`);
  if (filters.projectId) clauses.push(`project_id = ${add(filters.projectId)}`);
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function activityToOut(row: ActivityRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    user_id: row.user_id,
    project_folder_id: row.project_folder_id,
    agent_id: row.agent_id,
    source_type: row.activity_type,
    title: row.title,
    content: row.content ?? "",
    source_run_id: row.source_run_id,
    source_task_id: row.source_task_id,
    source_session_id: row.session_id,
    source_url: row.source_url,
    status: row.status,
    metadata_json: objectValue(row.payload_json),
    aggregate_key: row.aggregate_key,
    visibility: row.visibility,
    access_level: row.access_level,
    owner_user_id: row.owner_user_id,
    occurred_at: dateIso(row.occurred_at),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
    project_id: row.project_id,
  };
}

function normalizeSourceType(sourceType: string): string {
  const value = sourceType.trim().toLowerCase();
  const normalized = SOURCE_TYPE_ALIASES[value] ?? value;
  if (!SOURCE_TYPES.has(normalized)) {
    throw new HttpError(422, `invalid source_type: ${JSON.stringify(sourceType)}`);
  }
  return normalized;
}

function buildSummaryPreview(
  rows: ActivityRow[],
  evidenceRows: SummaryEvidenceRow[],
  sourceRows: SummarySourceItemRow[],
  summaryGoal: string | null,
): string {
  const header = summaryGoal ? `# ${summaryGoal}` : "# Input summary";
  const chunks = rows.map((row) => {
    const title = row.title ? `## ${row.title}` : `## ${row.activity_type}`;
    return `${title}\n\n${(row.content ?? "").trim()}`.trim();
  });
  for (const row of evidenceRows) {
    chunks.push(`## Evidence: ${row.title}\n\n${(row.content_excerpt ?? row.source_uri ?? "").trim()}`.trim());
  }
  for (const row of sourceRows) {
    chunks.push(`## Source: ${row.title}\n\n${(row.excerpt ?? row.source_uri ?? "").trim()}`.trim());
  }
  return [header, ...chunks].filter(Boolean).join("\n\n").slice(0, 8000);
}

function provenanceTrustFromEvidence(trustLevel: string | null | undefined): string {
  if (trustLevel === "trusted") return "trusted_external";
  if (trustLevel === "untrusted") return "untrusted_external";
  return "agent_inferred";
}

export function summaryInputFromBody(body: Record<string, unknown>): SummaryRunInput {
  return {
    activityIds: stringArray(body.activity_ids),
    evidenceIds: stringArray(body.evidence_ids),
    sourceItemIds: stringArray(body.source_item_ids),
    summaryGoal: optionalString(body.summary_goal),
    createMemoryProposal: Boolean(body.create_memory_proposal),
    createKnowledgeProposal: Boolean(body.create_knowledge_proposal),
  };
}

export function listPageOut(
  rows: Record<string, unknown>[],
  total: number,
  limit: number,
  offset: number,
): Record<string, unknown> {
  return page(rows, total, limit, offset);
}

export function totalFromCount(rows: Array<{ total?: unknown }>): number {
  return countFromRow(rows[0]);
}

export function confidenceOrNull(value: unknown): number | null {
  const parsed = numberValue(value);
  if (parsed === null) return null;
  if (parsed < 0 || parsed > 1) throw new HttpError(422, "confidence must be between 0 and 1");
  return parsed;
}
