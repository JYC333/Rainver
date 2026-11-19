import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import type { GmailMessage, GmailThreadReadOutput, GmailThreadSelection } from '@rainver/protocol'
import { GMAIL_CLEARING_FAILURES, gmailApi, gmailFailure, type GmailFailure } from '../../../../api/gmail'
import { useAppTranslation } from '../../../../i18n'
import { formatDateTime } from '../../../../i18n/format'
import { SafeExternalLink } from '../../../../components/SafeExternalLink'
import { Button } from '../../../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../../components/ui/dialog'
import { useGmailScope } from '../../../sources/gmail/useGmailScope'

/**
 * One selected thread, read page by page (20 newest-first messages, server
 * cursor). Mount it with `key` = scope + selection: unmounting (close, scope
 * change, removal) aborts the read and drops the text. Bodies are rendered as
 * React text only — no HTML, images or links from the mail.
 */
export function GmailThreadReader({ spaceId, selection, title, onClose, onRefused }: {
  spaceId: string
  selection: GmailThreadSelection
  title: string
  onClose: () => void
  /**
   * A clearing refusal (401/403/404, reauth, inactive, changed): the parent
   * clears everything of this connection, which unmounts the reader.
   */
  onRefused: (kind: GmailFailure) => void
}) {
  const { t } = useAppTranslation()
  const { run } = useGmailScope(`${spaceId}|${selection.id}`)
  const [page, setPage] = useState<{ number: number; data: GmailThreadReadOutput } | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<GmailFailure | null>(null)

  const load = useCallback(async (cursor: string | null, number: number) => {
    setLoading(true); setFailure(null)
    const result = await run(signal => gmailApi.read(selection.id, cursor, { spaceId, signal }), 'read')
    if (!result) return
    setLoading(false)
    if (result.ok) { setPage({ number, data: result.value }); return }
    const kind = gmailFailure(result.error)
    if (GMAIL_CLEARING_FAILURES.has(kind)) { setPage(null); onRefused(kind); return }
    setFailure(kind)
  }, [onRefused, run, selection.id, spaceId])
  useEffect(() => { void load(null, 1) }, [load])

  const data = page?.data
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-2xl">
      <DialogHeader className="mb-3 pr-6">
        <DialogTitle className="break-words">{data?.subject ?? title}</DialogTitle>
        <DialogDescription>{data ? t('gmail_ui.reader.page', { page: page!.number, count: data.messages_in_window }) : t('gmail_ui.reader.title')}</DialogDescription>
      </DialogHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(null, 1)}><RefreshCw className="size-4" aria-hidden="true" />{t('gmail_ui.reader.refresh')}</Button>
        {data?.next_cursor && <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(data.next_cursor, page!.number + 1)}>{t('gmail_ui.reader.older')}</Button>}
        {page && page.number > 1 && <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load(null, 1)}>{t('gmail_ui.reader.newest')}</Button>}
        <Button size="sm" variant="ghost" asChild><SafeExternalLink href={data?.gmail_url ?? selection.gmail_url}><ExternalLink className="size-4" aria-hidden="true" />{t('gmail_ui.project.open_in_gmail')}</SafeExternalLink></Button>
      </div>
      {loading && <p role="status" className="text-sm text-muted-foreground">{t('gmail_ui.reader.loading')}</p>}
      {failure && <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-3 text-sm">
        <span>{t(`gmail_ui.errors.${failure}`)}</span>
        {!GMAIL_CLEARING_FAILURES.has(failure) && <Button size="sm" variant="outline" onClick={() => void load(null, 1)}>{t('gmail_ui.errors.retry')}</Button>}
      </div>}
      {data && data.truncated && <div role="note" className="mb-3 rounded-md border border-warning/40 p-3 text-xs">
        <p>{t('gmail_ui.reader.truncated')}</p>
        <ul className="list-disc pl-4">{data.truncation.map(reason => <li key={reason}>{t(`gmail_ui.reader.truncation.${reason}`)}</li>)}</ul>
      </div>}
      {data && data.messages.length === 0 && !loading && <p className="text-sm text-muted-foreground">{t('gmail_ui.reader.empty')}</p>}
      {data && <ol className="space-y-3" aria-label={t('gmail_ui.reader.title')}>
        {data.messages.map(message => <li key={message.google_message_id}><GmailMessageView message={message} /></li>)}
      </ol>}
    </DialogContent>
  </Dialog>
}

function GmailMessageView({ message }: { message: GmailMessage }) {
  const { t } = useAppTranslation()
  const header = (label: string, value: string | null) => value ? <p className="break-words"><span className="text-muted-foreground">{label}: </span>{value}</p> : null
  return <article className="space-y-2 rounded-md border border-border p-3">
    <div className="flex flex-wrap items-start justify-between gap-2 text-xs">
      <div className="min-w-0 space-y-0.5">
        {header(t('gmail_ui.reader.from'), message.from)}
        {header(t('gmail_ui.reader.to'), message.to)}
        {header(t('gmail_ui.reader.cc'), message.cc)}
      </div>
      <time className="shrink-0 text-muted-foreground" dateTime={message.internal_date}>{formatDateTime(message.internal_date)}</time>
    </div>
    {message.omitted
      ? <p className="text-sm text-muted-foreground">{t(`gmail_ui.project.omitted.${message.omitted}`)}</p>
      : message.text_format === 'none' || !message.text
        ? <p className="text-sm text-muted-foreground">{t('gmail_ui.reader.no_text')}</p>
        : <div className="whitespace-pre-wrap break-words text-sm">{message.text}</div>}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {message.text_format === 'html_converted' && <span>{t('gmail_ui.reader.html_converted')}</span>}
      {message.text_truncated && <span>{t('gmail_ui.reader.text_truncated')}</span>}
      {message.attachment_count > 0 && <span>{t('gmail_ui.reader.attachments', { count: message.attachment_count })}</span>}
      <SafeExternalLink className="underline" href={message.gmail_url}>{t('gmail_ui.project.open_in_gmail')}</SafeExternalLink>
    </div>
  </article>
}
