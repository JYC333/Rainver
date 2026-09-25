import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { inheritContentAccessGrants } from "../access/contentAccessInheritance.js";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import { PgHostThreadRepository } from "../hosts/threadRepository.js";
import { resolvePrompt } from "../prompts/resolver.js";
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import { fitTextToTokenBudget } from "../usage/modelCatalog.js";

/**
 * Session rotation with a self-written handoff.
 *
 * A Conversation × Agent vendor session grows with every turn. Left alone,
 * the vendor compacts it on its own terms — invisibly, into nothing Rainver
 * owns. Before that point (a Rainver-set share of the window, below any
 * vendor's auto-compaction), the Room dispatches one **handoff turn** into the
 * old session: the Agent writes what its next session needs through
 * `handoff.write`, the document is kept as an Artifact on the thread, and the
 * person's pending turn starts a fresh session from the identity block, the
 * handoff and the Room summary. A handoff that fails leaves the old session in
 * place; the vendor's own compaction stays the safety net.
 *
 * The handoff turn is an ordinary Room Run parked ahead of the person's turn
 * in the Conversation's serial chain, and the rotation happens where that
 * turn is admitted (`AgentGroupRunLifecycleProjector`), in the same
 * transaction: nothing can dispatch into the thread between the session being
 * retired and the fresh turn being built.
 */
export const AGENT_HANDOFF_PROMPT_KEY = "agent.handoff";
export const AGENT_HANDOFF_ARTIFACT_TYPE = "agent_handoff";
export const HANDOFF_TOOL_ALLOWANCE: readonly SystemActionId[] = ["handoff.write" as SystemActionId];
/** A handoff is bounded to this share of the model's context window. */
const HANDOFF_WINDOW_SHARE = 0.04;
const HANDOFF_MIN_TOKENS = 1_000;

export function handoffBudgetTokens(contextWindowTokens: number): number {
  return Math.max(HANDOFF_MIN_TOKENS, Math.floor(contextWindowTokens * HANDOFF_WINDOW_SHARE));
}

/** What a handoff turn records on its Run, read back at execution and admission. */
export interface HandoffTurn {
  thread_id: string;
  context_tokens: number;
  budget_tokens: number;
}

/**
 * What the person's parked turn carries so it can be rebuilt as a fresh
 * session: the fresh prompt built at dispatch, split where the handoff goes.
 */
export interface HandoffRotation {
  handoff_run_id: string;
  thread_id: string;
  fresh_prompt_head: string;
  fresh_prompt_tail: string;
  identity_digest: string;
}

export function handoffTurnOf(run: Pick<RunRecord, "model_override_json">): HandoffTurn | null {
  const override = record(run.model_override_json);
  if (record(override.chat_turn).kind !== "handoff") return null;
  const handoff = record(override.handoff);
  const threadId = typeof handoff.thread_id === "string" ? handoff.thread_id : null;
  const contextTokens = integer(handoff.context_tokens);
  const budget = integer(handoff.budget_tokens);
  return threadId && contextTokens !== null && budget !== null
    ? { thread_id: threadId, context_tokens: contextTokens, budget_tokens: budget }
    : null;
}

export function handoffRotationOf(run: Pick<RunRecord, "model_override_json">): HandoffRotation | null {
  const rotation = record(record(run.model_override_json).handoff_rotation);
  return typeof rotation.handoff_run_id === "string"
    && typeof rotation.thread_id === "string"
    && typeof rotation.fresh_prompt_head === "string"
    && typeof rotation.fresh_prompt_tail === "string"
    && typeof rotation.identity_digest === "string"
    ? rotation as unknown as HandoffRotation
    : null;
}

/** The handoff turn's prompt, from the Prompt Library; null when it cannot be resolved. */
export async function renderHandoffPrompt(
  db: Queryable,
  input: { spaceId: string; userId: string; agentId: string; budgetTokens: number },
): Promise<string | null> {
  try {
    const resolved = await resolvePrompt(db, {
      spaceId: input.spaceId,
      userId: input.userId,
      agentId: input.agentId,
      assetKey: AGENT_HANDOFF_PROMPT_KEY,
      variables: { budget_tokens: String(input.budgetTokens) },
    });
    return resolved.validation_errors.length === 0 ? resolved.rendered_text?.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * A handoff tried in this vendor session that did not rotate it is not tried
 * again on every later turn: each attempt is a whole turn over a context past
 * the rotation share. The next one waits until the session has grown by a
 * real margin since the last attempt; a new session starts the count again.
 */
const HANDOFF_RETRY_GROWTH_SHARE = 0.1;

export async function handoffRecentlyAttempted(
  db: Queryable,
  input: {
    spaceId: string;
    threadId: string;
    vendorSessionId: string | null;
    contextTokens: number;
    windowTokens: number;
  },
): Promise<boolean> {
  if (!input.vendorSessionId) return false;
  const result = await db.query<{ context_tokens: string }>(
    `SELECT model_override_json->'handoff'->>'context_tokens' AS context_tokens
       FROM runs
      WHERE space_id = $1 AND host_task_thread_id = $2
        AND model_override_json->'chat_turn'->>'kind' = 'handoff'
        AND model_override_json->'host_thread'->>'runtime_session_id' = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [input.spaceId, input.threadId, input.vendorSessionId],
  );
  const last = integer(result.rows[0]?.context_tokens);
  if (last === null) return false;
  return input.contextTokens < last + Math.floor(input.windowTokens * HANDOFF_RETRY_GROWTH_SHARE);
}

export async function loadHandoffText(db: Queryable, spaceId: string, artifactId: string): Promise<string | null> {
  const result = await db.query<{ content: string | null }>(
    `SELECT content FROM artifacts WHERE space_id = $1 AND id = $2 AND artifact_type = $3 LIMIT 1`,
    [spaceId, artifactId, AGENT_HANDOFF_ARTIFACT_TYPE],
  );
  return result.rows[0]?.content?.trim() || null;
}

export function handoffPromptBlock(text: string): string {
  return `[Handoff you wrote before this session was renewed]\n${text.trim()}`;
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

export function renderHandoffDocument(input: HandoffInput, budgetTokens: number): string {
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
    const id = await insertArtifactRow(tx, {
      spaceId: run.space_id,
      ownerUserId,
      artifactType: AGENT_HANDOFF_ARTIFACT_TYPE,
      title: `Handoff from ${run.agent_name ?? "the Agent"}'s previous session`,
      content,
      metadata: {
        host_thread_id: turn.thread_id,
        context_tokens: turn.context_tokens,
        agent_id: run.agent_id,
        session_id: run.session_id,
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

/**
 * Called where the person's parked turn is admitted, after its handoff turn
 * ended. When the handoff Run succeeded and wrote its document, the vendor
 * session is retired and the turn's prompt becomes the fresh one built at
 * dispatch with the handoff in place. Otherwise the turn keeps the prompt it
 * was dispatched with and resumes the old session.
 */
export async function rotateForHandoff(
  db: Queryable,
  input: { waitingRun: RunRecord; handoffRun: RunRecord | null; rotation: HandoffRotation },
): Promise<{ prompt: string; model_override_json: Record<string, unknown> } | null> {
  const { waitingRun, handoffRun, rotation } = input;
  if (!handoffRun || (handoffRun.status !== "succeeded" && handoffRun.status !== "degraded")) return null;
  const turn = handoffTurnOf(handoffRun);
  if (!turn) return null;
  const artifact = await db.query<{ id: string; content: string }>(
    `SELECT id, content FROM artifacts
      WHERE space_id = $1 AND run_id = $2 AND artifact_type = $3
        AND metadata_json->>'host_thread_id' = $4
      ORDER BY updated_at DESC LIMIT 1`,
    [handoffRun.space_id, handoffRun.id, AGENT_HANDOFF_ARTIFACT_TYPE, turn.thread_id],
  );
  const document = artifact.rows[0];
  if (!document?.content?.trim()) return null;
  const retiring = record(record(handoffRun.model_override_json).host_thread).runtime_session_id;
  if (typeof retiring !== "string" || !retiring) return null;
  const rotated = await new PgHostThreadRepository(db).rotateAfterHandoff(turn.thread_id, document.id, retiring);
  if (!rotated) return null;
  const override = record(waitingRun.model_override_json);
  const hostThread = record(override.host_thread);
  const { fresh_prompt_head: head, fresh_prompt_tail: tail, ...kept } = rotation;
  return {
    prompt: [head, handoffPromptBlock(document.content), tail].filter(Boolean).join("\n\n"),
    model_override_json: {
      ...override,
      host_thread: {
        ...hostThread,
        runtime_session_id: null,
        fresh: true,
        identity_digest: rotation.identity_digest,
        identity_sent: true,
      },
      handoff_rotation: { ...kept, rotated_with_artifact_id: document.id },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
