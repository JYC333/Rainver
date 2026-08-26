import { X } from 'lucide-react'
import type { GraphProjectionNode } from '@rainver/protocol'
import { Button } from '../ui/button'

interface GraphDetailPanelProps {
  node: GraphProjectionNode
  onClose: () => void
  children?: React.ReactNode
}

export function GraphDetailPanel({ node, onClose, children }: GraphDetailPanelProps) {
  return (
    <aside className="w-72 shrink-0 border-l border-border bg-card/90">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{node.label}</div>
          <div className="truncate text-xs text-muted-foreground">{node.kind}</div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={onClose} title="Close" aria-label="Close">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-3 p-4 text-sm">
        {node.subtitle && <div className="text-muted-foreground">{node.subtitle}</div>}
        {children ?? (
          <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-xs">
            <dt className="text-muted-foreground">ID</dt>
            <dd className="min-w-0 truncate text-foreground">{node.id}</dd>
            {typeof node.degree === 'number' && (
              <>
                <dt className="text-muted-foreground">Degree</dt>
                <dd className="text-foreground">{node.degree}</dd>
              </>
            )}
            {typeof node.score === 'number' && (
              <>
                <dt className="text-muted-foreground">Score</dt>
                <dd className="text-foreground">{node.score.toFixed(2)}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </aside>
  )
}
