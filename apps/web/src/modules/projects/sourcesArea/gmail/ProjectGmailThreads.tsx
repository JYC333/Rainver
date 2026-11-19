import { useCallback, useEffect, useState } from 'react'
import { Lock, Trash2 } from 'lucide-react'
import type { GmailConnection, GmailThreadSelection } from '@rainver/protocol'
import { projectsApi } from '../../../../api/client'
import { GMAIL_CLEARING_FAILURES, gmailApi, gmailFailure, type GmailFailure } from '../../../../api/gmail'
import { useSpace } from '../../../../contexts/SpaceContext'
import { SpaceLink } from '../../../../core/spaceNav'
import { useAppTranslation } from '../../../../i18n'
import { formatDate } from '../../../../i18n/format'
import type { Project } from '../../../../types/api'
import { Button } from '../../../../components/ui/button'
import { Card } from '../../../../components/ui/card'
import { Select } from '../../../../components/ui/select'
import { useGmailScope } from '../../../sources/gmail/useGmailScope'
import { GmailThreadReader } from './GmailThreadReader'

/**
 * The signed-in person's private Gmail in one Project. Gmail V2 retired the
 * manual search and thread selection: new mail is watched by the person's own
 * monitors (Sources → Access and Gmail). What stays here is the person's
 * earlier selections for this Project, still readable and removable by them
 * alone. Owner-private: nothing here is shown to other Project members. Every
 * scope (person, Space, Project, connection) is its own mounted instance, so
 * a change drops selections and mail in the same render and aborts requests.
 */
export function ProjectGmailThreads({ projectId }: { projectId: string }) {
  const { activeSpaceId, userId } = useSpace()
  if (!activeSpaceId || !userId || !projectId) return null
  return <ProjectGmailScope key={`${userId}|${activeSpaceId}|${projectId}`} spaceId={activeSpaceId} projectId={projectId} />
}

function ErrorLine({ kind, onRetry }: { kind: GmailFailure; onRetry?: () => void }) {
  const { t } = useAppTranslation()
  return <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-3 text-sm">
    <span>{t(`gmail_ui.errors.${kind}`)}</span>
    {kind === 'reauth' && <Button size="sm" variant="outline" asChild><SpaceLink to="/sources/access">{t('gmail_ui.project.open_connections')}</SpaceLink></Button>}
    {onRetry && !GMAIL_CLEARING_FAILURES.has(kind) && <Button size="sm" variant="outline" onClick={onRetry}>{t('gmail_ui.errors.retry')}</Button>}
  </div>
}

function ProjectGmailScope({ spaceId, projectId }: { spaceId: string; projectId: string }) {
  const { t } = useAppTranslation()
  const { run } = useGmailScope('project')
  const [project, setProject] = useState<Project | null>(null)
  const [connections, setConnections] = useState<{ configured: boolean; items: GmailConnection[] } | null>(null)
  const [failure, setFailure] = useState<GmailFailure | null>(null)
  const [connectionId, setConnectionId] = useState('')

  const load = useCallback(async () => {
    setFailure(null)
    const result = await run(async signal => Promise.all([
      projectsApi.get(projectId, { spaceId, signal }),
      gmailApi.connections({ spaceId, signal }),
    ]), 'load')
    if (!result) return
    if (!result.ok) { setProject(null); setConnections(null); setFailure(gmailFailure(result.error)); return }
    const [nextProject, list] = result.value
    setProject(nextProject)
    setConnections({ configured: list.configured, items: list.connections })
    setConnectionId(current => list.connections.some(c => c.id === current)
      ? current : (list.connections.find(c => c.status === 'active') ?? list.connections[0])?.id ?? '')
  }, [projectId, run, spaceId])
  useEffect(() => { void load() }, [load])

  const connection = connections?.items.find(c => c.id === connectionId) ?? null
  return <Card className="space-y-4 p-4" aria-labelledby="project-gmail-title">
    <div className="space-y-1">
      <h2 id="project-gmail-title" className="flex items-center gap-2 text-base font-semibold"><Lock className="size-4" aria-hidden="true" />{t('gmail_ui.project.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('gmail_ui.project.intro')}</p>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>{t('gmail_ui.project.monitoring_hint')}</span>
      <Button size="sm" variant="outline" asChild><SpaceLink to="/sources/access">{t('gmail_ui.project.open_monitoring')}</SpaceLink></Button>
    </div>
    {!connections && !failure && <p role="status" className="text-sm text-muted-foreground">{t('gmail_ui.connections.loading')}</p>}
    {failure && <ErrorLine kind={failure} onRetry={() => void load()} />}
    {connections && !connections.configured && <p role="note" className="text-sm">{t('gmail_ui.connections.not_configured')}</p>}
    {connections && connections.configured && connections.items.length === 0 && <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>{t('gmail_ui.project.no_connection')}</span>
      <Button size="sm" variant="outline" asChild><SpaceLink to="/sources/access">{t('gmail_ui.project.open_connections')}</SpaceLink></Button>
    </div>}
    {connections && connections.items.length > 0 && <div className="space-y-1">
      <span className="text-sm font-medium" id="project-gmail-connection">{t('gmail_ui.project.connection')}</span>
      <Select ariaLabel={t('gmail_ui.project.connection')} value={connectionId} onChange={setConnectionId}
        options={connections.items.map(c => ({ value: c.id, label: `${c.mailbox_email} · ${t(`gmail_ui.connections.status.${c.status}`)}` }))} />
    </div>}
    {project && connection && <ProjectGmailConnection key={connection.id} spaceId={spaceId} project={project} connection={connection} />}
  </Card>
}

function ProjectGmailConnection({ spaceId, project, connection }: { spaceId: string; project: Project; connection: GmailConnection }) {
  const { t } = useAppTranslation()
  const { run, invalidate, keyFor, settle, exclusive } = useGmailScope('connection')
  const [selections, setSelections] = useState<GmailThreadSelection[] | null>(null)
  const [selectionFailure, setSelectionFailure] = useState<GmailFailure | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionFailure, setActionFailure] = useState<GmailFailure | null>(null)
  // A refusal that removed everything this connection showed.
  const [denied, setDenied] = useState<GmailFailure | null>(null)
  const [reading, setReading] = useState<string | null>(null)

  const active = connection.status === 'active'

  /**
   * The one path for every clearing refusal (401/403/404, reauth, inactive,
   * changed) from the selection list, remove or the reader: every request of
   * this connection started so far is aborted and can no longer deliver, and
   * selections and the open reader go in the same render.
   */
  const clear = useCallback((kind: GmailFailure) => {
    invalidate()
    setSelections(null); setSelectionFailure(null)
    setBusy(null); setActionFailure(null)
    setReading(null)
    setDenied(kind)
  }, [invalidate])

  // Only the newest list read can land: a refresh after a write supersedes a slower earlier read.
  const loadSelections = useCallback(async () => {
    const result = await run(signal => gmailApi.selections({ project_id: project.id, connection_id: connection.id }, { spaceId, signal }), 'selections')
    if (!result) return
    if (result.ok) { setSelections(result.value); setSelectionFailure(null); return }
    const kind = gmailFailure(result.error)
    if (GMAIL_CLEARING_FAILURES.has(kind)) clear(kind)
    else setSelectionFailure(kind)
  }, [clear, connection.id, project.id, run, spaceId])
  useEffect(() => { void loadSelections() }, [loadSelections])

  // After a hidden 404 or a withdrawal, a fresh list read (a new generation) shows what is still the person's.
  const refuse = useCallback((kind: GmailFailure) => {
    clear(kind)
    if (kind === 'gone' || kind === 'changed') void loadSelections()
  }, [clear, loadSelections])

  /** A write's outcome: success or an ordinary failure re-reads the list (superseding any older read); a clearing refusal clears. */
  const write = (intent: string, call: (signal: AbortSignal) => Promise<unknown>) => exclusive(intent, async () => {
    setBusy(intent); setActionFailure(null)
    const result = await run(call)
    if (!result) return
    setBusy(null)
    if (result.ok) { settle(intent); setDenied(null); await loadSelections(); return }
    const kind = gmailFailure(result.error)
    if (GMAIL_CLEARING_FAILURES.has(kind)) { settle(intent); refuse(kind); return }
    setActionFailure(kind)
    await loadSelections()
  })
  const remove = (selection: GmailThreadSelection) => {
    const intent = `remove:${selection.id}`
    // The body goes away at once; a failed removal can be retried.
    if (reading === selection.id) setReading(null)
    return write(intent, signal => gmailApi.removeSelection(selection.id, keyFor(intent), { spaceId, signal }))
  }

  const label = (s: GmailThreadSelection) => t('gmail_ui.project.selection_label', { date: formatDate(s.created_at) })
  const open = selections?.find(s => s.id === reading) ?? null
  return <div className="space-y-4">
    {!active && <ErrorLine kind={connection.status === 'reauth_required' ? 'reauth' : 'inactive'} />}
    {denied && <ErrorLine kind={denied} />}
    {actionFailure && <ErrorLine kind={actionFailure} />}

    <section className="space-y-2" aria-label={t('gmail_ui.project.selections')}>
      <h3 className="text-sm font-medium">{t('gmail_ui.project.selections')}</h3>
      {!selections && !selectionFailure && !denied && <p role="status" className="text-sm text-muted-foreground">{t('gmail_ui.connections.loading')}</p>}
      {selectionFailure && <ErrorLine kind={selectionFailure} onRetry={() => void loadSelections()} />}
      {selections && selections.length === 0 && <p className="text-sm text-muted-foreground">{t('gmail_ui.project.no_selections')}</p>}
      {selections && selections.length > 0 && <ul className="space-y-2">{selections.map(selection => <li key={selection.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm">{label(selection)}</p>
          <p className="text-xs text-muted-foreground">{t('gmail_ui.project.window', {
            after: selection.read_after ? formatDate(selection.read_after, { timeZone: 'UTC' }) : t('gmail_ui.project.window_open'),
            before: selection.read_before ? formatDate(selection.read_before, { timeZone: 'UTC' }) : t('gmail_ui.project.window_open'),
          })}</p>
          {!selection.project_readable && <p className="text-xs">{t('gmail_ui.project.lost_access')}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!selection.project_readable || !active} onClick={() => setReading(selection.id)}>{t('gmail_ui.project.read')}</Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void remove(selection)}><Trash2 className="size-4" aria-hidden="true" />{t('gmail_ui.project.remove')}</Button>
        </div>
      </li>)}</ul>}
    </section>
    {open && <GmailThreadReader key={open.id} spaceId={spaceId} selection={open} title={label(open)} onClose={() => setReading(null)} onRefused={refuse} />}
  </div>
}
