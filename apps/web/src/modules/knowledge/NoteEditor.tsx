import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useOutletContext, useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { CornerDownLeft, Link2, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { knowledgeApi, notesApi, ApiRequestError } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { cn, errMsg, isNotFoundError } from '../../lib/utils'
import type { EntityLink, EntityLinkType, KnowledgeItemSummary, Note, NoteRevision, NoteSummary } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { SaveStatusIndicator } from '../../components/SaveStatusIndicator'
import { useAutosave } from '../../hooks/useAutosave'
import {
  RichTextEditor,
  emptyRichTextDocument,
  normalizeNoteDocument,
  richTextSnapshotFromDocument,
  AiEditBanner,
  HistoryChip,
  NoteRevisionHistory,
  type RichTextDocument,
  type RichTextEditorHandle,
} from '../../components/editor'
import type { NotesOutletContext } from './NotesPage'

const LINK_TYPE_OPTIONS: { value: EntityLinkType; label: string }[] = [
  { value: 'related_to', label: 'related to' },
  { value: 'references', label: 'references' },
  { value: 'derived_from', label: 'derived from' },
  { value: 'source_for', label: 'source for' },
  { value: 'belongs_to', label: 'belongs to' },
]

const TARGET_KIND_OPTIONS = [
  { value: 'note', label: 'Note' },
  { value: 'knowledge_item', label: 'Wiki' },
]

type StatusPanel = 'links' | 'backlinks' | 'history' | null

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

/**
 * The open-note editor for the Notes section. Rendered into {@link NotesPage}'s
 * Outlet at `/knowledge/notes/:noteId`, so the section tree + tabs stay mounted.
 *
 * Layout is a full-bleed document: a borderless title + body that fill the pane,
 * with a bottom status bar. Links and backlinks are not rendered inline — they
 * live behind status-bar chips that open upward panels on demand. The editor
 * reports the resolved note up to the section so the open tab label stays in
 * sync (see {@link NotesOutletContext}).
 */
export default function NoteEditor() {
  const { noteId = '' } = useParams()
  const { activeSpaceId } = useSpace()
  const { onNoteResolved } = useOutletContext<NotesOutletContext>()

  const [note, setNote] = useState<Note | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [title, setTitle] = useState('')
  const [editorDocument, setEditorDocument] = useState<RichTextDocument>(() => emptyRichTextDocument())
  const editorRef = useRef<RichTextEditorHandle>(null)

  // Refs mirror the latest editable values so the debounced flush — which may
  // run after a re-render or while navigating away — reads fresh data.
  const noteRef = useRef<Note | null>(null)
  const titleRef = useRef(title)
  const editorDocumentRef = useRef(editorDocument)
  noteRef.current = note
  titleRef.current = title
  editorDocumentRef.current = editorDocument

  // Cache of fully-loaded notes (the list/tree only carry summaries without the
  // body), so re-opening a tab renders instantly instead of re-fetching.
  const noteCacheRef = useRef<Map<string, Note>>(new Map())

  const [links, setLinks] = useState<EntityLink[]>([])
  const [backlinks, setBacklinks] = useState<EntityLink[]>([])
  const [noteOptions, setNoteOptions] = useState<NoteSummary[]>([])
  const [wikiOptions, setWikiOptions] = useState<KnowledgeItemSummary[]>([])
  const [linkKind, setLinkKind] = useState('note')
  const [linkTargetId, setLinkTargetId] = useState('')
  const [linkType, setLinkType] = useState<EntityLinkType>('related_to')
  const [linking, setLinking] = useState(false)

  const [panel, setPanel] = useState<StatusPanel>(null)
  const statusBarRef = useRef<HTMLDivElement>(null)

  const [revisions, setRevisions] = useState<NoteRevision[] | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)

  const titleById = useMemo(() => {
    const map = new Map<string, { title: string; to: string }>()
    noteOptions.forEach(n => map.set(n.id, { title: n.title, to: `/knowledge/notes/${n.id}` }))
    wikiOptions.forEach(w => map.set(w.id, { title: w.title, to: `/knowledge/wiki/${w.id}` }))
    return map
  }, [noteOptions, wikiOptions])

  const loadLinks = useCallback(async (id: string) => {
    try {
      const [out, back] = await Promise.all([notesApi.links(id), notesApi.backlinks(id)])
      // links() returns every link touching the note; keep only the outgoing ones here.
      setLinks(out.filter(l => l.source_type === 'note' && l.source_id === id))
      setBacklinks(back)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }, [])

  // Persist the current editor state. Reads the latest values from refs so it
  // is safe to call from a debounce timer or a flush-on-leave cleanup. A
  // blank title is omitted (the backend rejects empty titles) rather than
  // failing the save. `expect_version` makes every save go through the
  // same optimistic-concurrency + revision-history writer AI edits use —
  // on a real conflict (someone/something else changed the note since it
  // loaded) the save is refused rather than silently overwriting it; the
  // user's in-progress edit stays on screen and the History panel shows
  // what changed underneath them.
  const performSaveImpl = useCallback(async () => {
    const current = noteRef.current
    if (!current) return
    const snapshot = editorRef.current?.getSnapshot() ?? richTextSnapshotFromDocument(editorDocumentRef.current)
    const trimmedTitle = titleRef.current.trim()
    try {
      const updated = await notesApi.update(current.id, {
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        ...snapshot,
        expect_version: current.version,
      })
      onNoteResolved(updated)
      noteCacheRef.current.set(updated.id, updated)
      // Don't clobber the view if we've since navigated to a different note.
      if (noteRef.current?.id === current.id) {
        noteRef.current = updated
        setNote(updated)
      }
      setRevisions(null)
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 409) {
        toast.error('This note changed elsewhere while you were editing. Your edit was not saved — check History, then retry.')
      } else {
        toast.error(errMsg(e))
      }
      throw e
    }
  }, [onNoteResolved])

  // `flushKey: noteId` flushes a pending save when switching to a different
  // note (this component stays mounted across the switch), not only on
  // unmount.
  const { state: saveState, setState: setSaveState, scheduleSave, performSave } = useAutosave(performSaveImpl, { flushKey: noteId })
  const saveStateRef = useRef(saveState)
  saveStateRef.current = saveState

  // Apply a fully-loaded note to the editor (the clean, "saved" baseline).
  const seedFromNote = useCallback((n: Note) => {
    noteRef.current = n
    setNote(n)
    setTitle(n.title)
    setEditorDocument(normalizeNoteDocument(n))
    setSaveState('saved')
    setNotFound(false)
    setRevisions(null)
  }, [setSaveState])

  const loadHistory = useCallback(async (id: string) => {
    try {
      setRevisions(await notesApi.revisions(id))
    } catch (e) {
      toast.error(errMsg(e))
    }
  }, [])

  const rollback = useCallback(async (toVersion: number) => {
    const current = noteRef.current
    if (!current) return
    if (saveStateRef.current !== 'saved' && !window.confirm('You have an unsaved edit. Restoring a version will discard it. Continue?')) return
    setHistoryBusy(true)
    try {
      const restored = await notesApi.rollback(current.id, toVersion)
      onNoteResolved(restored)
      noteCacheRef.current.set(restored.id, restored)
      seedFromNote(restored)
      await loadHistory(restored.id)
      toast.success(`Restored version ${toVersion} as version ${restored.version}`)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setHistoryBusy(false)
    }
  }, [onNoteResolved, seedFromNote, loadHistory])

  // Refresh a note shown from cache, in the background. Only applies the result
  // when it's safe — same note, no pending local edits — and only touches the
  // editor body if the content actually changed (to avoid resetting the cursor).
  const revalidate = useCallback(async (id: string) => {
    let fresh: Note
    try {
      fresh = await notesApi.get(id)
    } catch {
      return
    }
    noteCacheRef.current.set(fresh.id, fresh)
    if (noteRef.current?.id !== fresh.id || saveStateRef.current !== 'saved') return
    onNoteResolved(fresh)
    setTitle(fresh.title)
    setNote(fresh)
    noteRef.current = fresh
    const currentJson = JSON.stringify(editorRef.current?.getSnapshot().content_json ?? editorDocumentRef.current)
    const freshDoc = normalizeNoteDocument(fresh)
    if (JSON.stringify(freshDoc) !== currentJson) setEditorDocument(freshDoc)
  }, [onNoteResolved])

  const load = useCallback(async () => {
    if (!noteId || !activeSpaceId) {
      setNote(null)
      setLoading(false)
      return
    }
    setPanel(null)
    // Clear the previous note's links so stale counts don't linger mid-switch.
    setLinks([])
    setBacklinks([])

    // Cache hit → render instantly, then revalidate quietly in the background.
    const cached = noteCacheRef.current.get(noteId)
    if (cached) {
      seedFromNote(cached)
      setLoading(false)
      void loadLinks(cached.id)
      void revalidate(noteId)
      return
    }

    setLoading(true)
    setNotFound(false)
    try {
      const n = await notesApi.get(noteId)
      noteCacheRef.current.set(n.id, n)
      seedFromNote(n)
      onNoteResolved(n)
      // Links aren't on the critical path (they live behind a footer panel), so
      // fetch them without blocking the editor from rendering.
      void loadLinks(n.id)
    } catch (e) {
      if (isNotFoundError(e)) setNotFound(true)
      else toast.error(errMsg(e))
      setNote(null)
    } finally {
      setLoading(false)
    }
  }, [noteId, activeSpaceId, loadLinks, onNoteResolved, seedFromNote, revalidate])

  useEffect(() => { load() }, [load])

  // Lazily fetch candidates for the link picker (notes + wiki items in this space).
  useEffect(() => {
    if (!activeSpaceId) return
    notesApi.list({ status: 'active', limit: 100 }).then(p => setNoteOptions(p.items)).catch(() => {})
    knowledgeApi.list({ status: 'active', limit: 100 }).then(p => setWikiOptions(p.items)).catch(() => {})
  }, [activeSpaceId])

  // Dismiss the open status-bar panel on outside click / Escape.
  useEffect(() => {
    if (!panel) return
    function onPointerDown(e: MouseEvent) {
      if (statusBarRef.current && !statusBarRef.current.contains(e.target as Node)) setPanel(null)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setPanel(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [panel])

  async function addLink() {
    if (!note || !linkTargetId) {
      toast.error('Pick something to link to')
      return
    }
    setLinking(true)
    try {
      await notesApi.createLink(note.id, {
        target_type: linkKind as EntityLink['target_type'],
        target_id: linkTargetId,
        link_type: linkType,
      })
      setLinkTargetId('')
      toast.success('Link added')
      await loadLinks(note.id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLinking(false)
    }
  }

  async function removeLink(linkId: string) {
    if (!note) return
    try {
      await notesApi.deleteLink(note.id, linkId)
      await loadLinks(note.id)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  function renderEndpoint(type: string, id: string) {
    const known = titleById.get(id)
    if (known) return <Link to={known.to} className="underline-offset-2 hover:underline">{known.title}</Link>
    return <span>{type} · {id.slice(0, 8)}</span>
  }

  const targetChoices = linkKind === 'note'
    ? noteOptions.filter(n => n.id !== note?.id).map(n => ({ value: n.id, label: n.title }))
    : wikiOptions.map(w => ({ value: w.id, label: w.title }))

  function togglePanel(next: Exclude<StatusPanel, null>) {
    setPanel(cur => {
      const opening = cur !== next
      if (opening && next === 'history' && note) void loadHistory(note.id)
      return opening ? next : null
    })
  }

  // Keep the editor mounted across note switches: only fall back to the skeleton
  // on the very first load (no note yet). When switching, the previous note stays
  // visible (dimmed) until the new one arrives — no jarring unmount/remount.
  if (!note) {
    if (loading) {
      return (
        <div className="flex h-full flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-8 space-y-4">
              <Skeleton className="h-9 w-2/3" />
              <Skeleton className="h-48 w-full" />
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {!activeSpaceId
          ? 'Select an operational space to inspect this note.'
          : notFound
            ? 'Note not found.'
            : 'Unable to load this note.'}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 py-8 sm:px-8">
          <input
            value={title}
            onChange={e => { setTitle(e.target.value); scheduleSave() }}
            placeholder="Untitled note"
            aria-label="Note title"
            className="w-full bg-transparent text-3xl font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          {note.updated_by_run_id && note.version > 1 && saveState === 'saved' && (
            <div className="mt-4">
              <AiEditBanner runId={note.updated_by_run_id} busy={historyBusy} onUndo={() => void rollback(note.version - 1)} />
            </div>
          )}
          <RichTextEditor
            ref={editorRef}
            initialContent={editorDocument}
            variant="page"
            className="mt-4 flex-1"
            onChange={scheduleSave}
          />
        </div>
      </div>

      <div ref={statusBarRef} className="relative shrink-0 border-t border-border bg-card/50">
        {panel === 'links' && (
          <StatusPanelShell title="Links" onClose={() => setPanel(null)}>
            <div className="max-h-[30vh] space-y-2 overflow-y-auto">
              {links.length === 0 && <p className="text-sm text-muted-foreground">No outgoing links.</p>}
              {links.map(l => (
                <div key={l.id} className="flex items-center justify-between gap-2 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline">{l.link_type}</Badge>
                    <span className="text-muted-foreground">→</span>
                    {renderEndpoint(l.target_type, l.target_id)}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => removeLink(l.id)} aria-label="Remove link">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="mt-3 space-y-2 border-t border-border pt-3">
              <div className="flex items-end gap-2">
                <div className="w-[88px] shrink-0">
                  <Label className="text-xs">Kind</Label>
                  <Select
                    size="sm"
                    dropUp
                    value={linkKind}
                    onChange={v => { setLinkKind(v); setLinkTargetId('') }}
                    options={TARGET_KIND_OPTIONS}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <Label className="text-xs">Target</Label>
                  <Select
                    size="sm"
                    dropUp
                    value={linkTargetId}
                    onChange={setLinkTargetId}
                    options={[{ value: '', label: targetChoices.length ? 'Select…' : 'None available' }, ...targetChoices]}
                  />
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Label className="text-xs">Relation</Label>
                  <Select size="sm" dropUp value={linkType} onChange={v => setLinkType(v as EntityLinkType)} options={LINK_TYPE_OPTIONS} />
                </div>
                <Button size="sm" variant="outline" onClick={addLink} disabled={linking || !linkTargetId}>
                  Add link
                </Button>
              </div>
            </div>
          </StatusPanelShell>
        )}

        {panel === 'backlinks' && (
          <StatusPanelShell title="Backlinks" onClose={() => setPanel(null)}>
            <div className="max-h-[40vh] space-y-2 overflow-y-auto">
              {backlinks.length === 0 && <p className="text-sm text-muted-foreground">Nothing links here yet.</p>}
              {backlinks.map(l => (
                <div key={l.id} className="flex items-center gap-2 text-sm">
                  {renderEndpoint(l.source_type, l.source_id)}
                  <span className="text-muted-foreground">→</span>
                  <Badge variant="outline">{l.link_type}</Badge>
                  <span className="text-muted-foreground">this note</span>
                </div>
              ))}
            </div>
          </StatusPanelShell>
        )}

        {panel === 'history' && (
          <StatusPanelShell title="History" onClose={() => setPanel(null)}>
            <div className="max-h-[50vh] overflow-y-auto">
              <NoteRevisionHistory
                revisions={revisions}
                currentVersion={note.version}
                busy={historyBusy}
                onRollback={toVersion => void rollback(toVersion)}
              />
            </div>
          </StatusPanelShell>
        )}

        <div className="flex h-10 items-center justify-between gap-3 px-3 text-xs sm:px-4">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span className="hidden truncate sm:inline">Updated {fmt(note.updated_at)}</span>
          </div>
          <div className="flex items-center gap-1">
            <StatusChip
              active={panel === 'links'}
              onClick={() => togglePanel('links')}
              icon={<Link2 className="size-3.5" />}
              label="Links"
              count={links.length}
            />
            <StatusChip
              active={panel === 'backlinks'}
              onClick={() => togglePanel('backlinks')}
              icon={<CornerDownLeft className="size-3.5" />}
              label="Backlinks"
              count={backlinks.length}
            />
            <HistoryChip active={panel === 'history'} onClick={() => togglePanel('history')} />
            <div className="mx-1 h-5 w-px bg-border" />
            <SaveStatusIndicator state={saveState} onRetry={() => { void performSave() }} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** A status-bar chip that toggles an upward panel; shows a live count badge. */
function StatusChip({
  active, onClick, icon, label, count,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors',
        active ? 'bg-primary/10 text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {icon}
      <span>{label}</span>
      <span
        className={cn(
          'min-w-4 rounded-full px-1 text-center text-[10px] font-semibold',
          count > 0 ? 'bg-primary/15 text-accent-foreground' : 'bg-muted text-muted-foreground',
        )}
      >
        {count}
      </span>
    </button>
  )
}

/** The floating panel that rises from a status-bar chip. */
function StatusPanelShell({
  title, onClose, children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="absolute bottom-[calc(100%+0.5rem)] right-2 z-30 w-[min(26rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-border bg-card shadow-lg sm:right-4">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title} panel`}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}
