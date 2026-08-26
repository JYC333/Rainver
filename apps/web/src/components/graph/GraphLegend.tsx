import type { GraphProjection } from '@rainver/protocol'
import { resolveEdgeStyle, resolveNodeStyle } from './core/graphTheme'
import type { GraphTheme, GraphViewState } from './types'
import { cn } from '../../lib/utils'

interface GraphLegendProps {
  projection: GraphProjection
  theme: GraphTheme
  viewState: GraphViewState
  onToggleKind: (kind: string) => void
  onToggleEdgeKind: (kind: string, active: boolean) => void
}

export function GraphLegend({
  projection,
  theme,
  viewState,
  onToggleKind,
  onToggleEdgeKind,
}: GraphLegendProps) {
  const nodeKinds = uniqueSorted(projection.nodes.map((node) => node.kind))
  const edgeKinds = uniqueSorted(projection.edges.map((edge) => edge.kind))
  const activeEdgeKinds = new Set(viewState.activeEdgeKinds)

  return (
    <div className="flex max-h-full w-48 flex-col gap-3 overflow-auto border-l border-border bg-background/90 p-3 text-xs">
      <div className="space-y-1">
        <div className="text-[11px] font-medium uppercase text-muted-foreground">Nodes</div>
        {nodeKinds.map((kind) => {
          const sample = projection.nodes.find((node) => node.kind === kind)
          const style = sample ? resolveNodeStyle(sample, theme) : theme.fallbackNode
          const hidden = viewState.hiddenKinds.includes(kind)
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onToggleKind(kind)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent',
                hidden && 'opacity-40',
              )}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: style.color }} />
              <span className="min-w-0 flex-1 truncate text-foreground">{kind}</span>
            </button>
          )
        })}
      </div>
      {edgeKinds.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">Edges</div>
          {edgeKinds.map((kind) => {
            const sample = projection.edges.find((edge) => edge.kind === kind)
            const style = sample ? resolveEdgeStyle(sample, theme) : theme.fallbackEdge
            const active = activeEdgeKinds.size === 0 || activeEdgeKinds.has(kind)
            return (
              <button
                key={kind}
                type="button"
                onClick={() => onToggleEdgeKind(kind, !active)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent',
                  !active && 'opacity-40',
                )}
              >
                <span className="h-px w-4 shrink-0" style={{ backgroundColor: style.color }} />
                <span className="min-w-0 flex-1 truncate text-foreground">{kind}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}
