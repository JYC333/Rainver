import { useEffect, useRef, useState } from 'react'
import { runsApi, type RequestOptions } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Textarea } from '../../components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { mergeAbortSignals } from '../../lib/mergeAbortSignals'
import { useAppTranslation } from '../../i18n'
import type { Run } from '../../types/api'

/** Bound to one physical delivery; a late response cannot retarget another Run. */
export function RunLiveInputControls({ run, scope, onChanged }: { run: Run; scope: RequestOptions; onChanged?: (run: Run) => void }) {
  const { t } = useAppTranslation()
  const [binding, setBinding] = useState<string | null>(null)
  const [open, setOpen] = useState(false), [content, setContent] = useState('')
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    setBinding(null); setOpen(false); setContent(''); setNotice(null); setBusy(false)
    return () => { generation.current++ }
  }, [run.id, run.session_id, scope.spaceId, scope.signal])
  useEffect(() => {
    const current = generation.current
    const controller = new AbortController()
    const signal = mergeAbortSignals(controller.signal, scope.signal)
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    setBinding(null)
    const check = async () => {
      try {
        const result = await runsApi.liveInput(run.id, { ...scope, signal })
        if (!stopped && generation.current === current) setBinding(result.available ? result.binding_id : null)
      } catch { if (!stopped && generation.current === current) setBinding(null) }
      if (!stopped && generation.current === current && !signal?.aborted) timer = setTimeout(() => void check(), 5000)
    }
    if (run.status === 'running' && run.session_id) void check()
    return () => { stopped = true; controller.abort(); clearTimeout(timer) }
  }, [run.id, run.status, run.session_id, scope.spaceId, scope.signal])
  useEffect(() => {
    if (run.status !== 'running') setNotice(current => current ?? t('conversation_ui.run.live_input_ended'))
  }, [run.status, t])
  if (!binding && !open) return null
  const send = async () => {
    if (!binding || !content.trim() || busy) return
    const current = generation.current
    setBusy(true); setNotice(null)
    try {
      const result = await runsApi.sendLiveInput(run.id, { binding_id: binding, content: content.trim() }, scope)
      if (generation.current !== current) return
      if (result.state === 'injected') {
        setContent(''); setNotice(t('conversation_ui.run.live_input_delivered'))
        onChanged?.(run)
      } else if (result.state === 'pending') {
        // Saved and still owed to this turn by the server; clearing the draft prevents a duplicate send.
        setContent(''); setNotice(t('conversation_ui.run.live_input_pending'))
      } else {
        setBinding(null)
        setNotice(t(result.state === 'unconfirmed' ? 'conversation_ui.run.live_input_unconfirmed' : 'conversation_ui.run.live_input_not_delivered'))
      }
    } catch {
      if (generation.current === current) setNotice(t('conversation_ui.run.live_input_error'))
    } finally { if (generation.current === current) setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next) }}>
    <Button type="button" size="sm" variant="outline" className="h-6 px-2" disabled={!binding} onClick={() => setOpen(true)}>{t('conversation_ui.run.live_input')}</Button>
    <DialogContent className="w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>{t('conversation_ui.run.live_input')}</DialogTitle><DialogDescription>{t('conversation_ui.run.live_input_description')}</DialogDescription></DialogHeader>
      <Textarea aria-label={t('conversation_ui.run.live_input')} value={content} onChange={event => setContent(event.target.value)} maxLength={8000} disabled={busy} />
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      <DialogFooter><Button type="button" size="sm" disabled={busy || !binding || !content.trim()} onClick={() => void send()}>{t(busy ? 'conversation_ui.run.live_input_sending' : 'conversation_ui.run.live_input_send')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
