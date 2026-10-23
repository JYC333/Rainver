import { isDeepStrictEqual } from "node:util";
import type { Pool } from "../../db/pool.js";
import type { AgentAttentionReadRequest, AgentAttentionReadState, AgentAttentionViewRequest, AgentAttentionViewResult, AgentWorkIdentity } from "@rainver/protocol";
import { withTransaction } from "../../db/tx.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { AgentAttentionRepository, subjectId, type WorkTarget } from "./repository.js";
import { projectWorks, workKey, readState } from "./readModel.js";
export async function loadWorks(db: Queryable, userId: string, enabledAt?: string, target?: WorkTarget) {
  const repository = new AgentAttentionRepository(db);
  const baseline = enabledAt ?? (await repository.baseline(userId));
  return projectWorks({
    userId,
    baseline,
    ...(await repository.facts(userId, target))
  });
}
export function findWork(items: Awaited<ReturnType<typeof loadWorks>>, spaceId: string, identity: AgentWorkIdentity) {
  const item = items.find(i => i.work_key === workKey(spaceId, identity));
  if (!item) throw new HttpError(404, "Agent work not found");
  return item;
}

/** Serializes only this user's subject decisions; no business state is written. */
export async function changeReadState(pool: Pool, userId: string, input: AgentAttentionReadRequest): Promise<AgentAttentionReadState> {
  return withTransaction(pool, async db => {
    const repository = new AgentAttentionRepository(db);
    const lockKey = `${userId}:${workKey(input.space_id, input.identity)}:${input.subject.kind}:${subjectId(input.subject)}`;
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [lockKey]);
    const item = findWork(await loadWorks(db, userId, undefined, {
      space_id: input.space_id,
      identity: input.identity
    }), input.space_id, input.identity);
    const current = item.read_states.find(s => s.subject.kind === input.subject.kind && subjectId(s.subject) === subjectId(input.subject));
    if (!current) throw new HttpError(404, "Read subject not found in this work");
    if (current.state_version !== input.state_version || !isDeepStrictEqual(current.subject, input.subject)) {
      throw new HttpError(409, "Attention read state changed", {
        current
      });
    }
    const stored = await repository.writeRead(userId, input);
    if (!stored) throw new HttpError(409, "Attention read state changed", {
      current
    });
    return readState(current.subject, stored, current.unread);
  });
}

/**
 * A conversation surface displayed these messages. The server resolves which
 * authorized work and current revisions that means and records a read for each
 * one still unread, including a manual unread: viewing again is the next view
 * that decision waits for. Unknown or unauthorized ids are ignored; a lost CAS
 * race is left for the next report. Nothing else is acknowledged.
 */
export async function recordViews(pool: Pool, userId: string, input: AgentAttentionViewRequest): Promise<AgentAttentionViewResult> {
  return withTransaction(pool, async db => {
    const repository = new AgentAttentionRepository(db);
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${userId}:${input.space_id}:views:${input.session_id}`]);
    const ids = new Set(input.message_ids);
    const items = await loadWorks(db, userId, undefined, { space_id: input.space_id, identity: { kind: "session", source_id: input.session_id } });
    const read_states: AgentAttentionReadState[] = [];
    for (const item of items) {
      if (item.space_id !== input.space_id) continue;
      for (const state of item.read_states) {
        if (state.subject.kind !== "message" || !ids.has(state.subject.message_id) || !state.unread) continue;
        const stored = await repository.writeRead(userId, { identity: item.identity, space_id: item.space_id, subject: state.subject, state_version: state.state_version, action: "read" });
        if (stored) read_states.push(readState(state.subject, stored, state.unread));
      }
    }
    return { read_count: read_states.length, read_states };
  });
}
