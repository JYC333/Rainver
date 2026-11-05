import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useAppTranslation } from '../../../i18n'
import { Button } from '../../../components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../../components/ui/dropdown-menu'
import { useDraggable } from '@dnd-kit/core'
import { Bot, CircleDot, User, GripVertical } from 'lucide-react'
import { SpaceLink as Link } from '../../../core/spaceNav'
import type { ProjectBoardCard } from '../../../types/api'
import { projectTaskHref } from '../taskHref'

/**
 * One card: what a person needs to decide whether to open it, and nothing else.
 *
 * Title, who holds it, whether something is running,
 * and a red edge when it is held up. Run logs, evaluation detail and the whole
 * completion breakdown live one click away in the Work tab — a card that tries
 * to show them stops being scannable, which is the only job it has.
 */
/**
 * Memoised against the Board's poll. `mergeBoard` keeps an unchanged card as
 * the same object, so the default shallow compare is exactly right: a card
 * re-renders when it actually changed and not when its neighbour did.
 */
const BoardCard = memo(function BoardCard({ card, projectId, canMove, onAction }: {
  card: ProjectBoardCard
  projectId: string
  /** Whether the viewer may move it. A viewer sees the card and drags nothing. */
  canMove: boolean
  onAction: (card: ProjectBoardCard, mode: 'edit' | 'delete') => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    disabled: !canMove,
  })
  const { t } = useAppTranslation()
  const [menuOpen,setMenuOpen]=useState(false)
  const [contextPoint,setContextPoint]=useState<{x:number;y:number}|null>(null)
  const handleRef=useRef<HTMLButtonElement|null>(null)
  const setHandleRef=useCallback((node:HTMLButtonElement|null)=>{handleRef.current=node;setActivatorNodeRef(node)},[setActivatorNodeRef])
  const dragged=useRef(false)
  useEffect(()=>{if(isDragging){dragged.current=true;setMenuOpen(false);setContextPoint(null)}},[isDragging])
  const blocked = card.status === 'blocked'
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined

  const actions=<>
    <DropdownMenuItem asChild><Link to={projectTaskHref(projectId,card.id)}>{t('board_ui.open')}</Link></DropdownMenuItem>
    {canMove&&<><DropdownMenuItem onSelect={()=>onAction(card,'edit')}>{t('board_ui.edit')}</DropdownMenuItem><DropdownMenuItem className="text-destructive" onSelect={()=>onAction(card,'delete')}>{t('board_ui.delete')}</DropdownMenuItem></>}
  </>
  const preventRightRelease:React.PointerEventHandler<HTMLDivElement>=event=>{
    // Opening beneath the cursor must not select an item on right mouse-up.
    if(event.button!==0){event.preventDefault();event.stopPropagation()}
  }
  return (
    <>
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
    <div
      ref={setNodeRef}
      style={style}
      onPointerDown={event=>{
        if(event.button!==0||!canMove)return
        dragged.current=false
        setContextPoint(null)
        listeners?.onPointerDown?.(event)
      }}
      onContextMenu={event=>{
        event.preventDefault();event.stopPropagation()
        if(isDragging)return
        setMenuOpen(false)
        setContextPoint({x:event.clientX,y:event.clientY})
      }}
      className={[
        'rounded-lg border bg-card p-3 text-left shadow-sm transition-shadow',
        canMove?'cursor-grab select-none active:cursor-grabbing':'',
        isDragging ? 'opacity-60 shadow-md' : 'hover:shadow',
        blocked ? 'border-destructive/60' : 'border-border',
      ].join(' ')}
      data-testid={`board-card-${card.id}`}
    >
      <div className="flex items-start gap-1.5">
        <DropdownMenuTrigger asChild>
          <Button
            ref={setHandleRef} type="button" size="icon" variant="ghost"
            className="size-6 shrink-0 touch-none cursor-grab active:cursor-grabbing"
            aria-label={t('board_ui.actions',{title:card.title})}
            title={t('board_ui.drag_help')}
            data-testid={`board-card-handle-${card.id}`}
            {...attributes}
            onPointerDown={event=>{event.stopPropagation();dragged.current=false;setContextPoint(null);if(canMove)listeners?.onPointerDown?.(event);event.preventDefault()}}
            onKeyDown={event=>{
              // The document-level KeyboardSensor owns every key until drop
              // or cancellation. Suppress Radix's earlier trigger handler,
              // including Space/Enter on a drop that keeps this card mounted.
              if(isDragging){event.preventDefault();return}
              if(event.key==='Enter'){event.preventDefault();setContextPoint(null);setMenuOpen(true)}
              else if(canMove)listeners?.onKeyDown?.(event)
            }}
            onClick={()=>{if(!dragged.current){setContextPoint(null);setMenuOpen(open=>!open)}}}
          ><GripVertical className="size-4" /></Button>
        </DropdownMenuTrigger>
        <Link
          draggable={false}
          to={projectTaskHref(projectId, card.id)}
          className="block min-w-0 flex-1 text-sm font-medium leading-snug hover:underline"
        >
          {card.title}
        </Link>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">

        {card.responsible.kind === 'agent' && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Bot className="size-3" />
            {card.responsible.display_name ?? 'Agent'}
          </span>
        )}
        {card.responsible.kind === 'user' && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <User className="size-3" />
            {card.responsible.display_name ?? 'Someone'}
          </span>
        )}
        {card.active_run_count > 0 && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            title={`${card.active_run_count} active run${card.active_run_count === 1 ? '' : 's'}`}
          >
            <CircleDot className="size-3 animate-pulse" />
            {card.active_run_count}
          </span>
        )}
      </div>

      {blocked && card.blocked_reason && (
        <p className="mt-2 text-[11px] text-destructive">{card.blocked_reason}</p>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">
        Updated {new Date(card.updated_at).toLocaleString()}
      </p>
    </div>
    <DropdownMenuContent align="start" onPointerUpCapture={preventRightRelease}>{actions}</DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu open={contextPoint!==null} onOpenChange={open=>{if(!open)setContextPoint(null)}}>
      {/* Radix's measurable point trigger reuses its positioning, viewport
          collision handling and menu keyboard behaviour. It is not a control. */}
      {contextPoint&&<DropdownMenuTrigger asChild><span aria-hidden tabIndex={-1} style={{position:'fixed',left:contextPoint.x,top:contextPoint.y,width:0,height:0,pointerEvents:'none'}}/></DropdownMenuTrigger>}
      <DropdownMenuContent align="start" sideOffset={0} collisionPadding={8} onPointerUpCapture={preventRightRelease}
        onCloseAutoFocus={event=>{event.preventDefault();handleRef.current?.focus()}}>{actions}</DropdownMenuContent>
    </DropdownMenu>
    </>

  )
})

export default BoardCard
