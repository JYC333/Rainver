import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowLeft, Archive, Database } from 'lucide-react'
import { toast } from 'sonner'
import { memoryApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { Memory } from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { ScopeBadge } from '../../components/ScopeBadge'
import { ContentAccessControl } from '../../components/ContentAccessControl'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '-'
}

function val(value: string | number | null | undefined) {
  return value === null || value === undefined || value === '' ? '-' : String(value)
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm break-words">{value}</div>
    </div>
  )
}

export default function MemoryDetailPage() {
  const { memoryId = '' } = useParams()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [memory, setMemory] = useState<Memory | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!memoryId) return
    if (!activeSpaceId) {
      setMemory(null)
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const row = await memoryApi.get(memoryId)
        if (!cancelled) setMemory(row)
      } catch (e) {
        if (!cancelled) {
          toast.error(errMsg(e))
          setMemory(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [memoryId, activeSpaceId])

  async function proposeArchive() {
    if (!memory) return
    setBusy(true)
    try {
      const proposal = await memoryApi.delete(memory.id)
      toast.success('Archive proposal submitted')
      setMemory(await memoryApi.get(memory.id))
      if (proposal?.id) {
        toast.message('Review the archive proposal from Proposals.')
      }
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/memory"><ArrowLeft className="size-4 mr-1" />Memory</Link>
      </Button>

      {loading && <Skeleton className="h-48 w-full" />}

      {!loading && !memory && (
        <Card>
          <EmptyState
            title={activeSpaceId ? 'Memory not found or not accessible' : 'Select an operational space'}
            description={activeSpaceId ? 'The memory does not exist in this space, or your viewer cannot read it.' : 'Choose a space to inspect this memory.'}
          />
        </Card>
      )}

      {!loading && memory && (
        <>
          <div className="flex flex-col gap-4 pb-4 border-b border-border lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-center gap-4 min-w-0">
              <div
                className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
                  border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
                }}
              >
                <Database className="size-5 text-accent-foreground" />
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-semibold tracking-tight truncate">{memory.title || 'Untitled memory'}</h1>
                <p className="text-sm text-muted-foreground">Approved long-term context record.</p>
                <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <ContentAccessControl resourceType="memory" resourceId={memory.id} ownerUserId={memory.owner_user_id} />
              <Button size="sm" variant="destructive" disabled={busy || memory.status !== 'active'} onClick={proposeArchive}>
                <Archive className="size-3.5" /> Archive proposal
              </Button>
            </div>
          </div>

          <Card className="space-y-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{memory.type}</Badge>
              <Badge variant="outline">{memory.status}</Badge>
              <Badge variant="outline">{memory.scope}</Badge>
              <ScopeBadge visibility={memory.visibility} />
              {memory.sensitivity_level && <Badge variant="outline">{memory.sensitivity_level}</Badge>}
              {memory.source_trust && <Badge variant="muted">{memory.source_trust}</Badge>}
            </div>
            <div className="rounded-md border border-border bg-background p-4">
              {memory.content === null ? (
                <p className="text-sm text-muted-foreground">Content redacted for this viewer.</p>
              ) : (
                <p className="text-sm whitespace-pre-wrap">{memory.content}</p>
              )}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardTitle>Scope</CardTitle>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Namespace" value={<code className="text-xs">{val(memory.namespace)}</code>} />
                <Field label="Access level" value={memory.access_level} />
              </div>
              <details className="mt-4 rounded-md border border-border bg-muted/20 p-3 text-xs">
                <summary className="cursor-pointer font-medium">Technical identifiers</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="Memory ID" value={<code className="text-xs">{memory.id}</code>} />
                  <Field label="Space ID" value={<code className="text-xs">{memory.space_id}</code>} />
                  <Field label="Project ID" value={<code className="text-xs">{val(memory.project_id)}</code>} />
                  <Field label="Owner user" value={<code className="text-xs">{val(memory.owner_user_id)}</code>} />
                  <Field label="Subject user" value={<code className="text-xs">{val(memory.subject_user_id)}</code>} />
                </div>
              </details>
            </Card>

            <Card>
              <CardTitle>Quality</CardTitle>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Importance" value={memory.importance.toFixed(2)} />
                <Field label="Confidence" value={memory.confidence.toFixed(2)} />
                <Field label="Version" value={memory.version} />
                <Field label="Layer" value={val(memory.memory_layer)} />
                <Field label="Type" value={val(memory.type)} />
                <Field label="Tags" value={(memory.tags ?? []).length ? memory.tags?.join(', ') : '-'} />
                <Field label="Last confirmed" value={fmt(memory.last_confirmed_at)} />
                <Field label="Last accessed" value={fmt(memory.last_accessed_at)} />
              </div>
            </Card>

            <Card>
              <CardTitle>Provenance</CardTitle>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Created by" value={val(memory.created_by)} />
                <Field label="Approved by" value={val(memory.approved_by)} />
                <Field
                  label="Created from proposal"
                  value={memory.created_from_proposal_id ? (
                    <Link to={`/proposals/${memory.created_from_proposal_id}`} className="text-accent-foreground hover:underline">
                      {memory.created_from_proposal_id}
                    </Link>
                  ) : '-'}
                />
              </div>
            </Card>

            <Card>
              <CardTitle>Lifecycle</CardTitle>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Created" value={fmt(memory.created_at)} />
                <Field label="Updated" value={fmt(memory.updated_at)} />
                <Field label="Deleted" value={fmt(memory.deleted_at)} />
                <Field label="Root memory" value={<code className="text-xs">{val(memory.root_memory_id)}</code>} />
                <Field label="Supersedes" value={<code className="text-xs">{val(memory.supersedes_memory_id)}</code>} />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
