import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { DndContext, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { laneKeyboardCoordinates } from './laneKeyboardCoordinates'
import { toast } from 'sonner'
import { agentsApi, projectsApi, tasksApi } from '../../../api/client'
import TaskCreateForm from '../../tasks/TaskCreateForm'
import type { AgentOut } from '../../../types/api'
import { blockedCompletion, completionReasonLabel, moveCardStatus } from './completionOverride'
import { errMsg } from '../../../lib/utils'
import type { ProjectBoard, ProjectBoardCard } from '../../../types/api'
import { Button } from '../../../components/ui/button'
import { Badge } from '../../../components/ui/badge'
import { Skeleton } from '../../../components/ui/skeleton'
import { EmptyState } from '../../../components/ui/empty-state'
import { usePeriodicRefresh } from '../../../hooks/usePeriodicRefresh'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../../components/ui/dialog'
import BoardCard from './BoardCard'
import { PERSON_ONLY_TASK_STATUSES } from '@rainver/protocol'

type BoardFilter = 'all' | 'mine' | 'agent_held' | 'needs_me'

const FILTER_LABELS: Record<BoardFilter, string> = {
  all: 'All',
  mine: 'Mine',
  agent_held: 'Agent working',
  needs_me: 'Needs me',
}

/** Read refresh cadence; the same five seconds the Inquiry Area uses for a live Thread. */
const BOARD_REFRESH_MS = 5_000

export default function ProjectBoardPage() {
  const { projectId = '' } = useParams()
  const [board, setBoard] = useState<ProjectBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<BoardFilter>('all')
  // A close the server refused. Holding the card and its reasons here is what
  // turns the 422 into a decision the person can act on rather than an error.
  const [blockedClose, setBlockedClose] = useState<{ card: ProjectBoardCard; missing: string[] } | null>(null)
  const [overriding, setOverriding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [agents, setAgents] = useState<AgentOut[]>([])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Arrow keys jump between lanes rather than nudging by pixels, so a
    // keyboard move is "next lane", the same unit a drag is judged in.
    useSensor(KeyboardSensor, { coordinateGetter: laneKeyboardCoordinates }),
  )

  // A response for the Project the person has already left must not be
  // painted under the new Project's header.
  const showingRef = useRef(projectId)
  const load = useCallback(async (quiet = false) => {
    showingRef.current = projectId
    if (!quiet) setLoading(true)
    try {
      const next = await projectsApi.getBoard(projectId)
      if (showingRef.current !== projectId) return
      setBoard(next)
    } catch (error) {
      // A background refresh that fails keeps what is drawn rather than
      // toasting every five seconds while the server is away.
      if (showingRef.current === projectId && !quiet) toast.error(errMsg(error))
    } finally {
      if (showingRef.current === projectId) setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])
  // Cards an Agent creates from the Room arrive while this page is open.
  const refresh = useCallback(() => load(true), [load])
  usePeriodicRefresh(refresh, BOARD_REFRESH_MS)

  const visibleCards = useMemo(() => {
    if (!board) return []
    // Relative to the person asking — the server counted them that way, and a
    // lane that lists everyone's cards under a badge counting one is worse
    // than no filter at all.
    const isMine = (card: ProjectBoardCard) =>
      card.responsible.kind === 'user' && card.responsible.id === board.viewer_user_id
    if (filter === 'mine') return board.cards.filter(isMine)
    if (filter === 'agent_held') return board.cards.filter(card => card.responsible.kind === 'agent')
    if (filter === 'needs_me') {
      return board.cards.filter(card => PERSON_ONLY_TASK_STATUSES.includes(card.status as never) && isMine(card))
    }
    return board.cards
  }, [board, filter])

  const moveCard = useCallback(async (
    card: ProjectBoardCard,
    toStatus: string,
    acknowledged?: string[],
  ) => {
    try {
      await moveCardStatus(card.id, toStatus, acknowledged)
      setBlockedClose(null)
      await load()
    } catch (error) {
      const missing = blockedCompletion(error)
      if (missing) {
        setBlockedClose({ card, missing })
        return
      }
      toast.error(errMsg(error))
    }
  }, [load])

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const toStatus = event.over?.id
    if (typeof toStatus !== 'string') return
    const card = board?.cards.find(item => item.id === event.active.id)
    if (!card || card.status === toStatus) return
    void moveCard(card, toStatus)
  }, [board, moveCard])

  const openCreate = useCallback(async () => {
    setCreating(true)
    try {
      setAgents(await agentsApi.list({ limit: '100' }))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }, [])

  const createTask = useCallback(async (body: Record<string, unknown>) => {
    // Created here, in the Project: the daily action of putting work on the
    // Board must not mean leaving the Board for the cross-Project list.
    await tasksApi.create({ ...body, project_id: projectId, status: 'ready' })
    toast.success('Task created')
    setCreating(false)
    await load()
  }, [projectId, load])

  if (loading) return <div className="p-6 space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>
  if (!board) {
    return <div className="p-6"><EmptyState title="Board unavailable" description="This Project's board could not be loaded." /></div>
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Board</h1>
          <p className="text-sm text-muted-foreground">{board.project.name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {board.viewer_can_write && (
            <Button size="sm" className="mr-2" onClick={() => void openCreate()}>New Task</Button>
          )}
          {(Object.keys(FILTER_LABELS) as BoardFilter[]).map(key => (
            <Button
              key={key}
              size="sm"
              variant={filter === key ? 'default' : 'outline'}
              onClick={() => setFilter(key)}
            >
              {FILTER_LABELS[key]}
              <Badge variant="secondary" className="ml-1.5">{board.filters[key]}</Badge>
            </Button>
          ))}
        </div>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Task</DialogTitle>
            <DialogDescription className="sr-only">Create a Task in this Project.</DialogDescription>
          </DialogHeader>
          <TaskCreateForm boards={[]} agents={agents} submitLabel="Create Task" onSubmit={createTask} onCancel={() => setCreating(false)} />
        </DialogContent>
      </Dialog>

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid flex-1 auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
          {board.columns.map(column => (
            <BoardColumnLane
              key={column.status_key}
              statusKey={column.status_key}
              label={column.label}
              wipLimit={column.wip_limit}
              cards={visibleCards.filter(card => card.column_key === column.status_key)}
              projectId={projectId}
              canMove={board.viewer_can_write}
            />
          ))}
        </div>
      </DndContext>

      <Dialog open={blockedClose !== null} onOpenChange={open => { if (!open) setBlockedClose(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>This Task has not met what it declared</DialogTitle>
            <DialogDescription>
              You can close it anyway. The record will say it was closed without these.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 text-sm">
            {blockedClose?.missing.map(reason => (
              <li key={reason} className="text-muted-foreground">• {completionReasonLabel(reason)}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockedClose(null)}>Cancel</Button>
            <Button
              disabled={overriding}
              onClick={async () => {
                if (!blockedClose) return
                setOverriding(true)
                try {
                  await moveCard(blockedClose.card, 'done', blockedClose.missing)
                } finally {
                  setOverriding(false)
                }
              }}
            >
              {overriding ? 'Closing…' : 'Close anyway'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BoardColumnLane({ statusKey, label, wipLimit, cards, projectId, canMove }: {
  statusKey: string
  label: string
  wipLimit: number | null
  cards: ProjectBoardCard[]
  projectId: string
  canMove: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: statusKey })
  // The limit is shown, not enforced: a person moving one more card past it is
  // making a call the Board has no standing to refuse.
  const overLimit = wipLimit !== null && cards.length > wipLimit
  return (
    <div
      ref={setNodeRef}
      className={[
        'flex min-h-[12rem] flex-col gap-2 rounded-xl border border-border bg-card p-3',
        isOver ? 'ring-2 ring-primary/40' : '',
      ].join(' ')}
      data-testid={`board-column-${statusKey}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className={['text-xs', overLimit ? 'text-destructive' : 'text-muted-foreground'].join(' ')}>
          {cards.length}{wipLimit !== null ? ` / ${wipLimit}` : ''}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {cards.map(card => <BoardCard key={card.id} card={card} projectId={projectId} canMove={canMove} />)}
      </div>
    </div>
  )
}
