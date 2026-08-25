import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { artifactsApi, hostsApi, runsApi, type ModelProviderOut } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { HostThreadEvent, HostThreadMessage, HostTaskThread, Run } from '../../types/api'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { DiffViewer } from '../project_files/ProjectFilesParts'
import { MarkdownMessage } from '../agent_groups/MarkdownMessage'
import { backendLabel } from './backendChoice'

const EVENT_POLL_INTERVAL_MS = 2_000
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])
const NEAR_BOTTOM_PX = 80

interface ToolActivityItem {
  toolCallId: string
  toolName: string | null
  inputSummary: string | null
  /** ACP runtime replatform P3 (A9): the 9-category ACP kind — execute/edit/read/... Absent for a run predating this absorption. */
  kind: string | null
  /** ACP runtime replatform P3 (A9): absent for codex (adapter asymmetry, not a bug — see the ACP runtime replatform plan §4). */
  resultSummary: string | null
  status: 'running' | 'in_progress' | 'succeeded' | 'failed'
}

interface PlanEntry {
  content: string
  status?: string | null
}

type TurnBlock =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thought'; key: string; text: string }
  | { kind: 'tool'; key: string; item: ToolActivityItem }

interface TurnContent {
  blocks: TurnBlock[]
  diagnostics: string[]
  /** ACP runtime replatform P3 (A9): appended as snapshots server-side — only the latest is meaningful to show. */
  plan: PlanEntry[] | null
}

/**
 * Preserves the real interleaving of assistant text and tool calls (a
 * text segment, then a tool call, then more text, ...) instead of
 * bucketing all text before all tools — real-usage feedback: the old
 * bucketed rendering made it impossible to tell which text came before or
 * after which tool call, and buried the true final answer under
 * everything the run ever said. Consecutive `assistant_text` events
 * accumulate into one block until a tool call (or the end) flushes them,
 * so a multi-line block (e.g. a markdown table spanning several
 * normalizer-coalesced lines) renders as one `MarkdownMessage`, not one
 * per line. A `tool_activity_finished` event updates its already-pushed
 * block's `item` in place (same object reference), not a separate lookup
 * at render time.
 */
function parsePlanEntries(text: string | null): PlanEntry[] | null {
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return null
    return parsed
      .map(raw => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : null))
      .filter((raw): raw is Record<string, unknown> => raw !== null && typeof raw.content === 'string')
      .map(raw => ({
        content: raw.content as string,
        status: typeof raw.status === 'string' ? raw.status : null,
      }))
  } catch {
    return null
  }
}

function buildTurnContent(events: HostThreadEvent[]): TurnContent {
  const blocks: TurnBlock[] = []
  const toolByCallId = new Map<string, ToolActivityItem>()
  const diagnostics: string[] = []
  let plan: PlanEntry[] | null = null
  let textBuffer: string[] = []
  let thoughtBuffer: string[] = []
  let textKeySeq = 0

  function flushText() {
    // Reasoning first: it is what led to the text that follows it.
    if (thoughtBuffer.length > 0) {
      blocks.push({ kind: 'thought', key: `thought-${textKeySeq}`, text: thoughtBuffer.join('\n') })
      thoughtBuffer = []
    }
    if (textBuffer.length === 0) { textKeySeq++; return }
    blocks.push({ kind: 'text', key: `text-${textKeySeq++}`, text: textBuffer.join('\n') })
    textBuffer = []
  }

  for (const e of events) {
    if (e.event_type === 'assistant_text' && e.text) {
      textBuffer.push(e.text)
    } else if (e.event_type === 'assistant_thought' && e.text) {
      thoughtBuffer.push(e.text)
    } else if (e.event_type === 'tool_activity_started') {
      flushText()
      const id = e.tool_call_id ?? e.id
      const item: ToolActivityItem = {
        toolCallId: id,
        toolName: e.tool_name,
        inputSummary: e.tool_input_summary,
        kind: e.tool_kind,
        resultSummary: null,
        status: 'running',
      }
      toolByCallId.set(id, item)
      blocks.push({ kind: 'tool', key: `tool-${id}`, item })
    } else if (e.event_type === 'tool_activity_finished') {
      const id = e.tool_call_id ?? ''
      const existing = toolByCallId.get(id)
      if (existing) {
        existing.status = e.status === 'failed' ? 'failed' : e.status === 'in_progress' ? 'in_progress' : 'succeeded'
        if (e.tool_result_summary) existing.resultSummary = e.tool_result_summary
      }
    } else if (e.event_type === 'diagnostic' && e.text) {
      diagnostics.push(e.text)
    } else if (e.event_type === 'plan_updated') {
      // Snapshots, not deltas — the latest one replaces the last, never merges.
      plan = parsePlanEntries(e.text)
    }
  }
  flushText()
  return { blocks, diagnostics, plan }
}

function renderBlock(block: TurnBlock) {
  if (block.kind === 'text') return <MarkdownMessage key={block.key} content={block.text} />
  if (block.kind === 'thought') return <ThoughtBlock key={block.key} text={block.text} />
  return <ToolActivityRow key={block.key} item={block.item} />
}

/**
 * The model's reasoning, collapsed. It is not the answer and must not read as
 * one — a MiniMax turn's whole `<think>` block used to sit above the reply as
 * ordinary assistant text.
 */
function ThoughtBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border border-dashed border-border text-xs">
      <button
        type="button"
        className="w-full flex items-center gap-2 p-2 text-left hover:bg-muted/40"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="text-muted-foreground">Reasoning</span>
      </button>
      {open && <div className="px-2 pb-2 text-muted-foreground whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="flex gap-0.5">
        <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
        <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
        <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce" />
      </span>
      Working…
    </div>
  )
}

function ToolActivityRow({ item }: { item: ToolActivityItem }) {
  const [open, setOpen] = useState(false)
  const statusVariant = item.status === 'succeeded' ? 'secondary' : item.status === 'failed' ? 'destructive' : 'muted'
  const isRunning = item.status === 'running' || item.status === 'in_progress'
  return (
    <div className="rounded-md border border-border text-xs">
      <button
        type="button"
        className="w-full flex items-center gap-2 p-2 text-left hover:bg-muted/40"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        {item.kind && <Badge variant="outline" className="shrink-0">{item.kind}</Badge>}
        <span className="font-mono">{item.toolName ?? 'tool'}</span>
        {isRunning
          ? <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground" />
          : <Badge variant={statusVariant} className="ml-auto">{item.status}</Badge>}
      </button>
      {open && (item.inputSummary || item.resultSummary) && (
        <div className="px-2 pb-2 space-y-1">
          {item.inputSummary && (
            <pre className="overflow-x-auto text-[11px] text-muted-foreground whitespace-pre-wrap break-all">{item.inputSummary}</pre>
          )}
          {item.resultSummary && (
            <pre className="overflow-x-auto text-[11px] whitespace-pre-wrap break-all border-t border-border pt-1">{item.resultSummary}</pre>
          )}
        </div>
      )}
    </div>
  )
}

/** ACP runtime replatform P3 (A9): the thread's latest plan snapshot — a live checklist of progress, not a history of every revision. */
function PlanChecklist({ entries }: { entries: PlanEntry[] }) {
  if (entries.length === 0) return null
  return (
    <div className="rounded-md border border-border p-2 text-xs space-y-1">
      {entries.map((entry, index) => {
        const done = entry.status === 'completed'
        const active = entry.status === 'in_progress'
        return (
          <div key={index} className="flex items-center gap-2">
            <span
              className={`size-1.5 rounded-full shrink-0 ${done ? 'bg-primary' : active ? 'bg-amber-500' : 'bg-muted-foreground/40'}`}
            />
            <span className={done ? 'text-muted-foreground line-through' : ''}>{entry.content}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Everything before the final answer, collapsed once a run finishes — the reasoning trail stays available but doesn't bury the answer (real-usage feedback). */
function PriorStepsCollapsible({ blocks }: { blocks: TurnBlock[] }) {
  const [open, setOpen] = useState(false)
  const toolCount = blocks.filter(b => b.kind === 'tool').length
  return (
    <div className="rounded-md border border-border text-xs">
      <button
        type="button"
        className="w-full flex items-center gap-2 p-2 text-left hover:bg-muted/40"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="text-muted-foreground">
          {blocks.length} earlier step{blocks.length === 1 ? '' : 's'}
          {toolCount > 0 ? ` · ${toolCount} tool call${toolCount === 1 ? '' : 's'}` : ''}
        </span>
      </button>
      {open && <div className="px-2 pb-2 space-y-2">{blocks.map(renderBlock)}</div>}
    </div>
  )
}

function DiagnosticsDrawer({ lines, autoOpen }: { lines: string[]; autoOpen: boolean }) {
  const [open, setOpen] = useState(autoOpen)
  if (lines.length === 0) return null
  return (
    <div className="rounded-md border border-border text-xs">
      <button
        type="button"
        className="w-full flex items-center gap-2 p-2 text-left hover:bg-muted/40"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span>Diagnostics ({lines.length})</span>
      </button>
      {open && (
        <pre className="px-2 pb-2 max-h-48 overflow-auto text-[11px] text-muted-foreground whitespace-pre-wrap">{lines.join('\n')}</pre>
      )}
    </div>
  )
}

function RunDiff({ runId }: { runId: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    artifactsApi
      .list({ run_id: runId, artifact_type: 'remote_diff' })
      .then(page => {
        const artifactId = page.items[0]?.id
        if (!artifactId) return null
        return artifactsApi.get(artifactId)
      })
      .then(artifact => { if (!cancelled) setDiff(artifact?.content ?? null) })
      .catch(error => { if (!cancelled) toast.error(errMsg(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [runId])

  if (loading) return <Skeleton className="h-24 w-full" />
  if (!diff) return <p className="text-xs text-muted-foreground">No diff was uploaded for this run.</p>
  return (
    <div className="max-h-96 overflow-auto rounded-md border border-border">
      <DiffViewer diff={diff} />
    </div>
  )
}

function TurnCard({ message, run, events, providers, onRunChanged }: {
  message: HostThreadMessage
  run: Run | null
  events: HostThreadEvent[]
  providers: ModelProviderOut[] | null
  onRunChanged: () => void
}) {
  const [showDiff, setShowDiff] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const content = useMemo(() => buildTurnContent(events), [events])
  // A held run has finished executing, so its diff is exactly what a reviewer
  // needs to decide with.
  const ended = Boolean(run && (run.status === 'succeeded' || run.status === 'failed' || run.status === 'waiting_for_review'))
  const canShowDiff = ended
  const held = run?.status === 'waiting_for_review'
  const isActive = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status))

  async function recover(action: 'resume' | 'abandon') {
    if (!run) return
    setRecoveryBusy(true)
    try {
      if (action === 'resume') {
        await runsApi.resume(run.id)
        toast.success('Run resumed and queued')
      } else {
        await runsApi.abandon(run.id)
        toast.success('Run abandoned')
      }
      setConfirmAbandon(false)
      onRunChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setRecoveryBusy(false)
    }
  }

  // Once the run has actually finished with a trailing text block, that
  // block is the real answer — everything before it collapses into
  // `PriorStepsCollapsible` instead of staying expanded forever. A run
  // still in flight, or one that ended without a final text block (e.g.
  // failed mid-tool-call), just renders every block live in order.
  const lastBlock = content.blocks[content.blocks.length - 1]
  const finalBlock = canShowDiff && lastBlock?.kind === 'text' ? lastBlock : null
  const priorBlocks = finalBlock ? content.blocks.slice(0, -1) : []

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary/10 border border-primary/20 px-3 py-2 text-sm whitespace-pre-wrap">
          {message.prompt}
          {message.status !== 'dispatched' && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant={message.status === 'withdrawn' ? 'muted' : 'warning'}>{message.status}</Badge>
              {/* A queued message already carries the backend it will run on.
                  Without this, the window between sending and dispatch is the
                  one place a backend change is invisible. */}
              {message.status === 'queued' && backendLabel(providers, message.model_provider_id, message.model) && (
                <span className="text-xs text-muted-foreground">
                  {backendLabel(providers, message.model_provider_id, message.model)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {run && (
        <div className="flex justify-start">
          <div className="max-w-[85%] w-full rounded-lg border border-border bg-card px-3 py-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={run.status} />
              <span className="text-xs text-muted-foreground">{fmt(run.created_at)}</span>
              {/* Which backend actually answered. Read from the message, which
                  carries what dispatch resolved, rather than re-deriving it
                  from the host's current default — that default may have
                  changed since this turn ran. */}
              {backendLabel(providers, message.model_provider_id, message.model) && (
                <span className="text-xs text-muted-foreground">
                  · {backendLabel(providers, message.model_provider_id, message.model)}
                </span>
              )}
            </div>
            {content.plan && content.plan.length > 0 && <PlanChecklist entries={content.plan} />}
            {finalBlock ? (
              <>
                {/* A reasoning block is already a disclosure of its own;
                    wrapping it in "earlier steps" buries it a second time and
                    calls it something it isn't. Only real steps get wrapped. */}
                {priorBlocks.length > 0 && (
                  priorBlocks.every(b => b.kind === 'thought')
                    ? priorBlocks.map(renderBlock)
                    : <PriorStepsCollapsible blocks={priorBlocks} />
                )}
                {renderBlock(finalBlock)}
              </>
            ) : (
              content.blocks.map(renderBlock)
            )}
            {isActive && <TypingIndicator />}
            <DiagnosticsDrawer lines={content.diagnostics} autoOpen={run.status === 'failed' || held} />
            {(run.status === 'failed' || held) && run.error_message && (
              <p className="text-xs text-destructive border border-destructive/20 rounded p-2 bg-destructive/5">{run.error_message}</p>
            )}
            {held && (
              // A held run was only actionable from the Run detail page, so
              // from here the thread simply stopped with no way to continue
              // it — the state names a review that had nowhere to happen.
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
                <span className="text-xs text-muted-foreground">Waiting for your review.</span>
                <Button size="sm" onClick={() => void recover('resume')} disabled={recoveryBusy}>
                  {recoveryBusy ? 'Working…' : 'Retry'}
                </Button>
                {confirmAbandon ? (
                  <>
                    <Button size="sm" variant="destructive" onClick={() => void recover('abandon')} disabled={recoveryBusy}>
                      Confirm abandon
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmAbandon(false)} disabled={recoveryBusy}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setConfirmAbandon(true)} disabled={recoveryBusy}>
                    Abandon
                  </Button>
                )}
              </div>
            )}
            {canShowDiff && (
              <div>
                <button className="text-xs text-accent-foreground hover:underline" onClick={() => setShowDiff(s => !s)}>
                  {showDiff ? 'Hide diff' : 'Review diff'}
                </button>
                {showDiff && <div className="mt-2"><RunDiff runId={run.id} /></div>}
              </div>
            )}
          </div>
        </div>
      )}

      {!run && message.status === 'dispatched' && (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-lg border border-border bg-card px-3 py-2">
            <TypingIndicator />
          </div>
        </div>
      )}
    </div>
  )
}

export default function ThreadConversation({
  thread,
  runs,
  providers,
  onThreadChanged,
}: {
  thread: HostTaskThread
  runs: Run[]
  /** Named so a turn can say which backend answered it. Passed in rather than
   *  fetched here: this screen mounts the composer alongside, and the same
   *  list serves both. Null while it is still loading, or if it failed. */
  providers: ModelProviderOut[] | null
  onThreadChanged: () => void
}) {
  const [messages, setMessages] = useState<HostThreadMessage[]>([])
  const [events, setEvents] = useState<HostThreadEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [resuming, setResuming] = useState(false)
  const cursorRef = useRef(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Only auto-scroll to newly arrived content while the reader was already
  // at (or near) the bottom — someone scrolled up to reread earlier turns
  // must not get yanked back down by the next poll tick, matching the
  // Room conversation's own follow-scroll convention (AgentGroupsPage.tsx).
  const followRef = useRef(true)

  const runsById = useMemo(() => new Map(runs.map(r => [r.id, r])), [runs])
  const activeRun = useMemo(() => runs.find(r => ACTIVE_RUN_STATUSES.has(r.status)) ?? null, [runs])

  const loadInitial = useCallback(async () => {
    setLoading(true)
    followRef.current = true
    try {
      const [messagesResult, eventsResult] = await Promise.all([
        hostsApi.listMessages(thread.id),
        hostsApi.listEvents(thread.id, -1),
      ])
      setMessages(messagesResult.items)
      setEvents(eventsResult.items)
      cursorRef.current = eventsResult.items.reduce((max, e) => Math.max(max, e.event_index), -1)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [thread.id])

  useEffect(() => { void loadInitial() }, [loadInitial])

  useEffect(() => {
    if (!activeRun) return
    const timer = window.setInterval(() => {
      void hostsApi.listEvents(thread.id, cursorRef.current)
        .then(result => {
          if (result.items.length === 0) return
          setEvents(current => [...current, ...result.items])
          cursorRef.current = result.items.reduce((max, e) => Math.max(max, e.event_index), cursorRef.current)
          // `activeRun` is derived from the `runs` prop, which this
          // component never fetches itself — nothing else re-polls it once
          // mounted. A `status` event is the run's own authoritative
          // started/succeeded/failed/timeout signal (remoteHostCliAdapter's
          // thread_event_sink), so it's what actually has to drive the
          // parent's reload; without this, `activeRun` would never go
          // false and Cancel/diagnostics/diff would stay stuck at
          // "still running" until an unrelated page action (discovery
          // review, P3).
          if (result.items.some(e => e.event_type === 'status')) onThreadChanged()
        })
        .catch(() => { /* transient poll failure — next tick retries */ })
    }, EVENT_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [activeRun, thread.id, onThreadChanged])

  // A run finishing (active -> terminal) can leave the last poll's cursor
  // behind its true final events (poll cadence vs. terminal-status timing);
  // refresh once more.
  const prevActiveRunId = useRef<string | null>(null)
  useEffect(() => {
    if (prevActiveRunId.current && !activeRun) {
      void hostsApi.listEvents(thread.id, cursorRef.current).then(result => {
        if (result.items.length === 0) return
        setEvents(current => [...current, ...result.items])
        cursorRef.current = result.items.reduce((max, e) => Math.max(max, e.event_index), cursorRef.current)
      })
    }
    prevActiveRunId.current = activeRun?.id ?? null
  }, [activeRun, thread.id])

  // `runs` changing means the parent just re-fetched after something
  // happened — a new dispatch, a cancel, a resume — so this is exactly the
  // signal to resync the message list right away. Without this, a message
  // the user just sent only appeared once its run reached a terminal
  // status (via the effect above), because nothing else re-fetched
  // `messages` in between — the user's own turn looked like it never sent
  // until the whole run finished (real-usage feedback).
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    void hostsApi.listMessages(thread.id).then(result => setMessages(result.items)).catch(() => { /* next runs update retries */ })
  }, [runs, thread.id])

  useEffect(() => {
    const container = scrollRef.current
    // jsdom (this repo's test environment) has no `Element.scrollTo` — the
    // same guard `AgentGroupsPage.tsx`'s own follow-scroll effect uses.
    if (loading || !container || !followRef.current || typeof container.scrollTo !== 'function') return
    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, events, loading])

  async function withdraw(messageId: string) {
    try {
      await hostsApi.withdrawMessage(thread.id, messageId)
      setMessages(current => current.map(m => (m.id === messageId ? { ...m, status: 'withdrawn' } : m)))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function cancel() {
    setCancelling(true)
    try {
      await hostsApi.cancel(thread.id)
      toast.success('Cancel requested')
      onThreadChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setCancelling(false)
    }
  }

  async function resume() {
    setResuming(true)
    try {
      await hostsApi.resumeQueue(thread.id)
      onThreadChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setResuming(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const queuedMessages = messages.filter(m => m.status === 'queued')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(thread.queue_paused_at || activeRun) && (
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          {thread.queue_paused_at ? (
            <div className="text-sm">
              <Badge variant="warning">Queue paused</Badge>
              <span className="ml-2 text-muted-foreground">
                {queuedMessages.length > 0 ? `${queuedMessages.length} message(s) waiting` : 'Waiting for you to resume'}
              </span>
            </div>
          ) : <span />}
          {thread.queue_paused_at && (
            <Button size="sm" variant="outline" onClick={resume} disabled={resuming}>
              {resuming ? 'Resuming…' : 'Resume'}
            </Button>
          )}
          {activeRun && (
            <Button size="sm" variant="destructive" onClick={cancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4"
        onScroll={event => {
          const container = event.currentTarget
          const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
          followRef.current = distanceFromBottom <= NEAR_BOTTOM_PX
        }}
      >
        {messages.map(message => (
          <div key={message.id}>
            <TurnCard
              message={message}
              run={message.run_id ? runsById.get(message.run_id) ?? null : null}
              events={message.run_id ? events.filter(e => e.run_id === message.run_id) : []}
              providers={providers}
              onRunChanged={onThreadChanged}
            />
            {message.status === 'queued' && (
              <div className="flex justify-end mt-1">
                <button className="text-xs text-muted-foreground hover:underline" onClick={() => withdraw(message.id)}>
                  Withdraw
                </button>
              </div>
            )}
          </div>
        ))}
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages yet in this conversation.</p>
        )}
      </div>
    </div>
  )
}
