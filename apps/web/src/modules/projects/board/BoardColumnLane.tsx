import { useCallback } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { GripVertical } from 'lucide-react'
import type { ProjectBoardColumn, ProjectBoardCard } from '../../../types/api'
import { useAppTranslation } from '../../../i18n'
import { Button } from '../../../components/ui/button'
import BoardCard from './BoardCard'
import { BoardColumnMenu, BoardColumnName, BoardColumnMeaning } from './BoardColumnControls'

export default function BoardColumnLane({column,cards,projectId,canWrite,busy,canDelete,canAdd,onAction,onCreate,onRename,onMeaning,onAdd,onRemove}:{
  column:ProjectBoardColumn;cards:ProjectBoardCard[];projectId:string;canWrite:boolean;busy:boolean;canDelete:boolean;canAdd:boolean;
  onAction:(card:ProjectBoardCard,mode:'edit'|'delete')=>void;onCreate?:()=>void;
  onRename:(name:string)=>Promise<void>;onMeaning:(status:string)=>Promise<void>;onAdd:()=>void;onRemove:()=>void;
}) {
  const {t}=useAppTranslation()
  const configurable=canWrite&&Boolean(column.status_key)
  const {setNodeRef:setDropRef,isOver}=useDroppable({id:column.key,disabled:!column.status_key||busy})
  const {setNodeRef:setDragRef,setActivatorNodeRef,attributes,listeners,transform,isDragging}=useDraggable({id:`column:${column.key}`,data:{type:'column',key:column.key},disabled:!configurable||busy})
  const setRef=useCallback((node:HTMLDivElement|null)=>{setDropRef(node);setDragRef(node)},[setDropRef,setDragRef])
  const label=column.status_key?column.label:t('board_ui.unassigned')
  const overLimit=column.wip_limit!==null&&cards.length>column.wip_limit
  return <div ref={setRef} data-testid={`board-column-${column.key}`} style={transform?{transform:`translate3d(${transform.x}px, ${transform.y}px, 0)`}:undefined}
    className={['flex min-h-[12rem] flex-col gap-2 rounded-xl border border-border bg-card p-3',isOver?'ring-2 ring-primary/40':'',isDragging?'z-10 opacity-70 shadow-lg':''].join(' ')}>
    <div className="flex items-start gap-1">
      {configurable&&<Button ref={setActivatorNodeRef} variant="ghost" size="icon" className="size-7 shrink-0 cursor-grab touch-none active:cursor-grabbing" disabled={busy} {...attributes} {...listeners} aria-label={t('board_ui.drag_column',{name:label})} title={t('board_ui.drag_column_help')}><GripVertical className="size-4"/></Button>}
      {configurable?<BoardColumnName column={column} disabled={busy} onRename={onRename}/>:<span className="min-w-0 flex-1 py-1 text-sm font-medium">{label}</span>}
      <span className={['py-1 text-xs',overLimit?'text-destructive':'text-muted-foreground'].join(' ')}>{cards.length}{column.wip_limit!==null?` / ${column.wip_limit}`:''}</span>
      {configurable&&<BoardColumnMenu column={column} disabled={busy} canDelete={canDelete} canAdd={canAdd} onAdd={onAdd} onDelete={onRemove}/>}
    </div>
    {column.status_key&&<BoardColumnMeaning column={column} disabled={busy} canWrite={canWrite} onChange={onMeaning}/>}
    {canWrite&&onCreate&&<Button size="sm" variant="ghost" disabled={busy} aria-label={t('board_ui.new_in',{name:label})} onClick={onCreate}>+ {t('board_ui.new_task')}</Button>}
    <div className="flex flex-col gap-2">{cards.map(card=><BoardCard key={card.id} card={card} projectId={projectId} canMove={canWrite&&!busy} onAction={onAction}/>)}</div>
  </div>
}
