import { PgHostThreadRepository } from "../hosts/threadRepository.js";
import type { Queryable } from "../routeUtils/common.js";

/** A retained session needs known, low context occupancy before changing models. */
export async function canSwitchRetainedSessionModel(db: Queryable, threadId: string | null | undefined, resumeSessionId: string): Promise<boolean> {
  const thread = threadId ? await new PgHostThreadRepository(db).getById(threadId) : null;
  return thread?.vendor_session_id === resumeSessionId
    && thread.context_tokens !== null && thread.context_window_tokens !== null
    && thread.context_tokens <= Math.min(4096, thread.context_window_tokens / 4);
}
