import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

const FILL = 'M0 32 C6 32 10 27 10 22 L10 8 Q10 0 18 0 L158 0 Q166 0 166 8 L166 22 C166 27 170 32 176 32 Z'
const STROKE = 'M0 32 C6 32 10 27 10 22 L10 8 Q10 0 18 0 L158 0 Q166 0 166 8 L166 22 C166 27 170 32 176 32'

/** Shared Notes / Files tab silhouette. Preview is conveyed only by italics. */
export function DocumentTab({ label, title = label, active, preview, fitLabel = false, closeLabel = `Close ${label}`, onSelect, onDoubleClick, onClose }: {
  label: string
  title?: string
  active: boolean
  preview?: boolean
  fitLabel?: boolean
  closeLabel?: string
  onSelect: () => void
  onDoubleClick?: () => void
  onClose: () => void
}) {
  return (
    <div className={cn('note-tab group relative flex h-8 min-w-[6.75rem] grow-0 items-center', fitLabel ? 'shrink-0' : 'max-w-[200px] shrink basis-44', active && 'note-tab--active z-10')}>
      <svg className="note-tab__bg" viewBox="0 0 176 32" preserveAspectRatio="none" aria-hidden="true">
        <path className="note-tab__fill" d={FILL} />
        <path className="note-tab__stroke" vectorEffect="non-scaling-stroke" d={STROKE} />
      </svg>
      <span className="note-tab__hover" aria-hidden="true" />
      <button type="button" role="tab" aria-selected={active} aria-label={label} title={title}
        className={fitLabel ? 'relative z-10 flex h-full items-center pl-[18px] pr-[36px]' : 'absolute inset-0 z-10'} data-preview={preview} onClick={onSelect} onDoubleClick={onDoubleClick}>
        <span style={fitLabel ? { position: 'static' } : undefined} className={cn('note-tab__label', active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground')}>
          <span className={cn(fitLabel ? 'whitespace-nowrap pr-1' : 'truncate', preview && 'italic')}>{label}</span>
        </span>
      </button>
      <button type="button" aria-label={closeLabel} title={`Close ${title}`} className="note-tab__close"
        onClick={event => { event.stopPropagation(); onClose() }}><X className="size-3" /></button>
    </div>
  )
}
