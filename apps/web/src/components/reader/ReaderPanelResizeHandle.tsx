import { useRef } from 'react'

interface Props {
  label: string
  width: number
  min: number
  max: number
  /** The right-hand panel grows when the handle moves left. */
  side: 'left' | 'right'
  onChange: (width: number) => void
}

/** One native pointer/keyboard separator, shared by the two Reader panels. */
export function ReaderPanelResizeHandle({ label, width, min, max, side, onChange }: Props) {
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null)
  const direction = side === 'right' ? -1 : 1
  const change = (value: number) => onChange(Math.round(Math.max(min, Math.min(max, value))))
  return <div role="separator" aria-label={label} aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} tabIndex={0}
    className="reader-panel-resize"
    onKeyDown={event => {
      if (event.key === 'Home') change(min)
      else if (event.key === 'End') change(max)
      else if (event.key === 'ArrowLeft') change(width - 16 * direction)
      else if (event.key === 'ArrowRight') change(width + 16 * direction)
      else return
      event.preventDefault(); event.stopPropagation()
    }}
    onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointer: event.pointerId, x: event.clientX, width }
    }}
    onPointerMove={event => {
      const start = drag.current
      if (start?.pointer === event.pointerId) change(start.width + (event.clientX - start.x) * direction)
    }}
    onPointerUp={event => {
      if (drag.current?.pointer !== event.pointerId) return
      drag.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={() => { drag.current = null }}
    onLostPointerCapture={() => { drag.current = null }} />
}
