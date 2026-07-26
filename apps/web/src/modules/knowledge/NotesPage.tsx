import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useSpaceNavigate as useNavigate } from '../../core/spaceNav'
import { stripSpacePrefix } from '../../core/navigation'
import { FolderPlus, Plus, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { notesApi, notesCollectionsApi, notesTreeApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { cn, errMsg } from '../../lib/utils'
import type { Note, NoteCollection, NoteSummary } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Label } from '../../components/ui/label'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { emptyRichTextDocument, richTextSnapshotFromDocument } from '../../components/editor'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog'
import KnowledgeSectionHeader from './KnowledgeSectionHeader'
import { NotesListPane } from './NotesListPane'
import NotesTree from './notes-tree/NotesTree'
import {
  applyCollectionMoves,
  applyNoteMoves,
  collectionPath,
  nextCollectionSortOrder,
  planCollectionMove,
  removeCollection,
  upsertCollection,
  type CollectionMove,
  type NoteMove,
} from './notes-tree/model'
import { createOptimisticTreeMutationQueue } from './notes-tree/treeMutationQueue'
import {
  ROOT_PARENT,
  activeNoteIdFromPath,
  hideArchivedOrDeletedNotes,
  isNoteToNoteLink,
  readTabs,
  restoreStatus,
  writeTabs,
} from './notesPageModel'

/** Context handed to the open-note editor (NoteEditor) via the Outlet. */
export interface NotesOutletContext {
  /** Report the resolved/saved note so the open tab label and list stay in sync. */
  onNoteResolved: (note: Note) => void
}

type CollectionDialogState =
  | { mode: 'create-root'; collection?: undefined }
  | { mode: 'create-child'; collection: NoteCollection }
  | { mode: 'rename'; collection: NoteCollection }
  | { mode: 'move'; collection: NoteCollection }
  | null

type NoteDeleteTarget = Pick<NoteSummary, 'id' | 'title'> & Partial<Omit<NoteSummary, 'id' | 'title'>>

interface LinkedDeleteDialogState {
  notes: NoteDeleteTarget[]
  relatedLinkCount: number
}

// Chrome-style tab silhouette in a 176×32 viewBox: rounded top corners plus
// curved feet flaring to the bottom edge. The fill path is closed; the stroke
// path is the same outline minus the bottom edge, so the active tab's border is
// open at the bottom and merges into the editor below.
const TAB_FILL_PATH =
  'M0 32 C6 32 10 27 10 22 L10 8 Q10 0 18 0 L158 0 Q166 0 166 8 L166 22 C166 27 170 32 176 32 Z'
const TAB_STROKE_PATH =
  'M0 32 C6 32 10 27 10 22 L10 8 Q10 0 18 0 L158 0 Q166 0 166 8 L166 22 C166 27 170 32 176 32'

export default function NotesPage() {
  const navigate = useNavigate()
  const { activeSpaceId } = useSpace()
  const location = useLocation()
  const noteId = activeNoteIdFromPath(stripSpacePrefix(location.pathname))

  const [collections, setCollections] = useState<NoteCollection[]>([])
  const [collectionsLoading, setCollectionsLoading] = useState(true)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)

  const [notes, setNotes] = useState<NoteSummary[]>([])
  // Every note in the space, used to nest notes under their folder in the tree.
  const [allNotes, setAllNotes] = useState<NoteSummary[]>([])
  const [collapsedCollections, setCollapsedCollections] = useState<Set<string>>(() => new Set())
  const [resolvedTitles, setResolvedTitles] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const [openIds, setOpenIds] = useState<string[]>(() => readTabs(activeSpaceId))
  const prevSpace = useRef(activeSpaceId)
  const [treeMutationQueue] = useState(() =>
    createOptimisticTreeMutationQueue(error => toast.error(errMsg(error))),
  )

  const [creating, setCreating] = useState(false)

  const [collectionDialog, setCollectionDialog] = useState<CollectionDialogState>(null)
  const [deleteDialog, setDeleteDialog] = useState<LinkedDeleteDialogState | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [collectionName, setCollectionName] = useState('')
  const [collectionParentId, setCollectionParentId] = useState(ROOT_PARENT)

  const visibleCollections = useMemo(() => collections.filter(c => !c.is_hidden), [collections])
  const collectionById = useMemo(() => new Map(collections.map(c => [c.id, c])), [collections])
  const visibleCollectionById = useMemo(() => new Map(visibleCollections.map(c => [c.id, c])), [visibleCollections])
  const selectedCollection = selectedCollectionId ? visibleCollectionById.get(selectedCollectionId) ?? null : null
  const canCreateNote = Boolean(activeSpaceId) && selectedCollection?.system_role !== 'archive'

  const parentOptions = useMemo(() => {
    const excluded = collectionDialog?.mode === 'move' ? collectionDialog.collection.id : null
    return [
      { value: ROOT_PARENT, label: 'Root' },
      ...visibleCollections
        .filter(c => c.id !== excluded)
        .map(c => ({ value: c.id, label: collectionPath(c, collectionById) })),
    ]
  }, [collectionById, collectionDialog, visibleCollections])

  const loadCollections = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!activeSpaceId) {
      setCollections([])
      setCollectionsLoading(false)
      return
    }
    if (!options.silent) setCollectionsLoading(true)
    try {
      const rows = await notesCollectionsApi.list()
      setCollections(rows)
    } catch (e) {
      toast.error(errMsg(e))
      if (!options.silent) setCollections([])
    } finally {
      if (!options.silent) setCollectionsLoading(false)
    }
  }, [activeSpaceId])

  const loadNotes = useCallback(async () => {
    if (!activeSpaceId || !selectedCollectionId) {
      setNotes([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const showingArchive = selectedCollection?.system_role === 'archive'
      const page = await notesApi.list({
        collection_id: selectedCollectionId,
        q: query.trim() || undefined,
        status: showingArchive ? 'archived' : undefined,
        limit: 200,
      })
      setNotes(showingArchive ? page.items : hideArchivedOrDeletedNotes(page.items))
    } catch (e) {
      toast.error(errMsg(e))
      setNotes([])
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId, query, selectedCollection?.system_role, selectedCollectionId])

  const loadAllNotes = useCallback(async () => {
    if (!activeSpaceId) {
      setAllNotes([])
      return
    }
    try {
      const page = await notesApi.list({ limit: 200 })
      setAllNotes(hideArchivedOrDeletedNotes(page.items))
    } catch {
      // Tree nesting is best-effort; the center list surfaces hard load errors.
    }
  }, [activeSpaceId])

  useEffect(() => { loadCollections() }, [loadCollections])
  useEffect(() => { loadAllNotes() }, [loadAllNotes])

  useEffect(() => {
    if (!activeSpaceId || collectionsLoading) return
    if (selectedCollectionId && visibleCollectionById.has(selectedCollectionId)) return
    const inbox = visibleCollections.find(c => c.system_role === 'inbox')
    setSelectedCollectionId(inbox?.id ?? visibleCollections[0]?.id ?? null)
  }, [activeSpaceId, collectionsLoading, selectedCollectionId, visibleCollectionById, visibleCollections])

  useEffect(() => { loadNotes() }, [loadNotes])

  useEffect(() => {
    if (prevSpace.current !== activeSpaceId) {
      prevSpace.current = activeSpaceId
      setOpenIds(readTabs(activeSpaceId))
      setSelectedCollectionId(null)
    }
  }, [activeSpaceId])

  useEffect(() => {
    if (!noteId) return
    setOpenIds(prev => (prev.includes(noteId) ? prev : [...prev, noteId]))
  }, [noteId])

  useEffect(() => { writeTabs(activeSpaceId, openIds) }, [activeSpaceId, openIds])

  const onNoteResolved = useCallback((n: Note) => {
    setResolvedTitles(prev => (prev[n.id] === n.title ? prev : { ...prev, [n.id]: n.title }))
    if (n.status === 'archived' || n.status === 'deleted') {
      setNotes(prev => prev.filter(x => x.id !== n.id))
      setAllNotes(prev => prev.filter(x => x.id !== n.id))
      return
    }
    const upsert = (prev: NoteSummary[]) => {
      const idx = prev.findIndex(x => x.id === n.id)
      if (idx === -1) return [n, ...prev]
      const next = prev.slice()
      next[idx] = n
      return next
    }
    setNotes(upsert)
    setAllNotes(upsert)
  }, [])

  const toggleCollection = useCallback((id: string) => {
    setCollapsedCollections(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const titleFor = useCallback(
    (id: string) => (
      resolvedTitles[id]
      ?? notes.find(n => n.id === id)?.title
      ?? allNotes.find(n => n.id === id)?.title
      ?? 'Untitled note'
    ),
    [allNotes, resolvedTitles, notes],
  )

  const syncSelectedCollection = useCallback((collectionId: string | null | undefined) => {
    if (!collectionId || !visibleCollectionById.has(collectionId)) return
    setSelectedCollectionId(prev => (prev === collectionId ? prev : collectionId))
  }, [visibleCollectionById])

  const syncSelectedCollectionForNote = useCallback((id: string) => {
    const note = allNotes.find(n => n.id === id) ?? notes.find(n => n.id === id)
    syncSelectedCollection(note?.collection_id)
  }, [allNotes, notes, syncSelectedCollection])

  const openNote = useCallback((id: string) => {
    syncSelectedCollectionForNote(id)
    navigate(`/knowledge/notes/${id}`)
  }, [navigate, syncSelectedCollectionForNote])

  const selectCollection = useCallback((id: string) => {
    setSelectedCollectionId(id)
    if (noteId) navigate('/knowledge/notes')
  }, [navigate, noteId])

  useEffect(() => {
    if (!noteId) return
    syncSelectedCollectionForNote(noteId)
  }, [noteId, syncSelectedCollectionForNote])

  function closeTab(id: string) {
    const idx = openIds.indexOf(id)
    const next = openIds.filter(x => x !== id)
    setOpenIds(next)
    if (id === noteId) {
      const fallback = next[idx] ?? next[idx - 1] ?? null
      navigate(fallback ? `/knowledge/notes/${fallback}` : '/knowledge/notes')
    }
  }

  const resolveDeleteTargets = useCallback((targetNotes: Array<Pick<NoteSummary, 'id' | 'title'>>) => {
    const uniqueNotes = new Map<string, NoteDeleteTarget>()
    targetNotes.forEach(note => {
      const full = allNotes.find(n => n.id === note.id) ?? notes.find(n => n.id === note.id)
      uniqueNotes.set(note.id, {
        ...full,
        ...note,
        title: note.title || full?.title || 'Untitled note',
      })
    })
    return [...uniqueNotes.values()]
  }, [allNotes, notes])

  const countRelatedNoteLinks = useCallback(async (targetNotes: NoteDeleteTarget[]) => {
    const linkIds = new Set<string>()
    await Promise.all(targetNotes.map(async note => {
      const [links, backlinks] = await Promise.all([notesApi.links(note.id), notesApi.backlinks(note.id)])
      links.concat(backlinks).forEach(link => {
        if (isNoteToNoteLink(link)) linkIds.add(link.id)
      })
    }))
    return linkIds.size
  }, [])

  const removeNoteIdsFromView = useCallback((removedIds: Set<string>) => {
    setNotes(prev => prev.filter(n => !removedIds.has(n.id)))
    setAllNotes(prev => prev.filter(n => !removedIds.has(n.id)))
    setResolvedTitles(prev => {
      const next = { ...prev }
      removedIds.forEach(id => delete next[id])
      return next
    })

    const idx = noteId ? openIds.indexOf(noteId) : -1
    const nextOpenIds = openIds.filter(id => !removedIds.has(id))
    setOpenIds(nextOpenIds)
    if (noteId && removedIds.has(noteId)) {
      const fallback = nextOpenIds[idx] ?? nextOpenIds[idx - 1] ?? null
      navigate(fallback ? `/knowledge/notes/${fallback}` : '/knowledge/notes')
    }
  }, [navigate, noteId, openIds])

  const restoreDeletedNotes = useCallback(async (targetNotes: NoteDeleteTarget[]) => {
    try {
      await Promise.all(targetNotes.map(note => notesApi.update(note.id, { status: restoreStatus(note.status) })))
      await Promise.all([loadAllNotes(), loadNotes()])
      toast.success(targetNotes.length === 1 ? 'Note restored' : `${targetNotes.length} notes restored`)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }, [loadAllNotes, loadNotes])

  const softDeleteNotes = useCallback(async (targetNotes: NoteDeleteTarget[]) => {
    const uniqueNotes = [...new Map(targetNotes.map(note => [note.id, note])).values()]
    if (uniqueNotes.length === 0) return false

    try {
      await Promise.all(uniqueNotes.map(note => notesApi.delete(note.id)))
      const deletedIds = new Set(uniqueNotes.map(note => note.id))
      removeNoteIdsFromView(deletedIds)

      toast.success(uniqueNotes.length === 1 ? 'Note deleted' : `${uniqueNotes.length} notes deleted`, {
        action: {
          label: 'Undo',
          onClick: () => { void restoreDeletedNotes(uniqueNotes) },
        },
      })
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    }
  }, [removeNoteIdsFromView, restoreDeletedNotes])

  const archiveNotes = useCallback(async (targetNotes: Array<Pick<NoteSummary, 'id' | 'title'>>) => {
    const uniqueNotes = resolveDeleteTargets(targetNotes)
    if (uniqueNotes.length === 0) return

    try {
      await Promise.all(uniqueNotes.map(note => notesApi.update(note.id, { status: 'archived' })))
      removeNoteIdsFromView(new Set(uniqueNotes.map(note => note.id)))
      toast.success(uniqueNotes.length === 1 ? 'Note archived' : `${uniqueNotes.length} notes archived`)
      await Promise.all([loadAllNotes(), loadNotes()])
    } catch (e) {
      toast.error(errMsg(e))
    }
  }, [loadAllNotes, loadNotes, removeNoteIdsFromView, resolveDeleteTargets])

  const deleteNotes = useCallback(async (targetNotes: Array<Pick<NoteSummary, 'id' | 'title'>>) => {
    const uniqueNotes = resolveDeleteTargets(targetNotes)
    if (uniqueNotes.length === 0) return

    try {
      const relatedLinkCount = await countRelatedNoteLinks(uniqueNotes)
      if (relatedLinkCount > 0) {
        setDeleteDialog({ notes: uniqueNotes, relatedLinkCount })
        return
      }
    } catch (e) {
      toast.error(errMsg(e))
      return
    }

    await softDeleteNotes(uniqueNotes)
  }, [countRelatedNoteLinks, resolveDeleteTargets, softDeleteNotes])

  const confirmLinkedDelete = useCallback(async () => {
    if (!deleteDialog) return
    setDeleteBusy(true)
    try {
      const deleted = await softDeleteNotes(deleteDialog.notes)
      if (deleted) setDeleteDialog(null)
    } finally {
      setDeleteBusy(false)
    }
  }, [deleteDialog, softDeleteNotes])

  const deleteNote = useCallback((note: Pick<NoteSummary, 'id' | 'title'>) => {
    deleteNotes([note])
  }, [deleteNotes])

  const archiveNote = useCallback((note: Pick<NoteSummary, 'id' | 'title'>) => {
    archiveNotes([note])
  }, [archiveNotes])

  const outletContext: NotesOutletContext = useMemo(() => ({
    onNoteResolved,
  }), [onNoteResolved])

  async function createNote() {
    if (!canCreateNote) return
    setCreating(true)
    try {
      const content = emptyRichTextDocument()
      const targetCollection = selectedCollection
      const note = await notesApi.create({
        title: 'Untitled note',
        ...richTextSnapshotFromDocument(content),
        status: 'active',
        ...(targetCollection ? { collection_id: targetCollection.id } : {}),
      })
      onNoteResolved(note)
      toast.success('Note created')
      openNote(note.id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  function openCreateRoot() {
    setCollectionDialog({ mode: 'create-root' })
    setCollectionName('')
    setCollectionParentId(ROOT_PARENT)
  }

  function openCreateChild(collection: NoteCollection) {
    setCollectionDialog({ mode: 'create-child', collection })
    setCollectionName('')
    setCollectionParentId(collection.id)
  }

  function openRename(collection: NoteCollection) {
    setCollectionDialog({ mode: 'rename', collection })
    setCollectionName(collection.name)
    setCollectionParentId(collection.parent_id ?? ROOT_PARENT)
  }

  function openMove(collection: NoteCollection) {
    setCollectionDialog({ mode: 'move', collection })
    setCollectionName(collection.name)
    setCollectionParentId(collection.parent_id ?? ROOT_PARENT)
  }

  function enqueueCollectionReorder(
    updates: CollectionMove[],
    afterSuccess?: () => void,
  ) {
    treeMutationQueue.enqueue({
      key: 'collections',
      apply: () => setCollections(current => applyCollectionMoves(current, updates)),
      persist: async () => {
        await notesTreeApi.reorder({
          kind: 'collections',
          updates: updates.map(update => ({
            id: update.id,
            parent_id: update.parentId,
            sort_order: update.sortOrder,
          })),
        })
      },
      reconcile: async () => { await loadCollections({ silent: true }) },
      afterSuccess,
    })
  }

  function submitCollectionDialog() {
    if (!collectionDialog) return
    if (collectionDialog.mode !== 'move' && !collectionName.trim()) {
      toast.error('Folder name is required')
      return
    }
    const parent_id = collectionParentId === ROOT_PARENT ? null : collectionParentId
    if (collectionDialog.mode === 'create-root' || collectionDialog.mode === 'create-child') {
      if (!activeSpaceId) return
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const optimisticCollection: NoteCollection = {
        id,
        space_id: activeSpaceId,
        parent_id,
        name: collectionName.trim(),
        system_role: 'normal',
        sort_order: nextCollectionSortOrder(collections, parent_id),
        is_system: false,
        is_hidden: false,
        created_at: now,
        updated_at: now,
      }
      treeMutationQueue.enqueue({
        key: 'collections',
        apply: () => setCollections(current => upsertCollection(current, optimisticCollection)),
        persist: async () => {
          await notesCollectionsApi.create({
            id,
            name: optimisticCollection.name,
            parent_id,
            sort_order: optimisticCollection.sort_order,
          })
        },
        reconcile: async () => { await loadCollections({ silent: true }) },
        afterSuccess: () => {
          toast.success('Folder created')
        },
      })
    } else if (collectionDialog.mode === 'rename') {
      const collection = collectionDialog.collection
      const name = collectionName.trim()
      treeMutationQueue.enqueue({
        key: 'collections',
        apply: () => setCollections(current => current.map(item => (
          item.id === collection.id ? { ...item, name } : item
        ))),
        persist: async () => {
          await notesCollectionsApi.update(collection.id, { name })
        },
        reconcile: async () => { await loadCollections({ silent: true }) },
        afterSuccess: () => {
          toast.success('Folder renamed')
        },
      })
    } else {
      const updates = planCollectionMove(
        collectionDialog.collection.id,
        parent_id,
        null,
        collections,
      )
      if (updates.length > 0) {
        enqueueCollectionReorder(updates, () => toast.success('Folder moved'))
      }
    }
    setCollectionDialog(null)
  }

  function hideCollection(collection: NoteCollection) {
    treeMutationQueue.enqueue({
      key: 'collections',
      apply: () => setCollections(current => current.map(item => (
        item.id === collection.id ? { ...item, is_hidden: true } : item
      ))),
      persist: async () => {
        await notesCollectionsApi.update(collection.id, { is_hidden: true })
      },
      reconcile: async () => { await loadCollections({ silent: true }) },
      afterSuccess: () => toast.success('Folder hidden'),
    })
    if (selectedCollectionId === collection.id) setSelectedCollectionId(null)
  }

  function deleteCollection(collection: NoteCollection) {
    treeMutationQueue.enqueue({
      key: 'collections',
      apply: () => setCollections(current => removeCollection(current, collection.id)),
      persist: async () => { await notesCollectionsApi.delete(collection.id) },
      reconcile: async () => { await loadCollections({ silent: true }) },
      afterSuccess: () => toast.success('Folder deleted'),
    })
    if (selectedCollectionId === collection.id) setSelectedCollectionId(null)
  }

  function dropCollections(updates: CollectionMove[]) {
    enqueueCollectionReorder(updates)
  }

  function dropNotes(updates: NoteMove[]) {
    const optimisticAllNotes = applyNoteMoves(allNotes, updates)
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const optimisticVisibleNotes = selectedCollectionId
      ? optimisticAllNotes.filter(note => (
        note.collection_id === selectedCollectionId
        && (selectedCollection?.system_role === 'archive' ? note.status === 'archived' : note.status === 'active')
        && (!normalizedQuery || `${note.title} ${note.excerpt ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
      ))
      : []
    treeMutationQueue.enqueue({
      key: 'notes',
      apply: () => {
        setNotes(optimisticVisibleNotes)
        setAllNotes(optimisticAllNotes)
      },
      persist: async () => {
        await notesTreeApi.reorder({
          kind: 'notes',
          updates: updates.map(update => ({
            id: update.id,
            collection_id: update.collectionId,
            sort_order: update.sortOrder,
          })),
        })
      },
      reconcile: async () => { await Promise.all([loadNotes(), loadAllNotes()]) },
      // Full-text queries can match note content that is not present in a
      // NoteSummary. Reconcile that exceptional view in the background
      // without blocking the already-updated tree.
      afterSuccess: normalizedQuery ? () => { void loadNotes() } : undefined,
    })
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      <div className="relative hidden sm:block">
        <Search className="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search notes"
          className="h-8 w-44 pl-8"
        />
      </div>
      <Button size="sm" variant="outline" onClick={openCreateRoot} disabled={!activeSpaceId}>
        <FolderPlus className="size-4 mr-1" /> New folder
      </Button>
      <Button size="sm" onClick={createNote} disabled={!canCreateNote || creating}>
        <Plus className="size-4 mr-1" /> {creating ? 'Creating...' : 'New note'}
      </Button>
    </div>
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-6 pt-5 shrink-0">
        <KnowledgeSectionHeader section="notes" actions={headerActions} />
      </div>

      <div className="flex-1 min-h-0 flex">
        <aside
          aria-label="Notes organization"
          className="hidden md:flex w-64 shrink-0 flex-col border-r border-border bg-card/40 overflow-y-auto p-2"
        >
          {collectionsLoading ? (
            <div className="p-2 space-y-2">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-4/5" />
            </div>
          ) : visibleCollections.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">
              No folders.
            </div>
          ) : (
            // Tree-specific UI and interactions live in notes-tree; this page
            // only coordinates data loading, navigation, tabs, and mutations.
            <NotesTree
              collections={visibleCollections}
              notes={allNotes}
              selectedCollectionId={selectedCollectionId}
              activeNoteId={noteId}
              collapsedCollectionIds={collapsedCollections}
              onToggleCollection={toggleCollection}
              onSelectCollection={selectCollection}
              onSelectNoteCollection={syncSelectedCollection}
              onOpenNote={openNote}
              onArchiveNote={archiveNote}
              onArchiveNotes={archiveNotes}
              onDeleteNote={deleteNote}
              onDeleteNotes={deleteNotes}
              resolveNoteTitle={titleFor}
              onCreateChild={openCreateChild}
              onRename={openRename}
              onMove={openMove}
              onHide={hideCollection}
              onDeleteCollection={deleteCollection}
              onDropCollections={dropCollections}
              onDropNotes={dropNotes}
            />
          )}
          <Button size="sm" variant="outline" className="mt-2 justify-start" onClick={openCreateRoot} disabled={!activeSpaceId}>
            <FolderPlus className="size-4 mr-1" /> New folder
          </Button>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="md:hidden flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2 shrink-0">
            {visibleCollections.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => selectCollection(c.id)}
                className={cn(
                  'shrink-0 rounded-full px-3 py-1 text-[12px] border transition-colors',
                  c.id === selectedCollectionId
                    ? 'bg-primary/10 text-accent-foreground border-primary/30 font-medium'
                    : 'text-muted-foreground border-border hover:text-foreground',
                )}
              >
                {c.name}
              </button>
            ))}
          </div>

          {openIds.length > 0 && (
            <div role="tablist" aria-label="Open notes" className="note-tabs-strip flex items-end gap-0 overflow-x-auto bg-muted px-2 pt-2 shrink-0">
              {openIds.map(id => {
                const active = id === noteId
                return (
                  <div
                    key={id}
                    className={cn(
                      // Equal-width tabs start around 11rem and shrink together
                      // only when the strip runs out of room.
                      'note-tab group relative flex h-8 min-w-[6.75rem] max-w-[200px] shrink basis-44 grow-0 items-center',
                      active && 'note-tab--active z-10',
                    )}
                  >
                    <svg className="note-tab__bg" viewBox="0 0 176 32" preserveAspectRatio="none" aria-hidden="true">
                      <path className="note-tab__fill" d={TAB_FILL_PATH} />
                      <path className="note-tab__stroke" vectorEffect="non-scaling-stroke" d={TAB_STROKE_PATH} />
                    </svg>
                    <span className="note-tab__hover" aria-hidden="true" />
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-label={titleFor(id)}
                      onClick={() => openNote(id)}
                      className="absolute inset-0 z-10"
                      title={titleFor(id)}
                    >
                      <span
                        className={cn(
                          'note-tab__label',
                          active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
                        )}
                      >
                        <span className="truncate">
                          {titleFor(id)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        closeTab(id)
                      }}
                      aria-label={`Close ${titleFor(id)}`}
                      className="note-tab__close"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                )
              })}
              <button
                type="button"
                onClick={createNote}
                disabled={!canCreateNote || creating}
                aria-label="New note"
                title="New note"
                className="ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-40"
              >
                <Plus className="size-4" />
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0">
            {noteId ? (
              // The editor owns its own scroll so its bottom status bar stays pinned.
              <Outlet context={outletContext} />
            ) : (
              <div className="h-full overflow-y-auto">
                <NotesListPane
                  loading={loading || collectionsLoading}
                  hasSpace={Boolean(activeSpaceId)}
                  hasCollections={visibleCollections.length > 0}
                  collection={selectedCollection}
                  notes={notes}
                  searching={Boolean(query.trim())}
                  creating={creating}
                  canCreateNote={canCreateNote}
                  onOpen={openNote}
                  onNew={createNote}
                  titleFor={titleFor}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={deleteDialog !== null}
        onOpenChange={open => { if (!open && !deleteBusy) setDeleteDialog(null) }}
      >
        <DialogContent showClose={!deleteBusy} className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {deleteDialog?.notes.length === 1 ? 'Delete linked note?' : 'Delete linked notes?'}
            </DialogTitle>
            <DialogDescription>
              {deleteDialog?.notes.length === 1
                ? 'This note is linked to another note. Deleting it will soft-delete the note and remove it from the tree and open tabs.'
                : 'Some selected notes are linked to other notes. Deleting them will soft-delete the notes and remove them from the tree and open tabs.'}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {deleteDialog?.relatedLinkCount ?? 0} note link{(deleteDialog?.relatedLinkCount ?? 0) === 1 ? '' : 's'} will point at deleted content.
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteDialog(null)} disabled={deleteBusy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmLinkedDelete} disabled={deleteBusy}>
              {deleteBusy ? 'Deleting...' : 'Delete anyway'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={collectionDialog !== null} onOpenChange={open => { if (!open) setCollectionDialog(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {collectionDialog?.mode === 'rename'
                ? 'Rename folder'
                : collectionDialog?.mode === 'move'
                  ? 'Move folder'
                  : 'New folder'}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Create, rename, or move a note folder.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {collectionDialog?.mode !== 'move' && (
              <div>
                <Label className="text-xs">Name</Label>
                <Input
                  autoFocus
                  value={collectionName}
                  onChange={e => setCollectionName(e.target.value)}
                  placeholder="Folder name"
                />
              </div>
            )}
            {(collectionDialog?.mode === 'create-child' || collectionDialog?.mode === 'move') && (
              <div>
                <Label className="text-xs">Parent</Label>
                <Select value={collectionParentId} onChange={setCollectionParentId} options={parentOptions} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCollectionDialog(null)}>Cancel</Button>
            <Button size="sm" onClick={submitCollectionDialog}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
