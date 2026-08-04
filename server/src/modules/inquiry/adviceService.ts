import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import {
  HttpError,
  optionalString,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { assertProjectReadable, assertProjectWriter } from "../projects/access";
import { resolvePrompt } from "../prompts/resolver";
import { resolveProviderCommandStore } from "../providers/commands/store";
import { completeProviderMessages } from "../providers/invocation/invocation";
import { providerSupportsStructuredOutput } from "../providers/structuredOutputCapabilities";
import { NEXT_FOCUS_KINDS, type NextFocusKind } from "./threadService";

export const INQUIRY_NEXT_STEP_ADVICE_PROMPT_KEY = "inquiry.next_step_advice";

/** Explicit request, or the domain event that made earlier advice worth replacing. */
export const ADVICE_TRIGGER_KINDS = [
  "user_request",
  "iteration_recorded",
  "candidate_created",
  "search_completed",
] as const;
export type AdviceTriggerKind = (typeof ADVICE_TRIGGER_KINDS)[number];

export const INQUIRY_ADVICE_OUTPUT_CONTRACT = {
  type: "json_schema" as const,
  schema_id: "inquiry.next_step_advice.v1",
  strict: true as const,
  stage: "question_refinement" as const,
  schema: {
    type: "object",
    properties: {
      recommended_focus_kind: { type: "string", enum: [...NEXT_FOCUS_KINDS] },
      rationale: { type: "string", minLength: 1 },
      cited_refs: { type: "array", maxItems: 10, items: { type: "string", minLength: 1 } },
    },
    required: ["recommended_focus_kind", "rationale", "cited_refs"],
    additionalProperties: false,
  },
};

export interface InquiryThreadAdvice {
  id: string;
  project_id: string;
  thread_id: string;
  recommended_focus_kind: NextFocusKind;
  rationale: string;
  cited_refs: string[];
  thread_version: number;
  status: "open" | "adopted" | "dismissed";
  trigger_kind: string;
  model_version: string | null;
  /** True once the Thread has moved past the revision this advice reasoned about. */
  stale: boolean;
  created_at: string;
  updated_at: string;
}

interface AdviceRow {
  id: string;
  project_id: string;
  thread_id: string;
  recommended_focus_kind: string;
  rationale: string;
  cited_refs_json: unknown;
  thread_version: number;
  status: string;
  trigger_kind: string;
  model_version: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  current_thread_version: number;
}

interface ThreadContextRow {
  id: string;
  kind: string;
  statement: string;
  version: number;
  lifecycle_status: string;
  next_focus_kind: string | null;
  answer_state: string | null;
  current_answer_summary: string | null;
  evaluation_state: string | null;
  confidence: number | null;
}

type InvokeAdvice = (input: {
  spaceId: string;
  userId: string;
  projectId: string;
  providerId: string;
  model: string | null;
  system: string;
}) => Promise<Record<string, unknown>>;

/**
 * Model-generated advice about a Thread's next step.
 *
 * The recommendation is never applied on its own: adopting it goes through the
 * ordinary work-state command, so the Next Focus invariant and its work-event
 * audit trail keep exactly one enforcement point. This service only produces,
 * stores, and retires suggestions.
 */
export class InquiryAdviceService {
  private readonly invoke: InvokeAdvice;

  constructor(
    private readonly db: Queryable,
    config: ServerConfig,
    invoke?: InvokeAdvice,
  ) {
    this.invoke = invoke ?? (async (input) => {
      const response = await completeProviderMessages(resolveProviderCommandStore(config), input.spaceId, {
        provider_id: input.providerId,
        model: input.model,
        system: input.system,
        messages: [{ role: "user", content: "Recommend this Thread's next step." }],
        task: "inquiry_next_step_advice",
        output_format: INQUIRY_ADVICE_OUTPUT_CONTRACT,
        metering: {
          subject_user_id: input.userId,
          source_type: "local_run",
          execution_channel: "managed_api",
          project_id: input.projectId,
          task: "inquiry_next_step_advice",
        },
      });
      if (!response.structured_output) throw new HttpError(502, "Inquiry advice provider returned no structured output");
      return response.structured_output;
    });
  }

  static fromConfig(config: ServerConfig): InquiryAdviceService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new InquiryAdviceService(getDbPool(config.databaseUrl), config);
  }

  async getAdvice(identity: SpaceUserIdentity, projectId: string, threadId: string): Promise<InquiryThreadAdvice | null> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.db.query<AdviceRow>(
      `SELECT a.*, t.version AS current_thread_version
         FROM inquiry_thread_advice a
         JOIN inquiry_threads t ON t.id = a.thread_id AND t.space_id = a.space_id
        WHERE a.space_id = $1 AND a.project_id = $2 AND a.thread_id = $3`,
      [identity.spaceId, projectId, threadId],
    );
    return row.rows[0] ? mapAdvice(row.rows[0]) : null;
  }

  async dismissAdvice(identity: SpaceUserIdentity, projectId: string, threadId: string): Promise<InquiryThreadAdvice> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.db.query<AdviceRow>(
      `UPDATE inquiry_thread_advice a
          SET status = 'dismissed', updated_at = $4
         FROM inquiry_threads t
        WHERE a.thread_id = t.id AND t.space_id = a.space_id
          AND a.space_id = $1 AND a.project_id = $2 AND a.thread_id = $3
      RETURNING a.*, t.version AS current_thread_version`,
      [identity.spaceId, projectId, threadId, new Date().toISOString()],
    );
    if (!row.rows[0]) throw new HttpError(404, "No advice to dismiss for this Thread");
    return mapAdvice(row.rows[0]);
  }

  /**
   * Marks the advice as adopted. The caller is responsible for having applied
   * the Next Focus through the work-state command — this only records that the
   * suggestion was taken, so a later regeneration knows it is not still open.
   */
  async markAdopted(identity: SpaceUserIdentity, projectId: string, threadId: string): Promise<void> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await this.db.query(
      `UPDATE inquiry_thread_advice SET status = 'adopted', updated_at = $4
        WHERE space_id = $1 AND project_id = $2 AND thread_id = $3 AND status = 'open'`,
      [identity.spaceId, projectId, threadId, new Date().toISOString()],
    );
  }

  async generateAdvice(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    triggerKind: AdviceTriggerKind,
  ): Promise<InquiryThreadAdvice> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const thread = await this.loadThreadContext(identity, projectId, threadId);
    if (thread.lifecycle_status !== "active") {
      throw new HttpError(422, "Advice is only generated for active Threads");
    }

    const provider = await this.defaultProvider(identity.spaceId);
    if (!provider) {
      throw new HttpError(422, "Configure a space model provider before generating Inquiry advice");
    }
    const system = await this.buildPrompt(identity, projectId, thread);
    const output = await this.invoke({
      spaceId: identity.spaceId,
      userId: identity.userId,
      projectId,
      providerId: provider.id,
      model: provider.default_model,
      system,
    });

    const recommended = optionalString(output.recommended_focus_kind);
    if (!recommended || !NEXT_FOCUS_KINDS.includes(recommended as NextFocusKind)) {
      throw new HttpError(502, `Advice returned an unknown next step: ${recommended ?? "none"}`);
    }
    const rationale = optionalString(output.rationale);
    if (!rationale) throw new HttpError(502, "Advice returned no rationale");

    const now = new Date().toISOString();
    // One row per Thread: new advice replaces the previous suggestion rather
    // than accumulating a queue of stale recommendations to triage.
    const row = await this.db.query<AdviceRow>(
      `INSERT INTO inquiry_thread_advice
         (id, space_id, project_id, thread_id, recommended_focus_kind, rationale, cited_refs_json,
          thread_version, status, trigger_kind, model_version, generated_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'open', $9, $10, $11, $12, $12)
       ON CONFLICT (thread_id) DO UPDATE SET
         recommended_focus_kind = EXCLUDED.recommended_focus_kind,
         rationale = EXCLUDED.rationale,
         cited_refs_json = EXCLUDED.cited_refs_json,
         thread_version = EXCLUDED.thread_version,
         status = 'open',
         trigger_kind = EXCLUDED.trigger_kind,
         model_version = EXCLUDED.model_version,
         generated_by_user_id = EXCLUDED.generated_by_user_id,
         updated_at = EXCLUDED.updated_at
       RETURNING *, (
         SELECT t.version FROM inquiry_threads t
          WHERE t.id = inquiry_thread_advice.thread_id AND t.space_id = inquiry_thread_advice.space_id
       ) AS current_thread_version`,
      [
        randomUUID(), identity.spaceId, projectId, threadId,
        recommended, rationale.slice(0, 4000), JSON.stringify(citedRefs(output.cited_refs)),
        thread.version, triggerKind, optionalString(output.model_version), identity.userId, now,
      ],
    );
    return mapAdvice(row.rows[0]!);
  }

  /**
   * Advice has no provider selection of its own — it follows the space
   * default. A `task` policy chain for `inquiry_next_step_advice` still takes
   * precedence at invocation time; this only supplies the safety net.
   */
  private async defaultProvider(spaceId: string): Promise<{ id: string; default_model: string | null } | null> {
    const result = await this.db.query<{ id: string; provider_type: string; default_model: string | null }>(
      `SELECT p.id, p.provider_type, p.default_model
         FROM model_provider_space_grants g
         JOIN model_providers p ON p.id = g.provider_id
        WHERE g.space_id = $1 AND g.enabled = true AND p.enabled = true
        ORDER BY g.is_default DESC, p.updated_at DESC, p.id ASC
        LIMIT 1`,
      [spaceId],
    );
    const provider = result.rows[0];
    if (!provider) return null;
    // Advice is a schema-constrained response. Saying so here beats a 502 from
    // deep inside the provider call when the space default cannot do it.
    if (!providerSupportsStructuredOutput(provider.provider_type)) {
      throw new HttpError(422, `The space default model provider type '${provider.provider_type}' does not support structured output, which Inquiry advice requires`);
    }
    return provider;
  }

  private async loadThreadContext(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
  ): Promise<ThreadContextRow> {
    const row = await this.db.query<ThreadContextRow>(
      `SELECT t.id, t.kind, t.statement, t.version, t.lifecycle_status, t.next_focus_kind,
              q.answer_state, q.current_answer_summary,
              h.evaluation_state, h.confidence
         FROM inquiry_threads t
         LEFT JOIN inquiry_question_states q ON q.thread_id = t.id
         LEFT JOIN inquiry_hypothesis_states h ON h.thread_id = t.id
        WHERE t.id = $1 AND t.space_id = $2 AND t.project_id = $3`,
      [threadId, identity.spaceId, projectId],
    );
    if (!row.rows[0]) throw new HttpError(404, "Thread not found");
    return row.rows[0];
  }

  private async buildPrompt(
    identity: SpaceUserIdentity,
    projectId: string,
    thread: ThreadContextRow,
  ): Promise<string> {
    const [iterations, signals, pending, running] = await Promise.all([
      this.db.query<{ id: string; change_summary: string; created_at: Date | string }>(
        `SELECT id, change_summary, created_at FROM inquiry_iterations
          WHERE thread_id = $1 AND space_id = $2 ORDER BY created_at DESC LIMIT 5`,
        [thread.id, identity.spaceId],
      ),
      this.db.query<{ id: string; classification: string; total: string }>(
        `SELECT MIN(id) AS id, classification, COUNT(*)::text AS total
           FROM inquiry_evidence_signals
          WHERE thread_id = $1 AND space_id = $2
          GROUP BY classification`,
        [thread.id, identity.spaceId],
      ),
      this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM inquiry_signal_candidates
          WHERE thread_id = $1 AND space_id = $2 AND status = 'pending'`,
        [thread.id, identity.spaceId],
      ),
      this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM project_research_workflows
          WHERE primary_thread_id = $1 AND space_id = $2
            AND status NOT IN ('not_started', 'completed', 'archived')`,
        [thread.id, identity.spaceId],
      ),
    ]);

    const position = thread.kind === "question"
      ? `answer_state=${thread.answer_state ?? "open"}; ${thread.current_answer_summary ?? "no answer recorded"}`
      : `evaluation_state=${thread.evaluation_state ?? "untested"}; confidence=${thread.confidence ?? "unset"}`;

    const resolved = await resolvePrompt(this.db, {
      spaceId: identity.spaceId,
      userId: identity.userId,
      projectId,
      assetKey: INQUIRY_NEXT_STEP_ADVICE_PROMPT_KEY,
      variables: {
        thread_kind: thread.kind,
        thread_statement: thread.statement,
        thread_position: position,
        current_next_focus: thread.next_focus_kind ?? "none",
        search_running: Number(running.rows[0]?.total ?? "0") > 0 ? "yes" : "no",
        pending_candidate_count: pending.rows[0]?.total ?? "0",
        recent_iterations: iterations.rows.length === 0
          ? "none"
          : [...iterations.rows].reverse()
            .map((row) => `- ${row.id}: ${row.change_summary}`).join("\n"),
        evidence_summary: signals.rows.length === 0
          ? "none"
          : signals.rows.map((row) => `- ${row.classification}: ${row.total} signal(s), e.g. ${row.id}`).join("\n"),
      },
    });
    if (resolved.validation_errors.length > 0 || !resolved.rendered_text) {
      throw new HttpError(500, "Inquiry next-step advice prompt is not resolvable");
    }
    return resolved.rendered_text;
  }
}

function citedRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 10);
}

function mapAdvice(row: AdviceRow): InquiryThreadAdvice {
  return {
    id: row.id,
    project_id: row.project_id,
    thread_id: row.thread_id,
    recommended_focus_kind: row.recommended_focus_kind as NextFocusKind,
    rationale: row.rationale,
    cited_refs: citedRefs(row.cited_refs_json),
    thread_version: row.thread_version,
    status: row.status as InquiryThreadAdvice["status"],
    trigger_kind: row.trigger_kind,
    model_version: row.model_version,
    stale: row.current_thread_version > row.thread_version,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
