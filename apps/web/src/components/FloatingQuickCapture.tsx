import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, X, Send, Link2, Mic, Paperclip, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { activityApi } from '../api/client'
import { useSpace } from '../contexts/SpaceContext'
import { cn, errMsg } from '../lib/utils'
import { spacePath } from '../core/navigation'

const URL_RE = /^https?:\/\/\S+$/i

/**
 * Compact, always-available capture widget — floats bottom-right, never a large Home panel.
 *
 * Context-free capture always lands in the user's Personal Space, independently of the
 * Space currently being browsed.
 * Saving keeps you in place and shows lightweight feedback rather than navigating away.
 */
export function FloatingQuickCapture() {
  const navigate = useNavigate()
  const { spaces, personalSpaceId } = useSpace()

  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)

  const targetId = personalSpaceId
  const targetSpace = spaces.find(s => s.id === targetId) ?? null
  const targetName = targetSpace ? 'Personal Space' : null

  const save = useCallback(async () => {
    const value = text.trim()
    if (!value || !targetId) return
    setBusy(true)
    try {
      const isLink = URL_RE.test(value)
      await activityApi.create(
        isLink
          ? { source_type: 'web_capture', content: value, title: value.slice(0, 80), source_url: value }
          : { source_type: 'user_capture', content: value, title: value.slice(0, 80) },
        { spaceId: targetId },
      )
      setText('')
      toast.success(`Saved to Inbox · ${targetName ?? 'space'}`, {
        action: { label: 'View', onClick: () => navigate(spacePath(targetId, '/activity')) },
      })
      textRef.current?.focus()
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }, [text, targetId, targetName, navigate])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      toast.message('File capture is coming soon', {
        description: 'Drag-and-drop upload is not wired yet. Paste text or a link for now.',
      })
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Quick capture"
        title="Quick capture"
        className="fixed bottom-20 right-5 md:bottom-5 z-40 flex items-center justify-center size-12 rounded-full shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{ background: 'var(--primary)', color: 'var(--primary-foreground)', border: '1px solid var(--primary)' }}
      >
        <Plus className="size-5" />
      </button>
    )
  }

  return (
    <div
      className="fixed bottom-20 right-5 md:bottom-5 z-40 w-[min(360px,calc(100vw-2.5rem))] rounded-xl border border-border bg-card shadow-2xl"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">Quick capture</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close quick capture"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className={cn('p-3.5 flex flex-col gap-2.5', dragOver && 'ring-2 ring-primary/40 rounded-b-xl')}>
        <textarea
          ref={textRef}
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Capture a thought or paste a link…"
          rows={3}
          className="w-full resize-none bg-transparent border-none outline-none text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground"
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }}
        />

        {URL_RE.test(text.trim()) && (
          <div className="flex items-center gap-1.5 text-[11px] text-accent-foreground">
            <Link2 className="size-3" /> Saved as a link capture
          </div>
        )}

        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Send className="size-3" />
          <span>Save to:</span>
          <span className="text-foreground font-medium">{targetName ?? 'Personal Space unavailable'}</span>
        </div>

        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled
              title="Attach file — coming soon"
              className="flex items-center justify-center size-7 rounded-md border border-border text-muted-foreground opacity-50 cursor-not-allowed"
            >
              <Paperclip className="size-3.5" />
            </button>
            <button
              type="button"
              disabled
              title="Voice capture — coming soon"
              className="flex items-center justify-center size-7 rounded-md border border-border text-muted-foreground opacity-50 cursor-not-allowed"
            >
              <Mic className="size-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={!text.trim() || busy || !targetId}
            className="flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-medium transition-opacity disabled:opacity-40 disabled:pointer-events-none"
            style={{ background: 'var(--primary)', border: '1px solid var(--primary)', color: 'var(--primary-foreground)' }}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
            Capture
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground leading-snug">
          Saved as activity first. Nothing becomes memory or changes files until you review and accept proposals.
        </p>
      </div>
    </div>
  )
}
