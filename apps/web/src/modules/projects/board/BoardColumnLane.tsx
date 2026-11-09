import { useCallback, useState } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { GripVertical } from 'lucide-react'
import type { ProjectBoardColumn, ProjectBoardCard } from '../../../types/api'
import { useAppTranslation } from '../../../i18n'
import { Button } from '../../../components/ui/button'
import BoardCard from './BoardCard'
import { BoardColumnMenu, BoardColumnName, BoardColumnMeaning } from './BoardColumnControls'
import { completedCardsView, COMPLETED_CARDS_PAGE_SIZE } from './completedCards'

export default function BoardColumnLane({column,cards,projectId,canWrite,busy,canDelete,canAdd,draggingColumn,onAction,onCreate,onRename,onMeaning,onAdd,onRemove}:{
  column:ProjectBoardColumn;cards:ProjectBoardCard[];projectId:string;canWrite:boolean;busy:boolean;canDelete:boolean;canAdd:boolean;
  draggingColumn:boolean;
  onAction:(card:ProjectBoardCard,mode:'edit'|'delete')=>void;onCreate?:()=>void;
  onRename:(name:string)=>Promise<void>;onMeaning:(status:string)=>Promise<void>;onAdd:()=>void;onRemove:()=>void;
}) {
  const {t}=useAppTranslation()
  const [extraCompleted,setExtraCompleted]=useState(0)
  const view=completedCardsView(cards,extraCompleted)
  const configurable=canWrite&&Boolean(column.status_key)
  const {setNodeRef:setDropRef,isOver}=useDroppable({id:column.key,disabled:!column.status_key||busy})
  const {setNodeRef:setDragRef,setActivatorNodeRef,attributes,listeners,isDragging}=useDraggable({id:`column:${column.key}`,data:{type:'column',key:column.key},disabled:!configurable||busy})
  const setRef=useCallback((node:HTMLDivElement|null)=>{setDragRef(node);if(draggingColumn)setDropRef(node)},[setDropRef,setDragRef,draggingColumn])
  const label=column.status_key?column.label:t('board_ui.unassigned')
  const overLimit=column.wip_limit!==null&&cards.length>column.wip_limit
  return <div ref={setRef} data-board-lane data-testid={`board-column-${column.key}`}
    className={['flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-3',isOver?'ring-2 ring-inset ring-primary/40':'',isDragging?'opacity-60':''].join(' ')}>
    <div className="flex shrink-0 items-start gap-1">
      {configurable&&<Button ref={setActivatorNodeRef} variant="ghost" size="icon" className="size-7 shrink-0 cursor-grab touch-none active:cursor-grabbing" disabled={busy} {...attributes} {...listeners} aria-label={t('board_ui.drag_column',{name:label})} title={t('board_ui.drag_column_help')}><GripVertical className="size-4"/></Button>}
      {configurable?<BoardColumnName column={column} disabled={busy} onRename={onRename}/>:<span className="min-w-0 flex-1 py-1 text-sm font-medium">{label}</span>}
      <span className={['py-1 text-xs',overLimit?'text-destructive':'text-muted-foreground'].join(' ')}>{cards.length}{column.wip_limit!==null?` / ${column.wip_limit}`:''}</span>
      {configurable&&<BoardColumnMenu column={column} disabled={busy} canDelete={canDelete} canAdd={canAdd} onAdd={onAdd} onDelete={onRemove}/>}
    </div>
    {column.status_key&&<div className="shrink-0"><BoardColumnMeaning column={column} disabled={busy} canWrite={canWrite} onChange={onMeaning}/></div>}
    {canWrite&&onCreate&&<Button size="sm" variant="ghost" className="shrink-0" disabled={busy} aria-label={t('board_ui.new_in',{name:label})} onClick={onCreate}>+ {t('board_ui.new_task')}</Button>}
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
      <div ref={draggingColumn?undefined:setDropRef} className="flex min-h-full flex-col gap-2">
        {view.cards.map(card=><BoardCard key={card.id} card={card} projectId={projectId} canMove={canWrite&&!busy} onAction={onAction}/>)}
      </div>
    </div>
    {(view.hiddenCount>0||view.canCollapse)&&<div className="shrink-0 space-y-1 border-t border-border pt-2">
      <p className="text-xs text-muted-foreground">{t('board_ui.completed_visible',{visible:view.visibleCompletedCount,total:view.completedCount})}</p>
      <div className="flex flex-wrap gap-1">
        {view.hiddenCount>0&&<Button size="sm" variant="ghost" onClick={()=>setExtraCompleted(count=>count+COMPLETED_CARDS_PAGE_SIZE)}>{t('board_ui.show_more',{count:Math.min(COMPLETED_CARDS_PAGE_SIZE,view.hiddenCount)})}</Button>}
        {view.canCollapse&&<Button size="sm" variant="ghost" onClick={()=>setExtraCompleted(0)}>{t('board_ui.collapse_completed')}</Button>}
      </div>
    </div>}
  </div>
}
