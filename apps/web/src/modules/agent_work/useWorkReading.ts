import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentAttentionReadState, AgentWorkItem } from '@rainver/protocol'
import { AgentAttentionReadStateSchema } from '@rainver/protocol'
import { agentAttentionApi, ApiRequestError } from '../../api/client'
import { useConversationScope } from '../conversation/ConversationScope'
import { failureKind } from './useAgentWorkList'
import { readingSubjectKey, sameReadingRevision } from './readingSubjectKey'
import { useOptionalAttention } from './AgentAttentionProvider'

const stateKey = (state: AgentAttentionReadState) => readingSubjectKey(state.subject)
const EMPTY_SUBJECTS: AgentAttentionReadState[] = []
const subjectKey = (state: AgentAttentionReadState) => JSON.stringify(state.subject)

/**
 * One explicit open, one immutable display revision; never acknowledge a parent
 * wholesale. Messages are not confirmed here: the embedded conversation surface
 * reports its views like every other surface (`useAttentionViewing`), and the
 * server resolves what they read. This hook confirms the Run results, decisions
 * and authorizations this page itself rendered, and remembers which messages
 * were shown so a manual unread targets them.
 */
export function useWorkReading(item: AgentWorkItem, onConflict: () => void, onUnread: () => void, onState: (state: AgentAttentionReadState) => void, onReadError: (cause: unknown) => void, additionalSubjects: AgentAttentionReadState[] = EMPTY_SUBJECTS) {
  const scope = useConversationScope()
  const views = useOptionalAttention()?.views
  // A background item refresh may precede the transcript's own refresh. Keep
  // this open's source revisions; only newly paged subjects extend the snapshot.
  const [subjects, setSubjects] = useState(item.read_states)
  useEffect(() => {
    setSubjects(current => {
      const added = additionalSubjects.filter(next => !current.some(old => stateKey(old) === stateKey(next)))
      return added.length ? [...current, ...added] : current
    })
  }, [additionalSubjects])
  const states = useRef(new Map(item.read_states.map(state => [stateKey(state), state])))
  const attempted = useRef(new Set<string>())
  const displayed = useRef(new Set<string>())
  const paused = useRef(false)
  const pausedView = useRef<{ spaceId: string; sessionId: string } | null>(null)
  // This open's own conversation surfaces; a manual unread pauses only them.
  const [viewingGroup] = useState(() => ({}))
  const queue = useRef(Promise.resolve())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { paused.current = false; return () => {
    paused.current = true
    if (pausedView.current) views?.release(viewingGroup, pausedView.current.spaceId, pausedView.current.sessionId)
  } }, [views, viewingGroup])
  const write = useCallback(async (state: AgentAttentionReadState, action: 'read' | 'unread') => {
    try {
      const next = await agentAttentionApi.setReadState({ identity: item.identity, space_id: item.space_id,
        subject: state.subject, state_version: state.state_version, action }, scope)
      if (scope.signal?.aborted) return false
      states.current.set(stateKey(next), next)
      onState(next)
      return true
    } catch (cause) {
      if (scope.signal?.aborted) return false
      if (cause instanceof ApiRequestError && cause.status === 409) {
        const current = AgentAttentionReadStateSchema.safeParse(cause.payload?.current)
        if (current.success) { states.current.set(stateKey(current.data), current.data); onState(current.data) }
        paused.current = true
        setError('conflict')
        onConflict()
      } else {
        const kind = failureKind(cause)
        setError(kind)
        if (kind === 'denied') onReadError(cause)
      }
      return false
    }
  }, [item.identity, item.space_id, onConflict, onState, onReadError, scope])
  const confirm = useCallback((predicate: (state: AgentAttentionReadState) => boolean, acknowledge = true) => {
    if (paused.current || scope.signal?.aborted || document.visibilityState === 'hidden') return
    for (const state of subjects.filter(predicate)) {
      const key = subjectKey(state)
      displayed.current.add(stateKey(state))
      if (!states.current.has(stateKey(state))) states.current.set(stateKey(state), state)
      if (!acknowledge || attempted.current.has(key) || !state.unread) continue
      attempted.current.add(key)
      queue.current = queue.current.then(async () => {
        if (!paused.current && !scope.signal?.aborted) await write(states.current.get(stateKey(state)) ?? state, 'read')
      })
    }
  }, [subjects, scope, write])
  const messagesDisplayed = useCallback((ids: string[]) => {
    confirm(state => state.subject.kind === 'message' && ids.includes(state.subject.message_id), false)
  }, [confirm])
  const runDisplayed = useCallback((id: string, authorizationIds: string[] = []) => {
    confirm(state => ((state.subject.kind === 'run_result' || state.subject.kind === 'run_decision') && state.subject.run_id === id)
      || (state.subject.kind === 'authorization' && authorizationIds.includes(state.subject.authorization_request_id)))
  }, [confirm])
  const markUnread = useCallback(async () => {
    paused.current = true // Suspend immediately, before an older read response lands.
    setBusy(true)
    // Stop new reports synchronously. An already-issued report must finish
    // before this decision, otherwise it could consume the manual unread.
    const session = item.operations.find(operation => operation.kind === 'open_session')
    if (session && views) pausedView.current = { spaceId: item.space_id, sessionId: session.session_id }
    const pendingViews = session && views ? views.pause(viewingGroup, item.space_id, session.session_id) : Promise.resolve([])
    // Attach rejection handling before waiting for the separate Run-read queue.
    const viewed = pendingViews.then(reads => ({ reads }), cause => ({ cause }))
    await queue.current
    const reported = await viewed
    if (scope.signal?.aborted) return
    if ('cause' in reported) {
      const kind = failureKind(reported.cause)
      setError(kind); setBusy(false)
      if (kind === 'denied') onReadError(reported.cause)
      return
    }
    for (const state of reported.reads) {
      const current = states.current.get(stateKey(state))
      if (current && sameReadingRevision(current.subject, state.subject) && current.state_version < state.state_version) states.current.set(stateKey(state), state)
    }
    const targets = [...states.current.values()].filter(state => displayed.current.has(stateKey(state)))
    // Manual unread is also available for a summary-only subject; it never claims reading it.
    const results = []
    for (const state of targets.length ? targets : item.read_states.slice(0, 1)) {
      // Conversation views write outside this hook's read queue. An explicit
      // unread can use their already reauthorized version, while automatic
      // confirmation and the source revision remain frozen for this open.
      const refreshed = [...item.read_states, ...additionalSubjects].find(next => sameReadingRevision(next.subject, state.subject))
      results.push(await write(refreshed && refreshed.state_version > state.state_version ? refreshed : state, 'unread'))
    }
    if (!scope.signal?.aborted) {
      setBusy(false)
      if (results.length && results.every(Boolean)) onUnread()
    }
  }, [item.read_states, item.operations, item.space_id, additionalSubjects, onUnread, onReadError, scope, views, viewingGroup, write])
  return { messagesDisplayed, runDisplayed, confirm, markUnread, error, busy, viewingGroup }
}
