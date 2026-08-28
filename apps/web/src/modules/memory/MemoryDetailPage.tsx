import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowLeft, Archive, Database } from 'lucide-react'
import { toast } from 'sonner'
import { memoryApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAuth } from '../../contexts/AuthContext'
import { errMsg } from '../../lib/utils'
import type { Memory, MemoryVersion } from '../../types/api'
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
  const { currentUser } = useAuth()
  const [memory, setMemory] = useState<Memory | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [versions, setVersions] = useState<MemoryVersion[]>([])

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
        const [row, chain] = await Promise.all([
          memoryApi.get(memoryId),
          // Best effort: the entry is readable without its history, and a
          // failure here should not blank the page.
          memoryApi.versions(memoryId).catch(() => ({ items: [] as MemoryVersion[] })),
        ])
        if (!cancelled) {
          setMemory(row)
          setVersions(chain.items)
        }
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

  // Your own memory archives on the spot; someone else's goes through a
  // proposal (ADR 0003 §3). The server decides which and says so by what it
  // returns.
  async function archive() {
    if (!memory) return
    setBusy(true)
    try {
      const result = await memoryApi.delete(memory.id)
      const archived = 'content' in result && 'namespace' in result
      toast.success(archived ? 'Archived' : 'Archive proposal submitted')
      setMemory(await memoryApi.get(memory.id))
      if (!archived) toast.message('Review the archive proposal from Proposals.')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  // Restores this entry, or the older version a revision replaced — the
  // second half of ADR 0003 §2's "one action restores it", once the newer
  // version has been archived. Without it the chain is readable and the way
  // back is API-only.
  async function restore(id: string = memory?.id ?? '') {
    if (!id) return
    setBusy(true)
    try {
      await memoryApi.restore(id)
      toast.success('Restored')
      const [row, chain] = await Promise.all([
        memoryApi.get(memoryId),
        memoryApi.versions(memoryId).catch(() => ({ items: [] as MemoryVersion[] })),
      ])
      setMemory(row)
      setVersions(chain.items)
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
              {memory.status === 'archived'
                ? (
                  // Owner-only: the route answers 404 for anyone else, and
                  // unlike archive there is no proposal to fall back to.
                  memory.owner_user_id === currentUser?.id ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => restore()}>
                      <Archive className="size-3.5" /> Restore
                    </Button>
                  ) : null
                )
                : (
                  <Button size="sm" variant="destructive" disabled={busy || memory.status !== 'active'} onClick={archive}>
                    <Archive className="size-3.5" /> Archive
                  </Button>
                )}
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
                <Field
                  label="Written by"
                  value={memory.created_by?.startsWith('agent:')
                    ? <span>Agent <code className="text-xs">{memory.created_by.slice(6)}</code></span>
                    : val(memory.created_by)}
                />
                {/* Blank for an Agent's own write, and that is the honest
                    reading: nobody approved it in advance (ADR 0003 §2). */}
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

            <Card className="lg:col-span-2">
              <CardTitle>History</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Every version of this memory, oldest first. An Agent writes without asking
                and says why; this is where that is read, and one Archive takes it back.
              </p>
              <div className="mt-4 divide-y divide-border rounded-md border border-border">
                {versions.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">No earlier versions.</p>
                )}
                {versions.map(version => (
                  <div
                    key={version.memory.id}
                    className={`p-3 text-sm ${version.memory.id === memory.id ? 'bg-muted/30' : ''}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">v{version.memory.version}</Badge>
                      <Badge variant={version.memory.status === 'active' ? 'success' : 'muted'}>
                        {version.memory.status}
                      </Badge>
                      {version.written_by_agent_id && <Badge variant="secondary">Agent</Badge>}
                      <span className="text-xs text-muted-foreground">{fmt(version.memory.created_at)}</span>
                    </div>
                    {version.rationale && (
                      <p className="mt-1 text-xs text-muted-foreground">Why: {version.rationale}</p>
                    )}
                    {(version.session_id || version.run_id) && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {version.session_id && <>Session <code>{version.session_id.slice(0, 8)}</code> </>}
                        {version.run_id && (
                          <Link to={`/runs/${version.run_id}`} className="text-accent-foreground hover:underline">
                            run {version.run_id.slice(0, 8)}
                          </Link>
                        )}
                      </p>
                    )}
                    {version.memory.content && version.memory.id !== memory.id && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{version.memory.content}</p>
                    )}
                    {version.memory.status === 'superseded'
                      && version.memory.owner_user_id === currentUser?.id
                      && !versions.some(v => v.memory.status === 'active') && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        disabled={busy}
                        onClick={() => restore(version.memory.id)}
                      >
                        Restore this version
                      </Button>
                    )}
                  </div>
                ))}
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
