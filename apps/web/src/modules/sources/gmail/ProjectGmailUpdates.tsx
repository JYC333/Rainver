import { useCallback, useEffect, useState } from 'react'
import type { GmailDigest } from '@rainver/protocol'
import { gmailApi } from '../../../api/gmail'
import { SafeExternalLink } from '../../../components/SafeExternalLink'
import { StatusBadge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card, CardTitle } from '../../../components/ui/card'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { useAppTranslation } from '../../../i18n'
import { formatDateTime } from '../../../i18n/format'
import { useProjectLiveRefresh } from '../../../hooks/useProjectLiveRefresh'
import { useGmailScope } from './useGmailScope'

const seg = encodeURIComponent

export function ProjectGmailUpdates({ projectId, spaceId, scopeKey }: {
  projectId: string; spaceId: string; scopeKey: string
}) {
  const { t } = useAppTranslation()
  const { run, keyFor, settle, exclusive } = useGmailScope(scopeKey)
  const [items, setItems] = useState<GmailDigest[]>([])
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pauseFailed, setPauseFailed] = useState(false)
  const load = useCallback(async () => {
    const result = await run(signal => gmailApi.digests({ spaceId, signal, reviewProjectId: projectId }), 'digests')
    if (!result) return
    setItems(result.ok ? result.value.filter(d => d.kind === 'application' && d.project_id === projectId && d.project_name !== null) : [])
    setFailed(!result.ok)
  }, [projectId, run, spaceId])
  useEffect(() => { void load() }, [load])
  useProjectLiveRefresh(projectId, load)

  const pause = (digest: GmailDigest) => exclusive('pause', async () => {
    const intent = `pause:${digest.id}`
    setBusy(true)
    setPauseFailed(false)
    const result = await run(signal => gmailApi.setDigestStatus(digest.id, 'paused', keyFor(intent), { spaceId, signal }))
    if (!result) return
    setBusy(false)
    if (result.ok) {
      settle(intent)
      setItems(current => current.map(item => item.id === digest.id ? { ...item, status: result.value.status } : item))
    } else setPauseFailed(true)
    await load()
  })

  if (!items.length && !failed && !pauseFailed) return null
  return <Card id="gmail-application-updates" className="mb-0 space-y-3 p-4">
    <CardTitle>{t('gmail_ui.digests.application')}</CardTitle>
    {failed && <p role="status" className="text-sm text-muted-foreground">{t('gmail_ui.digests.application_load_failed')}</p>}
    {pauseFailed && <p role="alert" className="text-sm text-destructive">{t('gmail_ui.digests.application_pause_failed')}</p>}
    <ul className="space-y-3">
      {items.map(digest => <li key={digest.id} className="space-y-1 text-sm">
        <StatusBadge status={digest.status === 'active' ? 'active' : 'inactive'} label={t(`gmail_ui.digests.status.${digest.status}`)} />
        {digest.runtime && <p className="text-muted-foreground">{t('gmail_ui.digests.runtime', { agent: digest.runtime.agent_name, model: digest.runtime.model_label })}</p>}
        {digest.mail_items && <p className="text-muted-foreground">{t('gmail_ui.digests.mail_items', digest.mail_items)}</p>}
        {digest.next_run_at && <p className="text-muted-foreground">{t('gmail_ui.digests.next_run', { date: formatDateTime(digest.next_run_at) })}</p>}
        {digest.retry_at && <p className="text-muted-foreground">{t('gmail_ui.digests.retry_at', { date: formatDateTime(digest.retry_at) })}</p>}
        {digest.status === 'paused' && (digest.last_error_code === 'gmail_digest_reconfirm_required'
          ? <p role="status">{t('gmail_ui.digests.reconfirm_required')}</p>
          : <p>{t('gmail_ui.digests.resume_scope_application')}</p>)}
        {digest.status === 'active' && <p className="text-muted-foreground">{t('gmail_ui.digests.coverage_application', { date: formatDateTime(digest.covered_until) })}</p>}
        {digest.last_delivery?.status === 'failed' && <p className="text-muted-foreground">{t('gmail_ui.digests.failed_window', {
          start: formatDateTime(digest.last_delivery.window_start), end: formatDateTime(digest.last_delivery.window_end),
        })}</p>}
        {digest.last_delivered_at && <p className="text-muted-foreground">{t('gmail_ui.digests.last_delivery', { date: formatDateTime(digest.last_delivered_at) })}</p>}
        {digest.last_error_code && digest.last_error_code !== 'gmail_digest_reconfirm_required' && <p role="status" className="text-muted-foreground">{t(digest.last_error_code === 'gmail_digest_read_limit' ? 'gmail_ui.digests.read_limit'
          : digest.last_error_code === 'gmail_digest_window_incomplete' ? 'gmail_ui.digests.incomplete'
          : digest.last_error_code === 'gmail_digest_audience_outside_project' ? 'gmail_ui.digests.audience_outside_project'
          : digest.last_error_code === 'gmail_digest_audience_not_owner' ? 'gmail_ui.digests.audience_not_owner'
          : digest.last_error_code === 'gmail_digest_runtime_changed' ? 'gmail_ui.digests.runtime_changed'
          : digest.last_error_code === 'gmail_digest_model_fallback' ? 'gmail_ui.digests.model_fallback'
          : digest.last_error_code === 'gmail_digest_launch_reconfirm_required' ? 'gmail_ui.digests.launch_reconfirm_required'
          : digest.last_error_code === 'gmail_digest_model_unavailable' ? 'gmail_ui.digests.model_unavailable'
          : digest.last_error_code === 'gmail_digest_agent_not_in_project' ? 'gmail_ui.digests.agent_removed' : 'gmail_ui.digests.delivery_issue')}</p>}
        {!digest.last_delivered_at && digest.status === 'active' && <p className="text-muted-foreground">{t('gmail_ui.digests.application_no_delivery')}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button asChild size="sm" variant="outline">
            <Link to={`/projects/${seg(projectId)}/agents/${seg(digest.agent_id)}/chat?session=${seg(digest.session_id)}`}>
              {t('gmail_ui.private_read.open')}
            </Link>
          </Button>
          {digest.status === 'active' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void pause(digest)}>
            {t('gmail_ui.digests.pause')}
          </Button>}
        </div>
        {!!digest.review_items?.length && <div className="space-y-2 border-t border-border pt-2">
          <p className="font-medium">{t('gmail_ui.digests.review_title')}</p>
          <ul className="space-y-1">
            {digest.review_items.map(item => <li key={item.message_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="text-muted-foreground">{formatDateTime(item.received_at)} · <span className="text-foreground">{t(`gmail_ui.digests.review_reason.${item.reason ?? 'unclear_fact'}`)}</span></p>
              <Button asChild size="sm" variant="outline" className="max-md:min-h-[44px]"><SafeExternalLink href={item.gmail_url}>
                {t('gmail_ui.digests.review_open_gmail')}
              </SafeExternalLink></Button>
            </li>)}
          </ul>
          {(digest.mail_items?.review ?? 0) > digest.review_items.length && <p className="text-xs text-muted-foreground">
            {t('gmail_ui.digests.review_limit', { shown: digest.review_items.length, total: digest.mail_items?.review })}
          </p>}
        </div>}
      </li>)}
    </ul>
  </Card>
}
