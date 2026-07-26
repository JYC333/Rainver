import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, closestCenter, pointerWithin, useDraggable, useDroppable,
  useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import {
  ChevronRight, EyeOff, FileText, Folder, FolderPlus, MoreHorizontal, Pencil, Trash2,
} from 'lucide-react'
import type { NoteCollection, NoteSummary } from '../../../types/api'
import { cn } from '../../../lib/utils'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu'
import { TreeContextMenu, type TreeContextMenuPosition } from './TreeContextMenu'
import {
  buildCollectionTree, collectionAndDescendantIds, findCollectionNode, flattenVisibleNotes,
  groupNotesByCollection, isDraggableCollection, isProtectedCollection, resolveTreeDrop,
  type CollectionMove, type CollectionNode,
  type DragSourceData, type DropTargetData, type NoteMove,
} from './model'

const notesTreeCollisionDetection: CollisionDetection = args => {
  const pointerCollisions = pointerWithin(args)
  if (pointerCollisions.length === 0) return closestCenter(args)
  // Gap hit areas overlap the edge of their neighboring row. The pointer's
  // exact gap must win over the larger folder/note row so the highlighted
  // line and the persisted destination always agree.
  return [...pointerCollisions].sort((left, right) => {
    const leftKind = left.data?.droppableContainer.data.current?.kind
    const rightKind = right.data?.droppableContainer.data.current?.kind
    const leftIsGap = leftKind === 'collection-gap' || leftKind === 'note-gap'
    const rightIsGap = rightKind === 'collection-gap' || rightKind === 'note-gap'
    return Number(rightIsGap) - Number(leftIsGap)
  })
}

/**
 * Notes tree wrapper boundary.
 *
 * Keep tree-specific rendering and interactions in this module: folder rows,
 * note rows, keyboard handlers, context menus, drag/drop, and any future
 * third-party tree renderer such as Wunderbaum. The page that renders this
 * component should continue to own APIs, routing, toasts/confirms, tabs, and
 * collection dialogs, passing those behaviors in through callbacks.
 */
export interface NotesTreeProps {
  collections: NoteCollection[]
  notes: NoteSummary[]
  selectedCollectionId: string | null
  activeNoteId?: string
  collapsedCollectionIds: Set<string>
  resolveNoteTitle: (id: string) => string
  onToggleCollection: (id: string) => void
  onSelectCollection: (id: string) => void
  onSelectNoteCollection?: (id: string) => void
  onOpenNote: (id: string) => void
  onArchiveNote: (note: Pick<NoteSummary, 'id' | 'title'>) => void
  onArchiveNotes?: (notes: Array<Pick<NoteSummary, 'id' | 'title'>>) => void
  onDeleteNote: (note: Pick<NoteSummary, 'id' | 'title'>) => void
  onDeleteNotes?: (notes: Array<Pick<NoteSummary, 'id' | 'title'>>) => void
  onCreateChild: (collection: NoteCollection) => void
  onRename: (collection: NoteCollection) => void
  onMove: (collection: NoteCollection) => void
  onHide: (collection: NoteCollection) => void
  onDeleteCollection: (collection: NoteCollection) => void
  /** Drag a folder onto another folder (or a gap between siblings, or the
   * root strip) to reparent and/or reorder it. Project-backed folders may be
   * freely placed; fixed collection roots (Inbox/Archive/Projects) are not
   * draggable. Every affected sibling's new position is included. */
  onDropCollections?: (updates: CollectionMove[]) => void
  /** Drag a note onto a folder (or a gap between two notes in a folder) to
   * move and/or reorder it. */
  onDropNotes?: (updates: NoteMove[]) => void
}

export default function NotesTree({
  collections, notes, selectedCollectionId, activeNoteId, collapsedCollectionIds,
  resolveNoteTitle, onToggleCollection, onSelectCollection, onSelectNoteCollection,
  onOpenNote, onArchiveNote, onArchiveNotes, onDeleteNote, onDeleteNotes,
  onCreateChild, onRename, onMove, onHide, onDeleteCollection, onDropCollections, onDropNotes,
}: NotesTreeProps) {
  const collectionTree = useMemo(() => buildCollectionTree(collections), [collections])
  const visibleTreeNotes = useMemo(
    () => notes.filter(note => note.status !== 'archived' && note.status !== 'deleted'),
    [notes],
  )
  const notesByCollection = useMemo(() => groupNotesByCollection(visibleTreeNotes), [visibleTreeNotes])
  const visibleNotes = useMemo(
    () => flattenVisibleNotes(collectionTree, notesByCollection, collapsedCollectionIds),
    [collectionTree, collapsedCollectionIds, notesByCollection],
  )
  // Tracks what's currently being dragged (if anything) so FolderRow can dim
  // invalid targets live and the tree can show the right kind of drop
  // affordances (collection gaps + root strip vs. note gaps) instead of
  // cluttering the view when nothing is being dragged.
  const [activeDrag, setActiveDrag] = useState<DragSourceData | null>(null)
  const draggingCollectionId = activeDrag?.type === 'collection' ? activeDrag.collection.id : null
  const showCollectionGaps = activeDrag?.type === 'collection'
  const showNoteGaps = activeDrag?.type === 'note'
  // A folder being dragged, plus its own descendants, are invalid drop
  // targets for itself (self-drop is a no-op; dropping into a descendant
  // would orphan the subtree into a cycle).
  const invalidDropTargetIds = useMemo(() => {
    if (!draggingCollectionId) return new Set<string>()
    const node = findCollectionNode(collectionTree, draggingCollectionId)
    return node ? collectionAndDescendantIds(node) : new Set<string>([draggingCollectionId])
  }, [collectionTree, draggingCollectionId])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleDragStart(event: DragStartEvent) {
    setActiveDrag((event.active.data.current as DragSourceData | undefined) ?? null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null)
    const { active, over } = event
    if (!over) return
    const source = active.data.current as DragSourceData | undefined
    const target = over.data.current as DropTargetData | undefined
    if (!source || !target) return
    const resolved = resolveTreeDrop(source, target, collectionTree, collections, visibleTreeNotes)
    if (!resolved) return
    if (resolved.kind === 'move-collections') onDropCollections?.(resolved.updates)
    else onDropNotes?.(resolved.updates)
  }
  const visibleNoteIds = useMemo(() => visibleNotes.map(note => note.id), [visibleNotes])
  const visibleNotesById = useMemo(() => new Map(visibleNotes.map(note => [note.id, note])), [visibleNotes])
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<(TreeContextMenuPosition & { noteId: string }) | null>(null)
  const pendingTreeOpenId = useRef<string | null>(null)

  useEffect(() => {
    if (pendingTreeOpenId.current === activeNoteId) {
      pendingTreeOpenId.current = null
      return
    }
    pendingTreeOpenId.current = null
    // Opening a note from outside the tree (for example, by switching tabs)
    // starts a new single-note selection. The active row is styled directly
    // from activeNoteId, so retaining the tree's Shift/Ctrl selection here
    // would leave the previously active note highlighted as well.
    setSelectedNoteIds(new Set())
    setSelectionAnchorId(null)
    setContextMenu(null)
  }, [activeNoteId])

  useEffect(() => {
    setSelectedNoteIds(prev => {
      const visible = new Set(visibleNoteIds)
      const next = new Set([...prev].filter(id => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
    setSelectionAnchorId(prev => (prev && visibleNotesById.has(prev) ? prev : null))
  }, [visibleNoteIds, visibleNotesById])

  const contextMenuNotes = useMemo(() => {
    if (!contextMenu) return []
    const target = visibleNotesById.get(contextMenu.noteId)
    if (!target) return []
    const actionIds = selectedNoteIds.has(target.id) && selectedNoteIds.size > 1
      ? selectedNoteIds
      : new Set([target.id])
    return visibleNotes.filter(note => actionIds.has(note.id))
  }, [contextMenu, selectedNoteIds, visibleNotes, visibleNotesById])

  function notesForAction(note: NoteSummary) {
    if (selectedNoteIds.has(note.id) && selectedNoteIds.size > 1) {
      return visibleNotes.filter(item => selectedNoteIds.has(item.id))
    }
    return [note]
  }

  function selectRange(toId: string) {
    const fromId = selectionAnchorId ?? toId
    const from = visibleNoteIds.indexOf(fromId)
    const to = visibleNoteIds.indexOf(toId)
    if (from === -1 || to === -1) {
      setSelectedNoteIds(new Set([toId]))
      setSelectionAnchorId(toId)
      return
    }
    const [start, end] = from < to ? [from, to] : [to, from]
    setSelectedNoteIds(new Set(visibleNoteIds.slice(start, end + 1)))
  }

  function toggleSelected(noteId: string) {
    setSelectedNoteIds(prev => {
      const next = new Set(prev)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return next
    })
    setSelectionAnchorId(noteId)
  }

  function selectSingle(noteId: string) {
    setSelectedNoteIds(new Set([noteId]))
    setSelectionAnchorId(noteId)
  }

  function syncNoteCollection(note: NoteSummary) {
    if (note.collection_id) onSelectNoteCollection?.(note.collection_id)
  }

  function handleCollectionSelect(id: string) {
    setSelectedNoteIds(new Set())
    setSelectionAnchorId(null)
    setContextMenu(null)
    onSelectCollection(id)
  }

  function handleNoteClick(note: NoteSummary, event: MouseEvent<HTMLButtonElement>) {
    syncNoteCollection(note)
    if (event.shiftKey) {
      selectRange(note.id)
      return
    }
    if (event.metaKey || event.ctrlKey) {
      toggleSelected(note.id)
      return
    }
    selectSingle(note.id)
    pendingTreeOpenId.current = note.id
    onOpenNote(note.id)
  }

  function handleNoteContextMenu(note: NoteSummary, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    syncNoteCollection(note)
    if (!selectedNoteIds.has(note.id)) selectSingle(note.id)
    setContextMenu({ x: event.clientX, y: event.clientY, noteId: note.id })
  }

  function requestDeleteNotes(targetNotes: NoteSummary[]) {
    setContextMenu(null)
    const uniqueNotes = [...new Map(targetNotes.map(note => [note.id, note])).values()]
    if (uniqueNotes.length === 0) return
    if (uniqueNotes.length === 1 || !onDeleteNotes) {
      uniqueNotes.forEach(note => onDeleteNote(note))
      return
    }
    onDeleteNotes(uniqueNotes)
  }

  function requestArchiveNotes(targetNotes: NoteSummary[]) {
    setContextMenu(null)
    const uniqueNotes = [...new Map(targetNotes.map(note => [note.id, note])).values()]
    if (uniqueNotes.length === 0) return
    if (uniqueNotes.length === 1 || !onArchiveNotes) {
      uniqueNotes.forEach(note => onArchiveNote(note))
      return
    }
    onArchiveNotes(uniqueNotes)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={notesTreeCollisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <RootDropZone visible={showCollectionGaps} />
      <CollectionTree
        nodes={collectionTree}
        parentId={null}
        notesByCollection={notesByCollection}
        selectedId={selectedCollectionId}
        activeNoteId={activeNoteId}
        selectedNoteIds={selectedNoteIds}
        collapsed={collapsedCollectionIds}
        invalidDropTargetIds={invalidDropTargetIds}
        showCollectionGaps={showCollectionGaps}
        showNoteGaps={showNoteGaps}
        onToggle={onToggleCollection}
        onSelect={handleCollectionSelect}
        onNoteClick={handleNoteClick}
        onNoteContextMenu={handleNoteContextMenu}
        onDeleteNotes={note => requestDeleteNotes(notesForAction(note))}
        titleFor={resolveNoteTitle}
        onCreateChild={onCreateChild}
        onRename={onRename}
        onMove={onMove}
        onHide={onHide}
        onDelete={onDeleteCollection}
      />
      <TreeContextMenu
        label={contextMenuNotes.length > 1 ? 'Selected notes' : contextMenuNotes[0]?.title ?? 'Note'}
        archiveLabel={contextMenuNotes.length > 1 ? `Archive ${contextMenuNotes.length} notes` : 'Archive'}
        deleteLabel={contextMenuNotes.length > 1 ? `Delete ${contextMenuNotes.length} notes` : 'Delete'}
        position={contextMenu}
        onClose={() => setContextMenu(null)}
        onArchive={() => requestArchiveNotes(contextMenuNotes)}
        onDelete={() => requestDeleteNotes(contextMenuNotes)}
      />
      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {activeDrag && <DragPreview source={activeDrag} titleFor={resolveNoteTitle} />}
      </DragOverlay>
    </DndContext>
  )
}

function RootDropZone({ visible }: { visible: boolean }) {
  const droppable = useDroppable({ id: 'root-drop', data: { kind: 'into-root' } satisfies DropTargetData })
  if (!visible) return null
  return (
    <div className="relative h-0">
      <div
        ref={droppable.setNodeRef}
        aria-label="Move folder to top level"
        className="absolute inset-x-1 -top-1 z-20 flex h-2 items-center"
      >
        <span className={cn(
          'h-0.5 w-full rounded-full transition-colors',
          droppable.isOver ? 'bg-primary' : 'bg-border/70',
        )} />
      </div>
    </div>
  )
}

function DragPreview({ source, titleFor }: { source: DragSourceData; titleFor: (id: string) => string }) {
  const label = source.type === 'collection' ? source.collection.name : titleFor(source.note.id)
  return (
    <div className="flex size-full items-center gap-2 overflow-hidden rounded-md border border-border bg-card/90 px-2 text-[13px] opacity-85 shadow-lg backdrop-blur-[1px]">
      {source.type === 'collection' ? <Folder className="size-4 shrink-0" /> : <FileText className="size-3.5 shrink-0 opacity-70" />}
      <span className="truncate">{label}</span>
    </div>
  )
}

function DropGap({ id, data, indent, visible }: { id: string; data: DropTargetData; indent: number; visible: boolean }) {
  const droppable = useDroppable({ id, data })
  if (!visible) return null
  return (
    <div className="relative h-0">
      <div
        ref={droppable.setNodeRef}
        style={{ left: indent }}
        className="absolute right-1 -top-1 z-10 flex h-2 items-center"
      >
        <span className={cn(
          'h-0.5 w-full rounded-full transition-colors',
          droppable.isOver ? 'bg-primary' : 'bg-transparent',
        )} />
      </div>
    </div>
  )
}

interface CollectionTreeProps {
  nodes: CollectionNode[]
  parentId: string | null
  notesByCollection: Map<string, NoteSummary[]>
  selectedId: string | null
  activeNoteId: string | undefined
  selectedNoteIds: Set<string>
  collapsed: Set<string>
  invalidDropTargetIds: Set<string>
  showCollectionGaps: boolean
  showNoteGaps: boolean
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  onNoteClick: (note: NoteSummary, event: MouseEvent<HTMLButtonElement>) => void
  onNoteContextMenu: (note: NoteSummary, event: MouseEvent<HTMLButtonElement>) => void
  onDeleteNotes: (note: NoteSummary) => void
  titleFor: (id: string) => string
  onCreateChild: (collection: NoteCollection) => void
  onRename: (collection: NoteCollection) => void
  onMove: (collection: NoteCollection) => void
  onHide: (collection: NoteCollection) => void
  onDelete: (collection: NoteCollection) => void
  depth?: number
}

function CollectionTree({
  nodes, parentId, notesByCollection, selectedId, activeNoteId, selectedNoteIds, collapsed, invalidDropTargetIds,
  showCollectionGaps, showNoteGaps,
  onToggle, onSelect, onNoteClick, onNoteContextMenu, onDeleteNotes, titleFor,
  onCreateChild, onRename, onMove, onHide, onDelete, depth = 0,
}: CollectionTreeProps) {
  const visualDepth = Math.min(depth, 2)
  const indent = 8 + visualDepth * 14
  return (
    <div>
      <DropGap
        id={`collection-gap:${parentId ?? 'root'}:${nodes[0]?.id ?? 'end'}`}
        data={{ kind: 'collection-gap', parentId, beforeId: nodes[0]?.id ?? null }}
        indent={indent}
        visible={showCollectionGaps}
      />
      {nodes.map((node, index) => {
        const active = node.id === selectedId
        const protectedCollection = isProtectedCollection(node)
        const draggableCollection = isDraggableCollection(node)
        const childNotes = notesByCollection.get(node.id) ?? []
        const hasChildren = node.children.length > 0 || childNotes.length > 0
        const expanded = hasChildren && !collapsed.has(node.id)
        const nextSibling = nodes[index + 1]

        return (
          <Fragment key={node.id}>
            <div className="mb-0.5">
              <FolderRow
                node={node}
                active={active}
                indent={indent}
                protectedCollection={protectedCollection}
                draggableCollection={draggableCollection}
                invalidDropTarget={invalidDropTargetIds.has(node.id)}
                hasChildren={hasChildren}
                expanded={expanded}
                onToggle={() => onToggle(node.id)}
                onSelect={() => onSelect(node.id)}
                onCreateChild={() => onCreateChild(node)}
                onRename={() => onRename(node)}
                onMove={() => onMove(node)}
                onHide={() => onHide(node)}
                onDelete={() => onDelete(node)}
              />
              {expanded && (
                <div className="mt-1">
                  {node.children.length > 0 && (
                    <CollectionTree
                      nodes={node.children}
                      parentId={node.id}
                      notesByCollection={notesByCollection}
                      selectedId={selectedId}
                      activeNoteId={activeNoteId}
                      selectedNoteIds={selectedNoteIds}
                      collapsed={collapsed}
                      invalidDropTargetIds={invalidDropTargetIds}
                      showCollectionGaps={showCollectionGaps}
                      showNoteGaps={showNoteGaps}
                      onToggle={onToggle}
                      onSelect={onSelect}
                      onNoteClick={onNoteClick}
                      onNoteContextMenu={onNoteContextMenu}
                      onDeleteNotes={onDeleteNotes}
                      titleFor={titleFor}
                      onCreateChild={onCreateChild}
                      onRename={onRename}
                      onMove={onMove}
                      onHide={onHide}
                      onDelete={onDelete}
                      depth={depth + 1}
                    />
                  )}
                  <DropGap
                    id={`note-gap:${node.id}:${childNotes[0]?.id ?? 'end'}`}
                    data={{ kind: 'note-gap', collectionId: node.id, beforeId: childNotes[0]?.id ?? null }}
                    indent={indent + 26}
                    visible={showNoteGaps}
                  />
                  {childNotes.map((note, noteIndex) => {
                    const nextNote = childNotes[noteIndex + 1]
                    return (
                      <Fragment key={note.id}>
                        <NoteTreeItem
                          note={note}
                          title={titleFor(note.id)}
                          active={note.id === activeNoteId}
                          selected={selectedNoteIds.has(note.id)}
                          muted={note.status === 'archived'}
                          onClick={event => onNoteClick(note, event)}
                          onContextMenu={event => onNoteContextMenu(note, event)}
                          onDelete={() => onDeleteNotes(note)}
                          indent={indent + 26}
                        />
                        <DropGap
                          id={`note-gap:${node.id}:${nextNote?.id ?? 'end'}`}
                          data={{ kind: 'note-gap', collectionId: node.id, beforeId: nextNote?.id ?? null }}
                          indent={indent + 26}
                          visible={showNoteGaps}
                        />
                      </Fragment>
                    )
                  })}
                </div>
              )}
            </div>
            <DropGap
              id={`collection-gap:${parentId ?? 'root'}:${nextSibling?.id ?? 'end'}`}
              data={{ kind: 'collection-gap', parentId, beforeId: nextSibling?.id ?? null }}
              indent={indent}
              visible={showCollectionGaps}
            />
          </Fragment>
        )
      })}
    </div>
  )
}

interface FolderRowProps {
  node: CollectionNode
  active: boolean
  indent: number
  protectedCollection: boolean
  draggableCollection: boolean
  invalidDropTarget: boolean
  hasChildren: boolean
  expanded: boolean
  onToggle: () => void
  onSelect: () => void
  onCreateChild: () => void
  onRename: () => void
  onMove: () => void
  onHide: () => void
  onDelete: () => void
}

/** Folder action protection and drag policy are intentionally separate:
 * project-backed folders remain protected from deletion but can be placed
 * freely, while fixed collection roots cannot move. */
function FolderRow({
  node, active, indent, protectedCollection, draggableCollection, invalidDropTarget, hasChildren, expanded,
  onToggle, onSelect, onCreateChild, onRename, onMove, onHide, onDelete,
}: FolderRowProps) {
  const draggable = useDraggable({
    id: `collection:${node.id}`,
    data: { type: 'collection', collection: node } satisfies DragSourceData,
    disabled: !draggableCollection,
  })
  const droppable = useDroppable({
    id: `collection-drop:${node.id}`,
    data: { kind: 'into-collection', collectionId: node.id } satisfies DropTargetData,
  })
  const showsDropHighlight = droppable.isOver && !invalidDropTarget

  return (
    <div
      ref={droppable.setNodeRef}
      className={cn(
        'group flex items-center gap-1 rounded-md pr-1 text-[13px] transition-colors',
        active
          ? 'bg-primary/10 text-accent-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent',
        showsDropHighlight && 'ring-2 ring-primary/60 bg-primary/5',
        droppable.isOver && invalidDropTarget && 'cursor-not-allowed opacity-60',
        draggable.isDragging && 'opacity-40',
      )}
      style={{ paddingLeft: indent }}
    >
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
      <button
        type="button"
        ref={draggable.setNodeRef}
        {...draggable.listeners}
        {...draggable.attributes}
        onClick={onSelect}
        className="min-w-0 flex-1 flex items-center gap-2 py-1.5 text-left"
        title={node.name}
      >
        <Folder className="size-4 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Folder actions for ${node.name}`}
            className="shrink-0 rounded p-1 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-background/80"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onCreateChild}>
            <FolderPlus className="size-4" /> New child folder
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRename}>
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>
          {!protectedCollection && (
            <DropdownMenuItem onSelect={onMove}>
              <Folder className="size-4" /> Move
            </DropdownMenuItem>
          )}
          {!protectedCollection && <DropdownMenuSeparator />}
          {!protectedCollection && (
            <DropdownMenuItem onSelect={onHide}>
              <EyeOff className="size-4" /> Hide
            </DropdownMenuItem>
          )}
          {!protectedCollection && (
            <DropdownMenuItem onSelect={onDelete} className="text-destructive">
              <Trash2 className="size-4" /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function NoteTreeItem({
  note, title, active, selected, muted, onClick, onContextMenu, onDelete, indent,
}: {
  note: NoteSummary
  title: string
  active: boolean
  selected: boolean
  muted: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void
  onDelete: () => void
  indent: number
}) {
  const draggable = useDraggable({
    id: `note:${note.id}`,
    data: { type: 'note', note } satisfies DragSourceData,
  })

  return (
    <button
      type="button"
      ref={draggable.setNodeRef}
      {...draggable.listeners}
      {...draggable.attributes}
      aria-pressed={selected}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'Delete') return
        event.preventDefault()
        onDelete()
      }}
      title={title}
      style={{ paddingLeft: indent }}
      className={cn(
        'mx-1 mb-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md py-1 pr-2 text-[13px] transition-colors',
        active
          ? 'bg-primary/10 text-accent-foreground font-medium'
          : selected
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent',
        muted && !active && 'opacity-60',
        draggable.isDragging && 'opacity-40',
      )}
    >
      <FileText className="size-3.5 shrink-0 opacity-70" />
      <span className="truncate">{title}</span>
    </button>
  )
}
