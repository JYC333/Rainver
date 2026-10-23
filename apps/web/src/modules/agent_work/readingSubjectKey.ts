import type { AgentAttentionRevision } from '@rainver/protocol'

/** Reading-row identity excludes revision/attempt, matching the server's subject grain. */
export function readingSubjectKey(subject: AgentAttentionRevision): string {
  const id = subject.kind === 'message' ? subject.message_id
    : subject.kind === 'run_result' || subject.kind === 'run_decision' ? subject.run_id
    : subject.kind === 'authorization' ? subject.authorization_request_id
    : subject.kind === 'proposal' ? subject.proposal_id
    : subject.kind === 'task' ? subject.task_id : subject.merge_id
  return JSON.stringify([subject.kind, id])
}

/** Revisions are equality tokens; an attempt change is also a new result. */
export function sameReadingRevision(a: AgentAttentionRevision, b: AgentAttentionRevision): boolean {
  return readingSubjectKey(a) === readingSubjectKey(b) && a.revision === b.revision
    && (a.kind !== 'run_result' || b.kind === 'run_result' && a.attempt_id === b.attempt_id)
}
