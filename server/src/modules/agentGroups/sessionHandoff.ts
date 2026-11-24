import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { inheritContentAccessGrants } from "../access/contentAccessInheritance.js";
import { contentReadSql, roomRunReadAccessSql } from "../access/contentAccessSql.js";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import { resolvePrompt } from "../prompts/resolver.js";
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import { estimateModelTokens, fitTextToTokenBudget } from "../usage/modelCatalog.js";
import { modelSpec } from "../providers/modelSpecs.js";
import type { HostThread } from "../hosts/threadRepository.js";

/**
 * Conversation summary and restart.
 *
 * A Conversation × Agent vendor session is the Agent's working memory, and
 * the runtime compacts it on its own terms; Rainver does not rotate it by
 * occupancy. What a person can do is ask the Agent for a **summary**: one
 * turn into the current session whose only tool is `handoff.write`, whose
 * document is an Artifact on the Project, and after which the session
 * continues. They may then **restart** the Agent from that summary
 * (`RoomRosterService.restartFromSummary`): `stageHandoff` retains the
 * session and the next turn opens from the identity block, the summary and
 * the Room replay. Nothing here runs on its own.
 */
const AGENT_SUMMARY_PROMPT_KEY = "agent.conversation_summary";
const AGENT_HANDOFF_ARTIFACT_TYPE = "agent_handoff";
export const HANDOFF_TOOL_ALLOWANCE: readonly SystemActionId[] = ["handoff.write" as SystemActionId];
/** A summary is bounded to this share of the model's context window. */
const HANDOFF_WINDOW_SHARE = 0.04;
const HANDOFF_MIN_TOKENS = 1_000;

export function handoffBudgetTokens(contextWindowTokens: number): number {
  return Math.max(HANDOFF_MIN_TOKENS, Math.floor(contextWindowTokens * HANDOFF_WINDOW_SHARE));
}

/** What a handoff turn records on its Run, read back at execution and admission. */
interface HandoffTurn {
  thread_id: string;
  context_tokens: number;
  budget_tokens: number;
  /** Set by `RoomService.summarizeAgentContext`; a document older than that path lacks it. */
  manual_summary?: boolean;
}

export function handoffTurnOf(run: Pick<RunRecord, "model_override_json">): HandoffTurn | null {
  const override = record(run.model_override_json);
  if (record(override.chat_turn).kind !== "handoff") return null;
  const handoff = record(override.handoff);
  const threadId = typeof handoff.thread_id === "string" ? handoff.thread_id : null;
  const contextTokens = integer(handoff.context_tokens);
  const budget = integer(handoff.budget_tokens);
  return threadId && contextTokens !== null && budget !== null
    ? { thread_id: threadId, context_tokens: contextTokens, budget_tokens: budget, ...(handoff.manual_summary === true ? { manual_summary: true } : {}) }
    : null;
}

/** The summary turn's prompt, from the Prompt Library; null when it cannot be resolved. */
export async function renderHandoffPrompt(
  db: Queryable,
  input: { spaceId: string; userId: string; agentId: string; budgetTokens: number },
): Promise<string | null> {
  try {
    const resolved = await resolvePrompt(db, {
      spaceId: input.spaceId,
      userId: input.userId,
      agentId: input.agentId,
      assetKey: AGENT_SUMMARY_PROMPT_KEY,
      variables: { budget_tokens: String(input.budgetTokens) },
    });
    return resolved.validation_errors.length === 0 ? resolved.rendered_text?.trim() || null : null;
  } catch {
    return null;
  }
}

const handoffAudienceSql = `NOT EXISTS (
  SELECT 1 FROM unnest($4::text[]) audience(user_id)
   WHERE NOT COALESCE((
     ${contentReadSql("artifact", "a", "audience.user_id", { includeOversight: false })}
     AND ${roomRunReadAccessSql("a.run_id", "a.space_id", "audience.user_id")}
   ), false)
)`;

export async function loadHandoffText(db: Queryable, spaceId: string, artifactId: string, userIds: readonly string[]): Promise<string | null> {
  const result = await db.query<{ content: string | null }>(
    `SELECT a.content FROM artifacts a
      WHERE a.space_id = $1 AND a.id = $2 AND a.artifact_type = $3 AND ${handoffAudienceSql} LIMIT 1`,
    [spaceId, artifactId, AGENT_HANDOFF_ARTIFACT_TYPE, userIds],
  );
  return result.rows[0]?.content?.trim() || null;
}

/** Reuse only the last settled turn's summary, with no intervening work to lose. */
export async function reusableModelHandoff(
  db: Queryable,
  input: { thread: HostThread; model: string; userIds: readonly string[] },
): Promise<string | null> {
  const { thread, model, userIds } = input;
  const normalizedTarget = versionedClaudeModel(model);
  const target = normalizedTarget ? modelSpec(normalizedTarget) : null;
  if (!target || thread.status !== "active" || !thread.vendor_session_id || !thread.last_run_id) return null;
  if (thread.context_tokens !== null && thread.context_window_tokens !== null
    && thread.context_tokens <= Math.min(4096, thread.context_window_tokens / 4)) return null;
  const result = await db.query<{ id: string; content: string; source_model: string | null }>(
    `SELECT a.id, a.content, source.model_override_json->>'runtime_reported_model' AS source_model FROM artifacts a
       JOIN runs source ON source.id = a.run_id AND source.space_id = a.space_id
       JOIN sessions session ON session.id = source.session_id AND session.space_id = source.space_id
       JOIN rooms room ON room.id = session.room_id AND room.space_id = session.space_id
      WHERE a.space_id = $1 AND source.id = $2 AND source.status = 'succeeded'
        AND source.host_task_thread_id = $5
        AND source.model_override_json->'chat_turn'->>'kind' = 'handoff'
        AND NOT room.is_mainline AND source.model_override_json->'host_thread'->>'runtime_session_id' = $6
        AND a.artifact_type = $3 AND a.metadata_json->>'vendor_session_id' = $6
        AND a.metadata_json->>'host_thread_id' = $5
        AND ${handoffAudienceSql}
      ORDER BY a.created_at DESC LIMIT 1`,
    [thread.space_id, thread.last_run_id, AGENT_HANDOFF_ARTIFACT_TYPE, userIds, thread.id, thread.vendor_session_id],
  );
  const summary = result.rows[0];
  const sourceModel = versionedClaudeModel(summary?.source_model);
  if (!sourceModel || sourceModel === normalizedTarget) return null;
  const budget = Math.min(4096, Math.floor(
    (target.contextWindowTokens - target.defaultOutputReserveTokens - target.providerOverheadTokens) / 4,
  ));
  return summary?.content?.trim() && estimateModelTokens(handoffPromptBlock(summary.content)) <= budget ? summary.id : null;
}

function versionedClaudeModel(model: string | null | undefined): string | null {
  return model?.trim().toLowerCase().match(/^(?:anthropic\/)?(claude-(?:opus|sonnet|haiku|fable|mythos)-\d{1,2}(?:-\d{1,2})?)(?:-\d{8})?$/)?.[1] ?? null;
}

/**
 * The summary the Agent wrote in the vendor session a thread is still in, if
 * any: what the preflight shows, and what a restart-from-summary seeds the
 * next session from. A session that was reset or rotated has none, by the
 * `vendor_session_id` the document carries.
 */
export async function latestSummaryArtifactId(
  db: Queryable,
  input: { spaceId: string; threadId: string; vendorSessionId: string | null },
): Promise<string | null> {
  if (!input.vendorSessionId) return null;
  const result = await db.query<{ id: string }>(
    `SELECT id FROM artifacts
      WHERE space_id = $1 AND artifact_type = $2
        AND metadata_json->>'host_thread_id' = $3
        AND metadata_json->>'manual_summary' = 'true'
        AND metadata_json->>'vendor_session_id' = $4
      ORDER BY created_at DESC LIMIT 1`,
    [input.spaceId, AGENT_HANDOFF_ARTIFACT_TYPE, input.threadId, input.vendorSessionId],
  );
  return result.rows[0]?.id ?? null;
}

/** The document a finished handoff or summary Run wrote, if it wrote one. */
export async function handoffArtifactIdForRun(db: Queryable, run: Pick<RunRecord, "space_id" | "id">): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM artifacts WHERE space_id = $1 AND run_id = $2 AND artifact_type = $3 ORDER BY updated_at DESC LIMIT 1`,
    [run.space_id, run.id, AGENT_HANDOFF_ARTIFACT_TYPE],
  );
  return result.rows[0]?.id ?? null;
}

export function handoffPromptBlock(text: string): string {
  return `[Summary you wrote before this session was restarted]\n${text.trim()}`;
}

export function registerAgentHandoffExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const turn = handoffTurnOf(run);
  if (!turn || run.host_task_thread_id !== turn.thread_id) return;
  const pool = getDbPool(config.databaseUrl!);
  executors.set("handoff.write" as SystemActionId, async (input) => {
    const artifactId = await writeHandoffArtifact(pool, run, turn, input as HandoffInput);
    return {
      modelResult: { ok: true, tool: "handoff.write", artifact_id: artifactId },
      summary: { tool_name: "handoff.write", ok: true, artifact_id: artifactId },
    };
  });
}

interface HandoffInput {
  goal: string;
  decisions: string;
  files?: string;
  next_step: string;
  open_questions?: string;
}

function renderHandoffDocument(input: HandoffInput, budgetTokens: number): string {
  const sections: Array<[string, string | undefined]> = [
    ["Goal", input.goal],
    ["Decisions taken", input.decisions],
    ["Files changed and their state", input.files],
    ["What I was doing and the next step", input.next_step],
    ["Open questions for the person", input.open_questions],
  ];
  const text = sections
    .filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()))
    .map(([heading, body]) => `## ${heading}\n${body.trim()}`)
    .join("\n\n");
  return fitTextToTokenBudget(text, budgetTokens, "[handoff clipped to its budget]");
}

/**
 * One Artifact per handoff turn: a second call in the same turn replaces the
 * first, since it is the Agent correcting itself. A later handoff — another
 * session, or a retry — writes its own, so the document a rotation used is
 * never overwritten.
 */
async function writeHandoffArtifact(
  pool: Queryable,
  run: RunRecord,
  turn: HandoffTurn,
  input: HandoffInput,
): Promise<string> {
  const content = renderHandoffDocument(input, turn.budget_tokens);
  const ownerUserId = run.instructed_by_user_id ?? run.owner_user_id;
  if (!ownerUserId) throw new HttpError(422, "A handoff needs the person whose turn it serves");
  return withQueryableTransaction(pool, async (tx) => {
    await tx.query("SELECT 1 FROM host_threads WHERE id = $1 FOR UPDATE", [turn.thread_id]);
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM artifacts
        WHERE space_id = $1 AND artifact_type = $2 AND run_id = $3
          AND metadata_json->>'host_thread_id' = $4
        LIMIT 1`,
      [run.space_id, AGENT_HANDOFF_ARTIFACT_TYPE, run.id, turn.thread_id],
    );
    if (existing.rows[0]) {
      await tx.query(
        `UPDATE artifacts SET content = $2, updated_at = now() WHERE id = $1`,
        [existing.rows[0].id, content],
      );
      return existing.rows[0].id;
    }
    const now = new Date().toISOString();
    const visibility = run.visibility === "selected_users" ? "selected_users" : "private";
    const agentName = run.agent_name ?? "the Agent";
    const id = await insertArtifactRow(tx, {
      spaceId: run.space_id,
      ownerUserId,
      artifactType: AGENT_HANDOFF_ARTIFACT_TYPE,
      title: `Conversation summary by ${agentName}`,
      content,
      metadata: {
        host_thread_id: turn.thread_id,
        context_tokens: turn.context_tokens,
        agent_id: run.agent_id,
        session_id: run.session_id,
        // Which vendor session the document describes: a summary is "current"
        // while that session continues, and a restart from it retires exactly it.
        vendor_session_id: record(record(run.model_override_json).host_thread).runtime_session_id ?? null,
        manual_summary: turn.manual_summary === true,
      },
      canonicalFormat: "markdown",
      mimeType: "text/markdown; charset=utf-8",
      visibility,
      runId: run.id,
      projectId: run.project_id,
      createdAt: now,
    });
    // A Room Run's outputs reach exactly who the Run reached (B8A).
    if (visibility === "selected_users") {
      await inheritContentAccessGrants(tx, {
        spaceId: run.space_id,
        sourceResourceType: "run",
        sourceResourceId: run.id,
        targetResourceType: "artifact",
        targetResourceId: id,
        inheritedAt: now,
      });
    }
    return id;
  });
}


function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
