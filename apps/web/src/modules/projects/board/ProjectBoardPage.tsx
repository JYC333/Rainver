import BoardColumnLane from './BoardColumnLane'
import { BoardColumnDraft, BoardColumnRemoval } from './BoardColumnControls'
import BoardTaskEditor from './BoardTaskEditor'
import { useAppTranslation } from '../../../i18n'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { laneKeyboardCoordinates } from './laneKeyboardCoordinates'
import { applyCardMove, mergeBoard } from './mergeBoard'
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
  return <ProjectBoardContent key={projectId} projectId={projectId}/>
}

function ProjectBoardContent({projectId}:{projectId:string}) {
  const { t } = useAppTranslation()
  const [addingColumn,setAddingColumn]=useState<{after:string|null}|null>(null)
  const [removingColumn,setRemovingColumn]=useState<ProjectBoard['columns'][number]|null>(null)
  const [columnSaving,setColumnSaving]=useState(false)
  const columnPending=useRef(false)
  const loadVersion=useRef(0)
  const [cardAction,setCardAction]=useState<{card:ProjectBoardCard;mode:'edit'|'delete'}|null>(null)
  const [createColumn,setCreateColumn]=useState<ProjectBoard['columns'][number]|null>(null)
  const onCardAction=useCallback((card:ProjectBoardCard,mode:'edit'|'delete')=>setCardAction({card,mode}),[])
  const [board, setBoard] = useState<ProjectBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<BoardFilter>('all')
  // A close the server refused. Holding the card and its reasons here is what
  // turns the 422 into a decision the person can act on rather than an error.
  const [blockedClose, setBlockedClose] = useState<{ card: ProjectBoardCard; missing: string[]; destination:string } | null>(null)
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
    if(columnPending.current)return
    const version=loadVersion.current
    showingRef.current = projectId
    if (!quiet) setLoading(true)
    try {
      const next = await projectsApi.getBoard(projectId)
      if (showingRef.current !== projectId || version!==loadVersion.current) return
      // Folded in rather than replaced: a read where nothing moved returns the
      // very same object and sets no state, and a read where one card moved
      // keeps every other card's identity so only its lane re-renders.
      setBoard(current => mergeBoard(current, next))
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
    const destination=board?.columns.find(c=>c.key===toStatus)
    if(!destination?.status_key)return
    // Draw the card where it was dropped before the request goes out, and put
    // it back if the server refuses. Do not re-read through the loading path.
    // That replaces the whole Board with a skeleton on every drag.
    setBoard(current => (current ? applyCardMove(current, card.id, toStatus) : current))
    try {
      await moveCardStatus(card.id, card.status==='blocked'&&destination.status_key==='in_progress'?'blocked':destination.status_key, acknowledged, destination.board_id?{column_id:destination.key,board_id:destination.board_id}:undefined)
      setBlockedClose(null)
      // Quiet: the optimistic move is already drawn, and `mergeBoard` touches
      // only what the server decided differently.
      await load(true)
    } catch (error) {
      // Back to its lane with the status it had: a blocked card shares the
      // In Progress lane, and must come back blocked, not in progress.
      setBoard(current => {
        if (!current) return current
        const cards=current.cards.map(item=>item.id===card.id?{...item,status:card.status,column_key:card.column_key}:item)
        return {...current,cards,columns:current.columns.map(column=>({...column,count:cards.filter(item=>item.column_key===column.key).length}))}
      })
      const missing = blockedCompletion(error)
      if (missing) {
        setBlockedClose({ card, missing, destination:toStatus })
        return
      }
      toast.error(errMsg(error))
    }
  }, [load,board])

  const saveColumns=useCallback(async(columns:ProjectBoard['columns'],moves:Record<string,string>={})=>{
    if(!board||columnPending.current)throw new Error(t('board_ui.saving'))
    columnPending.current=true
    loadVersion.current++
    setColumnSaving(true)
    try {
      const next=await projectsApi.configureBoard(projectId,{
        revision:board.columns_revision,
        columns:columns.filter(c=>c.status_key).map(({key,label,status_key,wip_limit})=>({key,label,status_key,wip_limit})),
        moves,
      })
      setBoard(next)
    } finally {
      loadVersion.current++
      columnPending.current=false
      setColumnSaving(false)
    }
  },[board,projectId,t])

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const toStatus = event.over?.id
    if (typeof toStatus !== 'string'||columnPending.current) return
    if(event.active.data?.current?.type==='column'){
      if(!board)return
      const columns=board.columns.filter(c=>c.status_key)
      const from=columns.findIndex(c=>c.key===event.active.data?.current?.key)
      const to=columns.findIndex(c=>c.key===toStatus)
      if(from<0||to<0||from===to)return
      const next=[...columns]
      next.splice(to,0,next.splice(from,1)[0]!)
      const before=board
      setBoard({...board,columns:[...next,...board.columns.filter(c=>!c.status_key)]})
      void saveColumns(next).catch(error=>{setBoard(before);toast.error(errMsg(error))})
      return
    }
    const card = board?.cards.find(item => item.id === event.active.id)
    // Compared with the lane, not the status: a blocked card sits in the In
    // Progress lane, and dropping it back there must not unblock it.
    if (!card || card.column_key === toStatus) return
    void moveCard(card, toStatus)
  }, [board, moveCard, saveColumns])

  const openCreate = useCallback(async (column?:ProjectBoard['columns'][number]) => {
    setCreateColumn(column??board?.columns.find(c=>c.status_key==='ready')??board?.columns.find(c=>c.status_key && c.status_key!=='done')??null)
    setCreating(true)
    try {
      setAgents(await agentsApi.list({ limit: '100' }))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }, [board])

  const createTask = useCallback(async (body: Record<string, unknown>) => {
    // Created here, in the Project: the daily action of putting work on the
    // Board must not mean leaving the Board for the cross-Project list.
    await tasksApi.create({ ...body, project_id: projectId, status: createColumn?.status_key??'ready', ...(createColumn?.board_id?{board_id:createColumn.board_id,column_id:createColumn.key}:{}) })
    toast.success('Task created')
    setCreating(false)
    // Quiet for the same reason a move is: the new card arrives in its lane
    // without the rest of the Board blinking through a skeleton.
    await load(true)
  }, [projectId, load, createColumn])

  if (loading) return <div className="p-6 space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>
  if (!board) {
    return <div className="p-6"><EmptyState title="Board unavailable" description="This Project's board could not be loaded." /></div>
  }

  return (
    <div className="flex min-h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Board</h1>
          <p className="text-sm text-muted-foreground">{board.project.name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {board.viewer_can_write && (
            <Button size="sm" className="mr-2" disabled={columnSaving} onClick={() => void openCreate()}>{t('board_ui.new_task')}</Button>
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

      {removingColumn&&<BoardColumnRemoval column={removingColumn} columns={board.columns} disabled={columnSaving}
        onClose={()=>setRemovingColumn(null)} onDelete={async target=>{await saveColumns(board.columns.filter(c=>c.key!==removingColumn.key),{[removingColumn.key]:target});setRemovingColumn(null)}}/>}
      {cardAction&&<BoardTaskEditor key={cardAction.card.id+cardAction.mode} {...cardAction} onClose={()=>setCardAction(null)} onSaved={()=>{setCardAction(null);void load(true)}}/>}
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
            <Fragment key={column.key}>
              <BoardColumnLane column={column}
                cards={visibleCards.filter(card=>card.column_key===column.key)} projectId={projectId}
                canWrite={board.viewer_can_write} busy={columnSaving}
                canDelete={board.columns.filter(c=>c.status_key).length>1}
                canAdd={board.columns.filter(c=>c.status_key).length<30}
                onAction={onCardAction}
                onCreate={column.status_key&&column.status_key!=='done'?()=>void openCreate(column):undefined}
                onRename={name=>saveColumns(board.columns.map(c=>c.key===column.key?{...c,label:name}:c))}
                onMeaning={status_key=>saveColumns(board.columns.map(c=>c.key===column.key?{...c,status_key}:c))}
                onAdd={()=>setAddingColumn({after:column.key})}
                onRemove={()=>setRemovingColumn(column)}
              />
              {addingColumn?.after===column.key&&<BoardColumnDraft disabled={columnSaving} onCancel={()=>setAddingColumn(null)} onCreate={async(label,status_key)=>{
                const columns=board.columns.filter(c=>c.status_key)
                const index=columns.findIndex(c=>c.key===column.key)
                columns.splice(index+1,0,{key:`new:${crypto.randomUUID()}`,label,status_key,wip_limit:null,board_id:null,count:0})
                await saveColumns(columns);setAddingColumn(null)
              }}/>}
            </Fragment>
          ))}
          {board.viewer_can_write&&(addingColumn&&addingColumn.after===null
            ?<BoardColumnDraft disabled={columnSaving} onCancel={()=>setAddingColumn(null)} onCreate={async(label,status_key)=>{
              await saveColumns([...board.columns,{key:`new:${crypto.randomUUID()}`,label,status_key,wip_limit:null,board_id:null,count:0}]);setAddingColumn(null)
            }}/>
            :<Button variant="outline" className="self-start justify-start" disabled={columnSaving||board.columns.filter(c=>c.status_key).length>=30} onClick={()=>setAddingColumn({after:null})}>+ {t('board_ui.add')}</Button>)}
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
                  await moveCard(blockedClose.card, blockedClose.destination, blockedClose.missing)
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
