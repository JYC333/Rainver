import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { CheckCircle2, GripVertical, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { projectResearchApi } from '../../../api/client'
import type { ResearchChecklistItem } from '../../../types/api'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { EmptyState } from '../../../components/ui/empty-state'
import { Input } from '../../../components/ui/input'
import { errMsg } from '../../../lib/utils'
import { SpaceLink as Link } from '../../../core/spaceNav'

const CHECKLIST_COLUMNS = [
  { status: 'open', label: 'Open' },
  { status: 'done', label: 'Done' },
  { status: 'dismissed', label: 'Dismissed' },
] as const

type ChecklistStatus = ResearchChecklistItem['status']

const checklistCollisionDetection: CollisionDetection = args => {
  const pointerCollisions = pointerWithin(args)
  if (pointerCollisions.length === 0) return closestCenter(args)
  // A card is nested inside its column, so pointerWithin can report both.
  // Prefer the card under the pointer for exact ordering; use the column
  // only when the pointer is over its empty space.
  return [...pointerCollisions].sort((left, right) => {
    const leftIsItem = Boolean(left.data?.droppableContainer.data.current?.itemId)
    const rightIsItem = Boolean(right.data?.droppableContainer.data.current?.itemId)
    return Number(rightIsItem) - Number(leftIsItem)
  })
}

export function moveChecklistItem(
  items: ResearchChecklistItem[],
  draggedId: string,
  targetStatus: ChecklistStatus,
  targetId: string | null,
) {
  const dragged = items.find(item => item.id === draggedId)
  if (!dragged) return items
  const sourceItems = items
    .filter(item => item.status === dragged.status)
    .sort((a, b) => a.sort_order - b.sort_order)
  const sourceIndex = sourceItems.findIndex(item => item.id === draggedId)
  const targetItems = items
    .filter(item => item.status === targetStatus && item.id !== draggedId)
    .sort((a, b) => a.sort_order - b.sort_order)
  const originalTargetIndex = targetId
    ? items
      .filter(item => item.status === targetStatus)
      .sort((a, b) => a.sort_order - b.sort_order)
      .findIndex(item => item.id === targetId)
    : -1
  if (targetId && originalTargetIndex < 0) return items
  if (dragged.status === targetStatus && targetId === draggedId) return items

  let insertAt = targetId ? targetItems.findIndex(item => item.id === targetId) : targetItems.length
  if (targetId && dragged.status === targetStatus && sourceIndex < originalTargetIndex) insertAt += 1
  targetItems.splice(insertAt, 0, { ...dragged, status: targetStatus })

  const byStatus = new Map<ChecklistStatus, ResearchChecklistItem[]>()
  for (const column of CHECKLIST_COLUMNS) {
    const columnItems = column.status === targetStatus
      ? targetItems
      : items
        .filter(item => item.status === column.status && item.id !== draggedId)
        .sort((a, b) => a.sort_order - b.sort_order)
    byStatus.set(column.status, columnItems.map((item, sortOrder) => ({ ...item, sort_order: sortOrder })))
  }
  const next = CHECKLIST_COLUMNS.flatMap(column => byStatus.get(column.status) ?? [])
  const unchanged = next.length === items.length && next.every(item => {
    const current = items.find(value => value.id === item.id)
    return current?.status === item.status && current.sort_order === item.sort_order
  })
  return unchanged ? items : next
}

export function ChecklistView({
  projectId,
  items,
  onChange,
}: {
  projectId: string
  items: ResearchChecklistItem[]
  onChange: (items: ResearchChecklistItem[]) => void
}) {
  const [text, setText] = useState('')
  const [activeItem, setActiveItem] = useState<ResearchChecklistItem | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  async function add() {
    if (!text.trim()) return
    try {
      const item = await projectResearchApi.createChecklistItem(projectId, text)
      onChange([...items, item])
      setText('')
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function setStatus(item: ResearchChecklistItem, status: ResearchChecklistItem['status']) {
    try {
      const next = await projectResearchApi.updateChecklistItem(projectId, item.id, { status })
      onChange(items.map((value) => value.id === next.id ? next : value))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function remove(id: string) {
    try {
      await projectResearchApi.deleteChecklistItem(projectId, id)
      onChange(items.filter((value) => value.id !== id))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const itemId = event.active.data.current?.itemId
    setActiveItem(items.find(item => item.id === itemId) ?? null)
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveItem(null)
    const draggedId = event.active.data.current?.itemId
    const targetStatus = event.over?.data.current?.status
    const targetId = event.over?.data.current?.itemId ?? null
    if (
      typeof draggedId !== 'string'
      || (targetStatus !== 'open' && targetStatus !== 'done' && targetStatus !== 'dismissed')
      || (targetId !== null && typeof targetId !== 'string')
    ) return
    const reordered = moveChecklistItem(items, draggedId, targetStatus, targetId)
    if (reordered === items) return
    onChange(reordered)
    const previousById = new Map(items.map(item => [item.id, item]))
    const updates = reordered.filter(item => {
      const previous = previousById.get(item.id)
      return !previous || previous.status !== item.status || previous.sort_order !== item.sort_order
    })
    try {
      await Promise.all(updates.map(item => projectResearchApi.updateChecklistItem(projectId, item.id, {
        status: item.status,
        sort_order: item.sort_order,
      })))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void add() }} placeholder="Add a research task" />
        <Button onClick={() => void add()}><Plus className="size-4" />Add</Button>
      </div>
      {items.length === 0 ? (
        <EmptyState title="Checklist is empty" description="Track research gaps, follow-ups, and experiments here." />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={checklistCollisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={(event) => void handleDragEnd(event)}
          onDragCancel={() => setActiveItem(null)}
        >
          <div className="grid gap-4 md:grid-cols-3">
            {CHECKLIST_COLUMNS.map(column => (
              <ChecklistColumn
                key={column.status}
                status={column.status}
                label={column.label}
                items={items
                  .filter(item => item.status === column.status)
                  .sort((a, b) => a.sort_order - b.sort_order)}
                onToggle={item => void setStatus(item, item.status === 'done' ? 'open' : 'done')}
                onRemove={item => void remove(item.id)}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
            {activeItem && <ChecklistDragPreview item={activeItem} />}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  )
}

function ChecklistColumn({
  status,
  label,
  items,
  onToggle,
  onRemove,
}: {
  status: ChecklistStatus
  label: string
  items: ResearchChecklistItem[]
  onToggle: (item: ResearchChecklistItem) => void
  onRemove: (item: ResearchChecklistItem) => void
}) {
  const droppable = useDroppable({
    id: `checklist-column:${status}`,
    data: { status },
  })
  return (
    <section
      ref={droppable.setNodeRef}
      aria-label={`${label} checklist items`}
      className={`min-h-52 rounded-xl border p-3 transition-colors ${
        droppable.isOver ? 'border-primary/60 bg-primary/5' : 'border-border bg-muted/40'
      }`}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">{label}</h3>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      <div className="space-y-2">
        {items.map(item => (
          <ChecklistRow
            key={item.id}
            item={item}
            onToggle={() => onToggle(item)}
            onRemove={() => onRemove(item)}
          />
        ))}
        {items.length === 0 && (
          <p className="rounded-lg border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
            Drop an item here
          </p>
        )}
      </div>
    </section>
  )
}

function ChecklistRow({
  item,
  onToggle,
  onRemove,
}: {
  item: ResearchChecklistItem
  onToggle: () => void
  onRemove: () => void
}) {
  const draggable = useDraggable({
    id: `checklist:${item.id}`,
    data: { itemId: item.id },
  })
  const droppable = useDroppable({
    id: `checklist-drop:${item.id}`,
    data: { itemId: item.id, status: item.status },
  })
  const setCardRef = (node: HTMLDivElement | null) => {
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }

  return (
    <div
      ref={setCardRef}
      {...draggable.listeners}
      {...draggable.attributes}
      className="cursor-grab touch-none rounded-xl active:cursor-grabbing"
    >
      <Card
        className={`flex items-start gap-2 p-3 transition-[transform,opacity,box-shadow] duration-200 ${
          droppable.isOver && !draggable.isDragging ? 'ring-2 ring-primary/50' : ''
        } ${draggable.isDragging ? 'scale-[1.01] opacity-60 shadow-lg' : 'scale-100'}`}
      >
        <span
          aria-hidden
          className="mt-0.5 shrink-0 text-muted-foreground"
        >
          <GripVertical className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={onToggle}
              aria-label={item.status === 'done' ? `Mark ${item.text} open` : `Mark ${item.text} done`}
              className={item.status === 'done' ? 'text-success' : 'text-muted-foreground'}
            >
              <CheckCircle2 className="size-5" />
            </button>
            <span className={`min-w-0 flex-1 text-sm ${item.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>{item.text}</span>
          </div>
          {(item.origin === 'agent' || item.origin_run_id) && (
            <div className="mt-2 flex items-center gap-2 pl-7">
              {item.origin === 'agent' && <Badge variant="outline">AI suggestion</Badge>}
              {item.origin_run_id && <Link className="text-xs text-muted-foreground hover:underline" to={`/runs/${item.origin_run_id}`}>source</Link>}
            </div>
          )}
        </div>
        <Button size="icon" variant="ghost" aria-label={`Delete ${item.text}`} onClick={onRemove}><Trash2 className="size-4" /></Button>
      </Card>
    </div>
  )
}

function ChecklistDragPreview({ item }: { item: ResearchChecklistItem }) {
  return (
    <Card className="flex size-full items-start gap-2 overflow-hidden bg-card/95 p-3 opacity-95 shadow-xl">
      <GripVertical className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <CheckCircle2 className={item.status === 'done' ? 'size-5 shrink-0 text-success' : 'size-5 shrink-0 text-muted-foreground'} />
          <span className={`min-w-0 flex-1 text-sm ${item.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>
            {item.text}
          </span>
        </div>
        {(item.origin === 'agent' || item.origin_run_id) && (
          <div className="mt-2 flex items-center gap-2 pl-7">
            {item.origin === 'agent' && <Badge variant="outline">AI suggestion</Badge>}
            {item.origin_run_id && <span className="text-xs text-muted-foreground">source</span>}
          </div>
        )}
      </div>
      <Trash2 className="size-4 shrink-0 text-muted-foreground" />
    </Card>
  )
}
