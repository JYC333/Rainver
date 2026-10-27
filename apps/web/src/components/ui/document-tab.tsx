import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

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
      <span className="note-tab__bg" aria-hidden="true">
        {/* Only the straight middle stretches; the curved ends stay 18px wide. */}
        <svg className="absolute inset-y-0 left-0 h-full" width="18" viewBox="0 0 18 32" preserveAspectRatio="none">
          <path className="note-tab__fill" d="M0 32 C6 32 10 27 10 22 L10 8 Q10 0 18 0 L18 32 Z" />
          <path className="note-tab__stroke" d="M0 32 C6 32 10 27 10 22 L10 8 Q10 0 18 0" />
        </svg>
        <svg className="absolute inset-y-0 h-full" style={{ left: 18, width: 'calc(100% - 36px)' }} viewBox="0 0 140 32" preserveAspectRatio="none">
          <path className="note-tab__fill" d="M0 32 V0 H140 V32 Z" />
          <path className="note-tab__stroke" vectorEffect="non-scaling-stroke" d="M0 0 H140" />
        </svg>
        <svg className="absolute inset-y-0 right-0 h-full" width="18" viewBox="0 0 18 32" preserveAspectRatio="none">
          <path className="note-tab__fill" d="M0 0 Q8 0 8 8 L8 22 C8 27 12 32 18 32 H0 Z" />
          <path className="note-tab__stroke" d="M0 0 Q8 0 8 8 L8 22 C8 27 12 32 18 32" />
        </svg>
      </span>
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
