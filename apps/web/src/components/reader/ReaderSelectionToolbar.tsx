import { useEffect, type CSSProperties } from 'react'
import { Bookmark, Copy, Highlighter, MessageSquare, Quote } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import type { SelectionRect } from '../../components/editor/ReadOnlyTiptapReader'
import { useReaderShortcuts } from './readerShortcuts'
import type { ReaderAnnotationType } from './readerModel'

interface ReaderSelectionToolbarProps {
  selectionRect: SelectionRect | null
  pending: boolean
  onAction: (type: ReaderAnnotationType) => void
  /** True while a pointer is pressed on the toolbar, so a collapsing browser selection is not taken as "cleared". */
  onPressChange?: (pressed: boolean) => void
  /** Copies the selected text as shown (no annotation is made). */
  onCopy?: () => void
}

const ACTIONS: { type: ReaderAnnotationType; label: string; Icon: typeof Highlighter }[] = [
  { type: 'highlight', label: 'reading.actionHighlight', Icon: Highlighter },
  { type: 'comment', label: 'reading.actionComment', Icon: MessageSquare },
  { type: 'excerpt', label: 'reading.actionExcerpt', Icon: Quote },
  { type: 'bookmark', label: 'reading.actionBookmark', Icon: Bookmark },
]

const TOOLBAR_WIDTH = 204
/** On a coarse pointer each of the five buttons is 44px (index.css). */
const TOUCH_TOOLBAR_WIDTH = 5 * 44 + 16
const TOOLBAR_HEIGHT = 40
const EDGE_GAP = 8

function hasUsableRect(rect: SelectionRect | null): rect is SelectionRect {
  return rect != null && (rect.width > 0 || rect.height > 0)
}

/** The visible part of the page: the visual viewport when the browser has one (zoom, soft keyboard). */
function visibleBounds() {
  const viewport = window.visualViewport
  return viewport
    ? { top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height }
    : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight }
}

/**
 * Beside the selection without covering it, clamped to the visible viewport.
 * Touch browsers draw their own copy menu above a selection, so on a coarse
 * pointer the toolbar prefers the space below. Null means no position keeps
 * the selection uncovered; the toolbar then docks instead.
 */
export function floatingToolbarStyle(rect: SelectionRect, bounds = visibleBounds(), preferBelow = window.matchMedia?.('(pointer: coarse)').matches === true): CSSProperties | null {
  const minTop = bounds.top + EDGE_GAP
  const maxTop = bounds.top + bounds.height - TOOLBAR_HEIGHT - EDGE_GAP
  const above = rect.top - TOOLBAR_HEIGHT - EDGE_GAP
  const below = rect.bottom + EDGE_GAP
  const fitsAbove = above >= minTop
  const fitsBelow = below <= maxTop
  const top = preferBelow ? (fitsBelow ? below : fitsAbove ? above : null) : (fitsAbove ? above : fitsBelow ? below : null)
  if (top === null) return null
  const width = preferBelow ? TOUCH_TOOLBAR_WIDTH : TOOLBAR_WIDTH
  const center = rect.left + rect.width / 2
  const minLeft = bounds.left + EDGE_GAP
  const maxLeft = Math.max(minLeft, bounds.left + bounds.width - width - EDGE_GAP)
  const left = Math.min(Math.max(center - width / 2, minLeft), maxLeft)
  return { top, left }
}

export function ReaderSelectionToolbar({
  selectionRect,
  pending,
  onAction,
  onPressChange,
  onCopy,
}: ReaderSelectionToolbarProps) {
  const { t } = useAppTranslation()
  const { keys } = useReaderShortcuts()
  const style = hasUsableRect(selectionRect) ? floatingToolbarStyle(selectionRect) : null
  useEffect(() => {
    if (!onPressChange) return
    // Release after the click that follows the press has run.
    const release = () => window.setTimeout(() => onPressChange(false), 0)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      onPressChange(false)
    }
  }, [onPressChange])
  return (
    <div
      role="toolbar"
      aria-label={t('reading.annotateSelection')}
      className={cn(
        'reader-selection-toolbar',
        style ? 'reader-selection-toolbar-floating' : 'reader-selection-toolbar-docked',
      )}
      style={style ?? undefined}
      // Keep the browser selection alive while clicking toolbar buttons.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={() => onPressChange?.(true)}
    >
      {ACTIONS.map(({ type, label, Icon }) => (
        <Button
          key={type}
          variant="ghost"
          size="icon"
          className="size-9"
          disabled={pending}
          aria-label={t(label)}
          title={type === 'highlight' || type === 'comment' ? `${t(label)} (${keys[type]})` : t(label)}
          onClick={() => onAction(type)}
        >
          <Icon className="size-4" />
        </Button>
      ))}
      {onCopy && <Button variant="ghost" size="icon" className="size-9" aria-label={t('reading.copyQuote')} title={t('reading.copyQuote')} onClick={onCopy}>
        <Copy className="size-4" />
      </Button>}
    </div>
  )
}
