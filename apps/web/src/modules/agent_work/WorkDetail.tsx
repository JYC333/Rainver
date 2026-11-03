import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, RefreshCw } from 'lucide-react'
import type { AgentAttentionReadState, AgentAttentionReason, AgentWorkItem } from '@rainver/protocol'
import { agentAttentionApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { StatusBadge } from '../../components/ui/badge'
import { formatDateTime } from '../../i18n/format'
import { cn } from '../../lib/utils'
import { useSpace } from '../../contexts/SpaceContext'
import { ConversationLink, ConversationScope, useConversationScope } from '../conversation/ConversationScope'
import { useAppTranslation } from '../../i18n'
import { formatNumber } from '../../i18n/format'
import { useWorkReading } from './useWorkReading'
import { AttentionViewingGroup } from './AgentAttentionProvider'
import { failureKind } from './useAgentWorkList'
import { WorkReasons } from './WorkReasons'
import { WorkConversation } from './WorkConversation'
import { WorkRun } from './WorkRun'

export function WorkDetail({ source, revision, onClose, onUnread, onChanged, onReadState }: {
  source: AgentWorkItem; revision: number; onClose: () => void; onUnread: () => void; onChanged: () => void; onReadState: (state: AgentAttentionReadState) => void
}) {
  const { userId, spaces } = useSpace()
  return <ConversationScope spaceId={source.space_id} actionUserId={userId} actionRole={spaces.find(space => space.id === source.space_id)?.role ?? 'member'}>
    <DetailLoader source={source} revision={revision} onClose={onClose} onUnread={onUnread} onChanged={onChanged} onReadState={onReadState} />
  </ConversationScope>
}

function appendChildren(previous: AgentWorkItem | null, next: AgentWorkItem): AgentWorkItem {
  return { ...next, runs: [...(previous?.runs ?? []), ...next.runs], reasons: [...(previous?.reasons ?? []), ...next.reasons], read_states: [...(previous?.read_states ?? []), ...next.read_states] }
}

/**
 * Reasons of every loaded child page. The server sends the work's own reasons
 * on the first page and each Run's reasons on that Run's page, so later pages
 * carry reasons the first page does not; each is shown once, as sent.
 */
function loadedReasons(item: AgentWorkItem, childPage: AgentWorkItem | null): AgentAttentionReason[] {
  const seen = new Set<string>()
  return [...item.reasons, ...(childPage?.reasons ?? [])].filter(reason => {
    const key = JSON.stringify(reason)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function DetailLoader({ source, revision, onClose, onUnread, onChanged, onReadState }: Parameters<typeof WorkDetail>[0]) {
  const { t } = useAppTranslation()
  const [item, setItem] = useState<AgentWorkItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const loadedRetry = useRef(0)
  const [loading, setLoading] = useState(false)
  const scope = useConversationScope()
  const cursorBusy = useRef(false)
  const childRequest = useRef<AbortController | null>(null)
  const itemRequest = useRef<AbortController | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childPage, setChildPage] = useState<AgentWorkItem | null>(null)
  const childPages = useRef(1)
  useEffect(() => {
    const controller = new AbortController()
    itemRequest.current = controller
    childRequest.current?.abort()
    cursorBusy.current = true
    setLoading(true)
    void (async () => {
      const target = { ...source.identity, space_id: source.space_id }
      const next = await agentAttentionApi.item(target, { signal: controller.signal })
      let children: AgentWorkItem | null = null
      let cursor = next.runs_next_cursor, pages = 1
      while (!controller.signal.aborted && pages < childPages.current && cursor) {
        const page = await agentAttentionApi.item({ ...target, runs_cursor: cursor }, { signal: controller.signal })
        children = appendChildren(children, page)
        cursor = page.runs_next_cursor; pages++
      }
      if (controller.signal.aborted) return
      childPages.current = pages
      // Unrelated invalidations preserve content references; an explicit retry
      // must also retry failed nested reads even if the summary did not change.
      const retried = loadedRetry.current !== retry
      loadedRetry.current = retry
      setItem(current => !retried && JSON.stringify(current) === JSON.stringify(next) ? current : next)
      setChildPage(current => JSON.stringify(current) === JSON.stringify(children) ? current : children)
      setError(null)
    })().catch(cause => {
      if (!controller.signal.aborted) {
        const kind = failureKind(cause)
        setError(kind)
        // Failed reauthorization must remove the entire previously mounted subtree.
        if (kind === 'denied') setItem(null)
      }
    }).finally(() => { if (!controller.signal.aborted) { cursorBusy.current = false; setLoading(false) } })
    return () => { controller.abort(); childRequest.current?.abort() }
  }, [source.identity, source.space_id, revision, retry])
  const conflict = useCallback(() => setRetry(value => value + 1), [])
  const readError = useCallback((cause: unknown) => {
    const kind = failureKind(cause)
    setError(kind)
    if (kind === 'denied') {
      itemRequest.current?.abort()
      childRequest.current?.abort()
      setLoading(false)
      setItem(null)
    }
  }, [])
  const moreChildren = async () => {
    const cursor = childPage ? childPage.runs_next_cursor : item?.runs_next_cursor
    if (!cursor || cursorBusy.current) return
    cursorBusy.current = true
    const controller = new AbortController()
    childRequest.current = controller
    try {
      const next = await agentAttentionApi.item({ ...source.identity, space_id: source.space_id, runs_cursor: cursor }, { signal: controller.signal })
      if (scope.signal?.aborted || controller.signal.aborted) return
      childPages.current++
      setChildPage(previous => appendChildren(previous, next))
    } catch (cause) { if (!controller.signal.aborted && !scope.signal?.aborted) readError(cause) }
    finally { if (childRequest.current === controller && !controller.signal.aborted) cursorBusy.current = false }
  }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={onClose}><ArrowLeft className="size-3.5" />{t('agent_work.back')}</Button>
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={conflict} disabled={loading}><RefreshCw className="size-3.5" />{t('agent_work.refresh_detail')}</Button>
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t(`agent_work.${error}`)}</p>}
      {!item ? !error && <p role="status" className="text-sm text-muted-foreground">{t('agent_work.loading')}</p> : <ConversationScope spaceId={item.space_id}><DetailContent item={item} childPage={childPage}
        onConflict={conflict} onUnread={onUnread} onChanged={onChanged} onReadState={onReadState} onReadError={readError}
        expanded={expanded} onToggle={id => setExpanded(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next })}
        onMoreChildren={() => void moreChildren()} /></ConversationScope>}
    </div>
  </div>
}

function DetailContent({ item, childPage, onConflict, onUnread, onChanged, onReadState, onReadError, expanded, onToggle, onMoreChildren }: {
  item: AgentWorkItem; childPage: AgentWorkItem | null; onConflict: () => void; onUnread: () => void; onChanged: () => void;
  onReadState: (state: AgentAttentionReadState) => void; onReadError: (cause: unknown) => void; expanded: Set<string>; onToggle: (id: string) => void; onMoreChildren: () => void
}) {
  const { t } = useAppTranslation()
  const reading = useWorkReading(item, onConflict, onUnread, onReadState, onReadError, childPage?.read_states)
  const reasons = useMemo(() => loadedReasons(item, childPage), [item, childPage])
  useEffect(() => {
    reading.confirm(state => (state.subject.kind === 'task' && item.identity.kind === 'task' && state.subject.task_id === item.identity.source_id)
      || (state.subject.kind === 'task_merge' && reasons.some(reason => reason.kind === 'task_merge' && state.subject.kind === 'task_merge' && reason.merge_id === state.subject.merge_id)))
  }, [reading.confirm, item.identity, reasons])
  const conversation = item.operations.some(operation => operation.kind === 'open_session') && item.access_level === 'full'
  const [historyOpen, setHistoryOpen] = useState(false)
  const allRuns = [...item.runs, ...(childPage?.runs ?? [])]
  // Keep the selected result stable while child windows/background refreshes arrive.
  const [primaryId] = useState(() => item.runs.find(run => !run.retry_superseded && item.reasons.some(reason => 'run_id' in reason && reason.run_id === run.run_id))?.run_id
    ?? [...item.runs].filter(run => !run.retry_superseded).sort((a, b) => (b.ended_at ?? b.started_at ?? '').localeCompare(a.ended_at ?? a.started_at ?? ''))[0]?.run_id)
  const primary = allRuns.find(run => run.run_id === primaryId)
  const history = allRuns.filter(run => run.run_id !== primaryId)
  const runRevision = useMemo(() => ({ item, childPage }), [item, childPage])
  const links = [
    ...item.operations.filter(operation => operation.kind === 'open_task').map(operation => ({ key: operation.task_id, to: `/tasks/${operation.task_id}`, label: t('agent_work.open_task') })),
    ...reasons.filter(reason => reason.kind === 'proposal').map(reason => ({ key: reason.proposal_id, to: `/proposals/${reason.proposal_id}`, label: t('agent_work.open_proposal') })),
  ]
  return <>
    <div className="flex shrink-0 flex-wrap items-start justify-between gap-2">
      <h2 className="min-w-0 break-words text-lg font-semibold tracking-tight">{item.title}</h2>
      {item.read_states.length > 0 && <Button data-work-unread size="sm" variant="outline" disabled={reading.busy} onClick={() => void reading.markUnread()}>{t('agent_work.mark_unread')}</Button>}
    </div>
    <WorkReasons reasons={reasons} />
    {reading.error && <p role="alert" className="text-xs text-destructive">{t(`agent_work.${reading.error}`)}</p>}
    {links.length > 0 && <div className="flex flex-wrap gap-3">
      {links.map(link => <ConversationLink key={link.key} className="text-xs font-medium text-accent-foreground underline-offset-2 hover:underline" to={link.to}>{link.label}</ConversationLink>)}
    </div>}
    {conversation
      ? <AttentionViewingGroup value={reading.viewingGroup}><WorkConversation item={item} onMessagesDisplayed={reading.messagesDisplayed} onReadError={onReadError} onChanged={onChanged} /></AttentionViewingGroup>
      : item.access_level !== 'full' && <p className="text-xs text-muted-foreground">{t('agent_work.summary_only')}</p>}
    {/* A reply conversation already owns its turns and execution controls. */}
    {!conversation && <section aria-label={t('agent_work.result')} className="min-h-0 flex-1 space-y-3 overflow-auto">
      {primary && item.access_level === 'full' && <WorkRun key={primary.run_id} runId={primary.run_id} revision={runRevision} onDisplayed={reading.runDisplayed} onChanged={onChanged} />}
      {(history.length > 0 || item.runs_next_cursor || childPage?.runs_next_cursor) && <div className="rounded-md border border-border">
        <Button variant="ghost" size="sm" className="w-full justify-start gap-2" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>
          <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', historyOpen && 'rotate-90')} />
          {t('agent_work.execution_history', { count: formatNumber(Math.max(0, item.visible_run_count - (primary ? 1 : 0))) })}
        </Button>
        {historyOpen && <>
          {history.map(run => <div key={run.run_id} className="border-t border-border">
            <Button variant="ghost" size="sm" className="h-auto w-full justify-start gap-2 whitespace-normal text-left" aria-expanded={expanded.has(run.run_id)} onClick={() => onToggle(run.run_id)}>
              <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', expanded.has(run.run_id) && 'rotate-90')} />
              <span className="min-w-0 flex-1">
                <span className="block">{t('agent_work.execution_entry', { number: formatNumber(allRuns.indexOf(run) + 1) })} · {run.agent_name ?? t('agent_work.agent_fallback')}</span>
                <span className="block text-xs text-muted-foreground">{formatDateTime(run.started_at ?? run.ended_at)}</span>
              </span>
              <StatusBadge status={run.status} label={t(`agent_work.status.${run.status}`)} />
            </Button>
            {expanded.has(run.run_id) && item.access_level === 'full' && <WorkRun runId={run.run_id} revision={runRevision} onDisplayed={reading.runDisplayed} onChanged={onChanged} />}
          </div>)}
          {(childPage ? childPage.runs_next_cursor : item.runs_next_cursor) && <div className="border-t border-border p-2">
            <Button size="sm" variant="outline" onClick={onMoreChildren}>{t('agent_work.more_children', { count: formatNumber(item.visible_run_count) })}</Button>
          </div>}
        </>}
      </div>}
    </section>}
  </>
}
