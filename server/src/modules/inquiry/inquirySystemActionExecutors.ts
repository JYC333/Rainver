import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";
import { HttpError, withQueryableTransaction } from "../routeUtils/common.js";
import { lockActiveProjectForMutation } from "../projects/access.js";
import { InquiryThreadService } from "./threadService.js";
import { InquiryIterationService } from "./iterationService.js";
import {
  THREAD_FAN_OUT_PER_TURN,
  countThreadsOpenedInTurn,
  findActiveThreadWithStatement,
  threadCallIdempotencyKey,
} from "./threadFanOut.js";
import { InquiryAdviceService } from "./adviceService.js";

/**
 * Inquiry's Agent tool surface.
 *
 * `inquiry.create_thread` and `inquiry.record_conclusion` write directly
 * ([ADR 0017](../../../../.agent/decisions/0017-authorization-by-cost-not-authorship.md)
 * §2): a person asking in the turn is the authorization, and what replaces
 * the proposal gate is the trigger origin, the per-turn fan-out bound, and
 * the Project's updates, where every write here can be undone.
 * `inquiry.promote_knowledge` is still a proposal — promoting leaves the
 * Project for Space-level Knowledge, which is a change in reach.
 */
export function registerInquirySystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("inquiry.list_threads" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("inquiry.list_threads requires a project-scoped run");
    const kind = (input as { kind?: "question" | "hypothesis" }).kind;
    const threads = await listActiveThreadRefs(new InquiryThreadService(db), identity, run.project_id, kind);
    return {
      modelResult: { ok: true, tool: "inquiry.list_threads", threads },
      summary: { tool_name: "inquiry.list_threads", ok: true, count: threads.length },
    };
  });

  executors.set("inquiry.adopt_next_step" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("inquiry.adopt_next_step requires a project-scoped run");
    const threadId = String((input as { thread_id: string }).thread_id);
    // The Area's Adopt button and this action are one implementation: two
    // copies of "apply the focus, then mark adopted" is two chances for them
    // to disagree about what adopting means.
    const adopted = await new InquiryAdviceService(db, config).adoptAdvice(
      identity,
      run.project_id,
      threadId,
      { runId: run.id, agentId: run.agent_id },
    );
    const nextFocusKind = adopted.adopted.recommended_focus_kind;
    return {
      modelResult: { ok: true, tool: "inquiry.adopt_next_step", thread_id: threadId, next_focus_kind: nextFocusKind },
      summary: { tool_name: "inquiry.adopt_next_step", ok: true, thread_id: threadId, next_focus_kind: nextFocusKind },
    };
  });

  executors.set("inquiry.create_thread" as SystemActionId, async (input, context) => {
    if (!run.project_id) throw new Error("inquiry.create_thread requires a project-scoped run");
    const projectId = run.project_id;
    const provenance = { runId: run.id, agentId: run.agent_id };
    // One transaction for the count and the write. Read-then-write on the pool
    // let two tool calls in one turn both see four and both create — six
    // questions past a bound of five, which is the failure the bound exists
    // for. `createThread` takes `lockActiveProjectForMutation` inside, and
    // that lock serialises the whole class, so counting under it is enough.
    const thread = await withQueryableTransaction(db, async (tx) => {
      await lockActiveProjectForMutation(tx, identity.spaceId, projectId);
      const opened = await countThreadsOpenedInTurn(tx, identity.spaceId, projectId, provenance);
      if (opened >= THREAD_FAN_OUT_PER_TURN) {
        throw new HttpError(
          429,
          `This turn already opened ${THREAD_FAN_OUT_PER_TURN} questions. Continue in the next turn, or tell the user what is left to open.`,
        );
      }
      // Two ways the same question arrives twice, and the proposal path
      // handled both: the same tool call delivered again (the key), and a
      // re-planned or re-sampled turn producing the same statement under a
      // fresh call id (the statement). A duplicate Thread is durable — the
      // person has to archive it — so both are coalesced here rather than
      // left to be cleaned up.
      const body = input as Record<string, unknown>;
      const statement = typeof body.statement === "string" ? body.statement : "";
      const existing = statement
        ? await findActiveThreadWithStatement(tx, identity.spaceId, projectId, statement)
        : null;
      if (existing) {
        const rows = await new InquiryThreadService(tx).listThreads(identity, projectId);
        const found = rows.find((row) => String(row.id) === existing);
        if (found) return found;
      }
      return new InquiryThreadService(tx).createThread(
        identity,
        projectId,
        {
          ...body,
          producer_idempotency_key: threadCallIdempotencyKey(run.id, context.idempotency_key),
        },
        provenance,
      );
    });
    return {
      modelResult: { ok: true, tool: "inquiry.create_thread", thread_id: thread.id, statement: thread.statement },
      summary: { tool_name: "inquiry.create_thread", ok: true, thread_id: thread.id },
    };
  });

  executors.set("inquiry.record_conclusion" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("inquiry.record_conclusion requires a project-scoped run");
    const body = input as { thread_id: string } & Record<string, unknown>;
    const result = await new InquiryIterationService(db).recordIteration(
      identity,
      run.project_id,
      String(body.thread_id),
      { ...body, trigger_kind: "agent_conclusion", trigger_ref: run.id },
      { runId: run.id, agentId: run.agent_id },
    );
    return {
      modelResult: { ok: true, tool: "inquiry.record_conclusion", thread_id: body.thread_id, iteration_id: (result as { id?: string }).id },
      summary: { tool_name: "inquiry.record_conclusion", ok: true, thread_id: body.thread_id },
    };
  });
}

export interface ActiveThreadRef {
  thread_id: string;
  kind: string;
  statement: string;
  attention_state: string | null;
}

/** The active Threads of a Project as an Agent may address them: id first. */
export async function listActiveThreadRefs(
  threads: InquiryThreadService,
  identity: { spaceId: string; userId: string },
  projectId: string,
  kind?: "question" | "hypothesis",
): Promise<ActiveThreadRef[]> {
  const rows = await threads.listThreads(identity, projectId);
  return rows
    .filter((row) => row.lifecycle_status === "active" && (!kind || row.kind === kind))
    .map((row) => ({
      thread_id: String(row.id),
      kind: String(row.kind),
      statement: String(row.statement),
      attention_state: typeof row.attention_state === "string" ? row.attention_state : null,
    }));
}
