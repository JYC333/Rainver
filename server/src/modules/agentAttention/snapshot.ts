import { createHash } from "node:crypto";
import { AgentAttentionQuerySchema, type AgentAttentionNotice } from "@rainver/protocol";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { AgentAttentionRepository } from "./repository.js";
import { boundWork, projectWorks, sessionDetached } from "./readModel.js";
import { runTurnState } from "../runs/index.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Same authorized complete candidates and retention query as list; no Turn bodies.
 * `signals` holds every announceable source revision of every authorized work,
 * independent of the retention window, keyed by the revision alone: a work
 * re-entering the personal window, changing identity, becoming the viewer's or
 * being marked unread therefore keeps the keys it already had. The stream
 * announces only new keys of the viewer's own (`mine`) works.
 */
export const attentionBaseline = (pool: Queryable, userId: string) => new AgentAttentionRepository(pool).baseline(userId);
export async function readAttentionSnapshot(pool: Queryable, userId: string, enabledAt?: string) {
  const baseline = enabledAt ?? await attentionBaseline(pool, userId);
  return withQueryableTransaction(pool, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const facts = await new AgentAttentionRepository(db).facts(userId);
    const works = projectWorks({ userId, baseline, ...facts });
    const messageRuns = new Map(facts.runs.filter(run => run.message_id).map(run => [run.message_id, run]));
    const runs = new Map(facts.runs.map(run => [run.id, run]));
    const result = await new AgentAttentionRepository(db).pageWithSignals(works.map(item => boundWork(item)), AgentAttentionQuerySchema.parse({}), new Date().toISOString());
    const signals = new Map<string, { notice: AgentAttentionNotice; mine: boolean }>();
    for (const item of works) {
      const personalReasons = item.reasons.filter(reason => 'responsible' in reason && reason.responsible.kind === 'user' && reason.responsible.id === userId);
      for (const state of item.read_states) {
        const subject = state.subject;
        let kind: AgentAttentionNotice['kind'] | undefined;
        if (subject.kind === 'message') {
          if (personalReasons.some(reason => reason.kind === 'awaiting_answer' && reason.message_id === subject.message_id)) kind = 'answer';
          else {
            const run = messageRuns.get(subject.message_id);
            if (run && !run.question_open) {
              const turn = runTurnState(run.status, run.chat_completed, run.is_chat_turn);
              if (turn === 'failed') kind = 'failed';
              else if (turn === 'done') kind = 'finished';
            }
          }
        } else if (personalReasons.some(reason => {
          switch (subject.kind) {
            case 'authorization': return reason.kind === 'authorization' && reason.authorization_request_id === subject.authorization_request_id;
            case 'run_decision': return reason.kind === 'run_decision' && reason.run_id === subject.run_id;
            case 'proposal': return reason.kind === 'proposal' && reason.proposal_id === subject.proposal_id;
            case 'task': return reason.kind === 'task' && reason.task_id === subject.task_id;
            case 'task_merge': return reason.kind === 'task_merge' && reason.merge_id === subject.merge_id;
            default: return false;
          }
        })) kind = 'decision';
        else if (subject.kind === 'run_result') {
          const source = runs.get(subject.run_id);
          if (source && sessionDetached(source)) continue;
          kind = item.runs.some(run => run.run_id === subject.run_id && ['failed', 'cancelled', 'orphaned'].includes(run.status)) ? 'failed' : 'finished';
        }
        if (!kind) continue;
        // Classification can change when a question is answered without a new source revision.
        const key = digest(subject);
        signals.set(key, { notice: { key, kind, work_key: item.work_key }, mine: item.mine });
      }
    }
    // Also detects all_visible permission/status changes outside the personal window.
    return { page: result.page, unread_count: result.unread_count, version: digest([works, result.eligible_keys]), signals };
  });
}
export type AttentionSnapshot = Awaited<ReturnType<typeof readAttentionSnapshot>>;
