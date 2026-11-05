import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { HostOrdinaryTool, HostOrdinaryToolsResponse, OrdinaryToolReport } from '@rainver/protocol'
import { ApiRequestError, ordinaryToolsApi } from '../../../api/client'
import { useAppTranslation } from '../../../i18n'
import { Button } from '../../../components/ui/button'
import { Badge } from '../../../components/ui/badge'
import { Input } from '../../../components/ui/input'
import { errMsg } from '../../../lib/utils'
import OrdinaryAccountCard from './OrdinaryAccountCard'

/**
 * The ordinary CLI tools of one Host (`GET /hosts/:id/ordinary-tools`). Mount
 * it keyed by Host so nothing of a previous Host survives a switch; a reload
 * within the same Host keeps only the newest answer. Management buttons
 * appear only when the server says this person may manage the Host — the
 * server checks again on every action.
 */
/** While a tool operation runs, or an action's report is unconfirmed, the list is read again this often. */
const OPERATION_POLL_MS = 3_000
/** How many list reads an action's report waits for the server to record it before saying so. */
const CONFIRM_POLLS = 10

/** The Host's own answer to an action, applied to the row it changed. */
export function withReport(tool: HostOrdinaryTool, report: OrdinaryToolReport): HostOrdinaryTool {
  const catalog = tool.managed.catalog_version
  return {
    ...tool,
    host_status: report.status,
    source: report.source,
    version: report.version,
    version_text: report.version_text,
    registered: report.registered,
    reported_live: true,
    managed: {
      ...tool.managed,
      installed_version: report.managed_version,
      update_available: Boolean(report.managed_version && catalog && report.managed_version !== catalog),
    },
  }
}

/** What identifies a tool's installed state; the account card re-reads when it changes. */
export function toolStateSignature(tool: HostOrdinaryTool): string {
  return [tool.host_status, tool.source, tool.version, tool.managed.installed_version, tool.registered].join('|')
}

export default function CliToolsPanel({ hostId, hostKind }: { hostId: string; hostKind: 'server' | 'remote' }) {
  const { t } = useAppTranslation()
  const [view, setView] = useState<HostOrdinaryToolsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  // An action's report for a tool that the server's list (fed by the Host's
  // heartbeat, the same record the account endpoint checks) has not shown yet.
  const [pending, setPending] = useState<Record<string, { tool: HostOrdinaryTool; polls: number }>>({})
  // An operation seen running (from any page) that has ended, while the list
  // still shows the state from before it: the stored heartbeat may trail the
  // operation's end. Its result is unknown until the list changes.
  const [settling, setSettling] = useState<Record<string, { before: string; polls: number }>>({})
  // Bumped when the list confirms a report or shows an operation's result:
  // the account card then reads again.
  const [confirmed, setConfirmed] = useState<Record<string, number>>({})
  const sequence = useRef(0)
  const alive = useRef(true)
  const previousView = useRef<HostOrdinaryToolsResponse | null>(null)
  const settlingRef = useRef(settling)
  settlingRef.current = settling

  const load = useCallback(async () => {
    const mine = ++sequence.current
    try {
      const next = await ordinaryToolsApi.list(hostId)
      if (alive.current && mine === sequence.current) { setView(next); setError(null) }
    } catch (caught) {
      if (alive.current && mine === sequence.current) setError(errMsg(caught))
    }
  }, [hostId])

  useEffect(() => {
    alive.current = true
    // A different Host: nothing of the previous one stays on screen.
    setView(null)
    setError(null)
    setPending({})
    setSettling({})
    setConfirmed({})
    previousView.current = null
    void load()
    return () => { alive.current = false }
  }, [load])

  // A list that shows what a report said confirms it.
  useEffect(() => {
    if (!view) return
    const matched = Object.keys(pending).filter((toolId) => {
      const listed = view.tools.find((entry) => entry.tool_id === toolId)
      return !listed || toolStateSignature(listed) === toolStateSignature(pending[toolId].tool)
    })
    if (matched.length === 0) return
    setPending((previous) => Object.fromEntries(Object.entries(previous).filter(([toolId]) => !matched.includes(toolId))))
    setConfirmed((previous) => ({ ...previous, ...Object.fromEntries(matched.map((toolId) => [toolId, (previous[toolId] ?? 0) + 1])) }))
  }, [view, pending])

  // An operation that ended is followed until the list shows a different
  // state. An unchanged state is not a failure (a reinstall of the same
  // version changes nothing), so it only ends the reads at their bound.
  useEffect(() => {
    const before = previousView.current
    previousView.current = view
    if (!view) return
    const signatureOf = (list: HostOrdinaryToolsResponse, toolId: string) => {
      const listed = list.tools.find((entry) => entry.tool_id === toolId)
      return listed ? toolStateSignature(listed) : null
    }
    const runningNow = new Set(view.operations.map((operation) => operation.tool_id))
    const ended = (before?.operations ?? []).map((operation) => operation.tool_id).filter((toolId) => !runningNow.has(toolId))
    const next = { ...settlingRef.current }
    for (const toolId of runningNow) delete next[toolId]
    for (const toolId of ended) next[toolId] = { before: signatureOf(before!, toolId) ?? '', polls: 0 }
    const shown = Object.keys(next).filter((toolId) => signatureOf(view, toolId) !== next[toolId].before)
    for (const toolId of shown) delete next[toolId]
    if (ended.length === 0 && shown.length === 0 && !Array.from(runningNow).some((toolId) => toolId in settlingRef.current)) return
    setSettling(next)
    // An ended operation, and later its result, each make the account read again.
    const reread = [...new Set([...ended, ...shown])]
    if (reread.length > 0) setConfirmed((previous) => ({ ...previous, ...Object.fromEntries(reread.map((toolId) => [toolId, (previous[toolId] ?? 0) + 1])) }))
  }, [view])

  // A running operation, an ended one not yet shown, or a report not yet
  // confirmed (each for a bounded number of reads) is followed by reading
  // the list again. Nothing in progress: no reads.
  const operationsRunning = (view?.operations.length ?? 0) > 0
  const confirming = Object.values(pending).some((entry) => entry.polls < CONFIRM_POLLS)
    || Object.values(settling).some((entry) => entry.polls < CONFIRM_POLLS)
  useEffect(() => {
    if (!operationsRunning && !confirming) return
    const timer = setTimeout(() => {
      const bump = <T extends { polls: number }>(previous: Record<string, T>) =>
        Object.fromEntries(Object.entries(previous).map(([toolId, entry]) => [toolId, { ...entry, polls: entry.polls + 1 }]))
      setPending(bump)
      setSettling(bump)
      void load()
    }, OPERATION_POLL_MS)
    return () => clearTimeout(timer)
  }, [operationsRunning, confirming, view, pending, settling, load])

  const viewRef = useRef(view)
  viewRef.current = view
  const onReport = useCallback((toolId: string, report: OrdinaryToolReport | null) => {
    const tool = report ? viewRef.current?.tools.find((entry) => entry.tool_id === toolId) : undefined
    if (!tool || !report) return
    setPending((previous) => ({ ...previous, [toolId]: { tool: withReport(tool, report), polls: 0 } }))
  }, [])
  const checkAgain = (toolId: string) => {
    setPending((previous) => previous[toolId] ? { ...previous, [toolId]: { ...previous[toolId], polls: 0 } } : previous)
    setSettling((previous) => previous[toolId] ? { ...previous, [toolId]: { ...previous[toolId], polls: 0 } } : previous)
    void load()
  }

  if (!view) {
    return error
      ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{t('cli_tools.load_failed')} {error}</p>
          <Button size="sm" variant="outline" onClick={() => { setError(null); void load() }}>{t('cli_tools.retry')}</Button>
        </div>
      )
      : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('cli_tools.loading')}</p>
  }
  // A list that has not caught up with an action yet does not undo its report.
  const tools = view.tools.map((tool) => pending[tool.tool_id]?.tool ?? tool)
  const anyReported = view.tools.some((tool) => tool.host_status !== 'unknown')
  const banner = view.host_state === 'update_required' ? t('cli_tools.host_update_required')
    : view.host_state === 'offline' ? (anyReported ? t('cli_tools.host_offline') : t('cli_tools.host_offline_unknown'))
      : null
  const online = view.host_state === 'online'

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('cli_tools.intro')}</p>
      {banner && <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm">{banner}</p>}
      {!view.can_manage && hostKind === 'server' && <p className="text-xs text-muted-foreground">{t('cli_tools.manage_hint_admin')}</p>}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>{t('cli_tools.retry')}</Button>
        </div>
      )}
      <ul className="space-y-1">
      {tools.map((tool) => (
        <ToolRow key={`${hostId}:${tool.tool_id}`} hostId={hostId} tool={tool} online={online} canManage={view.can_manage}
          running={view.operations.some((operation) => operation.tool_id === tool.tool_id)}
          unconfirmed={(pending[tool.tool_id]?.polls ?? 0) >= CONFIRM_POLLS ? 'report'
            : (settling[tool.tool_id]?.polls ?? 0) >= CONFIRM_POLLS ? 'operation' : null}
          onCheckAgain={() => checkAgain(tool.tool_id)}
          confirmations={confirmed[tool.tool_id] ?? 0}
          onReport={(report) => onReport(tool.tool_id, report)} onChanged={load} />
      ))}
      </ul>
    </div>
  )
}

function ToolRow({ hostId, tool, online, canManage, running, unconfirmed, onCheckAgain, confirmations, onReport, onChanged }: {
  hostId: string; tool: HostOrdinaryTool; online: boolean; canManage: boolean; running: boolean
  unconfirmed: 'report' | 'operation' | null; onCheckAgain: () => void; confirmations: number
  onReport: (report: OrdinaryToolReport | null) => void; onChanged: () => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [busy, setBusy] = useState<'install' | 'remove' | 'register' | null>(null)
  const [registering, setRegistering] = useState(false)
  const [path, setPath] = useState('')
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const messageRef = useRef<HTMLParagraphElement>(null)
  // An installed or removed tool swaps its buttons; the result keeps the focus.
  useEffect(() => {
    if (!busy && document.activeElement === document.body) messageRef.current?.focus()
  }, [busy])

  const run = async (kind: 'install' | 'remove' | 'register', action: () => Promise<unknown>) => {
    setBusy(kind)
    setMessage(null)
    try {
      // The Host answers with the tool's state after the operation; that is
      // newer than the heartbeat-fed list, which may still lag behind it.
      const result = await action() as { tool?: OrdinaryToolReport | null } | null
      onReport(result?.tool ?? null)
      setMessage({ tone: 'info', text: t('cli_tools.action_done') })
      if (kind === 'register') { setRegistering(false); setPath('') }
    } catch (caught) {
      // A refusal still carries the Host's report of what is there now.
      const payload = caught instanceof ApiRequestError ? caught.payload as { tool?: OrdinaryToolReport | null } | undefined : undefined
      onReport(payload?.tool ?? null)
      setMessage({ tone: 'error', text: t('cli_tools.action_failed', { detail: errMsg(caught) }) })
    } finally {
      setBusy(null)
      await onChanged()
    }
  }

  const manage = canManage && online && !running && !busy
  const managed = tool.managed
  const showInstall = managed.installable && managed.catalog_version && (!managed.installed_version || managed.update_available)
  const statusVariant = tool.host_status === 'available' ? 'secondary' : 'outline'

  const actions = canManage && online
  const details = running || unconfirmed || registering || message || tool.requires_account

  // The same row as a Host's Agent (`HostAgentRow`): name, then state and
  // actions on one line. What does not fit a line goes below it.
  return (
    <li className="min-w-0 rounded-md border border-border text-xs" data-testid={`host-cli-tool-${hostId}-${tool.tool_id}`}>
      <div className="flex min-w-0 flex-col items-start gap-2 px-2 py-1.5 sm:flex-row sm:items-center">
        <span className="w-28 shrink-0 truncate font-medium" title={tool.label}>{tool.label}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <code className="text-muted-foreground">{tool.executable}</code>
          <Badge variant={statusVariant}>
            {t(`cli_tools.status_${tool.host_status}`)}{tool.version ? ` · ${tool.version}` : ''}
          </Badge>
          {tool.source && <Badge variant="outline">{t(`cli_tools.source_${tool.source}`)}</Badge>}
          {!tool.reported_live && tool.host_status !== 'unknown' && <Badge variant="outline">{t('cli_tools.last_report')}</Badge>}
          <span className="text-muted-foreground">{t('cli_tools.sandbox_not_verified')}</span>
          {actions && showInstall && (
            <Button size="sm" disabled={!manage} onClick={() => void run('install', () => ordinaryToolsApi.install(hostId, tool.tool_id))}>
              {busy === 'install' ? t('cli_tools.installing')
                : managed.installed_version ? t('cli_tools.update', { version: managed.catalog_version }) : t('cli_tools.install', { version: managed.catalog_version })}
            </Button>
          )}
          {actions && managed.installed_version && (
            <Button size="sm" variant="outline" disabled={!manage} onClick={() => void run('remove', () => ordinaryToolsApi.remove(hostId, tool.tool_id, 'managed'))}>
              {busy === 'remove' ? t('cli_tools.removing') : t('cli_tools.remove_managed')}
            </Button>
          )}
          {actions && (tool.registered ? (
            <Button size="sm" variant="outline" disabled={!manage} onClick={() => void run('remove', () => ordinaryToolsApi.remove(hostId, tool.tool_id, 'registered'))}>
              {busy === 'remove' ? t('cli_tools.removing') : t('cli_tools.remove_registration')}
            </Button>
          ) : !registering && (
            <Button size="sm" variant="ghost" disabled={!manage} onClick={() => setRegistering(true)}>{t('cli_tools.register')}</Button>
          ))}
        </span>
      </div>
      {details && (
      <div className="space-y-2 border-t border-border px-2 py-2">
      {running && <p role="status" className="text-muted-foreground">{t('cli_tools.operation_running')}</p>}
      {unconfirmed && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>{t(unconfirmed === 'report' ? 'cli_tools.report_unconfirmed' : 'cli_tools.operation_unconfirmed')}</span>
          <Button size="sm" variant="outline" onClick={onCheckAgain}>{t('cli_tools.check_again')}</Button>
        </div>
      )}
      {registering && (
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run('register', () => ordinaryToolsApi.register(hostId, tool.tool_id, path.trim() || null)) }}>
          <label className="block space-y-1">
            <span>{t('cli_tools.register_path')}</span>
            <Input value={path} onChange={(event) => setPath(event.target.value)} placeholder={`/usr/local/bin/${tool.executable}`} disabled={busy === 'register'} />
          </label>
          <p className="text-muted-foreground">{t('cli_tools.register_path_help')}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy === 'register'}>{busy === 'register' ? t('cli_tools.registering') : t('cli_tools.register_submit')}</Button>
            <Button size="sm" type="button" variant="ghost" disabled={busy === 'register'} onClick={() => { setRegistering(false); setPath('') }}>{t('cli_tools.cancel')}</Button>
          </div>
        </form>
      )}
      {message && <p ref={messageRef} tabIndex={-1} role={message.tone === 'error' ? 'alert' : 'status'} className={`outline-none ${message.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{message.text}</p>}
      {tool.requires_account && (
        <OrdinaryAccountCard key={`${hostId}:${tool.tool_id}`} hostId={hostId} toolId={tool.tool_id}
          toolState={`${toolStateSignature(tool)}#${confirmations}`} toolAvailable={tool.host_status === 'available'} />
      )}
      </div>
      )}
    </li>
  )
}
