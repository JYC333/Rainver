import { useEffect, useState } from 'react'
import { knowledgeSourcesApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { KnowledgeSourceSummary } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import KnowledgeSectionHeader from './KnowledgeSectionHeader'
import { SafeExternalLink } from '../../components/SafeExternalLink'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

export default function SourcesPage() {
  const { activeSpaceId, userId } = useSpace()
  return <ScopedSources key={`${activeSpaceId}:${userId}`} />
}

function ScopedSources() {
  const { activeSpaceId } = useSpace()
  const [sources, setSources] = useState<KnowledgeSourceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    if (!activeSpaceId) {
      setSources([])
      setLoading(false)
      return
    }
    async function load() {
      try {
        const page = await knowledgeSourcesApi.list({ limit: 100 })
        if (active) setSources(page.items)
      } catch (e) {
        if (!active) return
        setError(errMsg(e))
        setSources([])
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [activeSpaceId])

  return (
    <div className="p-6 space-y-6">
      <KnowledgeSectionHeader
        section="sources"
        description="External materials, evidence, and references that can support Notes and Wiki items."
      />

      {loading && <Skeleton className="h-32 w-full" />}

      {!loading && error && <Card role="alert">Sources unavailable: {error}</Card>}

      {!loading && !error && sources.length === 0 && (
        <Card>
          <EmptyState
            title={activeSpaceId ? 'No sources yet' : 'Select an operational space'}
            description={
              activeSpaceId
                ? 'Sources are raw references and evidence — captured from source or attached to wiki knowledge.'
                : 'Choose a space to browse sources.'
            }
          />
        </Card>
      )}

      {!loading && sources.length > 0 && (
        <Card>
          <div className="divide-y divide-border">
            {sources.map(source => (
              <div key={source.id} className="py-4 first:pt-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                      <h2 className="font-medium text-sm">{source.title}</h2>
                      <Badge variant="secondary">{source.source_type}</Badge>
                      <Badge variant="outline">{source.status}</Badge>
                    </div>
                    {source.uri && (
                      <SafeExternalLink
                        href={source.uri}
                        className="text-sm text-muted-foreground underline-offset-2 hover:underline break-all"
                      >
                        {source.uri}
                      </SafeExternalLink>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground shrink-0">{fmt(source.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
