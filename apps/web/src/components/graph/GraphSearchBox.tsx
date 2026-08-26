import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { GraphProjection, GraphProjectionNode } from '@rainver/protocol'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

interface GraphSearchBoxProps {
  projection: GraphProjection
  onFocusNode: (node: GraphProjectionNode) => void
}

export function GraphSearchBox({ projection, onFocusNode }: GraphSearchBoxProps) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return projection.nodes
      .filter((node) =>
        node.label.toLowerCase().includes(normalized) ||
        node.kind.toLowerCase().includes(normalized) ||
        node.id.toLowerCase().includes(normalized),
      )
      .slice(0, 6)
  }, [projection.nodes, query])

  function submit() {
    const first = matches[0]
    if (first) onFocusNode(first)
  }

  return (
    <div className="relative flex w-full max-w-72 items-center gap-1">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
        placeholder="Search nodes"
        className="h-8 pr-8"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute right-1 h-6 w-6 px-0"
        onClick={submit}
        title="Focus node"
        aria-label="Focus node"
      >
        <Search className="size-3.5" />
      </Button>
      {matches.length > 0 && (
        <div className="absolute left-0 top-9 z-30 w-full overflow-hidden rounded-md border border-border bg-card shadow-md">
          {matches.map((node) => (
            <button
              key={node.id}
              type="button"
              className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => {
                onFocusNode(node)
                setQuery(node.label)
              }}
            >
              <span className="truncate text-foreground">{node.label}</span>
              <span className="truncate text-xs text-muted-foreground">{node.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
