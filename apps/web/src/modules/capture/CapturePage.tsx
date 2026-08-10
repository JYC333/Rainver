import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Send, Paperclip, Mic, Square, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { activityApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Textarea } from '../../components/ui/textarea'
import { useSpace } from '../../contexts/SpaceContext'
import { spacePath } from '../../core/navigation'

export default function CapturePage() {
  const navigate = useNavigate()
  const { personalSpaceId } = useSpace()
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [recording, setRecording] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function handleCapture(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    if (!personalSpaceId) {
      toast.error('Personal Space is unavailable')
      return
    }
    setSubmitting(true)
    try {
      await activityApi.create({
        source_type: 'user_capture',
        content: text,
        title: text.slice(0, 80),
      }, { spaceId: personalSpaceId })
      toast.success('Saved to Activity Inbox')
      navigate(spacePath(personalSpaceId, '/activity'))
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function doUpload(file: File, kind: 'file' | 'voice') {
    if (!personalSpaceId) {
      toast.error('Personal Space is unavailable')
      return
    }
    setUploading(true)
    try {
      await activityApi.upload(file, { kind, spaceId: personalSpaceId })
      toast.success('Saved to Activity Inbox')
      navigate(spacePath(personalSpaceId, '/activity'))
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setUploading(false)
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) void doUpload(f, 'file')
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error('Voice recording is not supported in this browser')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data) }
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        const type = mr.mimeType || 'audio/webm'
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'mp4' : 'webm'
        const blob = new Blob(chunksRef.current, { type })
        setRecording(false)
        if (blob.size > 0) {
          void doUpload(new File([blob], `voice-${Date.now()}.${ext}`, { type }), 'voice')
        }
      }
      recorderRef.current = mr
      mr.start()
      setRecording(true)
    } catch (err) {
      toast.error(errMsg(err))
    }
  }

  function stopRecording() {
    recorderRef.current?.stop()
    recorderRef.current = null
  }

  const busy = submitting || uploading

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Plus className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Capture</h1>
          <p className="text-sm text-muted-foreground">Quickly save thoughts, notes, files, and voice memos.</p>
        </div>
      </div>

      <form onSubmit={handleCapture} className="space-y-3">
        <div className="rounded-md border border-border bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
          Save to: <span className="font-medium text-foreground">Personal Space</span>
        </div>
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Capture a thought, paste a link, or drop a snippet. Nothing commits without review."
          rows={6}
          className="resize-none"
          autoFocus
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>
            {text.length} chars · personal capture
          </span>
          <Button type="submit" size="sm" disabled={!text.trim() || busy || recording || !personalSpaceId}>
            <Send className="size-3.5 mr-1.5" />
            {submitting ? 'Capturing…' : 'Capture'}
          </Button>
        </div>
      </form>

      {/* File & voice capture (store-only — lands in the Activity Inbox for review) */}
      <div className="pt-4 border-t border-border space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Or capture a file / voice memo</p>
        <div className="flex items-center gap-2 flex-wrap">
          <input ref={fileInputRef} type="file" hidden onChange={onPickFile} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!personalSpaceId || busy || recording}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Paperclip className="size-3.5 mr-1.5" />}
            Attach file
          </Button>
          {recording ? (
            <Button type="button" variant="destructive" size="sm" onClick={stopRecording}>
              <Square className="size-3.5 mr-1.5" /> Stop &amp; save
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!personalSpaceId || busy}
              onClick={() => void startRecording()}
            >
              <Mic className="size-3.5 mr-1.5" /> Record voice
            </Button>
          )}
          {recording && (
            <span className="flex items-center gap-1.5 text-[12px] text-destructive">
              <span className="size-2 rounded-full bg-destructive animate-pulse" /> Recording…
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Files and voice memos up to 25&nbsp;MB are stored and queued in the Activity Inbox. Audio is not transcribed yet.
        </p>
      </div>
    </div>
  )
}
