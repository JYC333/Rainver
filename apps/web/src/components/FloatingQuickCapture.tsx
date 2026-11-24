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
import { useAppTranslation } from '../i18n'
import { registerInMemoryResidue, sessionEpoch } from '../lib/sessionResidue'

const URL_RE = /^https?:\/\/\S+$/i
interface CaptureDraft {
  text: string
  pasted: boolean
  chosen: CaptureDestination | null
}
const emptyDraft: CaptureDraft = { text: '', pasted: false, chosen: null }

/**
 * The one capture affordance, everywhere. Do not add a second floating button
 * for another pipeline: the moment a thought arrives is when its category is
 * not yet known.
 *
 * The destination is chosen after the box is open, defaults are inferred from
 * where the text came from rather than what it says, and every default is one
 * click from being overridden.
 *
 * From `md` up it sits at the lower right of a Project's middle content, beside
 * the docked Project chat rather than over it: the Project layout publishes
 * that edge as `--project-content-right-inset` (unset, so zero, elsewhere).
 */
export function FloatingQuickCapture() {
  const { t } = useAppTranslation()
  const navigate = useNavigate()
  const { spaces, personalSpaceId, activeSpaceId } = useSpace()
  const { projectId, target } = useProjectCaptureContext()

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const spaceId = activeSpaceId ?? personalSpaceId
  const draftKey = JSON.stringify([spaceId, projectId, target?.objectId])
  const [drafts, setDrafts] = useState<Record<string, CaptureDraft>>({})
  useEffect(() => registerInMemoryResidue(() => setDrafts({})), [])
  const { text, pasted, chosen } = drafts[draftKey] ?? emptyDraft
  const updateDraft = useCallback((update: (draft: CaptureDraft) => CaptureDraft) => {
    setDrafts(previous => {
      const next = { ...previous }
      const updated = update(previous[draftKey] ?? emptyDraft)
      if (updated.text || updated.pasted || updated.chosen) next[draftKey] = updated
      else delete next[draftKey]
      return next
    })
  }, [draftKey])
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

  const close = () => {
    setOpen(false)
    updateDraft(draft => draft.text.trim() ? draft : emptyDraft)
  }

  // In a Space with one member there is no team to be divided from, so the
  // "only you / team visible" half of every line is noise. What gets stored is
  // identical either way. Do not migrate rows when the Space gains members.
  // Unknown member count reads as "not solo": the Space list arrives
  // asynchronously, and the wording that may be wrong in the gap is the one
  // that understates sharing.
  const memberCount = spaces.find(s => s.id === (activeSpaceId ?? personalSpaceId))?.member_count
  const soloSpace = memberCount !== undefined && memberCount <= 1

  const label = useCallback((value: CaptureDestination) => {
    const name =
      value === 'object_marginalia' ? t('capture.object_marginalia', { target: target?.title ?? t('capture.this') })
      : value === 'project_marginalia' ? t('capture.project_marginalia')
      : value === 'project_raw' ? t('capture.project_raw')
      : t('capture.personal_inbox')
    const consequence =
      value === 'object_marginalia' || value === 'project_marginalia'
        ? (soloSpace ? [] : [t('capture.only_you')])
        : value === 'project_raw' ? [t('capture.pending'), ...(soloSpace ? [] : [t('capture.team_visible')])]
        : [t('capture.pending'), ...(soloSpace ? [] : [t('capture.only_you')])]
    return [name, ...consequence].join(' · ')
  }, [target?.title, soloSpace, t])

  // The segmented control has room for a name and nothing else, so every
  // destination also carries its consequence on the line below it.
  const short = useCallback((value: CaptureDestination) => (
    value === 'object_marginalia' ? target?.title ?? t('capture.this_short')
    : value === 'project_marginalia' ? t('capture.project_short')
    : value === 'project_raw' ? t('capture.raw_short')
    : t('capture.inbox_short')
  ), [target?.title, t])

  const save = useCallback(async () => {
    const value = text.trim()
    if (!value || busy) return
    const epoch = sessionEpoch()
    setBusy(true)
    try {
      const result = await captureApi.create({
        text: value,
        destination,
        ...(destination === 'personal_inbox' ? {} : { project_id: projectId ?? undefined }),
        ...(destination === 'object_marginalia' && target ? { target_id: target.objectId } : {}),
      }, undefined, spaceId ?? undefined)
      if (epoch !== sessionEpoch()) return
      // Only what was sent is cleared. The box keeps focus for the next
      // thought, so text typed while the save ran is kept, not thrown away.
      updateDraft(current => ({
        ...emptyDraft,
        text: current.text === text ? '' : current.text.startsWith(text) ? current.text.slice(text.length).trimStart() : current.text,
      }))
      // A capture that landed in a note may have landed in a note the user is
      // looking at. Tell the surfaces once, here, instead of making them watch.
      if (result.note_id) {
        publishNoteChanged({ noteId: result.note_id, projectId: result.project_id, reason: 'capture' })
      }
      const href = result.note_id
        ? spacePath(result.space_id, `/projects/${result.project_id}/notes/${result.note_id}`)
        : spacePath(result.space_id, `/activity/${encodeURIComponent(result.activity_id)}`)
      toast.success(result.note_title
        ? t('capture.captured_to', { name: result.note_title })
        : t('capture.saved', { destination: label(destination) }), {
        action: { label: t('capture.view'), onClick: () => navigate(href) },
      })
      textRef.current?.focus()
    } catch (err) {
      if (epoch === sessionEpoch()) toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }, [text, busy, destination, projectId, target, label, navigate, spaceId, updateDraft, t])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      toast.message(t('capture.file_soon'), {
        description: t('capture.file_soon_description'),
      })
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('capture.quick')}
        title={t('capture.quick')}
        className="fixed bottom-[calc(5rem+var(--app-safe-bottom))] right-5 md:bottom-5 md:right-[calc(1.25rem+var(--project-content-right-inset,0px))] z-40 flex items-center justify-center size-12 rounded-full shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{ background: 'var(--primary)', color: 'var(--primary-foreground)', border: '1px solid var(--primary)' }}
      >
        <Plus className="size-5" />
      </button>
    )
  }

  return (
    <div
      className="fixed bottom-[calc(5rem+var(--app-safe-bottom))] right-5 md:bottom-5 md:right-[clamp(1.25rem,calc(1.25rem+var(--project-content-right-inset,0px)),calc(100vw-var(--project-content-left-edge,0px)-1.25rem-360px))] z-40 w-[min(360px,calc(100vw-2.5rem))] rounded-xl border border-border bg-card shadow-2xl"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('capture.quick')}</span>
        <button
          type="button"
          onClick={close}
          aria-label={t('capture.close')}
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
          <div role="radiogroup" aria-label={t('capture.destination')} className="flex w-full items-center gap-0.5 rounded-lg bg-muted p-1">
            {available.map(value => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={value === destination}
                aria-label={label(value)}
                title={label(value)}
                onClick={() => { updateDraft(draft => ({ ...draft, chosen: value })); textRef.current?.focus() }}
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
          onChange={e => {
            const value = e.target.value
            updateDraft(draft => ({ ...draft, text: value, pasted: Boolean(value.trim()) && draft.pasted }))
          }}
          onPaste={() => updateDraft(draft => ({ ...draft, pasted: true }))}
          placeholder={t('capture.placeholder')}
          rows={3}
          className="w-full resize-none bg-transparent border-none outline-none text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground"
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }}
        />

        {URL_RE.test(text.trim()) && (
          <div className="flex items-center gap-1.5 text-[11px] text-accent-foreground">
            <Link2 className="size-3" /> {t('capture.link_capture')}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled
              title={t('capture.attach_soon')}
              className="flex items-center justify-center size-7 rounded-md border border-border text-muted-foreground opacity-50 cursor-not-allowed"
            >
              <Paperclip className="size-3.5" />
            </button>
            <button
              type="button"
              disabled
              title={t('capture.voice_soon')}
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
            {t('capture.submit')}
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground leading-snug">
          {destination === 'object_marginalia' || destination === 'project_marginalia'
            ? t('capture.marginalia_explanation')
            : t('capture.review_explanation')}
        </p>
      </div>
    </div>
  )
}
