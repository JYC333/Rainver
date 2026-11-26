import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ExternalLink, Mail } from 'lucide-react'
import { GMAIL_MANUAL_REVOCATION_URL, GmailOAuthCallbackResultSchema, type GmailAgentReadGrant, type GmailConnection, type GmailConnectionList, type GmailDigest, type GmailOAuthCallbackResult } from '@rainver/protocol'
import { GMAIL_CLEARING_FAILURES, gmailApi, gmailConsentUrl, gmailFailure, type GmailFailure } from '../../../api/gmail'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { useSpace } from '../../../contexts/SpaceContext'
import { useAppTranslation } from '../../../i18n'
import { formatDateTime } from '../../../i18n/format'
import { SafeExternalLink } from '../../../components/SafeExternalLink'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { StatusBadge } from '../../../components/ui/badge'
import { Input } from '../../../components/ui/input'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { useGmailScope } from './useGmailScope'

const seg = encodeURIComponent

type Delegation = NonNullable<GmailConnection['read_delegations']>[number]
type Pending = { kind: 'disconnect' | 'forget'; connection: GmailConnection } | { kind: 'revoke_grant'; connection: GmailConnection; grant: GmailAgentReadGrant } | { kind: 'revoke_delegation'; delegation: Delegation } | { kind: 'end_digest'; digest: GmailDigest } | null

/**
 * The signed-in person's own Gmail connections in the active Space: connect,
 * status, reconnect, local-only disconnect and forget, and — the one place to
 * manage them — Agent reads: the on/off switch and each Project the person
 * allowed in a conversation, with when it was last used and its revocation. No secret is ever typed
 * here: the Google client is server configuration, and the consent URL opens
 * only when the person clicks "Continue to Google".
 */
export function GmailConnectionsCard() {
  const { activeSpaceId, userId } = useSpace()
  const { t } = useAppTranslation()
  const spaceId = activeSpaceId ?? ''
  const scopeKey = `${userId}|${spaceId}`
  const { run, invalidate, keyFor, settle } = useGmailScope(scopeKey)
  const [params, setParams] = useSearchParams()
  const [list, setList] = useState<{ scope: string; data: GmailConnectionList } | null>(null)
  const [digests, setDigests] = useState<{ scope: string; items: GmailDigest[] } | null>(null)
  const [digestError, setDigestError] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ scope: string; kind: GmailFailure } | null>(null)
  // A refused start/disconnect/forget, kept apart from the list read so a refresh does not hide it.
  const [actionFailure, setActionFailure] = useState<{ scope: string; kind: GmailFailure } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [consent, setConsent] = useState<{ scope: string; url: string; target: string | null } | null>(null)
  const [disconnected, setDisconnected] = useState<{ scope: string; connectionId: string } | null>(null)
  const [notice, setNotice] = useState<GmailOAuthCallbackResult | null>(null)
  const [timeEdit, setTimeEdit] = useState<{ scope: string; digest: GmailDigest; time: string } | null>(null)
  const [pending, setPending] = useState<Pending>(null)

  // The callback's fixed result code is shown once, then removed from the URL.
  useEffect(() => {
    const raw = params.get('gmail')
    if (raw === null) return
    const parsed = GmailOAuthCallbackResultSchema.safeParse(raw)
    setNotice(parsed.success ? parsed.data : null)
    const next = new URLSearchParams(params); next.delete('gmail'); setParams(next, { replace: true })
  }, [params, setParams])

  /**
   * A clearing refusal (401/403/404, reauth, inactive, changed) from any call:
   * every request of this scope started so far is aborted and can no longer
   * deliver, and the list, consent link, receipt and open dialog go at once —
   * even though person and Space are unchanged.
   */
  const clear = useCallback(() => {
    invalidate()
    setList(null); setDigests(null); setConsent(null); setDisconnected(null); setPending(null); setTimeEdit(null); setBusy(null); setActionFailure(null)
  }, [invalidate])

  const loadDigests = useCallback(async () => {
    const result = await run(signal => gmailApi.digests({ spaceId, signal }), 'digests')
    if (!result) return
    setDigests(result.ok ? { scope: scopeKey, items: result.value } : null)
    setDigestError(result.ok ? null : scopeKey)
  }, [run, spaceId, scopeKey])

  // Only the newest list read can land: the refresh after a write supersedes a slower earlier read.
  const load = useCallback(async () => {
    if (!spaceId) return
    const result = await run(signal => gmailApi.connections({ spaceId, signal }), 'list')
    if (!result) return
    if (result.ok) {
      setList({ scope: scopeKey, data: result.value }); setFailure(null)
      if (result.value.configured && result.value.connections.length) await loadDigests()
      return
    }
    const kind = gmailFailure(result.error)
    if (GMAIL_CLEARING_FAILURES.has(kind)) clear()
    else setList(null)
    setFailure({ scope: scopeKey, kind })
  }, [clear, loadDigests, run, scopeKey, spaceId])
  useEffect(() => { setList(null); setFailure(null); setActionFailure(null); setBusy(null); setConsent(null); setDisconnected(null); setPending(null); void load() }, [load])

  const data = list?.scope === scopeKey ? list.data : null
  const error = failure?.scope === scopeKey ? failure.kind : null
  const shownConsent = consent?.scope === scopeKey ? consent : null
  const receipt = disconnected?.scope === scopeKey ? disconnected : null
  const actionError = actionFailure?.scope === scopeKey ? actionFailure.kind : null

  /** A refused write: clearing kinds clear the whole scope and show its error; others stay beside the list. */
  const refuse = (error: unknown) => {
    const kind = gmailFailure(error)
    if (GMAIL_CLEARING_FAILURES.has(kind)) { clear(); setFailure({ scope: scopeKey, kind }) }
    else setActionFailure({ scope: scopeKey, kind })
  }

  const start = async (target: string | null) => {
    if (busy || !spaceId) return
    setBusy(`start:${target ?? ''}`); setConsent(null); setActionFailure(null)
    const result = await run(signal => gmailApi.startOAuth(target ? { reconnect_connection_id: target } : {}, { spaceId, signal }))
    if (!result) return
    setBusy(null)
    if (!result.ok) { refuse(result.error); return }
    // Only Google's own consent page becomes a link, whatever the reply says.
    const url = gmailConsentUrl(result.value.authorize_url)
    if (url) setConsent({ scope: scopeKey, url, target })
    else setActionFailure({ scope: scopeKey, kind: 'consent_invalid' })
  }

  const act = async (kind: 'disconnect' | 'forget', connection: GmailConnection) => {
    if (busy || !spaceId) return
    const intent = `${kind}:${connection.id}`
    setBusy(intent); setActionFailure(null)
    const key = keyFor(intent)
    const result = await run<unknown>(signal => kind === 'disconnect'
      ? gmailApi.disconnect(connection.id, key, { spaceId, signal })
      : gmailApi.forget(connection.id, key, { spaceId, signal }))
    if (!result) return
    setBusy(null)
    if (result.ok) {
      settle(intent)
      if (kind === 'disconnect') setDisconnected({ scope: scopeKey, connectionId: connection.id })
      setConsent(current => current?.target === connection.id ? null : current)
      await load()
      return
    }
    const clearing = GMAIL_CLEARING_FAILURES.has(gmailFailure(result.error))
    if (clearing) settle(intent)
    refuse(result.error)
    // An ordinary failure re-reads the list, superseding any older read.
    if (!clearing) await load()
  }

  const setAgentRead = async (connection: GmailConnection, enabled: boolean) => {
    if (busy || !spaceId) return
    const intent = `agent_read:${connection.id}:${enabled}`
    setBusy(intent); setActionFailure(null)
    const result = await run(signal => gmailApi.setAgentRead(connection.id, enabled, keyFor(intent), { spaceId, signal }))
    if (!result) return
    setBusy(null)
    const clearing = !result.ok && GMAIL_CLEARING_FAILURES.has(gmailFailure(result.error))
    if (result.ok || clearing) settle(intent)
    if (!result.ok) refuse(result.error)
    if (!clearing) await load()
  }

  const revokeGrant = async (grant: GmailAgentReadGrant) => {
    if (busy || !spaceId) return
    const intent = `revoke_grant:${grant.grant_id}`
    setBusy(intent); setActionFailure(null)
    const result = await run(signal => gmailApi.revokeAgentReadGrant(grant.grant_id, keyFor(intent), { spaceId, signal }))
    if (!result) return
    setBusy(null)
    const clearing = !result.ok && GMAIL_CLEARING_FAILURES.has(gmailFailure(result.error))
    if (result.ok || clearing) settle(intent)
    if (!result.ok) refuse(result.error)
    if (!clearing) await load()
  }

  const revokeDelegation = async (delegation: Delegation) => {
    if (busy || !spaceId) return
    const intent = `revoke_delegation:${delegation.delegation_id}`
    setBusy(intent); setActionFailure(null)
    const result = await run(signal => gmailApi.revokeDelegation(delegation.delegation_id, keyFor(intent), { spaceId, signal }))
    if (!result) return
    setBusy(null)
    const clearing = !result.ok && GMAIL_CLEARING_FAILURES.has(gmailFailure(result.error))
    if (result.ok || clearing) settle(intent)
    if (!result.ok) refuse(result.error)
    if (!clearing) await load()
  }

  const edit = timeEdit?.scope === scopeKey ? timeEdit : null
  const saveDigestTime = async () => {
    if (!edit || busy || !spaceId || !edit.time) return
    const intent = `digest_time:${edit.digest.id}:${edit.time}`
    setBusy(intent); setActionFailure(null)
    const result = await run(signal => gmailApi.setDigestTime(edit.digest.id, edit.time, keyFor(intent), { spaceId, signal }))
    if (!result) return
    setBusy(null)
    if (!result.ok) { refuse(result.error); return }
    settle(intent)
    setTimeEdit(null)
    await load()
  }

  const actOnDigest = async (digest: GmailDigest, action: 'active' | 'paused' | 'ended') => {
    if (busy || !spaceId) return
    const intent = `digest:${digest.id}:${action}`
    setBusy(intent); setActionFailure(null)
    const result = await run<unknown>(signal => action === 'ended'
      ? gmailApi.endDigest(digest.id, keyFor(intent), { spaceId, signal })
      : gmailApi.setDigestStatus(digest.id, action, keyFor(intent), { spaceId, signal }))
    if (!result) return
    setBusy(null)
    if (result.ok) settle(intent)
    else refuse(result.error)
    if (result.ok || !GMAIL_CLEARING_FAILURES.has(gmailFailure(result.error))) await loadDigests()
  }

  const statusLabel = (c: GmailConnection) => t(`gmail_ui.connections.status.${c.status}`)
  const configured = data?.configured ?? false
  return <Card className="m-4 max-w-xl space-y-4 p-6" aria-labelledby="gmail-connections-title">
    <div className="space-y-1">
      <h2 id="gmail-connections-title" className="flex items-center gap-2 text-base font-semibold"><Mail className="size-4" aria-hidden="true" />{t('gmail_ui.connections.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('gmail_ui.connections.intro')}</p>
    </div>
    {notice && <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">{t(`gmail_ui.connections.callback.${notice}`)}</p>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">{t('gmail_ui.connections.loading')}</p>}
    {error && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-3 text-sm">
      <span>{t(`gmail_ui.errors.${error}`)}</span>
      <Button size="sm" variant="outline" onClick={() => void load()}>{t('gmail_ui.errors.retry')}</Button>
    </div>}
    {digestError === scopeKey && data?.configured && data.connections.length > 0 && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
      {t('gmail_ui.digests.load_failed')}
      <Button size="sm" variant="outline" onClick={() => void loadDigests()}>{t('gmail_ui.errors.retry')}</Button>
    </div>}
    {actionError && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">{t(`gmail_ui.errors.${actionError}`)}</p>}
    {data && !configured && <p role="note" className="rounded-md border border-border p-3 text-sm">{t('gmail_ui.connections.not_configured')}</p>}
    {data && data.connections.length === 0 && configured && <p className="text-sm text-muted-foreground">{t('gmail_ui.connections.empty')}</p>}
    {data && data.connections.length > 0 && <ul className="space-y-3" aria-label={t('gmail_ui.connections.title')}>
      {data.connections.map(connection => <li key={connection.id} className="space-y-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-all text-sm font-medium">{connection.mailbox_email}</span>
          <StatusBadge status={connection.status === 'active' ? 'active' : connection.status === 'reauth_required' ? 'attention' : 'inactive'} label={statusLabel(connection)} />
        </div>
        <p className="text-xs text-muted-foreground">{connection.status === 'disconnected' && connection.disconnected_at
          ? t('gmail_ui.connections.disconnected_at', { date: formatDateTime(connection.disconnected_at) })
          : t('gmail_ui.connections.connected_at', { date: formatDateTime(connection.connected_at) })}</p>
        {connection.status === 'reauth_required' && <p className="text-xs">{t('gmail_ui.connections.reauth_hint')}</p>}
        {connection.status === 'active' && <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3" aria-label={t('gmail_ui.connections.agent_read.title')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t('gmail_ui.connections.agent_read.title')}</span>
            <StatusBadge status={connection.agent_read_enabled ? 'active' : 'inactive'} label={t(connection.agent_read_enabled ? 'gmail_ui.connections.agent_read.on' : 'gmail_ui.connections.agent_read.off')} />
          </div>
          <p className="text-xs text-muted-foreground">{t('gmail_ui.connections.agent_read.hint')}</p>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void setAgentRead(connection, !connection.agent_read_enabled)}>
            {t(connection.agent_read_enabled ? 'gmail_ui.connections.agent_read.disable' : 'gmail_ui.connections.agent_read.enable')}</Button>
          {connection.agent_read_enabled && <div className="space-y-1 border-t border-border pt-2">
            <p className="text-xs font-medium">{t('gmail_ui.connections.agent_read.grants_title')}</p>
            {connection.agent_read_grants.length === 0
              ? <p className="text-xs text-muted-foreground">{t('gmail_ui.connections.agent_read.grants_empty')}</p>
              : <ul className="space-y-1" aria-label={t('gmail_ui.connections.agent_read.grants_title')}>
                {connection.agent_read_grants.map(grant => <li key={grant.grant_id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{grant.project_name ?? t('gmail_ui.connections.agent_read.grant_unknown_project')}</span>
                    <span className="text-muted-foreground"> · {grant.last_used_at
                      ? t('gmail_ui.connections.agent_read.last_used', { date: formatDateTime(grant.last_used_at) })
                      : t('gmail_ui.connections.agent_read.allowed_at', { date: formatDateTime(grant.created_at) })}</span>
                  </span>
                  <Button size="sm" variant="ghost" disabled={busy !== null} aria-label={t('gmail_ui.connections.agent_read.revoke_label', { project: grant.project_name ?? t('gmail_ui.connections.agent_read.grant_unknown_project') })}
                    onClick={() => setPending({ kind: 'revoke_grant', connection, grant })}>{t('gmail_ui.connections.agent_read.revoke')}</Button>
                </li>)}
              </ul>}
          </div>}
          {connection.agent_read_enabled && (connection.read_delegations?.length ?? 0) > 0 && <div className="space-y-1 border-t border-border pt-2">
            <p className="text-xs font-medium">{t('gmail_ui.connections.delegations.title')}</p>
            <ul className="space-y-1" aria-label={t('gmail_ui.connections.delegations.title')}>
              {connection.read_delegations!.map(delegation => <li key={delegation.delegation_id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="min-w-0 break-words">
                  <span className="font-medium">{delegation.grantee_name}</span>
                  <span className="text-muted-foreground"> · {delegation.project_name ?? t('gmail_ui.connections.agent_read.grant_unknown_project')} · {t('gmail_ui.connections.delegations.scope', { scope: delegation.query_scope })} · {delegation.last_used_at
                    ? t('gmail_ui.connections.delegations.used', { count: delegation.read_count, date: formatDateTime(delegation.last_used_at) })
                    : t('gmail_ui.connections.agent_read.allowed_at', { date: formatDateTime(delegation.created_at) })}</span>
                </span>
                <Button size="sm" variant="ghost" disabled={busy !== null} aria-label={t('gmail_ui.connections.delegations.revoke_label', { member: delegation.grantee_name })}
                  onClick={() => setPending({ kind: 'revoke_delegation', delegation })}>{t('gmail_ui.connections.agent_read.revoke')}</Button>
              </li>)}
            </ul>
          </div>}
        </div>}
        {digests?.scope === scopeKey && digests.items.some(digest => digest.connection_id === connection.id) && (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
            <h3 className="text-sm font-medium">{t(digests.items.some(digest => digest.connection_id === connection.id && digest.kind === 'application')
              ? 'gmail_ui.digests.rules_title' : 'gmail_ui.digests.title')}</h3>
            <ul className="space-y-2">
              {digests.items.filter(digest => digest.connection_id === connection.id).map(digest => digest.kind === 'application' ? <li key={digest.id} className="flex flex-wrap items-center gap-2 border-t border-border pt-2 text-xs">
                <span className="font-medium">{t('gmail_ui.digests.application')}</span>
                <StatusBadge status={digest.status === 'active' ? 'active' : 'inactive'} label={t(`gmail_ui.digests.status.${digest.status}`)} />
                {digest.project_name && <Button asChild size="sm" variant="outline">
                  <Link to={`/projects/${seg(digest.project_id)}/plugins/phd_application/board`}>
                    {t('gmail_ui.digests.open_project_applications', { project: digest.project_name })}
                  </Link>
                </Button>}
                {digest.status !== 'ended' && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setPending({ kind: 'end_digest', digest })}>{t('gmail_ui.digests.end')}</Button>}
              </li> : <li key={digest.id} className="space-y-1 border-t border-border pt-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t(`gmail_ui.digests.${digest.kind}`)}</span>
                  <StatusBadge status={digest.status === 'active' ? 'active' : 'inactive'} label={t(`gmail_ui.digests.status.${digest.status}`)} />
                </div>
                <p className="text-muted-foreground">{digest.project_name ?? t('gmail_ui.connections.agent_read.grant_unknown_project')}
                  {digest.local_time && ` · ${digest.local_time} (${digest.time_zone})`}
                </p>
                {digest.next_run_at && <p className="text-muted-foreground">{t('gmail_ui.digests.next_run', { date: formatDateTime(digest.next_run_at) })}</p>}
                {digest.retry_at && <p className="text-muted-foreground">{t('gmail_ui.digests.retry_at', { date: formatDateTime(digest.retry_at) })}</p>}
                {digest.status === 'paused' && (digest.last_error_code === 'gmail_digest_reconfirm_required'
                  ? <p role="status">{t('gmail_ui.digests.reconfirm_required')}</p>
                  : <p>{t(`gmail_ui.digests.resume_scope_${digest.kind}`)}</p>)}
                {digest.status === 'active' && <p className="text-muted-foreground">{t(`gmail_ui.digests.coverage_${digest.kind}`, { date: formatDateTime(digest.covered_until) })}</p>}
                {digest.last_delivery?.status === 'failed' && <p className="text-muted-foreground">{t('gmail_ui.digests.failed_window', {
                  start: formatDateTime(digest.last_delivery.window_start), end: formatDateTime(digest.last_delivery.window_end),
                })}</p>}
                {digest.last_delivered_at && <p className="text-muted-foreground">{t('gmail_ui.digests.last_delivery', { date: formatDateTime(digest.last_delivered_at) })}</p>}
                {digest.last_error_code && digest.last_error_code !== 'gmail_digest_reconfirm_required' && <p role="status" className="text-muted-foreground">{t(digest.last_error_code === 'gmail_digest_read_limit' ? 'gmail_ui.digests.read_limit'
                  : digest.last_error_code === 'gmail_digest_window_incomplete' ? 'gmail_ui.digests.incomplete'
                  : digest.last_error_code === 'gmail_digest_audience_outside_project' ? 'gmail_ui.digests.audience_outside_project'
                  : digest.last_error_code === 'gmail_digest_audience_not_owner' ? 'gmail_ui.digests.audience_not_owner'
                  : digest.last_error_code === 'gmail_digest_runtime_changed' ? 'gmail_ui.digests.runtime_changed_paused' : 'gmail_ui.digests.delivery_issue')}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  {digest.project_name && <Link className="underline" to={digest.room_id
                    ? `/projects/${seg(digest.project_id)}/rooms?room=${seg(digest.room_id)}&conversation=${seg(digest.session_id)}`
                    : `/projects/${seg(digest.project_id)}/agents/${seg(digest.agent_id)}/chat?session=${seg(digest.session_id)}`}>
                    {t(digest.room_id ? 'gmail_ui.digests.open_room_conversation' : 'gmail_ui.private_read.open')}</Link>}
                  {digest.status !== 'ended' && digest.last_error_code === 'gmail_digest_reconfirm_required' && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setPending({ kind: 'end_digest', digest })}>{t('gmail_ui.digests.end')}</Button>}
                  {digest.status !== 'ended' && digest.last_error_code !== 'gmail_digest_reconfirm_required' && <>
                    {digest.local_time && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => {
                      setActionFailure(null)
                      setTimeEdit({ scope: scopeKey, digest, time: digest.local_time! })
                    }}>{t('gmail_ui.digests.change_time')}</Button>}
                    {/* A digest paused for a changed Agent, runtime or model resumes only on a new card naming it (ADR 0035 §3). */}
                    {(digest.status === 'active' || digest.last_error_code !== 'gmail_digest_runtime_changed') && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void actOnDigest(digest, digest.status === 'active' ? 'paused' : 'active')}>
                      {t(digest.status === 'active' ? 'gmail_ui.digests.pause' : 'gmail_ui.digests.resume')}
                    </Button>}
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setPending({ kind: 'end_digest', digest })}>{t('gmail_ui.digests.end')}</Button>
                  </>}
                </div>
              </li>)}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {connection.status !== 'active' && configured && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void start(connection.id)}>
            {busy === `start:${connection.id}` ? t('gmail_ui.connections.preparing') : t('gmail_ui.connections.reconnect')}</Button>}
          {connection.status !== 'disconnected' && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setPending({ kind: 'disconnect', connection })}>{t('gmail_ui.connections.disconnect')}</Button>}
          {connection.status !== 'active' && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setPending({ kind: 'forget', connection })}>{t('gmail_ui.connections.forget')}</Button>}
        </div>
        {receipt?.connectionId === connection.id && <RevocationNotice />}
      </li>)}
    </ul>}
    <Dialog open={edit !== null} onOpenChange={open => { if (!open && !busy) setTimeEdit(null) }}>
      <DialogContent className="w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>{t('gmail_ui.digests.change_time')}</DialogTitle>
          <DialogDescription>{t('gmail_ui.digests.time_zone', { zone: edit?.digest.time_zone })}</DialogDescription>
        </DialogHeader>
        <Input type="time" aria-label={t('gmail_ui.digests.change_time')} value={edit?.time ?? ''} disabled={busy !== null}
          onChange={event => { if (edit) setTimeEdit({ ...edit, time: event.target.value }) }} />
        {actionFailure?.scope === scopeKey && <p role="alert" className="text-sm text-destructive">{t('gmail_ui.digests.change_time_failed')}</p>}
        <DialogFooter>
          <Button disabled={busy !== null || !edit?.time || edit.time === edit.digest.local_time}
            onClick={() => void saveDigestTime()}>{t('gmail_ui.digests.save_time')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {receipt && !data?.connections.some(c => c.id === receipt.connectionId) && <RevocationNotice />}
    {data && configured && <div className="space-y-2">
      {!shownConsent && <Button size="sm" disabled={busy !== null} onClick={() => void start(null)}>{busy === 'start:' ? t('gmail_ui.connections.preparing') : t('gmail_ui.connections.connect')}</Button>}
      {shownConsent && <div className="space-y-2 rounded-md border border-border p-3">
        <p className="text-sm">{t('gmail_ui.connections.continue_hint')}</p>
        {/* Same tab, so Google returns here; opened only by this click. */}
        <Button size="sm" asChild><a href={shownConsent.url} rel="noopener noreferrer">{t('gmail_ui.connections.continue')}</a></Button>
      </div>}
    </div>}
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={open => { if (!open) setPending(null) }}
      title={pending?.kind === 'end_digest' ? t('gmail_ui.digests.end') : pending?.kind === 'revoke_delegation' ? t('gmail_ui.connections.delegations.revoke_title', { member: pending.delegation.grantee_name }) : pending?.kind === 'revoke_grant' ? t('gmail_ui.connections.agent_read.revoke_title') : pending?.kind === 'forget' ? t('gmail_ui.connections.forget_title') : t('gmail_ui.connections.disconnect_title')}
      description={pending?.kind === 'end_digest' ? t('gmail_ui.digests.end_body') : pending?.kind === 'revoke_delegation' ? t('gmail_ui.connections.delegations.revoke_body') : pending?.kind === 'revoke_grant' ? t('gmail_ui.connections.agent_read.revoke_body') : pending?.kind === 'forget' ? t('gmail_ui.connections.forget_body') : t('gmail_ui.connections.disconnect_body')}
      confirmLabel={pending?.kind === 'end_digest' ? t('gmail_ui.digests.end') : pending?.kind === 'revoke_delegation' || pending?.kind === 'revoke_grant' ? t('gmail_ui.connections.agent_read.revoke') : pending?.kind === 'forget' ? t('gmail_ui.connections.forget') : t('gmail_ui.connections.disconnect')}
      onConfirm={() => { if (!pending) return; if (pending.kind === 'end_digest') void actOnDigest(pending.digest, 'ended'); else if (pending.kind === 'revoke_grant') void revokeGrant(pending.grant); else if (pending.kind === 'revoke_delegation') void revokeDelegation(pending.delegation); else void act(pending.kind, pending.connection) }}
    />
  </Card>
}

/** Links only the protocol's fixed Google Account page, never a URL from a reply. */
function RevocationNotice() {
  const { t } = useAppTranslation()
  const href = GMAIL_MANUAL_REVOCATION_URL
  return <div role="status" className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
    <p>{t('gmail_ui.connections.disconnect_done')}</p>
    <Button size="sm" variant="outline" asChild><SafeExternalLink href={href}><ExternalLink className="size-4" aria-hidden="true" />{t('gmail_ui.connections.revoke_link')}</SafeExternalLink></Button>
  </div>
}
