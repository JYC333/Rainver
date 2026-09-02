import type { RunRecord } from "../runs/repository.js";

/**
 * What a Run bound to a host thread needs at execution time, read from the
 * Run itself: which thread it belongs to, and which vendor session the thread
 * asked it to resume.
 *
 * The Run row is the one authority for this. It used to travel in the
 * `agent_run` job payload instead, rebuilt by hand at each place that
 * enqueues one — and there are twenty of those. The Room path built it, the
 * lifecycle projector built it, the thread queue built it, and direct chat,
 * the supervisor retry, the authorization re-enqueue and the resume endpoint
 * each did not, so a Run on those paths started a fresh vendor session every
 * turn while its thread believed it was resuming one, and its thread's
 * dispatch claim was released only by the reconciler's safety net. Every
 * creation path already writes `model_override_json.host_thread` (the Room,
 * delegation and direct-chat overrides, and `createDispatchRun`), so the job
 * carries nothing and there is nothing to forget.
 */
export interface HostThreadDispatchInputs {
  thread_id: string | null;
  /** The vendor session the thread asked this Run to resume, if any. */
  resume_session_id: string | null;
  /**
   * Whether a resume was asked for at all. A thread's first-ever dispatch has
   * no session and never counts as a reset when none comes back.
   */
  resume_attempted: boolean;
}

export function hostThreadDispatchInputs(
  run: Pick<RunRecord, "host_task_thread_id" | "model_override_json">,
): HostThreadDispatchInputs {
  const threadId = typeof run.host_task_thread_id === "string" && run.host_task_thread_id
    ? run.host_task_thread_id
    : null;
  if (!threadId) return { thread_id: null, resume_session_id: null, resume_attempted: false };
  const override = run.model_override_json;
  const hostThread = override && typeof override === "object" && !Array.isArray(override)
    ? (override as Record<string, unknown>).host_thread
    : null;
  const sessionId = hostThread && typeof hostThread === "object" && !Array.isArray(hostThread)
    ? (hostThread as Record<string, unknown>).runtime_session_id
    : null;
  const resumeSessionId = typeof sessionId === "string" && sessionId ? sessionId : null;
  return { thread_id: threadId, resume_session_id: resumeSessionId, resume_attempted: resumeSessionId !== null };
}
