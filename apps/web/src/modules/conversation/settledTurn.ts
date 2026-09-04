import type { RunTurn } from '../../types/api'

/**
 * The turn a settled message keeps: its work, with the saved reply as prose.
 *
 * The live turn's own text is whatever had streamed when the message landed;
 * the message is what was actually written. The steps are the same either way,
 * and they are what the fold shows.
 *
 * The caller passes the state rather than this deriving it, because only the
 * caller knows what settled. A reply row is not evidence that a turn is over:
 * the server writes one at the pause as well (`chatTurnFinalizer` posts the
 * "waiting for review" notice under the Agent's name), so a turn that decides
 * for itself would collapse `blocked` to `done` and take the approval link
 * with it — the one thing a paused turn exists to show.
 */
export function settledTurn(
  streamed: RunTurn | null | undefined,
  state: RunTurn['state'],
  text: string,
): RunTurn | null {
  if (!streamed) return null
  const steps = streamed.parts.filter(part => part.type !== 'text')
  return {
    ...streamed,
    state,
    // Only a settled turn has nothing left to wait on. A blocked one keeps
    // what it is blocked on, because that is what names the link out.
    blocked_on: state === 'blocked' ? streamed.blocked_on : null,
    parts: [...steps, { type: 'text', index: steps.length, text }],
  }
}

/**
 * What state a turn read back on a cold load is shown in.
 *
 * A saved reply exists, so the Agent is not working on it any more — but the
 * turn can still read `working`: `chatTurnFinalizer` writes the message
 * before it appends `chat_completed`, and the server will not say `done`
 * until that event lands. A read-back is not a stream, so nothing would ever
 * correct it, and the reply would sit under a permanent "Working…" with its
 * work withheld.
 *
 * `blocked` is kept — that one is still true, and it carries the link out.
 */
export function readBackTurnState(state: RunTurn['state']): RunTurn['state'] {
  return state === 'working' ? 'done' : state
}
