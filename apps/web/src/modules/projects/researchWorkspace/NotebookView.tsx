import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { notesApi, ApiRequestError } from '../../../api/client'
import type { Note, NoteRevision } from '../../../types/api'
import type { RichTextEditorHandle } from '../../../components/editor/types'
import {
  RichTextEditor,
  AiEditBanner,
  HistoryChip,
  NoteRevisionHistory,
  normalizeNoteDocument,
  richTextSnapshotFromDocument,
} from '../../../components/editor'
import { SaveStatusIndicator } from '../../../components/SaveStatusIndicator'
import { useAutosave } from '../../../hooks/useAutosave'
import { Card } from '../../../components/ui/card'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { errMsg } from '../../../lib/utils'

/**
 * One card per project note in the Notebook tab. This is deliberately just
 * the generic Notes save/history/AI-co-edit machinery (see NoteEditor.tsx,
 * NoteRevisionHistory) pointed at a project-scoped note — a project's
 * "notebook" is free-form Notes, not a fixed set of sections, so any number
 * of these can exist and the user can add more via the panel below.
 */
export function ProjectNoteCard({
  note,
  onSaved,
  onDeleted,
}: {
  note: Note
  onSaved: (value: Note) => void
  onDeleted: (id: string) => void
}) {
  const editor = useRef<RichTextEditorHandle>(null)
  const [busy, setBusy] = useState(false)
  const [revisions, setRevisions] = useState<NoteRevision[] | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [title, setTitle] = useState(note.title)

  // Mirrors NoteEditor's editorDocument/revalidate split: our own save's
  // response is a fresh round-tripped object, but the editor already shows
  // exactly what was just typed, so nothing to reload there. Only an
  // external change (AI chat edit, rollback) reconciles the live document.
  const [editorContent, setEditorContent] = useState(() => normalizeNoteDocument(note))
  const baseVersionRef = useRef(note.version)
  const titleRef = useRef(note.title)

  const performSaveImpl = async () => {
    const snapshot = editor.current?.getSnapshot() ?? richTextSnapshotFromDocument(editorContent)
    const trimmedTitle = titleRef.current.trim()
    try {
      const updated = await notesApi.update(note.id, {
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        ...snapshot,
        expect_version: baseVersionRef.current,
      })
      baseVersionRef.current = updated.version
      onSaved(updated)
      setRevisions(null)
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        toast.error(`"${note.title}" changed elsewhere while you were editing. Your edit was not saved — check History, then retry.`)
      } else {
        toast.error(errMsg(error))
      }
      throw error
    }
  }

  const { state: saveState, setState: setSaveState, scheduleSave, performSave } = useAutosave(performSaveImpl)
  const dirty = saveState !== 'saved'
  if (!dirty && note.version !== baseVersionRef.current) {
    baseVersionRef.current = note.version
    titleRef.current = note.title
    setTitle(note.title)
    const freshDoc = normalizeNoteDocument(note)
    if (JSON.stringify(freshDoc) !== JSON.stringify(editorContent)) setEditorContent(freshDoc)
  }

  const latestIsAi = Boolean(note.updated_by_run_id)

  async function loadHistory(open = true) {
    setHistoryOpen(open)
    if (!open) return
    try {
      setRevisions(await notesApi.revisions(note.id))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function rollback(toVersion: number) {
    if (dirty && !window.confirm('You have an unsaved edit in this note. Restoring a version will discard it. Continue?')) return
    setBusy(true)
    try {
      const next = await notesApi.rollback(note.id, toVersion)
      onSaved(next)
      setSaveState('saved')
      setRevisions(null)
      setHistoryOpen(false)
      toast.success(`Restored version ${toVersion} as version ${next.version}`)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  async function deleteNote() {
    if (!window.confirm(`Delete "${note.title}"? This can be undone from Knowledge > Notes.`)) return
    try {
      await notesApi.delete(note.id)
      onDeleted(note.id)
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <input
          value={title}
          onChange={e => { setTitle(e.target.value); titleRef.current = e.target.value; scheduleSave() }}
          placeholder="Untitled note"
          aria-label="Note title"
          className="min-w-0 flex-1 bg-transparent text-lg font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <div className="flex shrink-0 items-center gap-2">
          <SaveStatusIndicator state={saveState} onRetry={() => { void performSave() }} />
          <HistoryChip active={historyOpen} onClick={() => void loadHistory(!historyOpen)} />
          <Link to={`/knowledge/notes/${note.id}`} className="text-xs text-muted-foreground hover:underline">Open in Notes</Link>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Version {note.version} · updated {new Date(note.updated_at).toLocaleString()}
        {note.updated_by_run_id
          ? <> by <Link className="hover:underline" to={`/runs/${note.updated_by_run_id}`}>AI</Link></>
          : note.updated_by_user_id ? ' by a researcher' : ''}
      </p>
      {latestIsAi && note.version > 1 && (
        <AiEditBanner runId={note.updated_by_run_id!} busy={busy} onUndo={() => void rollback(note.version - 1)} />
      )}
      <RichTextEditor
        ref={editor}
        key={note.id}
        initialContent={editorContent}
        variant="notes"
        onChange={scheduleSave}
      />
      {historyOpen && (
        <NoteRevisionHistory
          revisions={revisions}
          currentVersion={note.version}
          busy={busy}
          onRollback={toVersion => void rollback(toVersion)}
        />
      )}
      <div className="flex justify-end border-t border-border/60 pt-2">
        <button type="button" onClick={() => void deleteNote()} className="text-xs text-muted-foreground hover:text-destructive">
          Delete note
        </button>
      </div>
    </Card>
  )
}
