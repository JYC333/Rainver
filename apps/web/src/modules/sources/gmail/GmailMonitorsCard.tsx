import { useCallback, useEffect, useState } from 'react'
import { BellRing, ExternalLink } from 'lucide-react'
import type { GmailConnection, GmailMailboxSyncStatus, GmailMonitor, GmailMonitorCriteria, GmailMonitorList } from '@rainver/protocol'
import { GMAIL_CLEARING_FAILURES, gmailApi, gmailFailure, type GmailFailure, type GmailMonitorDraft } from '../../../api/gmail'
import { useSpace } from '../../../contexts/SpaceContext'
import { useAppTranslation } from '../../../i18n'
import { formatDateTime } from '../../../i18n/format'
import { SafeExternalLink } from '../../../components/SafeExternalLink'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { StatusBadge } from '../../../components/ui/badge'
import { ConfirmDialog } from '../../../components/ui/dialog'
import { useGmailScope } from './useGmailScope'

type Loaded = { scope: string; monitors: GmailMonitorList; drafts: GmailMonitorDraft[]; connections: GmailConnection[] }

/**
 * The person's own Gmail new-mail monitors in the active Space: drafts an
 * Agent wrote (accept / decline — the ordinary proposal decision), monitors
 * (pause, resume, delete), content-free check status per mailbox, and recent
 * matches as Gmail links only. No subject, sender or text is ever shown here,
 * because none is stored; the reminder itself is a private Inbox pointer.
 */
export function GmailMonitorsCard() {
  const { activeSpaceId, userId } = useSpace()
  const { t } = useAppTranslation()
  const spaceId = activeSpaceId ?? ''
  const scopeKey = `${userId}|${spaceId}`
  const { run, invalidate, keyFor, settle, exclusive } = useGmailScope(scopeKey)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<{ scope: string; kind: GmailFailure } | null>(null)
  const [actionFailure, setActionFailure] = useState<{ scope: string; kind: GmailFailure } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<GmailMonitor | null>(null)

  const clear = useCallback(() => { invalidate(); setLoaded(null); setBusy(null); setDeleting(null); setActionFailure(null) }, [invalidate])

  const load = useCallback(async () => {
    if (!spaceId) return
    const result = await run(signal => Promise.all([
      gmailApi.monitors({ spaceId, signal }), gmailApi.monitorDrafts({ spaceId, signal }), gmailApi.connections({ spaceId, signal }),
    ]), 'list')
    if (!result) return
    if (result.ok) {
      const [monitors, drafts, list] = result.value
      setLoaded({ scope: scopeKey, monitors, drafts, connections: list.connections }); setFailure(null); return
    }
    const kind = gmailFailure(result.error)
    if (GMAIL_CLEARING_FAILURES.has(kind)) clear(); else setLoaded(null)
    setFailure({ scope: scopeKey, kind })
  }, [clear, run, scopeKey, spaceId])
  useEffect(() => { setLoaded(null); setFailure(null); setActionFailure(null); setBusy(null); setDeleting(null); void load() }, [load])

  const data = loaded?.scope === scopeKey ? loaded : null
  const error = failure?.scope === scopeKey ? failure.kind : null
  const actionError = actionFailure?.scope === scopeKey ? actionFailure.kind : null

  /** One write per intent; its key survives a lost reply, so a retry replays the receipt. */
  const write = (intent: string, call: (key: string, signal: AbortSignal) => Promise<unknown>) => exclusive(intent, async () => {
    setBusy(intent); setActionFailure(null)
    const key = keyFor(intent)
    const result = await run(signal => call(key, signal))
    if (!result) return
    setBusy(null)
    if (result.ok) { settle(intent); await load(); return }
    const kind = gmailFailure(result.error)
    if (GMAIL_CLEARING_FAILURES.has(kind)) { settle(intent); clear(); setFailure({ scope: scopeKey, kind }); await load(); return }
    setActionFailure({ scope: scopeKey, kind })
    await load()
  })
  const decide = (draft: GmailMonitorDraft, decision: 'accept' | 'reject') =>
    write(`${decision}:${draft.id}`, (key, signal) => gmailApi.decideMonitorDraft(draft.id, decision, key, { spaceId, signal }))
  const setStatus = (monitor: GmailMonitor, status: 'active' | 'paused') =>
    write(`${status}:${monitor.id}`, (key, signal) => gmailApi.setMonitorStatus(monitor.id, status, key, { spaceId, signal }))
  const remove = (monitor: GmailMonitor) =>
    write(`delete:${monitor.id}`, (key, signal) => gmailApi.deleteMonitor(monitor.id, key, { spaceId, signal }))

  const mailbox = (connectionId: string) => data?.connections.find(c => c.id === connectionId)?.mailbox_email ?? null
  const syncOf = (connectionId: string) => data?.monitors.sync.find(s => s.connection_id === connectionId) ?? null
  const watched = data ? [...new Set(data.monitors.monitors.map(m => m.connection_id))] : []
  return <Card className="m-4 max-w-xl space-y-4 p-6" aria-labelledby="gmail-monitors-title">
    <div className="space-y-1">
      <h2 id="gmail-monitors-title" className="flex items-center gap-2 text-base font-semibold"><BellRing className="size-4" aria-hidden="true" />{t('gmail_ui.monitors.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('gmail_ui.monitors.intro')}</p>
    </div>
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">{t('gmail_ui.monitors.loading')}</p>}
    {error && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-3 text-sm">
      <span>{t(`gmail_ui.errors.${error}`)}</span>
      <Button size="sm" variant="outline" onClick={() => void load()}>{t('gmail_ui.errors.retry')}</Button>
    </div>}
    {actionError && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">{t(`gmail_ui.errors.${actionError}`)}</p>}

    {data && data.drafts.length > 0 && <section className="space-y-2" aria-labelledby="gmail-monitor-drafts">
      <h3 id="gmail-monitor-drafts" className="text-sm font-medium">{t('gmail_ui.monitors.drafts')}</h3>
      <ul className="space-y-2">{data.drafts.map(draft => <li key={draft.id} className="space-y-2 rounded-md border border-border p-3">
        <p className="break-words text-sm">{draft.purpose}</p>
        <Criteria criteria={draft.criteria} />
        {mailbox(draft.connection_id) && <p className="break-all text-xs text-muted-foreground">{t('gmail_ui.monitors.mailbox', { email: mailbox(draft.connection_id) })}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy !== null} onClick={() => void decide(draft, 'accept')}>{t('gmail_ui.monitors.accept')}</Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide(draft, 'reject')}>{t('gmail_ui.monitors.decline')}</Button>
        </div>
      </li>)}</ul>
    </section>}

    {data && data.monitors.monitors.length === 0 && data.drafts.length === 0 && <p className="text-sm text-muted-foreground">{t('gmail_ui.monitors.empty')}</p>}
    {data && data.monitors.monitors.length > 0 && <section className="space-y-3" aria-labelledby="gmail-monitor-list">
      <h3 id="gmail-monitor-list" className="text-sm font-medium">{t('gmail_ui.monitors.active')}</h3>
      {watched.map(connectionId => <div key={connectionId} className="space-y-2">
        {mailbox(connectionId) && <p className="break-all text-xs font-medium">{t('gmail_ui.monitors.mailbox', { email: mailbox(connectionId) })}</p>}
        <SyncLine sync={syncOf(connectionId)} />
        <ul className="space-y-2">{data.monitors.monitors.filter(m => m.connection_id === connectionId).map(monitor => <li key={monitor.id} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 break-words text-sm">{monitor.purpose}</p>
            <StatusBadge status={monitor.status === 'active' ? 'active' : 'inactive'} label={t(`gmail_ui.monitors.status.${monitor.status}`)} />
          </div>
          <Criteria criteria={monitor.criteria} />
          <p className="text-xs text-muted-foreground">{[
            t('gmail_ui.monitors.since', { date: formatDateTime(monitor.active_since) }),
            t('gmail_ui.monitors.matches', { count: monitor.match_count }),
            monitor.last_matched_at ? t('gmail_ui.monitors.last_match', { date: formatDateTime(monitor.last_matched_at) }) : null,
          ].filter(Boolean).join(' · ')}</p>
          {monitor.project_id && <p className="text-xs text-muted-foreground">{t('gmail_ui.monitors.project_context')}</p>}
          <div className="flex flex-wrap gap-2">
            {monitor.status === 'active'
              ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void setStatus(monitor, 'paused')}>{t('gmail_ui.monitors.pause')}</Button>
              : <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void setStatus(monitor, 'active')}>{t('gmail_ui.monitors.resume')}</Button>}
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setDeleting(monitor)}>{t('gmail_ui.monitors.delete')}</Button>
          </div>
        </li>)}</ul>
      </div>)}
    </section>}

    {data && data.monitors.recent_matches.length > 0 && <section className="space-y-2" aria-labelledby="gmail-monitor-recent">
      <h3 id="gmail-monitor-recent" className="text-sm font-medium">{t('gmail_ui.monitors.recent')}</h3>
      <ul className="space-y-1">{data.monitors.recent_matches.slice(0, 10).map(match => <li key={`${match.monitor_id}:${match.google_message_id}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-xs text-muted-foreground">{formatDateTime(match.matched_at)}</span>
        <Button size="sm" variant="ghost" asChild><SafeExternalLink href={match.gmail_url}><ExternalLink className="size-4" aria-hidden="true" />{t('gmail_ui.monitors.open_match')}</SafeExternalLink></Button>
      </li>)}</ul>
    </section>}
    <ConfirmDialog
      open={deleting !== null}
      onOpenChange={open => { if (!open) setDeleting(null) }}
      title={t('gmail_ui.monitors.delete_title')}
      description={t('gmail_ui.monitors.delete_body')}
      confirmLabel={t('gmail_ui.monitors.delete')}
      onConfirm={() => { if (deleting) void remove(deleting) }}
    />
  </Card>
}

function Criteria({ criteria }: { criteria: GmailMonitorCriteria }) {
  const { t } = useAppTranslation()
  const lines = [
    criteria.from_any.length ? t('gmail_ui.monitors.from', { values: criteria.from_any.join(', ') }) : null,
    criteria.subject_any.length ? t('gmail_ui.monitors.subject', { values: criteria.subject_any.join(', ') }) : null,
    criteria.label_any.length ? t('gmail_ui.monitors.labels', { values: criteria.label_any.join(', ') }) : null,
  ].filter((line): line is string => line !== null)
  return <ul className="space-y-0.5 text-xs text-muted-foreground">{lines.map(line => <li key={line} className="break-words">{line}</li>)}</ul>
}

function SyncLine({ sync }: { sync: GmailMailboxSyncStatus | null }) {
  const { t } = useAppTranslation()
  if (!sync) return null
  const mode = sync.push === 'active' ? 'push_active' : sync.push === 'inactive' ? 'push_inactive' : 'not_configured'
  return <div className="space-y-1 text-xs text-muted-foreground" role="status">
    <p>{[t(`gmail_ui.monitors.sync.${mode}`),
      sync.last_success_at ? t('gmail_ui.monitors.sync.checked', { date: formatDateTime(sync.last_success_at) }) : t('gmail_ui.monitors.sync.never'),
      sync.next_check_at ? t('gmail_ui.monitors.sync.next', { date: formatDateTime(sync.next_check_at) }) : null,
    ].filter(Boolean).join(' · ')}</p>
    {sync.state !== 'ok' && <p>{t(`gmail_ui.monitors.sync.${sync.state}`)}</p>}
    {sync.recovery_partial && <p className="text-foreground">{t('gmail_ui.monitors.sync.partial')}</p>}
    {sync.last_error_code && sync.state === 'ok' && <p>{t('gmail_ui.monitors.sync.error', { code: sync.last_error_code })}</p>}
  </div>
}
