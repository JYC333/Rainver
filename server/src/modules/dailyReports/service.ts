import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { PgRunRepository } from "../runs/repository.js";
import { canonicalRunOutput } from "../runs/orchestrationResults.js";
import {
  BoundedProviderTaskError,
  runBoundedProviderTask,
} from "../runs/boundedProviderTaskRun.js";
import type { Queryable } from "../routeUtils/common.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import { contentOwnerFilterSql, contentReadSql } from "../access/contentAccessSql.js";
import { loadViewerSpaceRole } from "../retrieval/sourcePolicy.js";
import type { CredentialSpendBasis } from "../policy/credentialSpend.js";
import {
  assertValidLocalDate,
  assertValidTimezone,
  computeInitialNextRunAt,
  localDayUtcBounds,
  PgDailyReportSettingsRepository,
} from "./repository.js";

export interface DailyReportResult {
  run_id: string | null;
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

interface PersistedDailyReport {
  artifactId: string;
  proposalIds: string[];
  experienceProposalIds: string[];
  memoryProposalIds: string[];
  summaryPreview: string;
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

const VALID_MEMORY_TYPES = new Set(["semantic", "episodic", "preference", "procedural", "project"]);
const SERVICE_VERSION = "1";

/**
 * A report someone asked for now spends as them. A scheduled one spends on
 * their daily-report setting, re-read at spend time: switched off, or its
 * person no longer a member of the Space, it spends nothing.
 */
export function dailyReportSpend(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    setting: { id: string };
    triggerOrigin: string;
  },
): CredentialSpendBasis {
  if (input.triggerOrigin === "manual") return { kind: "person", user_id: input.userId };
  return {
    kind: "setup",
    setup: "daily_report",
    record_id: input.setting.id,
    user_id: input.userId,
    still_authorized: async () => {
      const setting = await new PgDailyReportSettingsRepository(db).getById(input.spaceId, input.setting.id);
      return setting?.enabled === true
        && setting.user_id === input.userId
        && (await loadViewerSpaceRole(db, input.spaceId, input.userId)) !== null;
    },
  };
}

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
          run_id: existing.run_id,
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
    if (captures.length === 0) {
      return {
        run_id: null,
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

    // One Run for this report, whatever the key pool does behind it. It used
    // to be one Run per provider attempt, each failed on the spot, so a report
    // that succeeded on the second key left a failed Run beside it claiming
    // the same work.
    const persisted: { value: PersistedDailyReport | null } = { value: null };
    const task = await runBoundedProviderTask(this.db, this.config, {
      completion: "text",
      spaceId: input.spaceId,
      userId: input.userId,
      task: "daily_report",
      providerId: "",
      model: null,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      prompt: `Generate Daily Capture Report for ${input.localDate} from ${captures.length} capture(s).`,
      runType: "reflection",
      triggerOrigin: input.triggerOrigin,
      contractSnapshot: {
        source: { kind: "direct", id: input.setting.id },
        route_hints_json: {
          owner_domain: "dailyReports",
          report_date: input.localDate,
          setting_id: input.setting.id,
          capture_count: captures.length,
        },
      },
      spend: dailyReportSpend(this.db, input),
      // Parsing and persistence are part of the bounded task, not of what
      // happens after it: the Run is marked succeeded by the same transaction
      // that writes the artifact and proposals, so a terminal Daily Report Run
      // always has a report behind it.
      finalize: async (completion, runId) => {
        let report: StructuredDailyReport;
        try {
          report = parseStructuredReport(completion.text);
        } catch {
          throw new BoundedProviderTaskError(
            "invalid_daily_report_json",
            "Provider response did not match the Daily Capture Report structure.",
          );
        }
        try {
          persisted.value = await this.persistSuccessfulReport({
            input,
            report,
            captureIds,
            captureCount: captures.length,
            runId,
          });
        } catch (error) {
          throw new BoundedProviderTaskError(
            "daily_report_persistence_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return null;
      },
    });

    const report = persisted.value;
    if (!task.ok || !report) {
      return {
        run_id: task.runId,
        artifact_id: null,
        proposal_ids: [],
        experience_proposal_ids: [],
        memory_proposal_ids: [],
        capture_count: captures.length,
        status: "failed",
        summary_preview: task.ok
          ? "Daily report produced no persisted report."
          : dailyReportFailureSummary(task.errorCode, task.error),
      };
    }
    return {
      run_id: task.runId,
      artifact_id: report.artifactId,
      proposal_ids: report.proposalIds,
      experience_proposal_ids: report.experienceProposalIds,
      memory_proposal_ids: report.memoryProposalIds,
      capture_count: captures.length,
      status: "succeeded",
      summary_preview: report.summaryPreview,
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

    await new PgRunRepository(db).markRunTerminal({
      run_id: runId,
      space_id: input.spaceId,
      status: "succeeded",
      output_json: canonicalRunOutput({
        success: true,
        outputText: report.overview,
        outputJson: {
          artifact_id: artifactId,
          proposal_ids: proposalIds,
          capture_count: captureCount,
        },
      }),
      completed_at: endedAt,
    });
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

/** What the person sees for a Daily Report that did not finish. */
function dailyReportFailureSummary(code: string, message: string): string {
  if (code === "invalid_daily_report_json") return "Invalid structured report from LLM.";
  if (code === "daily_report_persistence_failed") return `Daily report persistence failed: ${message}`;
  return `Provider call failed: ${message}`;
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
