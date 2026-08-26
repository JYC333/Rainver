import { ChevronDown } from 'lucide-react'
import { graphLayoutModes } from './core/graphLayouts'
import type { GraphProjectionLayoutMode } from '@rainver/protocol'
import type { GraphRendererMode } from './types'

interface GraphToolbarProps {
  layout: GraphProjectionLayoutMode
  renderer: GraphRendererMode
  warning?: string | null
  onLayoutChange: (layout: GraphProjectionLayoutMode) => void
  onRendererChange: (renderer: GraphRendererMode) => void
}

export function GraphToolbar({
  layout,
  renderer,
  warning,
  onLayoutChange,
  onRendererChange,
}: GraphToolbarProps) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border bg-card/80 px-3 py-2 backdrop-blur">
      <ToolbarSelect
        label="Graph layout"
        value={layout}
        onChange={(value) => onLayoutChange(value as GraphProjectionLayoutMode)}
        options={graphLayoutModes().map((value) => ({ value, label: labelForLayout(value) }))}
        className="w-36"
      />
      <ToolbarSelect
        label="Graph renderer"
        value={renderer}
        onChange={(value) => onRendererChange(value as GraphRendererMode)}
        options={[
          { value: 'canvas', label: 'Canvas' },
          { value: 'webgl', label: 'WebGL' },
        ]}
        className="w-28"
      />
      {warning && <div className="ml-auto truncate text-xs text-amber-600 dark:text-amber-300">{warning}</div>}
    </div>
  )
}

function ToolbarSelect({
  label,
  value,
  options,
  className,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  className?: string
  onChange: (value: string) => void
}) {
  return (
    <label className={`relative block ${className ?? ''}`}>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-full appearance-none rounded-md border border-border bg-input px-3 pr-8 text-sm text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </label>
  )
}

function labelForLayout(layout: GraphProjectionLayoutMode): string {
  switch (layout) {
    case 'force':
      return 'Force'
    case 'circular':
      return 'Circular'
    case 'radial':
      return 'Radial'
    case 'concentric':
      return 'Concentric'
    case 'clustered':
      return 'Clustered'
    case 'preset':
      return 'Preset'
    default:
      return layout
  }
}
