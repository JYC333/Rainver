import { useEffect, useState } from 'react'
import type { Room, RoomConversation } from '@rainver/protocol'
import { ApiRequestError, roomsApi } from '../../../api/client'
import { gmailApi } from '../../../api/gmail'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../../components/ui/dialog'
import { Select } from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'
import { useAppTranslation } from '../../../i18n'
import { useGmailScope } from './useGmailScope'

export function GmailSummaryShare({ spaceId, projectId, messageId, content }: {
  spaceId: string; projectId: string; messageId: string; content: string
}) {
  const { t } = useAppTranslation()
  const { run, invalidate, keyFor, settle, exclusive } = useGmailScope(`${spaceId}:${projectId}:${messageId}`)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState('')
  const [rooms, setRooms] = useState<Room[]>([])
  const [room, setRoom] = useState('')
  const [threads, setThreads] = useState<RoomConversation[]>([])
  const [thread, setThread] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(false)
  const [posted, setPosted] = useState(false)
  const [audience, setAudience] = useState<Awaited<ReturnType<typeof gmailApi.previewSummaryAudience>> | null>(null)
  const [audienceRequest, setAudienceRequest] = useState(0)
  const [audienceChanged, setAudienceChanged] = useState(false)

  useEffect(() => {
    if (!open) return
    void run(signal => roomsApi.list({ project_id: projectId, limit: 100 }, { spaceId, signal }), 'rooms')
      .then(result => {
        if (!result) return
        if (result.ok) setRooms(result.value.items)
        else setError(true)
        setLoading(false)
      })
  }, [open, projectId, run, spaceId])

  useEffect(() => {
    if (!open || !room) return
    void run(signal => roomsApi.conversations(room, { limit: 100 }, { spaceId, signal }), 'conversations')
      .then(result => {
        if (!result) return
        if (result.ok) setThreads(result.value.items.filter(item => item.status === 'active'))
        else setError(true)
        setLoading(false)
      })
  }, [open, room, run, spaceId])

  useEffect(() => {
    if (!open || !room || !thread) return
    void run(signal => gmailApi.previewSummaryAudience(
      { source_message_id: messageId, room_id: room, session_id: thread }, { spaceId, signal },
    ), 'audience').then(result => {
      if (!result) return
      if (result.ok) setAudience(result.value)
      else setError(true)
    })
  }, [open, room, thread, messageId, spaceId, run, audienceRequest])

  const clearAudience = () => {
    invalidate()
    setAudience(null)
    setAudienceChanged(false)
  }

  const reset = (next: boolean) => {
    clearAudience()
    setOpen(next)
    setPreview(next ? content.slice(0, 8000) : '')
    setRoom(''); setThread(''); setRooms([]); setThreads([]); setError(false); setLoading(next)
  }

  const send = async () => {
    if (!thread || !room || !audience || !preview.trim() || sending) return
    await exclusive('share', async () => {
      setSending(true); setError(false)
      const input = { source_message_id: messageId, room_id: room, session_id: thread, content: preview, audience_version: audience.audience_version }
      const result = await run(signal => gmailApi.shareSummary(input, keyFor('share'), { spaceId, signal }))
      if (!result) return
      setSending(false)
      if (result.ok) {
        settle('share'); setPosted(true); reset(false)
      } else if (result.error instanceof ApiRequestError && result.error.status === 409 && result.error.code === 'operation_conflict') {
        settle('share'); setAudience(null); setAudienceChanged(true); setAudienceRequest(value => value + 1)
      } else setError(true)
    })
  }

  const roomLabel = t('gmail_ui.share.room')
  const threadLabel = t('gmail_ui.share.thread')
  return <Dialog open={open} onOpenChange={next => { if (!sending) reset(next) }}>
    <DialogTrigger asChild><Button size="sm" variant="outline">{t('gmail_ui.share.open')}</Button></DialogTrigger>
    {posted && <span role="status" className="ml-2 text-xs">{t('gmail_ui.share.posted')}</span>}
    <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-auto">
      <DialogHeader>
        <DialogTitle>{t('gmail_ui.share.title')}</DialogTitle>
        <DialogDescription>{t('gmail_ui.share.hint')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <Textarea aria-label={t('gmail_ui.share.preview')} rows={7} value={preview} maxLength={8000} disabled={sending}
          onChange={event => { settle('share'); setPreview(event.target.value) }} />
        <Select ariaLabel={roomLabel} value={room} disabled={sending || rooms.length === 0}
          options={[{ value: '', label: roomLabel }, ...rooms.map(item => ({
            value: item.id, label: item.is_mainline ? t('gmail_ui.share.mainline') : item.title,
          }))]} onChange={value => {
          clearAudience(); settle('share'); setRoom(value); setThread(''); setThreads([]); setError(false); setLoading(Boolean(value))
        }} />
        <Select ariaLabel={threadLabel} value={thread} disabled={sending || threads.length === 0}
          options={[{ value: '', label: threadLabel }, ...threads.map(item => ({
            value: item.id, label: item.title ?? t('gmail_ui.share.untitled', { date: new Date(item.created_at).toLocaleString() }),
          }))]} onChange={value => { clearAudience(); settle('share'); setError(false); setThread(value) }} />
        {thread && !audience && !error && <p role="status" className="text-sm text-muted-foreground">{t('gmail_ui.share.audience_loading')}</p>}
        {audienceChanged && <p role="alert" className="text-sm">{t('gmail_ui.share.audience_changed')}</p>}
        {audience && <div className="space-y-1 rounded-md border border-border p-3 text-sm">
          <p className="font-medium">{t('gmail_ui.share.audience', { count: audience.readers.length })}</p>
          <ul className="list-inside list-disc break-words">
            {audience.readers.map((reader, index) => <li key={index}>{reader.display_name}</li>)}
          </ul>
        </div>}
        {thread && !audience && error && <Button variant="outline" size="sm" onClick={() => {
          setError(false); setAudienceRequest(value => value + 1)
        }}>{t('gmail_ui.share.reload_audience')}</Button>}
        {!loading && !error && (!rooms.length || (room && !threads.length)) && <p className="text-sm text-muted-foreground">{t('gmail_ui.share.no_target')}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{t('gmail_ui.share.failed')}</p>}
      </div>
      <DialogFooter className="mt-4">
        <Button disabled={sending || loading || !thread || !audience || !preview.trim()} onClick={() => void send()}>{t('gmail_ui.share.send')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
