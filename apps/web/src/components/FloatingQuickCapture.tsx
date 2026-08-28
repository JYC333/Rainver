import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, X, Send, Link2, Mic, Paperclip, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { captureApi } from '../api/client'
import { useSpace } from '../contexts/SpaceContext'
import { cn, errMsg } from '../lib/utils'
import { spacePath } from '../core/navigation'
import { publishNoteChanged } from '../core/noteEvents'
import { useProjectCaptureContext } from '../contexts/CaptureContext'
import type { CaptureDestination } from '../types/api'

const URL_RE = /^https?:\/\/\S+$/i

/**
 * The one capture affordance, everywhere.
 *
 * There used to be two floating buttons at the same corner — a global one
 * writing raw activity to the Personal Space and a Project one appending
 * straight into a note — and the overlap was the visible symptom of a real
 * split: two pipelines competing for one gesture. They are one entry now,
 * because the moment a thought arrives is exactly when its category is not yet
 * known, and classifying before typing is the friction capture exists to remove.
 *
 * So the destination is chosen *after* the box is open, defaults are inferred
 * from where the text came from rather than what it says, and every default is
 * one click from being overridden.
 */
export function FloatingQuickCapture() {
  const navigate = useNavigate()
  const { spaces, personalSpaceId, activeSpaceId } = useSpace()
  const { projectId, target } = useProjectCaptureContext()

  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // Set by the paste event, not derived from the text: a paste is where the
  // content came from, which is the only deterministic signal available.
  const [pasted, setPasted] = useState(false)
  // Deliberately reset after every capture. ADR 0013 decision 2 removed a
  // sticky write target once already — a destination remembered from last time
  // is invisible at the moment of writing, which is a mode error.
  const [chosen, setChosen] = useState<CaptureDestination | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  const available = useMemo<CaptureDestination[]>(() => {
    if (!projectId) return ['personal_inbox']
    return [
      ...(target ? (['object_marginalia'] as CaptureDestination[]) : []),
      'project_marginalia',
      'project_raw',
      'personal_inbox',
    ]
  }, [projectId, target])

  const inferred = useMemo<CaptureDestination>(() => {
    if (!projectId) return 'personal_inbox'
    if (pasted || URL_RE.test(text.trim())) return 'project_raw'
    return target ? 'object_marginalia' : 'project_marginalia'
  }, [projectId, target, pasted, text])

  const destination = chosen && available.includes(chosen) ? chosen : inferred

  // An abandoned capture must not set the destination for the next one either.
  // The composer is mounted once for the whole app, so without this an explicit
  // choice would survive closing the panel and walking into another Project.
  const reset = useCallback(() => { setPasted(false); setChosen(null) }, [])
  const close = useCallback(() => { setOpen(false); reset() }, [reset])
  useEffect(reset, [reset, projectId, target?.objectId])

  // In a Space with one member there is no team to be divided from, so the
  // "only you / team visible" half of every line is noise. What gets stored is
  // identical either way — a Space that later gains members needs no migration.
  // Unknown member count reads as "not solo": the Space list arrives
  // asynchronously, and the wording that may be wrong in the gap is the one
  // that understates sharing.
  const memberCount = spaces.find(s => s.id === (activeSpaceId ?? personalSpaceId))?.member_count
  const soloSpace = memberCount !== undefined && memberCount <= 1

  const label = useCallback((value: CaptureDestination) => {
    const name =
      value === 'object_marginalia' ? `marginalia on ${target?.title ?? 'this'}`
      : value === 'project_marginalia' ? 'project marginalia'
      : value === 'project_raw' ? 'project raw material'
      : 'personal inbox'
    const consequence =
      value === 'object_marginalia' || value === 'project_marginalia'
        ? (soloSpace ? [] : ['only you'])
        : value === 'project_raw' ? ['pending', ...(soloSpace ? [] : ['team visible'])]
        : ['pending', ...(soloSpace ? [] : ['only you'])]
    return [name, ...consequence].join(' · ')
  }, [target?.title, soloSpace])

  // The segmented control has room for a name and nothing else, so every
  // destination also carries its consequence on the line below it.
  const short = useCallback((value: CaptureDestination) => (
    value === 'object_marginalia' ? target?.title ?? 'This'
    : value === 'project_marginalia' ? 'Project'
    : value === 'project_raw' ? 'Raw'
    : 'Inbox'
  ), [target?.title])

  const save = useCallback(async () => {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    try {
      const result = await captureApi.create({
        text: value,
        destination,
        ...(destination === 'personal_inbox' ? {} : { project_id: projectId ?? undefined }),
        ...(destination === 'object_marginalia' && target ? { target_id: target.objectId } : {}),
      })
      setText('')
      reset()
      // A capture that landed in a note may have landed in a note the user is
      // looking at. Tell the surfaces once, here, instead of making them watch.
      if (result.note_id) {
        publishNoteChanged({ noteId: result.note_id, projectId: result.project_id, reason: 'capture' })
      }
      // Raw material joins the Space's one review queue, but the reader should
      // land where they were standing: the Project's own view of that queue,
      // not the Space-wide list they would then have to navigate back out of.
      const href = result.note_id
        ? spacePath(result.space_id, `/projects/${result.project_id}/notes/${result.note_id}`)
        : result.project_id
          ? spacePath(result.space_id, `/projects/${result.project_id}/sources?tab=raw`)
          : spacePath(result.space_id, '/activity?status=raw')
      toast.success(result.note_title ? `Captured to ${result.note_title}` : `Saved · ${label(destination)}`, {
        action: { label: 'View', onClick: () => navigate(href) },
      })
      textRef.current?.focus()
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }, [text, busy, destination, projectId, target, label, navigate, reset])

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
          onClick={close}
          aria-label="Close quick capture"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className={cn('p-3.5 flex flex-col gap-2.5', dragOver && 'ring-2 ring-primary/40 rounded-b-xl')}>
        {/* Every destination and its consequence, before a word is typed: the
            options are laid out flat rather than hidden behind a disclosure,
            because "where did that go" is the failure mode a capture box has,
            and an override that costs two clicks is an override nobody makes. */}
        {available.length > 1 && (
          <div role="radiogroup" aria-label="Capture destination" className="flex w-full items-center gap-0.5 rounded-lg bg-muted p-1">
            {available.map(value => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={value === destination}
                aria-label={label(value)}
                title={label(value)}
                onClick={() => { setChosen(value); textRef.current?.focus() }}
                className={cn(
                  'min-w-0 flex-1 truncate rounded-md px-2 py-1 text-[11px] font-medium transition-all',
                  value === destination
                    ? 'bg-background text-foreground shadow'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {short(value)}
              </button>
            ))}
          </div>
        )}

        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Send className="size-3 shrink-0" />
          <span className="truncate">→ {label(destination)}</span>
        </p>

        <textarea
          ref={textRef}
          autoFocus
          value={text}
          onChange={e => { setText(e.target.value); if (!e.target.value.trim()) setPasted(false) }}
          onPaste={() => setPasted(true)}
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
            disabled={!text.trim() || busy}
            className="flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-medium transition-opacity disabled:opacity-40 disabled:pointer-events-none"
            style={{ background: 'var(--primary)', border: '1px solid var(--primary)', color: 'var(--primary-foreground)' }}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
            Capture
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground leading-snug">
          {destination === 'object_marginalia' || destination === 'project_marginalia'
            ? 'Recorded as activity and written straight into your own note, not into the project\'s shared material.'
            : 'Saved as activity first. Nothing becomes memory or changes files until you review and accept proposals.'}
        </p>
      </div>
    </div>
  )
}
