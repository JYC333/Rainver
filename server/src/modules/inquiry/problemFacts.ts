import {InquiryMutationError} from "./operationErrors.js";
import { createHash } from "node:crypto";
import type { ProblemReference } from "@rainver/protocol";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectWriter, lockActiveProjectForMutation } from "../projects/access.js";
import { assertThreadReadable } from "./threadAccess.js";
import { recordThreadWorkEvent, type ThreadEventProvenance } from "./threadWorkEvents.js";
import type { ProblemPrimaryIntentSchema } from "@rainver/protocol";
import type { z } from "zod";
export type PrimaryIntent = z.infer<typeof ProblemPrimaryIntentSchema>;
export interface ProblemThread {
  object_id: string;
  statement: string;
  version: number;
  problem_revision: number;
  lifecycle_status: string;
  blocked_reason: string | null;
}
export async function lockProblem(db: Queryable, identity: SpaceUserIdentity, projectId: string, threadId: string): Promise<ProblemThread> {
  await assertProjectWriter(db, identity.spaceId, projectId, identity.userId);
  await lockActiveProjectForMutation(db, identity.spaceId, projectId);
  await assertThreadReadable(db, identity, projectId, threadId, "read_content");
  await assertThreadReadable(db, identity, projectId, threadId, "change");
  const r = await db.query<ProblemThread>(`SELECT object_id,statement,version,problem_revision,lifecycle_status,blocked_reason FROM inquiry_threads WHERE object_id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE`, [threadId, identity.spaceId, projectId]);
  if (!r.rows[0] || r.rows[0].lifecycle_status !== "active") throw new InquiryMutationError(409, "Only an active Thread can change problem work");
  return r.rows[0];
}
export function checkProblemVersion(thread: ProblemThread, body: Record<string, unknown>): void {
  if (body.expected_version !== thread.version || body.expected_revision !== thread.problem_revision) throw new InquiryMutationError(409, "Problem changed; read its projection before retrying");
}
export async function problemRound(db: Queryable, spaceId: string, threadId: string): Promise<number> {
  const r = await db.query<{
    n: number;
  }>(`SELECT COALESCE(max(round_number),0)::integer+1 AS n FROM inquiry_round_closeouts WHERE space_id=$1 AND thread_id=$2`, [spaceId, threadId]);
  return r.rows[0]!.n;
}
export async function replayProblemCommand(db: Queryable, spaceId: string, threadId: string, key: string, request: unknown): Promise<Record<string, unknown> | null> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`, [spaceId, key]);
  const r = await db.query<{
    thread_id: string;
    request_json: unknown;
    result_json: Record<string, unknown>;
  }>(`SELECT thread_id,request_json,result_json FROM inquiry_problem_commands WHERE space_id=$1 AND idempotency_key=$2`, [spaceId, key]);
  if (!r.rows[0]) return null;
  if (r.rows[0].thread_id !== threadId || !isDeepStrictEqual(r.rows[0].request_json, request)) throw new InquiryMutationError(409, "Idempotency key already used for a different command");
  return r.rows[0].result_json;
}
export async function saveProblemCommand(db: Queryable, identity: SpaceUserIdentity, projectId: string, threadId: string, key: string, request: unknown, result: unknown): Promise<void> {
  await db.query(`INSERT INTO inquiry_problem_commands(id,space_id,project_id,thread_id,idempotency_key,request_json,result_json) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [randomUUID(), identity.spaceId, projectId, threadId, key, JSON.stringify(request), JSON.stringify(result)]);
}
export async function refreshProblem(db: Queryable, spaceId: string, threadId: string): Promise<void> {
  await db.query(`UPDATE inquiry_threads SET problem_revision=problem_revision+1 WHERE object_id=$1 AND space_id=$2`, [threadId, spaceId]);
  await db.query(`UPDATE space_objects SET updated_at=now() WHERE id=$1 AND space_id=$2`, [threadId, spaceId]);
}
export async function startPrimary(db: Queryable, identity: SpaceUserIdentity, projectId: string, threadId: string, intent: PrimaryIntent, round: number, extra: {
  selection_kind?: string;
  skipped_stages?: string[];
  input_refs?: ProblemReference[];
  output_refs?: ProblemReference[];
} = {}): Promise<string> {
  await db.query(`UPDATE inquiry_thread_steps SET status='abandoned',ended_reason='replaced',completed_at=now() WHERE thread_id=$1 AND space_id=$2 AND slot='primary' AND status='in_progress'`, [threadId, identity.spaceId]);
  const id = randomUUID();
  await db.query(`INSERT INTO inquiry_thread_steps(id,space_id,project_id,thread_id,kind,status,slot,note,method_version,method_stage,work_kind,round_number,selection_kind,skipped_stages,context_refs,origin,started_at,created_at) VALUES($1,$2,$3,$4,$5,'in_progress','primary',$6,'problem_solving.v1',$7,$5,$8,$9,$10::jsonb,$11::jsonb,'user',now(),now())`, [id, identity.spaceId, projectId, threadId, intent.work_kind, intent.reason, intent.stage, round, extra.selection_kind ?? null, JSON.stringify(extra.skipped_stages ?? []), JSON.stringify([...(extra.input_refs ?? []).map(ref => ({
    role: "input",
    ref
  })), ...(extra.output_refs ?? []).map(ref => ({
    role: "output",
    ref
  }))])]);
  return id;
}
export async function closeRoundFact(db: Queryable, identity: SpaceUserIdentity, projectId: string, thread: ProblemThread, input: {
  summary: string;
  input_refs: unknown[];
  next_focus?: unknown;
  iteration_id?: string;
  method_version: string;
  start_next_primary?: PrimaryIntent;
}, provenance?: ThreadEventProvenance): Promise<Record<string, unknown>> {
  const threadId = thread.object_id,
    round = await problemRound(db, identity.spaceId, threadId),
    id = randomUUID();
  const primary = await db.query(`SELECT * FROM inquiry_thread_steps WHERE thread_id=$1 AND space_id=$2 AND slot='primary' AND status='in_progress'`, [threadId, identity.spaceId]);
  await db.query(`UPDATE inquiry_thread_steps SET status=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(context_refs) r WHERE r->>'role'='output') THEN 'done' ELSE 'abandoned' END,ended_reason='round_closed',completed_at=now(),iteration_id=$3 WHERE thread_id=$1 AND space_id=$2 AND slot='primary' AND status='in_progress'`, [threadId, identity.spaceId, input.iteration_id ?? null]);
  if (input.iteration_id) await db.query(`UPDATE inquiry_thread_steps SET iteration_id=$4 WHERE thread_id=$1 AND space_id=$2 AND round_number=$3 AND status <> 'in_progress' AND iteration_id IS NULL`, [threadId, identity.spaceId, round, input.iteration_id]);
  await db.query(`INSERT INTO inquiry_thread_steps(id,space_id,project_id,thread_id,kind,status,slot,note,method_version,method_stage,work_kind,round_number,context_refs,origin,started_at,completed_at,created_at) VALUES($1,$2,$3,$4,'close_round','done','primary',$5,'problem_solving.v1','conclude','close_round',$6,$7::jsonb,'user',now(),now(),now())`, [randomUUID(), identity.spaceId, projectId, threadId, input.summary, round, JSON.stringify(input.input_refs)]);
  await db.query(`INSERT INTO inquiry_round_closeouts(id,space_id,project_id,thread_id,round_number,method_version,summary,input_refs,next_focus,iteration_id,previous_primary,closed_revision,created_by_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,now())`, [id, identity.spaceId, projectId, threadId, round, input.method_version, input.summary, JSON.stringify(input.input_refs), JSON.stringify(input.next_focus ?? null), input.iteration_id ?? null, JSON.stringify(primary.rows[0] ?? null), thread.problem_revision + 1, identity.userId]);
  if (input.start_next_primary) await startPrimary(db, identity, projectId, threadId, input.start_next_primary, round + 1);
  await refreshProblem(db, identity.spaceId, threadId);
  await recordThreadWorkEvent(db, {
    spaceId: identity.spaceId,
    projectId,
    threadId,
    userId: identity.userId,
    eventKind: "thread.round_closed",
    occurredAt: new Date().toISOString(),
    idempotencySuffix: id,
    data: {
      statement: thread.statement,
      closeout_id: id,
      round_number: round,
      iteration_id: input.iteration_id ?? null,
      summary: input.summary,
      method_version: input.method_version,
      reference_refs: input.input_refs
    },
    provenance
  });
  return {
    id,
    thread_id: threadId,
    round_number: round,
    iteration_id: input.iteration_id ?? null
  };
}

/** Model keys cannot select another Run's (or a person's) receipt namespace.
 * `trustedCall` is a dispatcher-owned call identity (attempt and call id): it
 * gets its own `:call:` namespace, which no model-supplied key can reach. */
export function problemCommandKey(identity: SpaceUserIdentity, key: string, provenance?: ThreadEventProvenance, trustedCall?: string): string {
  const owner = provenance?.runId ? 'run:' + provenance.runId : 'user:' + identity.userId;
  return trustedCall ? `${owner}:call:${createHash('sha256').update(trustedCall).digest('hex')}` : `${owner}:${createHash('sha256').update(key).digest('hex')}`;
}
