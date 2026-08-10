import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, closestCenter, pointerWithin, useDraggable, useDroppable,
  useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import {
  ChevronRight, Copy, ExternalLink, EyeOff, FileText, Focus, Folder, FolderPlus, FolderTree,
  MoreHorizontal, Pencil, Trash2, X,
} from 'lucide-react'
import { SpaceLink as Link } from '../../../core/spaceNav'
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
  type DragSourceData, type DropTargetData, type NoteMove, type PlacedNote,
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
  /** The folder the tree is hoisted into: it becomes the only root and
   * everything outside its subtree is hidden. Null spans every collection. */
  hoistRootId: string | null
  /** Enter hoisting on a folder, or leave it (`null`). */
  onHoist: (collectionId: string | null) => void
  /** Whether leaving the current hoist root is offered. A surface that exists
   * *because* of its root — a Project's notes — has nowhere to leave to. */
  canExitHoist: boolean
  /** Drag a folder onto another folder (or a gap between siblings, or the
   * root strip) to reparent and/or reorder it. Project-backed folders may be
   * freely placed; fixed collection roots (Inbox/Archive/Projects) are not
   * draggable. Every affected sibling's new position is included. */
  onDropCollections?: (updates: CollectionMove[]) => void
  /** Drag a note onto a folder (or a gap between two notes in a folder) to
   * move and/or reorder that placement. */
  onDropNotes?: (updates: NoteMove[]) => void
  /**
   * Hold Alt while dropping to add a placement instead of moving one (U5).
   * Trilium uses a modifier on drop for the same distinction; without one the
   * only options are silently widening every drag or never allowing a second
   * placement at all.
   */
  onPlaceNote?: (noteId: string, collectionId: string) => void
  /** Take a note out of one folder, leaving its other placements alone. */
  onRemovePlacement?: (noteId: string, collectionId: string) => void
}

export default function NotesTree({
  collections, notes, selectedCollectionId, activeNoteId, collapsedCollectionIds,
  resolveNoteTitle, onToggleCollection, onSelectCollection, onSelectNoteCollection,
  onOpenNote, onArchiveNote, onArchiveNotes, onDeleteNote, onDeleteNotes,
  onCreateChild, onRename, onMove, onHide, onDeleteCollection, onDropCollections, onDropNotes,
  onPlaceNote, onRemovePlacement, hoistRootId, onHoist, canExitHoist,
}: NotesTreeProps) {
  const fullTree = useMemo(() => buildCollectionTree(collections), [collections])
  const hoistRoot = useMemo(
    () => (hoistRootId ? findCollectionNode(fullTree, hoistRootId) : null),
    [fullTree, hoistRootId],
  )
  // Hoisting is a filter over the tree that is already built, not a second
  // tree: the hoisted folder becomes the only root, so it stays visible as the
  // thing you are inside rather than disappearing along with its parents.
  const collectionTree = hoistRoot ? [hoistRoot] : fullTree
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

  // dnd-kit reports the pointer event that *started* the drag, so the modifier
  // state at drop time has to be tracked separately. Watched only while a note
  // is being dragged, and mirrored into the drag preview so "this will add a
  // placement" is visible before the pointer is released.
  const [additiveDrop, setAdditiveDrop] = useState(false)
  const draggingNote = activeDrag?.type === 'note'
  useEffect(() => {
    if (!draggingNote) {
      setAdditiveDrop(false)
      return
    }
    const sync = (event: globalThis.KeyboardEvent) => setAdditiveDrop(event.altKey)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
    }
  }, [draggingNote])

  function handleDragStart(event: DragStartEvent) {
    setActiveDrag((event.active.data.current as DragSourceData | undefined) ?? null)
    const activator = event.activatorEvent as { altKey?: boolean } | undefined
    setAdditiveDrop(Boolean(activator?.altKey))
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null)
    const { active, over } = event
    if (!over) return
    const source = active.data.current as DragSourceData | undefined
    const target = over.data.current as DropTargetData | undefined
    if (!source || !target) return
    const resolved = resolveTreeDrop(source, target, collectionTree, collections, visibleTreeNotes, additiveDrop)
    if (!resolved) return
    if (resolved.kind === 'move-collections') onDropCollections?.(resolved.updates)
    else if (resolved.kind === 'place-note') onPlaceNote?.(resolved.noteId, resolved.collectionId)
    else onDropNotes?.(resolved.updates)
  }

  // Selection is by *placement*, not by note: a note filed in two folders draws
  // two rows, and Shift-range, the context menu and "remove from this folder"
  // all need to know which of them the user is pointing at.
  const visibleKeys = useMemo(() => visibleNotes.map(placed => placed.key), [visibleNotes])
  const visibleByKey = useMemo(() => new Map(visibleNotes.map(placed => [placed.key, placed])), [visibleNotes])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<(TreeContextMenuPosition & { key: string }) | null>(null)
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
    setSelectedKeys(new Set())
    setSelectionAnchorKey(null)
    setContextMenu(null)
  }, [activeNoteId])

  useEffect(() => {
    setSelectedKeys(prev => {
      const visible = new Set(visibleKeys)
      const next = new Set([...prev].filter(key => visible.has(key)))
      return next.size === prev.size ? prev : next
    })
    setSelectionAnchorKey(prev => (prev && visibleByKey.has(prev) ? prev : null))
  }, [visibleKeys, visibleByKey])

  const contextMenuPlacements = useMemo(() => {
    if (!contextMenu) return []
    const target = visibleByKey.get(contextMenu.key)
    if (!target) return []
    const actionKeys = selectedKeys.has(target.key) && selectedKeys.size > 1
      ? selectedKeys
      : new Set([target.key])
    return visibleNotes.filter(placed => actionKeys.has(placed.key))
  }, [contextMenu, selectedKeys, visibleNotes, visibleByKey])

  const contextMenuTarget = contextMenu ? visibleByKey.get(contextMenu.key) ?? null : null

  function placementsForAction(placed: PlacedNote) {
    if (selectedKeys.has(placed.key) && selectedKeys.size > 1) {
      return visibleNotes.filter(item => selectedKeys.has(item.key))
    }
    return [placed]
  }

  function selectRange(toKey: string) {
    const fromKey = selectionAnchorKey ?? toKey
    const from = visibleKeys.indexOf(fromKey)
    const to = visibleKeys.indexOf(toKey)
    if (from === -1 || to === -1) {
      setSelectedKeys(new Set([toKey]))
      setSelectionAnchorKey(toKey)
      return
    }
    const [start, end] = from < to ? [from, to] : [to, from]
    setSelectedKeys(new Set(visibleKeys.slice(start, end + 1)))
  }

  function toggleSelected(key: string) {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setSelectionAnchorKey(key)
  }

  function selectSingle(key: string) {
    setSelectedKeys(new Set([key]))
    setSelectionAnchorKey(key)
  }

  function handleCollectionSelect(id: string) {
    setSelectedKeys(new Set())
    setSelectionAnchorKey(null)
    setContextMenu(null)
    onSelectCollection(id)
  }

  function handleNoteClick(placed: PlacedNote, event: MouseEvent<HTMLButtonElement>) {
    onSelectNoteCollection?.(placed.collectionId)
    if (event.shiftKey) {
      selectRange(placed.key)
      return
    }
    if (event.metaKey || event.ctrlKey) {
      toggleSelected(placed.key)
      return
    }
    selectSingle(placed.key)
    pendingTreeOpenId.current = placed.note.id
    onOpenNote(placed.note.id)
  }

  function handleNoteContextMenu(placed: PlacedNote, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    onSelectNoteCollection?.(placed.collectionId)
    if (!selectedKeys.has(placed.key)) selectSingle(placed.key)
    setContextMenu({ x: event.clientX, y: event.clientY, key: placed.key })
  }

  function requestDeleteNotes(targets: PlacedNote[]) {
    setContextMenu(null)
    const uniqueNotes = [...new Map(targets.map(placed => [placed.note.id, placed.note])).values()]
    if (uniqueNotes.length === 0) return
    if (uniqueNotes.length === 1 || !onDeleteNotes) {
      uniqueNotes.forEach(note => onDeleteNote(note))
      return
    }
    onDeleteNotes(uniqueNotes)
  }

  function requestArchiveNotes(targets: PlacedNote[]) {
    setContextMenu(null)
    const uniqueNotes = [...new Map(targets.map(placed => [placed.note.id, placed.note])).values()]
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
      {hoistRoot && (
        <HoistBar name={hoistRoot.name} onExit={canExitHoist ? () => onHoist(null) : null} />
      )}
      {/* Hoisted, "top level" is the hoist root itself. Offering the root strip
          would let a drag move a folder to a place the current view cannot
          show — a silent disappearance rather than a move. */}
      <RootDropZone visible={showCollectionGaps && !hoistRoot} />
      <CollectionTree
        nodes={collectionTree}
        parentId={null}
        hoistedRootLevel={Boolean(hoistRoot)}
        canExitHoist={canExitHoist}
        onHoist={onHoist}
        notesByCollection={notesByCollection}
        selectedId={selectedCollectionId}
        activeNoteId={activeNoteId}
        selectedKeys={selectedKeys}
        collapsed={collapsedCollectionIds}
        invalidDropTargetIds={invalidDropTargetIds}
        showCollectionGaps={showCollectionGaps}
        showNoteGaps={showNoteGaps}
        onToggle={onToggleCollection}
        onSelect={handleCollectionSelect}
        onNoteClick={handleNoteClick}
        onNoteContextMenu={handleNoteContextMenu}
        onDeleteNotes={placed => requestDeleteNotes(placementsForAction(placed))}
        titleFor={resolveNoteTitle}
        onCreateChild={onCreateChild}
        onRename={onRename}
        onMove={onMove}
        onHide={onHide}
        onDelete={onDeleteCollection}
      />
      <TreeContextMenu
        label={contextMenuPlacements.length > 1 ? 'Selected notes' : contextMenuPlacements[0]?.note.title ?? 'Note'}
        archiveLabel={contextMenuPlacements.length > 1 ? `Archive ${contextMenuPlacements.length} notes` : 'Archive'}
        deleteLabel={contextMenuPlacements.length > 1 ? `Delete ${contextMenuPlacements.length} notes` : 'Delete'}
        position={contextMenu}
        onClose={() => setContextMenu(null)}
        onArchive={() => requestArchiveNotes(contextMenuPlacements)}
        onDelete={() => requestDeleteNotes(contextMenuPlacements)}
        // Offered only on a note that is in more than one folder, and only for
        // a single row: taking a note out of its last folder is deleting it.
        onRemovePlacement={
          onRemovePlacement
            && contextMenuPlacements.length === 1
            && contextMenuTarget
            && contextMenuTarget.note.placements.length > 1
            ? () => onRemovePlacement(contextMenuTarget.note.id, contextMenuTarget.collectionId)
            : undefined
        }
      />
      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {activeDrag && <DragPreview source={activeDrag} titleFor={resolveNoteTitle} additive={additiveDrop} />}
      </DragOverlay>
    </DndContext>
  )
}

/** Says where you are while hoisted, and — where there is somewhere to go back
 * to — is the way out. */
function HoistBar({ name, onExit }: { name: string; onExit: (() => void) | null }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[12px]">
      <Focus className="size-3.5 shrink-0 text-accent-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium text-accent-foreground" title={name}>{name}</span>
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          aria-label={`Exit focus on ${name}`}
          title="Exit focus"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background/80 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
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

function DragPreview({
  source, titleFor, additive,
}: { source: DragSourceData; titleFor: (id: string) => string; additive: boolean }) {
  const label = source.type === 'collection' ? source.collection.name : titleFor(source.placed.note.id)
  return (
    <div className="flex size-full items-center gap-2 overflow-hidden rounded-md border border-border bg-card/90 px-2 text-[13px] opacity-85 shadow-lg backdrop-blur-[1px]">
      {source.type === 'collection' ? <Folder className="size-4 shrink-0" /> : <FileText className="size-3.5 shrink-0 opacity-70" />}
      <span className="truncate">{label}</span>
      {/* Says which of the two drops this is before the pointer is released. */}
      {additive && source.type === 'note' && (
        <span className="ml-auto shrink-0 rounded bg-primary/15 px-1 text-[10px] font-medium text-accent-foreground">
          + folder
        </span>
      )}
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
  notesByCollection: Map<string, PlacedNote[]>
  selectedId: string | null
  activeNoteId: string | undefined
  selectedKeys: Set<string>
  collapsed: Set<string>
  invalidDropTargetIds: Set<string>
  showCollectionGaps: boolean
  showNoteGaps: boolean
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  onNoteClick: (placed: PlacedNote, event: MouseEvent<HTMLButtonElement>) => void
  onNoteContextMenu: (placed: PlacedNote, event: MouseEvent<HTMLButtonElement>) => void
  onDeleteNotes: (placed: PlacedNote) => void
  titleFor: (id: string) => string
  onCreateChild: (collection: NoteCollection) => void
  onRename: (collection: NoteCollection) => void
  onMove: (collection: NoteCollection) => void
  onHide: (collection: NoteCollection) => void
  onDelete: (collection: NoteCollection) => void
  onHoist: (collectionId: string | null) => void
  canExitHoist: boolean
  /** True for the single level that *is* the hoist root: it defines the view,
   * so it cannot be reordered or reparented from inside it. */
  hoistedRootLevel?: boolean
  depth?: number
}

function CollectionTree({
  nodes, parentId, notesByCollection, selectedId, activeNoteId, selectedKeys, collapsed, invalidDropTargetIds,
  showCollectionGaps, showNoteGaps,
  onToggle, onSelect, onNoteClick, onNoteContextMenu, onDeleteNotes, titleFor,
  onCreateChild, onRename, onMove, onHide, onDelete, onHoist, canExitHoist,
  hoistedRootLevel = false, depth = 0,
}: CollectionTreeProps) {
  const visualDepth = Math.min(depth, 2)
  const indent = 8 + visualDepth * 14
  const siblingGapsVisible = showCollectionGaps && !hoistedRootLevel
  return (
    <div>
      <DropGap
        id={`collection-gap:${parentId ?? 'root'}:${nodes[0]?.id ?? 'end'}`}
        data={{ kind: 'collection-gap', parentId, beforeId: nodes[0]?.id ?? null }}
        indent={indent}
        visible={siblingGapsVisible}
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
                draggableCollection={draggableCollection && !hoistedRootLevel}
                invalidDropTarget={invalidDropTargetIds.has(node.id)}
                hasChildren={hasChildren}
                expanded={expanded}
                isHoistRoot={hoistedRootLevel}
                onToggle={() => onToggle(node.id)}
                onSelect={() => onSelect(node.id)}
                onCreateChild={() => onCreateChild(node)}
                onRename={() => onRename(node)}
                onMove={() => onMove(node)}
                onHide={() => onHide(node)}
                onDelete={() => onDelete(node)}
                // The hoist root's own menu offers the way out, unless the
                // surface pins it and there is nowhere to leave to.
                onHoist={hoistedRootLevel && !canExitHoist ? null : () => onHoist(hoistedRootLevel ? null : node.id)}
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
                      selectedKeys={selectedKeys}
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
                      onHoist={onHoist}
                      canExitHoist={canExitHoist}
                      depth={depth + 1}
                    />
                  )}
                  <DropGap
                    id={`note-gap:${node.id}:${childNotes[0]?.note.id ?? 'end'}`}
                    data={{ kind: 'note-gap', collectionId: node.id, beforeId: childNotes[0]?.note.id ?? null }}
                    indent={indent + 26}
                    visible={showNoteGaps}
                  />
                  {childNotes.map((placed, noteIndex) => {
                    const nextPlaced = childNotes[noteIndex + 1]
                    return (
                      <Fragment key={placed.key}>
                        <NoteTreeItem
                          placed={placed}
                          title={titleFor(placed.note.id)}
                          active={placed.note.id === activeNoteId}
                          selected={selectedKeys.has(placed.key)}
                          muted={placed.note.status === 'archived'}
                          onClick={event => onNoteClick(placed, event)}
                          onContextMenu={event => onNoteContextMenu(placed, event)}
                          onDelete={() => onDeleteNotes(placed)}
                          indent={indent + 26}
                        />
                        <DropGap
                          id={`note-gap:${node.id}:${nextPlaced?.note.id ?? 'end'}`}
                          data={{ kind: 'note-gap', collectionId: node.id, beforeId: nextPlaced?.note.id ?? null }}
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
              visible={siblingGapsVisible}
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
  isHoistRoot: boolean
  onToggle: () => void
  onSelect: () => void
  onCreateChild: () => void
  onRename: () => void
  onMove: () => void
  onHide: () => void
  onDelete: () => void
  onHoist: (() => void) | null
}

/** Folder action protection and drag policy are intentionally separate:
 * project-backed folders remain protected from deletion but can be placed
 * freely, while fixed collection roots cannot move. */
function FolderRow({
  node, active, indent, protectedCollection, draggableCollection, invalidDropTarget, hasChildren, expanded,
  isHoistRoot, onToggle, onSelect, onCreateChild, onRename, onMove, onHide, onDelete, onHoist,
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
  const workspaceRoot = node.system_role === 'project'

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
        title={workspaceRoot ? `${node.name} · Project workspace` : node.name}
      >
        {/* A Project's folder is a workspace root: hoisting into it is what
            turns this tree into that Project's notes surface. Marked so a user
            can see where hoisting is meaningful before trying it. */}
        {workspaceRoot
          ? <FolderTree className="size-4 shrink-0 text-accent-foreground" />
          : <Folder className="size-4 shrink-0" />}
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
          {/* NF: navigation both ways. The Notebook already links a note back
              to its place in this tree ("Open in Notes"); this is the return
              trip, so a project-backed folder is not a dead end. */}
          {node.project_id && (
            <DropdownMenuItem asChild>
              <Link to={`/projects/${node.project_id}/research`}>
                <ExternalLink className="size-4" /> Open project
              </Link>
            </DropdownMenuItem>
          )}
          {onHoist && (
            <DropdownMenuItem onSelect={onHoist}>
              <Focus className="size-4" /> {isHoistRoot ? 'Exit focus' : 'Focus on this folder'}
            </DropdownMenuItem>
          )}
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
  placed, title, active, selected, muted, onClick, onContextMenu, onDelete, indent,
}: {
  placed: PlacedNote
  title: string
  active: boolean
  selected: boolean
  muted: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void
  onDelete: () => void
  indent: number
}) {
  // Keyed by placement, not by note: the same note in two folders is two
  // draggables, and dnd-kit would otherwise see one id in two places.
  const draggable = useDraggable({
    id: `note:${placed.key}`,
    data: { type: 'note', placed } satisfies DragSourceData,
  })
  const placementCount = placed.note.placements.length

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
      title={placementCount > 1 ? `${title} · also in ${placementCount - 1} other folder${placementCount > 2 ? 's' : ''}` : title}
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
      {/* A note that appears elsewhere too — editing it here changes it there,
          and that is worth knowing before typing rather than after. */}
      {placementCount > 1 && (
        <Copy className="ml-auto size-3 shrink-0 opacity-60" aria-hidden />
      )}
    </button>
  )
}
