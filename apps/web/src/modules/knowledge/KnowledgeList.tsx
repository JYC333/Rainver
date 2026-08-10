import { SpaceLink as Link } from '../../core/spaceNav'
import type { KnowledgeItemSummary } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { ScopeBadge } from '../../components/ScopeBadge'
import { fmt, KNOWLEDGE_ITEM_KINDS, KNOWLEDGE_STATUSES, KNOWLEDGE_VISIBILITIES } from './utils'
import type { RetrievalSearchResult } from '../../types/api'

export interface KnowledgeFilters {
  knowledgeKind: string
  status: string
  visibility: string
  q: string
}

interface KnowledgeListProps {
  items: KnowledgeItemSummary[]
  total: number
  loading: boolean
  hasOperationalSpace: boolean
  filters: KnowledgeFilters
  onFiltersChange: (filters: KnowledgeFilters) => void
  onSearch: () => void
  onReset: () => void
  onItemOpen?: (item: KnowledgeItemSummary) => void
  searchResults?: RetrievalSearchResult[] | null
  onSearchResultOpen?: (result: RetrievalSearchResult) => void
}

export default function KnowledgeList({
  items,
  total,
  loading,
  hasOperationalSpace,
  filters,
  onFiltersChange,
  onSearch,
  onReset,
  onItemOpen,
  searchResults = null,
  onSearchResultOpen,
}: KnowledgeListProps) {
  const filtersActive = filters.knowledgeKind !== '' || filters.status !== 'active' || filters.visibility !== '' || filters.q.trim() !== ''
  const showingSearch = searchResults !== null
  const displayedCount = showingSearch ? searchResults.length : items.length
  const displayedTotal = showingSearch ? searchResults.length : total

  return (
    <Card>
      <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <CardTitle>{showingSearch ? 'Search Results' : 'Items'}</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">Showing {displayedCount} of {displayedTotal} total.</p>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="min-w-[140px]">
            <Label className="text-xs">knowledge_kind</Label>
            <Select
              value={filters.knowledgeKind}
              onChange={knowledgeKind => onFiltersChange({ ...filters, knowledgeKind })}
              options={[{ value: '', label: 'any' }, ...KNOWLEDGE_ITEM_KINDS.map(t => ({ value: t, label: t }))]}
            />
          </div>
          <div className="min-w-[130px]">
            <Label className="text-xs">status</Label>
            <Select
              value={filters.status}
              onChange={status => onFiltersChange({ ...filters, status })}
              options={[{ value: '', label: 'any' }, ...KNOWLEDGE_STATUSES.map(s => ({ value: s, label: s }))]}
            />
          </div>
          <div className="min-w-[150px]">
            <Label className="text-xs">visibility</Label>
            <Select
              value={filters.visibility}
              onChange={visibility => onFiltersChange({ ...filters, visibility })}
              options={[{ value: '', label: 'any' }, ...KNOWLEDGE_VISIBILITIES.map(v => ({ value: v, label: v }))]}
            />
          </div>
          <form className="flex gap-1.5 items-end" onSubmit={e => { e.preventDefault(); onSearch() }}>
            <div className="min-w-[220px]">
              <Label className="text-xs">q</Label>
              <Input
                value={filters.q}
                onChange={e => onFiltersChange({ ...filters, q: e.target.value })}
                placeholder="Search title or content..."
              />
            </div>
            <Button type="submit" size="sm">Search</Button>
            <Button type="button" size="sm" variant="outline" onClick={onReset}>Reset</Button>
          </form>
        </div>
      </div>

      {loading && <Skeleton className="h-32 w-full" />}
      {!loading && displayedCount === 0 && (
        <p className="text-muted-foreground text-center py-10 text-sm">
          {!hasOperationalSpace
            ? 'Select an operational space to browse knowledge.'
            : showingSearch
              ? 'No knowledge items matched this search.'
              : filtersActive
              ? 'No knowledge items match these filters.'
              : 'No active knowledge items yet.'}
        </p>
      )}
      {!loading && showingSearch && searchResults.length > 0 && (
        <div className="divide-y divide-border">
          {searchResults.map(result => (
            <Link
              key={`${result.object_type}:${result.object_id}`}
              to={`/knowledge/wiki/${result.object_id}`}
              onClick={() => onSearchResultOpen?.(result)}
              className="block py-4 first:pt-2 hover:bg-accent/30 -mx-2 px-2 rounded-md"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-1">
                    <h2 className="font-medium text-sm">{result.title}</h2>
                    {result.object_profile_label && <Badge variant="secondary">{result.object_profile_label}</Badge>}
                    <Badge variant="secondary">{result.evidence.kind}</Badge>
                    <Badge variant="outline">{result.score.toFixed(4)}</Badge>
                  </div>
                  {result.snippet && <p className="text-sm text-muted-foreground line-clamp-2">{result.snippet}</p>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                {result.matched_fields.map(field => <Badge key={field} variant="muted">{field}</Badge>)}
              </div>
            </Link>
          ))}
        </div>
      )}
      {!loading && !showingSearch && items.length > 0 && (
        <div className="divide-y divide-border">
          {items.map(item => (
            <Link
              key={item.id}
              to={`/knowledge/wiki/${item.id}`}
              onClick={() => onItemOpen?.(item)}
              className="block py-4 first:pt-2 hover:bg-accent/30 -mx-2 px-2 rounded-md"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-1">
                    <h2 className="font-medium text-sm">{item.title}</h2>
                    <Badge variant="secondary">{item.knowledge_kind}</Badge>
                    <Badge variant="outline">{item.status}</Badge>
                    <ScopeBadge visibility={item.visibility} />
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2">{item.content_preview}</p>
                </div>
                <p className="text-xs text-muted-foreground shrink-0">{fmt(item.updated_at)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                <Badge variant="muted">{item.verification_status}</Badge>
                <Badge variant="muted">{item.reflection_status}</Badge>
                {item.tags.map(tag => <Badge key={tag} variant="outline">{tag}</Badge>)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  )
}
