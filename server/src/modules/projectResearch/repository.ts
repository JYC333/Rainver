import { randomUUID } from "node:crypto";
import {
  HttpError,
  dateIso,
  objectValue,
  optionalString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql";
import { contentResourceDefinition } from "../access/contentAccessRegistry";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "../projects/access";
import { ProjectCorpusRepository } from "../projects/corpusRepository";
import { evidenceProvenanceReadableClause, sourceItemReadableClause } from "../sources/sourceItemAccess";
import { PgUsageRepository, type UsageRunSummaryRecord } from "../usage/repository";

const OUTPUT_TYPES = new Set(["paper", "thesis", "report", "review", "proposal", "other"]);
const PAPER_TYPES = new Set(["empirical", "theory", "survey", "review", "position", "case_study", "other"]);
const CITATION_STYLES = new Set(["apa", "mla", "chicago", "ieee", "acm", "vancouver", "other"]);
const EXPERIMENT_INTAKE = new Set(["none", "code_experiments", "human_study", "both", "undecided"]);
const WORKFLOW_TYPES = new Set(["literature_review", "empirical_paper", "theory_paper", "paper_review", "revision"]);
const WORKFLOW_MODES = new Set(["manual", "agent_assisted", "autonomous"]);
const CHECKPOINT_TYPES = new Set(["profile_approval", "screening_gate", "idea_review", "integrity_gate", "manuscript_gate", "review_gate", "other"]);
const SCREENING_REVIEW_ITEM_LIMIT = 200;
const CHECKPOINT_DECISIONS = new Set(["approved", "rejected", "waived"]);
const SUPPORT_STATUSES = new Set(["unsupported", "supported", "partial", "gap_declared"]);
const RESEARCH_OBJECT_ACCESS = contentResourceDefinition("space_object")!;
const RESEARCH_SOURCE_ACCESS = contentResourceDefinition("source_item")!;
const RESEARCH_EVIDENCE_ACCESS = contentResourceDefinition("extracted_evidence")!;
const RESEARCH_ANNOTATION_ACCESS = contentResourceDefinition("reader_annotation")!;

interface ProfileRow {
  id: string;
  project_id: string;
  preset_key: string;
  research_question: string | null;
  working_title: string | null;
  domain: string | null;
  output_type: string | null;
  paper_type: string | null;
  citation_style: string | null;
  target_venue: string | null;
  language: string;
  experiment_intake_declaration: string;
  status: string;
  approved_by_user_id: string | null;
  approved_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface WorkflowRow {
  id: string;
  project_id: string;
  workflow_type: string;
  current_stage: string | null;
  status: string;
  mode: string;
  state_json: unknown;
  started_by_user_id: string | null;
  started_run_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface ScanSummaryDayRow {
  workflow_id: string;
  scan_date: string;
  scanned_at: unknown;
  new_item_count: number;
  relevant_count: number;
  maybe_count: number;
  excluded_count: number;
  supports_count: number;
  contradicts_count: number;
  new_direction_count: number;
  comparisons_json: unknown;
  integrity_alerts_json: unknown;
  scan_count: number;
}

interface CheckpointRow {
  id: string;
  project_id: string;
  workflow_id: string;
  stage_key: string;
  checkpoint_type: string;
  status: string;
  machine_result_json: unknown;
  user_decision: string | null;
  decision_reason: string | null;
  decided_by_user_id: string | null;
  decided_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface ScreeningReviewItemRow {
  source_item_id: string;
  title: string | null;
  source_uri: string | null;
  source_external_id: string | null;
  author: string | null;
  occurred_at: unknown;
  content_state: string | null;
  object_id: string | null;
  evidence_id: string | null;
  triage_status: string;
  relevance: string | null;
  ai_relevance: string | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  has_full_text: boolean;
  has_evidence: boolean;
}

interface ScreeningReviewSummaryRow {
  total: string;
  relevant: string;
  maybe: string;
  excluded: string;
  missing_full_text: string;
  evidence_count: string;
  failed_items: string;
}

/**
 * A source item is an ingestion record. A paper can have more than one of
 * those records when a scan is retried, a backfill window overlaps, or the
 * same work is found through more than one channel. Review surfaces must
 * operate on the stable paper identity instead of the ingestion record ID.
 */
function screeningPaperIdentitySql(alias = "si"): string {
  return `CASE
    WHEN NULLIF(${alias}.metadata_json->>'arxiv_id', '') IS NOT NULL
      THEN 'arxiv:' || lower(regexp_replace(regexp_replace(${alias}.metadata_json->>'arxiv_id', '^arxiv:', '', 'i'), 'v[0-9]+$', '', 'i'))
    WHEN lower(COALESCE(${alias}.source_domain, '')) LIKE '%arxiv.org'
      AND NULLIF(${alias}.source_external_id, '') IS NOT NULL
      THEN 'arxiv:' || lower(regexp_replace(regexp_replace(${alias}.source_external_id, '^arxiv:', '', 'i'), 'v[0-9]+$', '', 'i'))
    WHEN NULLIF(${alias}.metadata_json->>'doi', '') IS NOT NULL
      THEN 'doi:' || lower(regexp_replace(${alias}.metadata_json->>'doi', '^https?://(dx\\.)?doi\\.org/', '', 'i'))
    WHEN NULLIF(${alias}.source_external_id, '') IS NOT NULL
      THEN 'external:' || lower(COALESCE(${alias}.source_domain, '') || ':' || ${alias}.source_external_id)
    WHEN NULLIF(${alias}.canonical_uri, '') IS NOT NULL
      THEN 'uri:' || lower(${alias}.canonical_uri)
    ELSE 'item:' || ${alias}.id
  END`;
}

/**
 * Build the common read model used by the screening list and its summary.
 * `source_papers` de-duplicates source ingestion records, while
 * `corpus_candidates` preserves all corpus rows long enough to merge full-text
 * and evidence availability before selecting the best row for display.
 */
function screeningPaperReviewCtes(): string {
  const sourcePaperKey = screeningPaperIdentitySql("si");
  return `WITH source_items_scoped AS (
           SELECT si.id AS source_item_id,
                  si.title,
                  si.source_uri,
                  si.source_external_id,
                  si.author,
                  si.occurred_at,
                  si.content_state,
                  si.last_seen_at,
                  si.updated_at,
                  ${sourcePaperKey} AS paper_key
             FROM source_items si
            WHERE si.space_id=$1
              AND si.deleted_at IS NULL
              AND si.id=ANY($3::text[])
         ), source_papers AS (
           SELECT DISTINCT ON (paper_key) *
             FROM source_items_scoped
            ORDER BY paper_key, last_seen_at DESC NULLS LAST, updated_at DESC NULLS LAST, source_item_id ASC
         ), corpus_candidates AS (
           SELECT ${screeningPaperIdentitySql("si")} AS paper_key,
                  pcis.source_item_id,
                  pci.object_id,
                  pci.evidence_id,
                  pci.source_decision_id,
                  pci.triage_status,
                  pci.triage_confirmed_by_user,
                  pci.relevance,
                  pci.metadata_json,
                  pci.updated_at,
                  pci.id,
                  d.relevance AS ai_relevance,
                  d.confidence AS ai_confidence,
                  d.reason AS ai_reason
             FROM project_corpus_items pci
             JOIN project_corpus_item_sources pcis
               ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
             JOIN source_items si
               ON si.space_id=pcis.space_id AND si.id=pcis.source_item_id AND si.deleted_at IS NULL
             LEFT JOIN source_post_processing_item_decisions d
               ON d.space_id=pci.space_id AND d.id=pci.source_decision_id
            WHERE pci.space_id=$1 AND pci.project_id=$2
              AND pci.status='active'
              AND pcis.source_item_id=ANY($3::text[])
         ), corpus_best AS (
           SELECT DISTINCT ON (paper_key) *
             FROM corpus_candidates
            ORDER BY paper_key,
                     triage_confirmed_by_user DESC,
                     (source_decision_id IS NOT NULL) DESC,
                     (object_id IS NOT NULL) DESC,
                     (evidence_id IS NOT NULL) DESC,
                     updated_at DESC NULLS LAST,
                     id ASC
         ), corpus_features AS (
           SELECT paper_key,
                  bool_or(object_id IS NOT NULL) AS has_full_text,
                  bool_or(evidence_id IS NOT NULL) AS has_evidence,
                  bool_or(metadata_json->>'processing_status'='failed') AS has_failed_item
             FROM corpus_candidates
            GROUP BY paper_key
         ), paper_rows AS (
           SELECT sp.paper_key,
                  sp.source_item_id,
                  sp.title,
                  sp.source_uri,
                  sp.source_external_id,
                  sp.author,
                  sp.occurred_at,
                  sp.content_state,
                  cb.object_id,
                  cb.evidence_id,
                  cb.triage_status,
                  cb.relevance,
                  cb.ai_relevance,
                  cb.ai_confidence,
                  cb.ai_reason,
                  COALESCE(cf.has_full_text, false) AS has_full_text,
                  COALESCE(cf.has_evidence, false) AS has_evidence,
                  COALESCE(cf.has_failed_item, false) AS has_failed_item
             FROM source_papers sp
             LEFT JOIN corpus_best cb ON cb.paper_key=sp.paper_key
             LEFT JOIN corpus_features cf ON cf.paper_key=sp.paper_key
         ) `;
}

interface ClaimLinkRow {
  id: string;
  project_id: string;
  workflow_id: string | null;
  claim_id: string;
  support_status: string;
  planned_experiment_ids_json: unknown;
  citation_anchors_json: unknown;
  unresolved_gap: boolean;
  gap_reason: string | null;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const PROFILE_COLUMNS = `
  id, project_id, preset_key, research_question, working_title, domain, output_type,
  paper_type, citation_style, target_venue, language, experiment_intake_declaration,
  status, approved_by_user_id, approved_at, created_at, updated_at
`;

const WORKFLOW_COLUMNS = `
  id, project_id, workflow_type, current_stage, status, mode, state_json,
  started_by_user_id, started_run_id, created_at, updated_at
`;

const CLAIM_LINK_SELECT = `
  pcl.id, pcl.project_id, pcl.workflow_id, pcl.claim_id, pcl.support_status,
  pcl.planned_experiment_ids_json, pcl.citation_anchors_json, pcl.unresolved_gap,
  pcl.gap_reason, pcl.created_by_user_id, pcl.created_at, pcl.updated_at
`;

const CHECKPOINT_COLUMNS = `
  id, project_id, workflow_id, stage_key, checkpoint_type, status, machine_result_json,
  user_decision, decision_reason, decided_by_user_id, decided_at, created_at, updated_at
`;

function requiredDateIso(value: unknown): string {
  return dateIso(value) ?? new Date(0).toISOString();
}

function profileOut(row: ProfileRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    preset_key: row.preset_key,
    research_question: row.research_question,
    working_title: row.working_title,
    domain: row.domain,
    output_type: row.output_type,
    paper_type: row.paper_type,
    citation_style: row.citation_style,
    target_venue: row.target_venue,
    language: row.language,
    experiment_intake_declaration: row.experiment_intake_declaration,
    status: row.status,
    approved_by_user_id: row.approved_by_user_id,
    approved_at: dateIso(row.approved_at),
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

function workflowOut(row: WorkflowRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    workflow_type: row.workflow_type,
    current_stage: row.current_stage,
    status: row.status,
    mode: row.mode,
    state_json: objectValue(row.state_json),
    started_by_user_id: row.started_by_user_id,
    started_run_id: row.started_run_id,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

function checkpointOut(row: CheckpointRow, review: Record<string, unknown> | null = null): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    workflow_id: row.workflow_id,
    stage_key: row.stage_key,
    checkpoint_type: row.checkpoint_type,
    status: row.status,
    machine_result_json: row.machine_result_json === null ? null : objectValue(row.machine_result_json),
    review,
    user_decision: row.user_decision,
    decision_reason: row.decision_reason,
    decided_by_user_id: row.decided_by_user_id,
    decided_at: dateIso(row.decided_at),
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function numericValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function reviewUsageOut(row: UsageRunSummaryRecord | undefined): Record<string, unknown> {
  const inputTokens = numericValue(row?.input_tokens);
  const outputTokens = numericValue(row?.output_tokens);
  const totalTokens = numericValue(row?.total_tokens);
  const estimatedCost = numericValue(row?.estimated_cost_usd);
  return {
    agent_run_count: Number(row?.agent_run_count ?? 0),
    completed_agent_run_count: Number(row?.completed_agent_run_count ?? 0),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    estimated_cost_usd: estimatedCost,
    cost_known: estimatedCost !== null,
    model_names: row?.model_names ?? [],
  };
}

function reviewRecommendation(row: ScreeningReviewItemRow): string {
  if (row.ai_relevance === "relevant" || row.ai_relevance === "maybe" || row.ai_relevance === "not_relevant") {
    return row.ai_relevance;
  }
  if (row.relevance === "relevant" || row.relevance === "maybe" || row.relevance === "not_relevant") {
    return row.relevance;
  }
  if (row.triage_status === "relevant" || row.triage_status === "included") return "relevant";
  if (row.triage_status === "maybe") return "maybe";
  if (row.triage_status === "excluded") return "not_relevant";
  return "unreviewed";
}

function claimLinkOut(row: ClaimLinkRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    workflow_id: row.workflow_id,
    claim_id: row.claim_id,
    support_status: row.support_status,
    planned_experiment_ids: jsonStringArray(row.planned_experiment_ids_json),
    citation_anchors: jsonStringArray(row.citation_anchors_json),
    unresolved_gap: row.unresolved_gap,
    gap_reason: row.gap_reason,
    created_by_user_id: row.created_by_user_id,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

function enumValue(value: unknown, allowed: Set<string>, field: string): string | null {
  const text = optionalString(value);
  if (!text) return null;
  if (!allowed.has(text)) throw new HttpError(422, `${field} must be one of ${[...allowed].join(", ")}`);
  return text;
}

export class ProjectResearchRepository {
  private readonly usageRepository: PgUsageRepository;

  constructor(private readonly db: Queryable) {
    this.usageRepository = new PgUsageRepository(db);
  }

  // --- Profile ---------------------------------------------------------

  async getProfile(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown> | null> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.profileRow(identity.spaceId, projectId);
    return row ? profileOut(row) : null;
  }

  async upsertProfile(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const outputType = enumValue(body.output_type, OUTPUT_TYPES, "output_type");
    const paperType = enumValue(body.paper_type, PAPER_TYPES, "paper_type");
    const citationStyle = enumValue(body.citation_style, CITATION_STYLES, "citation_style");
    const experimentIntake = enumValue(body.experiment_intake_declaration, EXPERIMENT_INTAKE, "experiment_intake_declaration") ?? "undecided";
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO project_research_profiles (
         id, space_id, project_id, research_question, working_title, domain, output_type,
         paper_type, citation_style, target_venue, language, experiment_intake_declaration,
         status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         'draft', $13, $13
       )
       ON CONFLICT (space_id, project_id)
       DO UPDATE SET research_question = EXCLUDED.research_question,
                     working_title = EXCLUDED.working_title,
                     domain = EXCLUDED.domain,
                     output_type = EXCLUDED.output_type,
                     paper_type = EXCLUDED.paper_type,
                     citation_style = EXCLUDED.citation_style,
                     target_venue = EXCLUDED.target_venue,
                     language = EXCLUDED.language,
                     experiment_intake_declaration = EXCLUDED.experiment_intake_declaration,
                     status = 'draft',
                     approved_by_user_id = NULL,
                     approved_at = NULL,
                     updated_at = EXCLUDED.updated_at`,
      [
        id,
        identity.spaceId,
        projectId,
        optionalString(body.research_question),
        optionalString(body.working_title),
        optionalString(body.domain),
        outputType,
        paperType,
        citationStyle,
        optionalString(body.target_venue),
        optionalString(body.language) ?? "en",
        experimentIntake,
        now,
      ],
    );
    const row = await this.profileRow(identity.spaceId, projectId);
    if (!row) throw new HttpError(500, "Failed to upsert research profile");
    return profileOut(row);
  }

  async approveProfile(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.profileRow(identity.spaceId, projectId);
    if (!row) throw new HttpError(404, "Research profile not found");
    if (row.status === "archived") throw new HttpError(422, "Cannot approve an archived research profile");
    if (row.status === "approved") return profileOut(row);
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE project_research_profiles
          SET status = 'approved', approved_by_user_id = $3, approved_at = $4, updated_at = $4
        WHERE space_id = $1 AND project_id = $2`,
      [identity.spaceId, projectId, identity.userId, now],
    );
    const updated = await this.profileRow(identity.spaceId, projectId);
    if (!updated) throw new HttpError(500, "Failed to approve research profile");
    return profileOut(updated);
  }

  private async profileRow(spaceId: string, projectId: string): Promise<ProfileRow | null> {
    const result = await this.db.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM project_research_profiles WHERE space_id = $1 AND project_id = $2 LIMIT 1`,
      [spaceId, projectId],
    );
    return result.rows[0] ?? null;
  }

  // --- Workflows ---------------------------------------------------------

  async listWorkflows(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const result = await this.db.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM project_research_workflows
        WHERE space_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id ASC`,
      [identity.spaceId, projectId],
    );
    return result.rows.map(workflowOut);
  }

  /**
   * Day-aggregated monitoring outcomes. One entry per (workflow, UTC day) —
   * UTC matches the pinned timezone of research post-processing rules — so
   * several same-day scans read as a single daily result. A missing day still
   * means "no scan recorded that day".
   */
  async listScanSummaries(identity: SpaceUserIdentity, projectId: string, limit = 30): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.db.query<ScanSummaryDayRow>(
      `SELECT workflow_id,
              (scanned_at AT TIME ZONE 'UTC')::date::text AS scan_date,
              max(scanned_at) AS scanned_at,
              sum(new_item_count)::int AS new_item_count,
              sum(relevant_count)::int AS relevant_count,
              sum(maybe_count)::int AS maybe_count,
              sum(excluded_count)::int AS excluded_count,
              sum(supports_count)::int AS supports_count,
              sum(contradicts_count)::int AS contradicts_count,
              sum(new_direction_count)::int AS new_direction_count,
              jsonb_path_query_array(jsonb_agg(comparisons_json ORDER BY scanned_at,scan_key), '$[*][*]') AS comparisons_json,
              jsonb_path_query_array(jsonb_agg(integrity_alerts_json ORDER BY scanned_at,scan_key), '$[*][*]') AS integrity_alerts_json,
              count(*)::int AS scan_count
         FROM research_scan_summaries
        WHERE space_id=$1 AND project_id=$2
        GROUP BY workflow_id, (scanned_at AT TIME ZONE 'UTC')::date
        ORDER BY scan_date DESC, workflow_id ASC
        LIMIT $3`,
      [identity.spaceId, projectId, boundedLimit],
    );
    return result.rows.map((row) => ({
      workflow_id: row.workflow_id,
      scan_date: row.scan_date,
      scanned_at: dateIso(row.scanned_at),
      new_item_count: row.new_item_count,
      relevant_count: row.relevant_count,
      maybe_count: row.maybe_count,
      excluded_count: row.excluded_count,
      supports_count: row.supports_count,
      contradicts_count: row.contradicts_count,
      new_direction_count: row.new_direction_count,
      comparisons: Array.isArray(row.comparisons_json) ? row.comparisons_json : [],
      integrity_alerts: Array.isArray(row.integrity_alerts_json) ? row.integrity_alerts_json : [],
      scan_count: row.scan_count,
    }));
  }

  async startWorkflow(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      return new ProjectResearchRepository(db).startWorkflowLocked(identity, projectId, body);
    });
  }

  private async startWorkflowLocked(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const profile = await this.profileRow(identity.spaceId, projectId);
    if (!profile || profile.status !== "approved") {
      throw new HttpError(422, "The research profile must be approved before starting a workflow");
    }
    const workflowType = enumValue(body.workflow_type, WORKFLOW_TYPES, "workflow_type");
    if (!workflowType) throw new HttpError(422, "workflow_type is required");
    const mode = enumValue(body.mode, WORKFLOW_MODES, "mode") ?? "manual";
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO project_research_workflows (
       id, space_id, project_id, workflow_type, status, mode, state_json,
         started_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6::jsonb, $7, $8, $8)`,
      [id, identity.spaceId, projectId, workflowType, mode, JSON.stringify({
        research_question: profile.research_question,
        research_question_version: 1,
      }), identity.userId, now],
    );
    const row = await this.workflowRow(identity.spaceId, projectId, id);
    if (!row) throw new HttpError(500, "Failed to start research workflow");
    return workflowOut(row);
  }

  async runStage(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    stageKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      return new ProjectResearchRepository(db).runStageLocked(identity, projectId, workflowId, stageKey, body);
    });
  }

  private async runStageLocked(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    stageKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const row = await this.workflowRow(identity.spaceId, projectId, workflowId);
    if (!row) throw new HttpError(404, "Research workflow not found");
    if (row.status !== "active") throw new HttpError(422, `Cannot run a stage on a workflow with status ${row.status}`);
    const runId = optionalString(body.run_id);
    const now = new Date().toISOString();
    const stageEntry = { status: runId ? "running" : "recorded", run_id: runId, updated_at: now };
    // jsonb_set against the current DB value (not the row read above) so two
    // concurrent runStage calls for different stage keys on the same
    // workflow don't lose one update in a read-modify-write race. stageKey
    // is passed as two separate parameters ($4, $5) rather than reused —
    // reusing one parameter across a plain-column context and an ARRAY[]
    // context in the same statement trips "inconsistent types deduced for
    // parameter" on this pg version/driver combination.
    await this.db.query(
      `UPDATE project_research_workflows
          SET current_stage = $4,
              state_json = jsonb_set(
                jsonb_set(coalesce(state_json, '{}'::jsonb), '{stages}', coalesce(state_json->'stages', '{}'::jsonb), true),
                ARRAY['stages', $5], $6::jsonb, true
              ),
              updated_at = $7
        WHERE space_id = $1 AND project_id = $2 AND id = $3`,
      [identity.spaceId, projectId, workflowId, stageKey, stageKey, JSON.stringify(stageEntry), now],
    );
    const updated = await this.workflowRow(identity.spaceId, projectId, workflowId);
    if (!updated) throw new HttpError(500, "Failed to run research workflow stage");
    return workflowOut(updated);
  }

  private async workflowRow(spaceId: string, projectId: string, workflowId: string): Promise<WorkflowRow | null> {
    const result = await this.db.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM project_research_workflows
        WHERE space_id = $1 AND project_id = $2 AND id = $3 LIMIT 1`,
      [spaceId, projectId, workflowId],
    );
    return result.rows[0] ?? null;
  }

  // --- Checkpoints ---------------------------------------------------------

  async listCheckpoints(identity: SpaceUserIdentity, projectId: string, workflowId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    await this.requireWorkflow(identity.spaceId, projectId, workflowId);
    const result = await this.db.query<CheckpointRow>(
      `SELECT ${CHECKPOINT_COLUMNS} FROM project_research_checkpoints
        WHERE space_id = $1 AND project_id = $2 AND workflow_id = $3
        ORDER BY created_at DESC, id ASC`,
      [identity.spaceId, projectId, workflowId],
    );
    return Promise.all(result.rows.map(async (row) => checkpointOut(row, await this.checkpointReview(identity.spaceId, projectId, row))));
  }

  async createCheckpoint(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    input: { stageKey: string; checkpointType: string; machineResult: Record<string, unknown> | null },
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await this.requireWorkflow(identity.spaceId, projectId, workflowId);
    const checkpointType = enumValue(input.checkpointType, CHECKPOINT_TYPES, "checkpoint_type");
    if (!checkpointType) throw new HttpError(422, "checkpoint_type is required");
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO project_research_checkpoints (
         id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status,
         machine_result_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::jsonb, $8, $8)`,
      [id, identity.spaceId, projectId, workflowId, input.stageKey, checkpointType, JSON.stringify(input.machineResult ?? {}), now],
    );
    const row = await this.checkpointRow(identity.spaceId, projectId, id);
    if (!row) throw new HttpError(500, "Failed to create checkpoint");
    return checkpointOut(row, await this.checkpointReview(identity.spaceId, projectId, row));
  }

  async decideCheckpoint(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    checkpointId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await this.requireWorkflow(identity.spaceId, projectId, workflowId);
    const decision = enumValue(body.decision, CHECKPOINT_DECISIONS, "decision");
    if (!decision) throw new HttpError(422, "decision is required and must be one of approved, rejected, waived");
    const row = await this.checkpointRow(identity.spaceId, projectId, checkpointId);
    if (!row || row.workflow_id !== workflowId) throw new HttpError(404, "Checkpoint not found");
    if (["approved", "waived"].includes(decision) && row.checkpoint_type === "screening_gate") {
      const operationId = optionalString(objectValue(row.machine_result_json).operation_id);
      const priorSynthesis = operationId
        ? await this.db.query<{ started: boolean }>(
            `SELECT (progress_json->>'synthesis_run_id') IS NOT NULL AS started
               FROM project_operations WHERE space_id=$1 AND project_id=$2 AND id=$3 LIMIT 1`,
            [identity.spaceId, projectId, operationId],
          )
        : { rows: [] };
      // A previously approved checkpoint may be replayed to repair a stale
      // operation projection. Once synthesis exists, do not reinterpret that
      // historical approval through today's corpus projection.
      if (priorSynthesis.rows[0]?.started !== true) {
        const review = await this.checkpointReview(identity.spaceId, projectId, row);
        const processingStatus = optionalString(objectValue(review?.summary).processing_status);
        if (processingStatus === "incomplete") {
          throw new HttpError(409, "Screening is not complete; wait for every paper to receive an AI classification before approving this batch");
        }
        if (processingStatus === "empty") {
          throw new HttpError(409, "No papers matched this search window; revise the search query or date range and rescan before continuing");
        }
      }
    }
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE project_research_checkpoints
          SET status = $5, user_decision = $5, decision_reason = $6,
              decided_by_user_id = $7, decided_at = $8, updated_at = $8
        WHERE space_id = $1 AND project_id = $2 AND workflow_id = $3 AND id = $4`,
      [identity.spaceId, projectId, workflowId, checkpointId, decision, optionalString(body.reason), identity.userId, now],
    );
    const updated = await this.checkpointRow(identity.spaceId, projectId, checkpointId);
    if (!updated) throw new HttpError(500, "Failed to decide checkpoint");
    return checkpointOut(updated, await this.checkpointReview(identity.spaceId, projectId, updated));
  }

  /**
   * Checkpoint machine results are intentionally opaque workflow state. The
   * UI consumes this separate read model so a reviewer sees the decision in
   * research terms rather than internal IDs and JSON flags.
   */
  private async checkpointReview(spaceId: string, projectId: string, checkpoint: CheckpointRow): Promise<Record<string, unknown> | null> {
    if (checkpoint.checkpoint_type !== "screening_gate" && checkpoint.checkpoint_type !== "idea_review") return null;
    const machineResult = objectValue(checkpoint.machine_result_json);
    const operationId = optionalString(machineResult.operation_id);
    if (!operationId) return null;

    const operation = await this.db.query<{ progress_json: unknown }>(
      `SELECT progress_json FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND id=$3 AND kind='research'
        LIMIT 1`,
      [spaceId, projectId, operationId],
    );
    const progress = objectValue(operation.rows[0]?.progress_json);

    if (checkpoint.checkpoint_type === "screening_gate") {
      const sourceItemIds = await this.reviewSourceItemIds(spaceId, progress);
      const ruleIds = uniqueStrings([
        ...stringArray(progress.source_post_processing_rule_ids),
        optionalString(progress.source_post_processing_rule_id) ?? "",
      ]);
      // A decided checkpoint's review must stay reproducible as of the
      // decision, but a still-pending one is refreshed in place (same row,
      // machine_result_json/updated_at rewritten on every reconcile tick) —
      // anchoring on created_at would freeze classified/usage counts at
      // whatever was true when the checkpoint first appeared, forever, no
      // matter how many later reconciles or refreshes run.
      const asOf = dateIso(checkpoint.decided_at) ?? dateIso(checkpoint.updated_at) ?? new Date().toISOString();
      const [items, corpusSummary, decisionCoverage, usage] = await Promise.all([
        sourceItemIds.length
          ? this.db.query<ScreeningReviewItemRow>(
            `${screeningPaperReviewCtes()}
             SELECT source_item_id,
                    title,
                    source_uri,
                    source_external_id,
                    author,
                    occurred_at,
                    content_state,
                    object_id,
                    evidence_id,
                    COALESCE(triage_status, 'new') AS triage_status,
                    relevance,
                    ai_relevance,
                    ai_confidence,
                    ai_reason,
                    has_full_text,
                    has_evidence
               FROM paper_rows
              ORDER BY
              CASE COALESCE(ai_relevance, relevance, triage_status)
                WHEN 'relevant' THEN 0
                WHEN 'maybe' THEN 1
                WHEN 'included' THEN 2
                ELSE 3
              END,
              occurred_at DESC NULLS LAST,
              title ASC,
              source_item_id ASC
            LIMIT ${SCREENING_REVIEW_ITEM_LIMIT}`,
            [spaceId, projectId, sourceItemIds],
          )
          : Promise.resolve({ rows: [] as ScreeningReviewItemRow[] }),
        sourceItemIds.length
          ? this.db.query<ScreeningReviewSummaryRow>(
              `${screeningPaperReviewCtes()}
               SELECT count(*)::int AS total,
                      count(*) FILTER (WHERE COALESCE(ai_relevance, relevance, triage_status) IN ('relevant','included'))::int AS relevant,
                      count(*) FILTER (WHERE COALESCE(ai_relevance, relevance, triage_status)='maybe')::int AS maybe,
                      count(*) FILTER (WHERE COALESCE(ai_relevance, relevance, triage_status) IN ('excluded','not_relevant'))::int AS excluded,
                      count(*) FILTER (WHERE NOT has_full_text)::int AS missing_full_text,
                      count(*) FILTER (WHERE has_evidence)::int AS evidence_count,
                      count(*) FILTER (WHERE has_failed_item)::int AS failed_items
                 FROM paper_rows`,
              [spaceId, projectId, sourceItemIds],
            )
          : Promise.resolve({ rows: [] as ScreeningReviewSummaryRow[] }),
        sourceItemIds.length
          ? this.db.query<{ classified: string }>(
              `SELECT count(DISTINCT ${screeningPaperIdentitySql("si")})::int AS classified
                 FROM source_post_processing_item_decisions d
                 JOIN source_items si
                   ON si.space_id=d.space_id AND si.id=d.source_item_id AND si.deleted_at IS NULL
                WHERE d.space_id=$1 AND d.project_id=$2 AND d.source_item_id=ANY($3::text[])
                  AND d.created_at <= $4::timestamptz
                  AND d.research_question_version=$5`,
              [spaceId, projectId, sourceItemIds, asOf, Math.max(1, numberValue(progress.research_question_version))],
            )
          : Promise.resolve({ rows: [{ classified: "0" }] }),
        this.screeningReviewUsage(spaceId, projectId, ruleIds, sourceItemIds, asOf),
      ]);
      const machineTotal = numberValue(machineResult.total);
      const summaryRow = corpusSummary.rows[0];
      const sourceTotal = sourceItemIds.length ? Number(summaryRow?.total ?? 0) : machineTotal;
      const classified = Number(decisionCoverage.rows[0]?.classified ?? 0);
      const summary = {
        total: sourceTotal,
        classified,
        unclassified: Math.max(0, sourceTotal - classified),
        relevant: Number(summaryRow?.relevant ?? 0),
        maybe: Number(summaryRow?.maybe ?? 0),
        excluded: Number(summaryRow?.excluded ?? 0),
        missing_full_text: Number(summaryRow?.missing_full_text ?? 0),
        evidence_count: Number(summaryRow?.evidence_count ?? 0),
        failed_items: Number(summaryRow?.failed_items ?? 0),
        processing_status: classified >= sourceTotal && sourceTotal > 0 ? "complete" : sourceTotal === 0 ? "empty" : "incomplete",
        partial: machineResult.partial === true,
      };
      const isEmpty = summary.processing_status === "empty";
      return {
        type: "screening",
        title: "Screening results",
        description: "Confirm that this screening batch is complete and worth moving into the literature matrix and synthesis.",
        decision_scope: "batch",
        decision_help: isEmpty
          ? "No papers matched this search window. Synthesis is paused; revise the search query or date range and rescan before continuing."
          : "Approve accepts the completed batch and starts synthesis. Reject keeps it out of the formal outputs so the search or screening criteria can be revised.",
        summary,
        usage,
        next_step: {
          key: isEmpty ? "rescan" : "synthesis",
          label: isEmpty ? "Rescan empty windows" : "Generate synthesis",
          description: isEmpty
            ? "Update the source query or date range, then rescan the empty windows. No synthesis run will be started for an empty corpus."
            : "Approval will build or refresh the literature matrix and spend additional model budget on the synthesis and idea candidates.",
        },
        items: items.rows.map((item) => ({
          source_item_id: item.source_item_id,
          title: item.title ?? "Untitled paper",
          source_uri: item.source_uri,
          external_id: item.source_external_id,
          author: item.author,
          occurred_at: dateIso(item.occurred_at),
          recommendation: reviewRecommendation(item),
          confidence: item.ai_confidence,
          reason: item.ai_reason,
          full_text_status: item.has_full_text ? "available" : (item.content_state ?? "not_available"),
          evidence_available: item.has_evidence,
          human_triage: item.triage_status,
        })),
        item_count: sourceTotal,
        displayed_item_count: items.rows.length,
        truncated: sourceTotal > items.rows.length,
      };
    }

    if (checkpoint.checkpoint_type === "idea_review") {
      const reportId = optionalString(machineResult.report_id);
      const report = reportId
        ? await this.db.query<{ content_json: unknown }>(
            `SELECT content_json FROM project_research_reports
              WHERE space_id=$1 AND project_id=$2 AND id=$3 LIMIT 1`,
            [spaceId, projectId, reportId],
          )
        : { rows: [] as Array<{ content_json: unknown }> };
      const content = objectValue(report.rows[0]?.content_json);
      const ideas = Array.isArray(content.ideas)
        ? content.ideas.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        : [];
      return {
        type: "ideas",
        title: "Idea candidates",
        description: "Confirm the generated idea batch before it becomes part of the project’s formal research outputs.",
        decision_scope: "batch",
        decision_help: "Approve accepts the complete batch. Reject keeps the candidates out of the formal research outputs.",
        summary: { total: numberValue(machineResult.idea_count) || ideas.length, classified: ideas.length, unclassified: 0, processing_status: "complete" },
        usage: await this.runUsage(spaceId, projectId, optionalString(progress.synthesis_run_id)),
        next_step: {
          key: "monitoring",
          label: "Activate monitoring",
          description: "Approval makes this idea batch part of the workflow record and activates ongoing literature monitoring.",
        },
        items: ideas.slice(0, 50).map((idea) => ({
          title: optionalString(idea.title) ?? "Untitled idea",
          problem: optionalString(idea.problem),
          novelty: optionalString(idea.novelty),
          testability: optionalString(idea.testability),
          reference_count: Array.isArray(idea.references) ? idea.references.length : 0,
        })),
        item_count: ideas.length || numberValue(machineResult.idea_count),
        displayed_item_count: Math.min(ideas.length, 50),
        truncated: ideas.length > 50,
      };
    }

    return null;
  }

  private async reviewSourceItemIds(spaceId: string, progress: Record<string, unknown>): Promise<string[]> {
    const stateItemIds = stringArray(progress.source_item_ids);
    const planIds = uniqueStrings([
      ...stringArray(progress.source_backfill_plan_ids),
      optionalString(progress.source_backfill_plan_id) ?? "",
    ]);
    if (planIds.length === 0) return stateItemIds;
    const result = await this.db.query<{ id: string }>(
      `SELECT id
         FROM source_items
        WHERE space_id=$1
          AND deleted_at IS NULL
          AND (
            metadata_json->>'source_backfill_plan_id'=ANY($2::text[])
            OR metadata_json->>'source_backfill_created_plan_id'=ANY($2::text[])
          )`,
      [spaceId, planIds],
    );
    return uniqueStrings([...stateItemIds, ...result.rows.map((row) => row.id)]);
  }

  private async screeningReviewUsage(
    spaceId: string,
    projectId: string,
    ruleIds: string[],
    sourceItemIds: string[],
    createdBefore: string,
  ): Promise<Record<string, unknown>> {
    if (ruleIds.length === 0 || sourceItemIds.length === 0) return this.emptyReviewUsage();
    const result = await this.db.query<{ id: string }>(
      `SELECT DISTINCT r.id
         FROM source_post_processing_runs pr
         JOIN runs r ON r.space_id=pr.space_id AND r.id=pr.agent_run_id
        WHERE pr.space_id=$1 AND pr.project_id=$2
          AND r.project_id=$2
          AND pr.rule_id=ANY($3::text[])
          AND pr.created_at <= $4::timestamptz
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(COALESCE(pr.input_item_ids_json, '[]'::jsonb)) input_item_id
             WHERE input_item_id = ANY($5::text[])
          )`,
      [spaceId, projectId, ruleIds, createdBefore, sourceItemIds],
    );
    return reviewUsageOut(await this.usageRepository.summarizeRunUsage(
      spaceId,
      projectId,
      result.rows.map((row) => row.id),
    ));
  }

  private async runUsage(spaceId: string, projectId: string, runId: string | null): Promise<Record<string, unknown>> {
    if (!runId) return this.emptyReviewUsage();
    return reviewUsageOut(await this.usageRepository.summarizeRunUsage(spaceId, projectId, [runId]));
  }

  private emptyReviewUsage(): Record<string, unknown> {
    return {
      agent_run_count: 0,
      completed_agent_run_count: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      estimated_cost_usd: null,
      cost_known: false,
      model_names: [],
    };
  }

  private async checkpointRow(spaceId: string, projectId: string, checkpointId: string): Promise<CheckpointRow | null> {
    const result = await this.db.query<CheckpointRow>(
      `SELECT ${CHECKPOINT_COLUMNS} FROM project_research_checkpoints
        WHERE space_id = $1 AND project_id = $2 AND id = $3 LIMIT 1`,
      [spaceId, projectId, checkpointId],
    );
    return result.rows[0] ?? null;
  }

  private async requireWorkflow(spaceId: string, projectId: string, workflowId: string): Promise<void> {
    const row = await this.workflowRow(spaceId, projectId, workflowId);
    if (!row) throw new HttpError(404, "Research workflow not found");
  }

  // --- Integrity ---------------------------------------------------------

  async runReportIntegrity(identity: SpaceUserIdentity, projectId: string, reportId: string): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const target = await this.db.query<{ workflow_id: string }>(
      `SELECT workflow_id FROM project_research_reports WHERE id=$1 AND space_id=$2 AND project_id=$3`,
      [reportId, identity.spaceId, projectId],
    );
    const workflowId = target.rows[0]?.workflow_id;
    if (!workflowId) throw new HttpError(404, "Research report not found");
    const report = await this.evaluateWorkflowIntegrity(identity, projectId, workflowId);
    const artifactId = await this.createArtifact(identity, projectId, {
      artifactType: "integrity_report",
      title: `Integrity Report (${new Date().toISOString()})`,
      content: JSON.stringify(report),
    });
    await this.db.query(`UPDATE artifacts SET surface_role='system_archive' WHERE id=$1 AND space_id=$2`, [artifactId, identity.spaceId]);
    await this.db.query(
      `UPDATE project_research_reports SET integrity_artifact_id=$4, updated_at=now()
        WHERE id=$1 AND space_id=$2 AND project_id=$3`,
      [reportId, identity.spaceId, projectId, artifactId],
    );
    return report;
  }

  async evaluateWorkflowIntegrity(identity: SpaceUserIdentity, projectId: string, workflowId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    await this.requireWorkflow(identity.spaceId, projectId, workflowId);
    return this.computeIntegrityReport(identity.spaceId, projectId, workflowId, identity.userId);
  }

  /**
   * V1 checks: citation existence for cited papers, claim has evidence or
   * an explicit gap, evidence source is visible in the project corpus, and
   * experiment-backed claims reference a project_experiment_provenance row.
   */
  private async computeIntegrityReport(
    spaceId: string,
    projectId: string,
    workflowId: string,
    viewerUserId: string,
  ): Promise<Record<string, unknown>> {
    const links = await this.db.query<{
      id: string;
      claim_id: string;
      support_status: string;
      planned_experiment_ids_json: unknown;
      citation_anchors_json: unknown;
      unresolved_gap: boolean;
    }>(
      `SELECT pcl.id, pcl.claim_id, pcl.support_status, pcl.planned_experiment_ids_json,
              pcl.citation_anchors_json, pcl.unresolved_gap
         FROM project_research_claim_links pcl
         JOIN claims c ON c.object_id = pcl.claim_id AND c.space_id = pcl.space_id
         JOIN space_objects so
           ON so.id = c.object_id
          AND so.space_id = c.space_id
          AND so.object_type = 'claim'
          AND so.deleted_at IS NULL
        WHERE pcl.space_id = $1
          AND pcl.project_id = $2
          AND (pcl.workflow_id = $3 OR pcl.workflow_id IS NULL)
          AND ${contentReadSql("space_object", "so", "$4")}`,
      [spaceId, projectId, workflowId, viewerUserId],
    );
    const findings: Array<{ severity: "high" | "medium" | "low"; claim_link_id: string; code: string; message: string }> = [];

    for (const link of links.rows) {
      const citationAnchors = Array.isArray(link.citation_anchors_json)
        ? link.citation_anchors_json.filter((v): v is string => typeof v === "string")
        : [];
      const plannedExperimentIds = Array.isArray(link.planned_experiment_ids_json)
        ? link.planned_experiment_ids_json.filter((v): v is string => typeof v === "string")
        : [];

      for (const paperObjectId of citationAnchors) {
        const exists = await this.db.query<{ object_id: string }>(
          `SELECT ap.object_id FROM academic_papers ap
             JOIN space_objects so ON so.id = ap.object_id AND so.space_id = ap.space_id
            WHERE ap.space_id = $1 AND ap.object_id = $2 AND so.deleted_at IS NULL LIMIT 1`,
          [spaceId, paperObjectId],
        );
        if (!exists.rows[0]) {
          findings.push({
            severity: "high",
            claim_link_id: link.id,
            code: "citation_not_found",
            message: `Cited paper ${paperObjectId} does not exist in this space`,
          });
        }
      }

      const evidenceRows = await this.db.query<{ source_object_id: string | null }>(
        `SELECT source_object_id FROM claim_sources WHERE space_id = $1 AND claim_id = $2`,
        [spaceId, link.claim_id],
      );
      if (evidenceRows.rows.length === 0 && !link.unresolved_gap) {
        findings.push({
          severity: "high",
          claim_link_id: link.id,
          code: "no_evidence_no_gap",
          message: "Claim has no evidence link and is not marked as a material gap",
        });
      }
      for (const evidence of evidenceRows.rows) {
        if (!evidence.source_object_id) continue;
        const inCorpus = await this.db.query<{ id: string }>(
          `SELECT id FROM project_corpus_items
            WHERE space_id = $1 AND project_id = $2 AND object_id = $3 AND status = 'active' LIMIT 1`,
          [spaceId, projectId, evidence.source_object_id],
        );
        if (!inCorpus.rows[0]) {
          findings.push({
            severity: "medium",
            claim_link_id: link.id,
            code: "evidence_not_in_project_corpus",
            message: `Evidence source ${evidence.source_object_id} is not visible in this project's corpus`,
          });
        }
      }

      for (const experimentKey of plannedExperimentIds) {
        const provenance = await this.db.query<{ id: string }>(
          `SELECT id FROM project_experiment_provenance
            WHERE space_id = $1 AND project_id = $2 AND experiment_key = $3 LIMIT 1`,
          [spaceId, projectId, experimentKey],
        );
        if (!provenance.rows[0]) {
          findings.push({
            severity: "high",
            claim_link_id: link.id,
            code: "experiment_provenance_not_found",
            message: `Declared experiment '${experimentKey}' has no provenance record in this project`,
          });
        }
      }
    }

    const blocking = findings.some((finding) => finding.severity === "high");
    return {
      schema_version: "integrity_report.v1",
      workflow_id: workflowId,
      generated_at: new Date().toISOString(),
      checked_claim_links: links.rows.length,
      findings,
      blocking,
    };
  }

  private async createArtifact(
    identity: SpaceUserIdentity,
    projectId: string,
    input: { artifactType: string; title: string; content: string },
  ): Promise<string> {
    const artifactId = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO artifacts (
         id, space_id, project_id, artifact_type, title, content, mime_type,
         exportable, export_formats_json, canonical_format, preview,
         created_at, updated_at, visibility, owner_user_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'application/json',
         true, $7::jsonb, 'json', false,
         $8, $8, 'private', $9
       )`,
      [artifactId, identity.spaceId, projectId, input.artifactType, input.title.slice(0, 512), input.content, JSON.stringify(["json"]), now, identity.userId],
    );
    return artifactId;
  }

  // --- Claim links ---------------------------------------------------------

  async listClaimLinks(identity: SpaceUserIdentity, projectId: string, workflowId?: string | null): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const params: unknown[] = [identity.spaceId, projectId, identity.userId];
    let where = `pcl.space_id = $1 AND pcl.project_id = $2 AND ${contentReadSql("space_object", "so", "$3")}`;
    if (workflowId) {
      params.push(workflowId);
      where += ` AND pcl.workflow_id = $${params.length}`;
    }
    const result = await this.db.query<ClaimLinkRow>(
      `SELECT ${CLAIM_LINK_SELECT}
         FROM project_research_claim_links pcl
         JOIN claims c ON c.object_id = pcl.claim_id AND c.space_id = pcl.space_id
         JOIN space_objects so
           ON so.id = c.object_id
          AND so.space_id = c.space_id
          AND so.object_type = 'claim'
          AND so.deleted_at IS NULL
        WHERE ${where}
        ORDER BY pcl.created_at DESC, pcl.id ASC`,
      params,
    );
    return result.rows.map(claimLinkOut);
  }

  async createClaimLink(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const claimId = optionalString(body.claim_id);
    if (!claimId) throw new HttpError(422, "claim_id is required");
    const claimExists = await this.db.query<{ object_id: string }>(
      `SELECT c.object_id
         FROM claims c
         JOIN space_objects so
           ON so.id = c.object_id
          AND so.space_id = c.space_id
          AND so.object_type = 'claim'
          AND so.deleted_at IS NULL
        WHERE c.object_id = $1
          AND c.space_id = $2
          AND ${contentReadSql("space_object", "so", "$3")}
        LIMIT 1`,
      [claimId, identity.spaceId, identity.userId],
    );
    if (!claimExists.rows[0]) throw new HttpError(422, "claim_id is not readable by this user");
    const existingLink = await this.db.query<{ id: string }>(
      `SELECT id FROM project_research_claim_links WHERE space_id = $1 AND project_id = $2 AND claim_id = $3 LIMIT 1`,
      [identity.spaceId, projectId, claimId],
    );
    if (existingLink.rows[0]) throw new HttpError(409, "This claim is already linked to the project");
    const workflowId = optionalString(body.workflow_id);
    if (workflowId) await this.requireWorkflow(identity.spaceId, projectId, workflowId);
    const supportStatus = enumValue(body.support_status, SUPPORT_STATUSES, "support_status") ?? "unsupported";
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO project_research_claim_links (
         id, space_id, project_id, workflow_id, claim_id, support_status,
         planned_experiment_ids_json, citation_anchors_json, unresolved_gap, gap_reason,
         created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $12)`,
      [
        id,
        identity.spaceId,
        projectId,
        workflowId,
        claimId,
        supportStatus,
        JSON.stringify(stringArray(body.planned_experiment_ids)),
        JSON.stringify(stringArray(body.citation_anchors)),
        body.unresolved_gap === true,
        optionalString(body.gap_reason),
        identity.userId,
        now,
      ],
    );
    const row = await this.claimLinkRow(identity.spaceId, projectId, id, identity.userId);
    if (!row) throw new HttpError(500, "Failed to create claim link");
    return claimLinkOut(row);
  }

  async updateClaimLink(
    identity: SpaceUserIdentity,
    projectId: string,
    claimLinkId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const current = await this.claimLinkRow(identity.spaceId, projectId, claimLinkId, identity.userId);
    if (!current) throw new HttpError(404, "Claim link not found");
    const supportStatus = body.support_status === undefined
      ? current.support_status
      : enumValue(body.support_status, SUPPORT_STATUSES, "support_status") ?? current.support_status;
    const plannedExperimentIds = body.planned_experiment_ids === undefined
      ? jsonStringArray(current.planned_experiment_ids_json)
      : stringArray(body.planned_experiment_ids);
    const citationAnchors = body.citation_anchors === undefined
      ? jsonStringArray(current.citation_anchors_json)
      : stringArray(body.citation_anchors);
    const unresolvedGap = body.unresolved_gap === undefined ? current.unresolved_gap : body.unresolved_gap === true;
    const gapReason = body.gap_reason === undefined ? current.gap_reason : optionalString(body.gap_reason);
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE project_research_claim_links
          SET support_status = $4, planned_experiment_ids_json = $5::jsonb, citation_anchors_json = $6::jsonb,
              unresolved_gap = $7, gap_reason = $8, updated_at = $9
        WHERE space_id = $1 AND project_id = $2 AND id = $3`,
      [identity.spaceId, projectId, claimLinkId, supportStatus, JSON.stringify(plannedExperimentIds), JSON.stringify(citationAnchors), unresolvedGap, gapReason, now],
    );
    const updated = await this.claimLinkRow(identity.spaceId, projectId, claimLinkId, identity.userId);
    if (!updated) throw new HttpError(500, "Failed to update claim link");
    return claimLinkOut(updated);
  }

  private async claimLinkRow(
    spaceId: string,
    projectId: string,
    claimLinkId: string,
    viewerUserId: string,
  ): Promise<ClaimLinkRow | null> {
    const result = await this.db.query<ClaimLinkRow>(
      `SELECT ${CLAIM_LINK_SELECT}
         FROM project_research_claim_links pcl
         JOIN claims c ON c.object_id = pcl.claim_id AND c.space_id = pcl.space_id
         JOIN space_objects so
           ON so.id = c.object_id
          AND so.space_id = c.space_id
          AND so.object_type = 'claim'
          AND so.deleted_at IS NULL
        WHERE pcl.space_id = $1
          AND pcl.project_id = $2
          AND pcl.id = $3
          AND ${contentReadSql("space_object", "so", "$4")}
        LIMIT 1`,
      [spaceId, projectId, claimLinkId, viewerUserId],
    );
    return result.rows[0] ?? null;
  }

  // --- Literature matrix / synthesis ---------------------------------------
  //
  // Thin read model over the existing Project Corpus (relevant/included/maybe papers).
  // The route contract stays stable as the backing query gains richer academic
  // metadata, extracted evidence, and annotations.

  async getLiteratureMatrix(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const result = await this.db.query<{
      id: string;
      object_id: string | null;
      triage_status: string;
      relevance: string | null;
      confidence: number | null;
      reason: string | null;
      object_title: string | null;
      object_summary: string | null;
      arxiv_id: string | null;
      doi: string | null;
      publication_date: unknown;
      venue: string | null;
      paper_type: string | null;
      cited_by_count: number | null;
      reference_count: number | null;
      source_uri: string | null;
      authors: unknown;
      categories: unknown;
      evidence_count: string;
      annotation_count: string;
    }>(
      `SELECT pci.id, pci.object_id, pci.triage_status, pci.relevance, pci.confidence, pci.reason,
              so.title AS object_title, so.summary AS object_summary,
              ap.arxiv_id, ap.doi, ap.publication_date, ap.venue, ap.paper_type,
              ap.cited_by_count, ap.reference_count,
              src.uri AS source_uri, src.metadata_json->'authors' AS authors, src.metadata_json->'categories' AS categories,
              (SELECT count(*) FROM extracted_evidence ee
                WHERE ee.space_id = pci.space_id AND ee.deleted_at IS NULL
                  AND ${contentReadSql("extracted_evidence", "ee", "$3")}
                  AND ${contentAccessLevelSql({ definition: RESEARCH_EVIDENCE_ACCESS, alias: "ee", userExpr: "$3" })} = 'full'
                  AND ${evidenceProvenanceReadableClause("ee", "$3", true)}
                  AND EXISTS (
                    SELECT 1
                      FROM project_corpus_item_sources pcis
                      JOIN source_items provenance_source
                        ON provenance_source.id = pcis.source_item_id
                       AND provenance_source.space_id = pcis.space_id
                       AND provenance_source.deleted_at IS NULL
                     WHERE pcis.corpus_item_id = pci.id
                       AND pcis.space_id = pci.space_id
                       AND pcis.source_item_id = COALESCE(ee.source_item_id, ee.origin_source_item_id)
                       AND ${sourceItemReadableClause("provenance_source", "$3", false)}
                       AND ${contentAccessLevelSql({ definition: RESEARCH_SOURCE_ACCESS, alias: "provenance_source", userExpr: "$3" })} = 'full'
                  )) AS evidence_count,
              (SELECT count(*) FROM reader_annotations ra
                WHERE ra.space_id = pci.space_id
                  AND ra.document_type = 'source_item'
                  AND ra.status = 'active'
                  AND ${contentReadSql("reader_annotation", "ra", "$3")}
                  AND ${contentAccessLevelSql({ definition: RESEARCH_ANNOTATION_ACCESS, alias: "ra", userExpr: "$3" })} = 'full'
                  AND EXISTS (
                    SELECT 1
                      FROM project_corpus_item_sources pcis
                      JOIN source_items provenance_source
                        ON provenance_source.id = pcis.source_item_id
                       AND provenance_source.space_id = pcis.space_id
                       AND provenance_source.deleted_at IS NULL
                     WHERE pcis.corpus_item_id = pci.id
                       AND pcis.space_id = pci.space_id
                       AND pcis.source_item_id = ra.document_id
                       AND ${sourceItemReadableClause("provenance_source", "$3", false)}
                       AND ${contentAccessLevelSql({ definition: RESEARCH_SOURCE_ACCESS, alias: "provenance_source", userExpr: "$3" })} = 'full'
                  )) AS annotation_count
         FROM project_corpus_items pci
         LEFT JOIN space_objects so ON so.id = pci.object_id AND so.space_id = pci.space_id
         LEFT JOIN academic_papers ap ON ap.object_id = so.id AND ap.space_id = pci.space_id
         LEFT JOIN sources src ON src.object_id = so.id AND src.space_id = pci.space_id
         LEFT JOIN source_items direct_source
           ON direct_source.id = pci.source_item_id
          AND direct_source.space_id = pci.space_id
          AND direct_source.deleted_at IS NULL
         LEFT JOIN extracted_evidence matrix_evidence
           ON matrix_evidence.id = pci.evidence_id
          AND matrix_evidence.space_id = pci.space_id
          AND matrix_evidence.deleted_at IS NULL
         LEFT JOIN source_items evidence_source
           ON evidence_source.id = COALESCE(matrix_evidence.source_item_id, matrix_evidence.origin_source_item_id)
          AND evidence_source.space_id = matrix_evidence.space_id
          AND evidence_source.deleted_at IS NULL
        WHERE pci.space_id = $1 AND pci.project_id = $2 AND pci.status = 'active'
          AND pci.triage_status IN ('relevant', 'included', 'maybe')
          AND (
            pci.object_id IS NULL
            OR (
              so.id IS NOT NULL
              AND ${contentReadSql("space_object", "so", "$3")}
              AND ${contentAccessLevelSql({ definition: RESEARCH_OBJECT_ACCESS, alias: "so", userExpr: "$3" })} = 'full'
            )
          )
          AND (
            pci.source_item_id IS NULL
            OR (
              direct_source.id IS NOT NULL
              AND ${sourceItemReadableClause("direct_source", "$3", false)}
              AND ${contentAccessLevelSql({ definition: RESEARCH_SOURCE_ACCESS, alias: "direct_source", userExpr: "$3" })} = 'full'
            )
          )
          AND (
            pci.evidence_id IS NULL
            OR (
              matrix_evidence.id IS NOT NULL
              AND ${contentReadSql("extracted_evidence", "matrix_evidence", "$3")}
              AND ${contentAccessLevelSql({ definition: RESEARCH_EVIDENCE_ACCESS, alias: "matrix_evidence", userExpr: "$3" })} = 'full'
              AND ${evidenceProvenanceReadableClause("matrix_evidence", "$3", true)}
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM project_corpus_item_sources any_provenance
               WHERE any_provenance.corpus_item_id = pci.id
                 AND any_provenance.space_id = pci.space_id
            )
            OR EXISTS (
              SELECT 1
                FROM project_corpus_item_sources readable_provenance
                JOIN source_items provenance_source
                  ON provenance_source.id = readable_provenance.source_item_id
                 AND provenance_source.space_id = readable_provenance.space_id
                 AND provenance_source.deleted_at IS NULL
               WHERE readable_provenance.corpus_item_id = pci.id
                 AND readable_provenance.space_id = pci.space_id
                 AND ${sourceItemReadableClause("provenance_source", "$3", false)}
                 AND ${contentAccessLevelSql({ definition: RESEARCH_SOURCE_ACCESS, alias: "provenance_source", userExpr: "$3" })} = 'full'
            )
          )
        ORDER BY pci.triage_status ASC, so.title ASC NULLS LAST`,
      [identity.spaceId, projectId, identity.userId],
    );
    return result.rows.map((row) => ({
      corpus_item_id: row.id,
      object_id: row.object_id,
      title: row.object_title,
      summary: row.object_summary,
      triage_status: row.triage_status,
      relevance: row.relevance,
      confidence: row.confidence,
      reason: row.reason,
      evidence_count: Number(row.evidence_count),
      annotation_count: Number(row.annotation_count),
      // paper_type is NOT NULL on academic_papers — a reliable "joined" signal.
      academic: row.paper_type !== null
        ? {
            arxiv_id: row.arxiv_id,
            doi: row.doi,
            publication_date: dateIso(row.publication_date),
            venue: row.venue,
            paper_type: row.paper_type,
            cited_by_count: row.cited_by_count,
            reference_count: row.reference_count,
            source_uri: row.source_uri,
            authors: Array.isArray(row.authors) ? row.authors : [],
            categories: Array.isArray(row.categories) ? row.categories : [],
          }
        : null,
    }));
  }

  async rebuildLiteratureMatrix(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await new ProjectCorpusRepository(this.db).backfillFromSources(identity, projectId);
    return this.getLiteratureMatrix(identity, projectId);
  }

  // --- Screening criteria ---------------------------------------------------------

  async getScreeningCriteria(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.screeningCriteriaRow(identity.spaceId, projectId);
    return row ? screeningCriteriaOut(row) : emptyScreeningCriteria(projectId);
  }

  async upsertScreeningCriteria(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const includeKeywords = stringArray(body.include_keywords);
    const excludeKeywords = stringArray(body.exclude_keywords);
    const methods = stringArray(body.methods);
    const venues = stringArray(body.venues);
    const requiredEvidenceFields = stringArray(body.required_evidence_fields);
    const dateRangeStart = optionalString(body.date_range_start);
    const dateRangeEnd = optionalString(body.date_range_end);
    if (dateRangeStart && dateRangeEnd && dateRangeStart > dateRangeEnd) {
      throw new HttpError(422, "date_range_start must be before date_range_end");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO project_research_screening_criteria (
         id, space_id, project_id, include_keywords_json, exclude_keywords_json, methods_json,
         date_range_start, date_range_end, venues_json, required_evidence_fields_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11, $11)
       ON CONFLICT (space_id, project_id)
       DO UPDATE SET include_keywords_json = EXCLUDED.include_keywords_json,
                     exclude_keywords_json = EXCLUDED.exclude_keywords_json,
                     methods_json = EXCLUDED.methods_json,
                     date_range_start = EXCLUDED.date_range_start,
                     date_range_end = EXCLUDED.date_range_end,
                     venues_json = EXCLUDED.venues_json,
                     required_evidence_fields_json = EXCLUDED.required_evidence_fields_json,
                     updated_at = EXCLUDED.updated_at`,
      [
        id,
        identity.spaceId,
        projectId,
        JSON.stringify(includeKeywords),
        JSON.stringify(excludeKeywords),
        JSON.stringify(methods),
        dateRangeStart,
        dateRangeEnd,
        JSON.stringify(venues),
        JSON.stringify(requiredEvidenceFields),
        now,
      ],
    );
    const row = await this.screeningCriteriaRow(identity.spaceId, projectId);
    if (!row) throw new HttpError(500, "Failed to upsert screening criteria");
    return screeningCriteriaOut(row);
  }

  private async screeningCriteriaRow(spaceId: string, projectId: string): Promise<ScreeningCriteriaRow | null> {
    const result = await this.db.query<ScreeningCriteriaRow>(
      `SELECT id, project_id, include_keywords_json, exclude_keywords_json, methods_json,
              date_range_start, date_range_end, venues_json, required_evidence_fields_json,
              created_at, updated_at
         FROM project_research_screening_criteria
        WHERE space_id = $1 AND project_id = $2 LIMIT 1`,
      [spaceId, projectId],
    );
    return result.rows[0] ?? null;
  }
}

interface ScreeningCriteriaRow {
  id: string;
  project_id: string;
  include_keywords_json: unknown;
  exclude_keywords_json: unknown;
  methods_json: unknown;
  date_range_start: unknown;
  date_range_end: unknown;
  venues_json: unknown;
  required_evidence_fields_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function screeningCriteriaOut(row: ScreeningCriteriaRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    include_keywords: jsonStringArray(row.include_keywords_json),
    exclude_keywords: jsonStringArray(row.exclude_keywords_json),
    methods: jsonStringArray(row.methods_json),
    date_range_start: dateIso(row.date_range_start),
    date_range_end: dateIso(row.date_range_end),
    venues: jsonStringArray(row.venues_json),
    required_evidence_fields: jsonStringArray(row.required_evidence_fields_json),
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

function emptyScreeningCriteria(projectId: string): Record<string, unknown> {
  return {
    id: null,
    project_id: projectId,
    include_keywords: [],
    exclude_keywords: [],
    methods: [],
    date_range_start: null,
    date_range_end: null,
    venues: [],
    required_evidence_fields: [],
    created_at: null,
    updated_at: null,
  };
}
