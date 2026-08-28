import { useDraggable } from '@dnd-kit/core'
import { Bot, CircleDot, User, GripVertical } from 'lucide-react'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { Badge } from '../../../components/ui/badge'
import type { ProjectBoardCard } from '../../../types/api'
import { projectTaskHref } from '../taskHref'

/**
 * One card: what a person needs to decide whether to open it, and nothing else.
 *
 * Title, where it is in its Loop, who holds it, whether something is running,
 * and a red edge when it is held up. Run logs, evaluation detail and the whole
 * completion breakdown live one click away in the Work tab — a card that tries
 * to show them stops being scannable, which is the only job it has.
 */
export default function BoardCard({ card, projectId, canMove }: {
  card: ProjectBoardCard
  projectId: string
  /** Whether the viewer may move it. A viewer sees the card and drags nothing. */
  canMove: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    disabled: !canMove,
  })
  const blocked = card.status === 'blocked'
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        'rounded-lg border bg-card p-3 text-left shadow-sm transition-shadow',
        isDragging ? 'opacity-60 shadow-md' : 'hover:shadow',
        blocked ? 'border-destructive/60' : 'border-border',
      ].join(' ')}
      data-testid={`board-card-${card.id}`}
    >
      <div className="flex items-start gap-1.5">
        {/* The drag handle is its own control, so the card is not a focusable
            "button" with a link nested inside it, and a keyboard has a target:
            focus it, Space to pick up, arrows to change lane, Space to drop. */}
        {canMove && (
          <button
            type="button"
            className="mt-0.5 shrink-0 cursor-grab rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Move ${card.title}`}
            data-testid={`board-card-handle-${card.id}`}
            {...listeners}
            {...attributes}
          >
            <GripVertical className="size-4" />
          </button>
        )}
        <Link
          to={projectTaskHref(projectId, card.id)}
          className="block min-w-0 flex-1 text-sm font-medium leading-snug hover:underline"
        >
          {card.title}
        </Link>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {card.loop_stage_label && (
          <Badge variant="outline" className="text-[11px]">{card.loop_stage_label}</Badge>
        )}
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
  )
}
