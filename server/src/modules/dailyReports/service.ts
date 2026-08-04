import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import { resolveProviderCommandStore } from "../providers/commands/store";
import { completeProviderText } from "../providers/invocation/invocation";
import type { Queryable } from "../routeUtils/common";
import { insertProposalRow } from "../proposals/reviewPackets";
import { contentOwnerFilterSql, contentReadSql } from "../access/contentAccessSql";
import {
  assertValidLocalDate,
  assertValidTimezone,
  computeInitialNextRunAt,
  localDayUtcBounds,
  PgDailyReportSettingsRepository,
} from "./repository";

export interface DailyReportResult {
  run_id: string;
  artifact_id: string | null;
  proposal_ids: string[];
  experience_proposal_ids: string[];
  memory_proposal_ids: string[];
  capture_count: number;
  status: string;
  summary_preview: string;
  skipped?: boolean;
  existing_artifact_id?: string | null;
}

interface SettingRow {
  id: string;
  space_id: string;
  user_id: string;
  enabled: boolean;
  local_time: string;
  timezone: string;
  include_source_types_json: unknown;
  create_experience_proposals: boolean;
  create_memory_proposals: boolean;
  experience_confidence_threshold: number;
  memory_confidence_threshold: number;
  max_experience_proposals_per_day: number;
  max_memory_proposals_per_day: number;
}

interface ReportTheme {
  title: string;
  summary: string;
  source_activity_ids: string[];
}

interface ReportIdea {
  title: string;
  content: string;
  source_activity_ids: string[];
}

interface ReportDecision {
  title: string;
  content: string;
  source_activity_ids: string[];
}

interface ReportOpenQuestion {
  question: string;
  context: string;
  source_activity_ids: string[];
}

interface ExperienceCandidate {
  title: string;
  content: string;
  confidence: number;
  source_activity_ids: string[];
}

interface MemoryCandidate {
  title: string;
  content: string;
  memory_type: string;
  confidence: number;
  source_activity_ids: string[];
}

interface StructuredDailyReport {
  report_title: string;
  overview: string;
  themes: ReportTheme[];
  ideas: ReportIdea[];
  decisions: ReportDecision[];
  open_questions: ReportOpenQuestion[];
  experience_candidates: ExperienceCandidate[];
  memory_candidates: MemoryCandidate[];
}

const DEFAULT_MODEL_CONFIG = { model: "claude-sonnet-4-6" };
const DEFAULT_MEMORY_POLICY = {
  readable_scopes: ["system", "space", "user", "project_folder", "capability", "agent"],
  writable_scopes: ["agent"],
  readable_types: ["preference", "semantic", "episodic", "procedural", "project"],
};
const DEFAULT_RUNTIME_POLICY = {
  risk_level: "medium",
  max_run_time_seconds: 300,
  allowed_adapter_types: [
    "capability",
    "model_api",
    "claude_code",
    "codex_cli",
    "opencode",
    "gemini_cli",
  ],
  default_adapter_type: "model_api",
};
const DEFAULT_RUNTIME_CONFIG = {};
const VALID_MEMORY_TYPES = new Set(["semantic", "episodic", "preference", "procedural", "project"]);
const SERVICE_VERSION = "1";

export class DailyCaptureReportService {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  async generateForDate(input: {
    spaceId: string;
    userId: string;
    setting: SettingRow;
    localDate: string;
    triggerOrigin: string;
    force?: boolean;
    createExperienceProposalsOverride?: boolean | null;
    createMemoryProposalsOverride?: boolean | null;
  }): Promise<DailyReportResult> {
    assertValidLocalDate(input.localDate);
    assertValidTimezone(input.setting.timezone || "UTC");
    if (!input.force) {
      const existing = await this.findExistingArtifact(input.spaceId, input.userId, input.localDate);
      if (existing) {
        return {
          run_id: existing.run_id ?? "",
          artifact_id: existing.id,
          proposal_ids: [],
          experience_proposal_ids: [],
          memory_proposal_ids: [],
          capture_count: 0,
          status: "skipped",
          summary_preview: "Report already exists for this date.",
          skipped: true,
          existing_artifact_id: existing.id,
        };
      }
    }

    const captures = await this.selectCaptures(input);
    const captureIds = captures.map((row) => row.id);
    const agent = await this.ensureSystemAgent(input.spaceId);
    const runId = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, source,
         mode, status, instructed_by_user_id, prompt, started_at, created_at, updated_at,
         owner_user_id, visibility, access_level, required_sandbox_level
       ) VALUES (
         $1, $2, $3, $4, 'reflection', $5, 'managed',
         'live', 'running', $6, $7, $8, $8, $8,
         $6, 'space_shared', 'full', 'none'
       )`,
      [
        runId,
        input.spaceId,
        agent.agentId,
        agent.versionId,
        input.triggerOrigin,
        input.userId,
        `Generate Daily Capture Report for ${input.localDate} from ${captures.length} capture(s).`,
        now,
      ],
    );

    if (captures.length === 0) {
      await this.db.query(
        `UPDATE runs SET status = 'succeeded', ended_at = $2, updated_at = $2 WHERE id = $1`,
        [runId, now],
      );
      return {
        run_id: runId,
        artifact_id: null,
        proposal_ids: [],
        experience_proposal_ids: [],
        memory_proposal_ids: [],
        capture_count: 0,
        status: "skipped",
        summary_preview: "No user_capture records found for this day.",
        skipped: true,
      };
    }

    const store = resolveProviderCommandStore(this.config);
    const contentBlocks = captures
      .map((cap) => {
        const text = (cap.content ?? "").trim();
        if (!text) return null;
        const label = cap.title || `Capture ${cap.id.slice(0, 8)}`;
        return `--- ${label} ---\n${text}`;
      })
      .filter((value): value is string => Boolean(value));
    const bounded = contentBlocks.join("\n\n").slice(0, 10_000);
    const systemPrompt =
      "You are a reflective journal assistant. Return ONLY valid JSON with keys: " +
      "report_title, overview, themes, ideas, decisions, open_questions, " +
      "experience_candidates, memory_candidates.";
    const userPrompt =
      `Date: ${input.localDate}\nActivity IDs:\n${captureIds.map((id) => `  - ${id}`).join("\n")}\n\n` +
      `Captures:\n\n${bounded}\n\nGenerate the daily capture report JSON:`;

    let rawJson: string;
    try {
      const completion = await completeProviderText(store, input.spaceId, {
        provider_id: "",
        model: null,
        system: systemPrompt,
        user: userPrompt,
        task: "daily_report",
        metering: {
          source_resource_type: "run",
          source_resource_id: runId,
          run_id: runId,
        },
      });
      rawJson = completion.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.query(
        `UPDATE runs SET status = 'failed', error_message = $2, ended_at = $3, updated_at = $3 WHERE id = $1`,
        [runId, message.slice(0, 1000), new Date().toISOString()],
      );
      return {
        run_id: runId,
        artifact_id: null,
        proposal_ids: [],
        experience_proposal_ids: [],
        memory_proposal_ids: [],
        capture_count: captures.length,
        status: "failed",
        summary_preview: `Provider call failed: ${message}`,
      };
    }

    let report: StructuredDailyReport;
    try {
      report = parseStructuredReport(rawJson);
    } catch {
      await this.db.query(
        `UPDATE runs SET status = 'failed', error_message = 'Invalid LLM JSON', ended_at = $2, updated_at = $2 WHERE id = $1`,
        [runId, new Date().toISOString()],
      );
      return {
        run_id: runId,
        artifact_id: null,
        proposal_ids: [],
        experience_proposal_ids: [],
        memory_proposal_ids: [],
        capture_count: captures.length,
        status: "failed",
        summary_preview: "Invalid structured report from LLM.",
      };
    }

    const persisted = await this.persistSuccessfulReport({
      input,
      report,
      captureIds,
      captureCount: captures.length,
      runId,
    });

    return {
      run_id: runId,
      artifact_id: persisted.artifactId,
      proposal_ids: persisted.proposalIds,
      experience_proposal_ids: persisted.experienceProposalIds,
      memory_proposal_ids: persisted.memoryProposalIds,
      capture_count: captures.length,
      status: "succeeded",
      summary_preview: persisted.summaryPreview,
    };
  }

  private async persistSuccessfulReport(args: {
    input: {
      spaceId: string;
      userId: string;
      setting: SettingRow;
      localDate: string;
      createExperienceProposalsOverride?: boolean | null;
      createMemoryProposalsOverride?: boolean | null;
    };
    report: StructuredDailyReport;
    captureIds: string[];
    captureCount: number;
    runId: string;
  }): Promise<{
    artifactId: string;
    proposalIds: string[];
    experienceProposalIds: string[];
    memoryProposalIds: string[];
    summaryPreview: string;
  }> {
    const persist = async (db: Queryable) => this.persistSuccessfulReportWithDb(db, args);
    if (!this.config.databaseUrl) return persist(this.db);
    return withTransaction(getDbPool(this.config.databaseUrl), persist);
  }

  private async persistSuccessfulReportWithDb(
    db: Queryable,
    args: {
      input: {
        spaceId: string;
        userId: string;
        setting: SettingRow;
        localDate: string;
        createExperienceProposalsOverride?: boolean | null;
        createMemoryProposalsOverride?: boolean | null;
      };
      report: StructuredDailyReport;
      captureIds: string[];
      captureCount: number;
      runId: string;
    },
  ): Promise<{
    artifactId: string;
    proposalIds: string[];
    experienceProposalIds: string[];
    memoryProposalIds: string[];
    summaryPreview: string;
  }> {
    const { input, report, captureIds, captureCount, runId } = args;
    const markdown = renderMarkdown(report, input.localDate);
    const artifactId = randomUUID();
    const endedAt = new Date().toISOString();
    const bounds = localDayUtcBounds(input.localDate, input.setting.timezone);
    await db.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, artifact_type, title, content, mime_type,
         exportable, export_formats_json, preview, owner_user_id, metadata_json,
         relevant_period_start, relevant_period_end, created_at, updated_at,
         visibility, trust_level
       ) VALUES (
         $1, $2, $3, 'daily_capture_report', $4, $5, 'text/markdown',
         true, '[]'::jsonb, false, $6, $7::jsonb,
         $8, $9, $10, $10,
         'space_shared', 'medium'
       )`,
      [
        artifactId,
        input.spaceId,
        runId,
        `Daily Capture Report — ${input.localDate}`,
        markdown,
        input.userId,
        JSON.stringify({
          report_type: "daily_capture_report",
          report_date: input.localDate,
          timezone: input.setting.timezone,
          source_activity_ids: captureIds,
          capture_count: captureCount,
          structured_report: report,
          service_version: SERVICE_VERSION,
          setting_id: input.setting.id,
        }),
        bounds.startUtcIso,
        bounds.endUtcIso,
        endedAt,
      ],
    );

    const experienceProposalIds: string[] = [];
    const createExperienceProposals =
      input.createExperienceProposalsOverride ?? input.setting.create_experience_proposals;
    if (createExperienceProposals) {
      for (const candidate of report.experience_candidates.slice(
        0,
        input.setting.max_experience_proposals_per_day,
      )) {
        const id = await this.insertExperienceProposal(
          db,
          input,
          candidate,
          captureIds,
          artifactId,
          runId,
        );
        if (id) experienceProposalIds.push(id);
      }
    }
    const memoryProposalIds: string[] = [];
    const createMemoryProposals =
      input.createMemoryProposalsOverride ?? input.setting.create_memory_proposals;
    if (createMemoryProposals) {
      for (const candidate of report.memory_candidates.slice(
        0,
        input.setting.max_memory_proposals_per_day,
      )) {
        const id = await this.insertMemoryProposal(
          db,
          input,
          candidate,
          captureIds,
          artifactId,
          runId,
        );
        if (id) memoryProposalIds.push(id);
      }
    }
    const proposalIds = [...experienceProposalIds, ...memoryProposalIds];

    await db.query(
      `UPDATE runs SET status = 'succeeded', ended_at = $2, updated_at = $2 WHERE id = $1`,
      [runId, endedAt],
    );
    const nextRunAt = computeInitialNextRunAt(input.setting, new Date(endedAt));
    await new PgDailyReportSettingsRepository(db).recordReportCompleted(
      input.spaceId,
      input.userId,
      input.localDate,
      nextRunAt,
      endedAt,
    );

    return {
      artifactId,
      proposalIds,
      experienceProposalIds,
      memoryProposalIds,
      summaryPreview: report.overview.slice(0, 500),
    };
  }

  private async findExistingArtifact(
    spaceId: string,
    userId: string,
    localDate: string,
  ): Promise<{ id: string; run_id: string | null } | null> {
    const result = await this.db.query<{ id: string; run_id: string | null }>(
      `SELECT id, run_id
         FROM artifacts a
        WHERE a.space_id = $1
          AND ${contentReadSql("artifact", "a", "$2")}
          AND ${contentOwnerFilterSql("artifact", "a", "$2")}
          AND a.artifact_type = 'daily_capture_report'
          AND a.metadata_json->>'report_date' = $3
        ORDER BY a.created_at DESC
        LIMIT 1`,
      [spaceId, userId, localDate],
    );
    return result.rows[0] ?? null;
  }

  private async selectCaptures(input: {
    spaceId: string;
    userId: string;
    setting: SettingRow;
    localDate: string;
  }): Promise<Array<{ id: string; title: string | null; content: string | null }>> {
    const sourceTypes = Array.isArray(input.setting.include_source_types_json)
      ? input.setting.include_source_types_json.map(String)
      : ["user_capture"];
    const bounds = localDayUtcBounds(input.localDate, input.setting.timezone);
    const result = await this.db.query<{ id: string; title: string | null; content: string | null }>(
      `SELECT id, title, content
         FROM activity_records ar
        WHERE ar.space_id = $1
          AND ${contentReadSql("activity", "ar", "$2")}
          AND ${contentOwnerFilterSql("activity", "ar", "$2")}
          AND ar.activity_type = ANY($3::text[])
          AND ar.status <> 'archived'
          AND ar.occurred_at >= $4
          AND ar.occurred_at < $5
        ORDER BY ar.occurred_at ASC`,
      [input.spaceId, input.userId, sourceTypes, bounds.startUtcIso, bounds.endUtcIso],
    );
    return result.rows;
  }

  private async ensureSystemAgent(spaceId: string): Promise<{ agentId: string; versionId: string }> {
    const existing = await this.db.query<{ id: string; current_version_id: string | null }>(
      `SELECT id, current_version_id FROM agents WHERE space_id = $1 AND name = 'daily-capture-reporter' LIMIT 1`,
      [spaceId],
    );
    if (existing.rows[0]?.current_version_id) {
      return { agentId: existing.rows[0].id, versionId: existing.rows[0].current_version_id };
    }
    const existingAgentId = existing.rows[0]?.id ?? null;
    if (existingAgentId) {
      const version = await this.db.query<{ id: string }>(
        `SELECT id FROM agent_versions WHERE space_id = $1 AND agent_id = $2 ORDER BY created_at ASC LIMIT 1`,
        [spaceId, existingAgentId],
      );
      if (version.rows[0]) {
        await this.db.query(
          `UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
          [spaceId, existingAgentId, version.rows[0].id, new Date().toISOString()],
        );
        return { agentId: existingAgentId, versionId: version.rows[0].id };
      }
    }
    const agentId = existingAgentId ?? randomUUID();
    const versionId = randomUUID();
    const now = new Date().toISOString();
    if (!existingAgentId) {
      await this.db.query(
        `INSERT INTO agents (
           id, space_id, name, description, status, agent_kind, visibility, created_at, updated_at
         ) VALUES (
           $1, $2, 'daily-capture-reporter',
           'System agent for daily capture report generation.',
           'active', 'standard', 'private', $3, $3
         )`,
        [agentId, spaceId, now],
      );
    }
    await this.db.query(
      `INSERT INTO agent_versions (
         id, agent_id, space_id, version_label, model_config_json, runtime_config_json,
         context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json,
         runtime_policy_json, created_at
       ) VALUES (
         $1, $2, $3, 'v1', $4::jsonb, $5::jsonb,
         '{}'::jsonb, $6::jsonb, '[]'::jsonb, '{}'::jsonb,
         $7::jsonb, $8
       )`,
      [
        versionId,
        agentId,
        spaceId,
        JSON.stringify(DEFAULT_MODEL_CONFIG),
        JSON.stringify(DEFAULT_RUNTIME_CONFIG),
        JSON.stringify(DEFAULT_MEMORY_POLICY),
        JSON.stringify(DEFAULT_RUNTIME_POLICY),
        now,
      ],
    );
    await this.db.query(
      `UPDATE agents SET current_version_id = $2, updated_at = $3 WHERE id = $1`,
      [agentId, versionId, now],
    );
    return { agentId, versionId };
  }

  private async insertExperienceProposal(
    db: Queryable,
    input: { spaceId: string; userId: string; setting: SettingRow },
    candidate: ExperienceCandidate,
    validIds: string[],
    artifactId: string,
    runId: string,
  ): Promise<string | null> {
    const confidence = candidate.confidence;
    if (!Number.isFinite(confidence) || confidence < input.setting.experience_confidence_threshold) return null;
    const rawSourceIds = candidate.source_activity_ids;
    const sourceIds = rawSourceIds.filter((id) => validIds.includes(id));
    if (sourceIds.length === 0 || sourceIds.length !== rawSourceIds.length) return null;
    const row = await insertProposalRow(db, {
      spaceId: input.spaceId,
      proposalType: "knowledge_create",
      title: candidate.title,
      rationale: "Daily capture report experience candidate",
      payload: {
        operation: "create",
        knowledge_kind: "summary",
        title: candidate.title,
        content: candidate.content,
        content_format: "markdown",
        visibility: "space_shared",
        owner_user_id: input.userId,
        tags: ["daily-capture-report"],
        confidence,
        source_refs: sourceIds.map((id) => ({
          source_type: "activity",
          source_id: id,
          source_trust: "user_confirmed",
        })),
        source_artifact_id: artifactId,
        source_run_id: runId,
        verification_status: "unverified",
        reflection_status: "unreviewed",
      },
      createdByUserId: input.userId,
      createdByRunId: runId,
      visibility: "space_shared",
      riskLevel: "low",
    });
    return row.id;
  }

  private async insertMemoryProposal(
    db: Queryable,
    input: { spaceId: string; userId: string; setting: SettingRow },
    candidate: MemoryCandidate,
    validIds: string[],
    artifactId: string,
    runId: string,
  ): Promise<string | null> {
    const confidence = candidate.confidence;
    if (!Number.isFinite(confidence) || confidence < input.setting.memory_confidence_threshold) return null;
    const memoryType = candidate.memory_type;
    if (!VALID_MEMORY_TYPES.has(memoryType)) return null;
    const rawSourceIds = candidate.source_activity_ids;
    const sourceIds = rawSourceIds.filter((id) => validIds.includes(id));
    if (sourceIds.length === 0 || sourceIds.length !== rawSourceIds.length) return null;
    const row = await insertProposalRow(db, {
      spaceId: input.spaceId,
      proposalType: "memory_create",
      title: candidate.title,
      rationale: `Memory candidate from Daily Capture Report. Confidence: ${confidence.toFixed(2)}.`,
      payload: {
        operation: "create",
        proposed_content: candidate.content,
        memory_type: memoryType,
        target_scope: "user",
        target_namespace: "user.default",
        target_visibility: "space_shared",
        owner_user_id: input.userId,
        provenance_entries: sourceIds.map((id) => ({
          source_type: "activity",
          source_id: id,
          source_trust: "user_confirmed",
        })),
        source_refs_metadata: {
          daily_report_artifact_id: artifactId,
          daily_report_run_id: runId,
        },
      },
      createdByUserId: input.userId,
      createdByRunId: runId,
      visibility: "space_shared",
      riskLevel: "low",
    });
    return row.id;
  }
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function parseStructuredReport(rawJson: string): StructuredDailyReport {
  const parsed = JSON.parse(extractJson(rawJson)) as unknown;
  const root = requiredObject(parsed, "report");
  return {
    report_title: requiredString(root.report_title, "report_title"),
    overview: requiredString(root.overview, "overview"),
    themes: optionalArray(root.themes, "themes").map((item, index) => {
      const row = requiredObject(item, `themes[${index}]`);
      return {
        title: requiredString(row.title, `themes[${index}].title`),
        summary: requiredString(row.summary, `themes[${index}].summary`),
        source_activity_ids: optionalStringArray(
          row.source_activity_ids,
          `themes[${index}].source_activity_ids`,
        ),
      };
    }),
    ideas: optionalArray(root.ideas, "ideas").map((item, index) => {
      const row = requiredObject(item, `ideas[${index}]`);
      return {
        title: requiredString(row.title, `ideas[${index}].title`),
        content: requiredString(row.content, `ideas[${index}].content`),
        source_activity_ids: optionalStringArray(
          row.source_activity_ids,
          `ideas[${index}].source_activity_ids`,
        ),
      };
    }),
    decisions: optionalArray(root.decisions, "decisions").map((item, index) => {
      const row = requiredObject(item, `decisions[${index}]`);
      return {
        title: requiredString(row.title, `decisions[${index}].title`),
        content: requiredString(row.content, `decisions[${index}].content`),
        source_activity_ids: optionalStringArray(
          row.source_activity_ids,
          `decisions[${index}].source_activity_ids`,
        ),
      };
    }),
    open_questions: optionalArray(root.open_questions, "open_questions").map((item, index) => {
      const row = requiredObject(item, `open_questions[${index}]`);
      return {
        question: requiredString(row.question, `open_questions[${index}].question`),
        context: requiredString(row.context, `open_questions[${index}].context`),
        source_activity_ids: optionalStringArray(
          row.source_activity_ids,
          `open_questions[${index}].source_activity_ids`,
        ),
      };
    }),
    experience_candidates: optionalArray(root.experience_candidates, "experience_candidates").map(
      (item, index) => {
        const row = requiredObject(item, `experience_candidates[${index}]`);
        return {
          title: requiredString(row.title, `experience_candidates[${index}].title`),
          content: requiredString(row.content, `experience_candidates[${index}].content`),
          confidence: requiredNumber(row.confidence, `experience_candidates[${index}].confidence`),
          source_activity_ids: optionalStringArray(
            row.source_activity_ids,
            `experience_candidates[${index}].source_activity_ids`,
          ),
        };
      },
    ),
    memory_candidates: optionalArray(root.memory_candidates, "memory_candidates").map((item, index) => {
      const row = requiredObject(item, `memory_candidates[${index}]`);
      return {
        title: requiredString(row.title, `memory_candidates[${index}].title`),
        content: requiredString(row.content, `memory_candidates[${index}].content`),
        memory_type: requiredString(row.memory_type, `memory_candidates[${index}].memory_type`),
        confidence: requiredNumber(row.confidence, `memory_candidates[${index}].confidence`),
        source_activity_ids: optionalStringArray(
          row.source_activity_ids,
          `memory_candidates[${index}].source_activity_ids`,
        ),
      };
    }),
  };
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function optionalArray(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function renderMarkdown(report: StructuredDailyReport, localDate: string): string {
  const title = report.report_title || "Daily Capture Report";
  const overview = report.overview;
  return [`# ${title}`, `*${localDate}*`, "", overview].join("\n");
}
