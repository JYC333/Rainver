import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ban, CheckCircle2, Plus, RefreshCw, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { artifactsApi, contextApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { cn, errMsg } from '../../lib/utils'
import type { Artifact, ContextArtifactRevocation, ContextArtifactRevocationScope } from '../../types/api'
import { CONTEXT_ATTACHABLE_ARTIFACT_TYPES, isContextAttachableArtifactType } from './contextArtifactTypes'

interface ContextArtifactPickerProps {
  selectedArtifactIds: string[]
  onChange: (artifactIds: string[]) => void
  projectFolderId?: string | null
  projectId?: string | null
  maxSelected?: number
  title?: string
  description?: string
  enableRevocationControls?: boolean
  className?: string
}

interface RevocationScopeRef {
  scope_type: ContextArtifactRevocationScope
  scope_id: string
}

export function ContextArtifactPicker({
  selectedArtifactIds,
  onChange,
  projectFolderId,
  projectId,
  maxSelected = 8,
  title = 'Context Artifacts',
  description = 'Selected artifacts are attached only to this build or future runs where you include the same ids.',
  enableRevocationControls = true,
  className,
}: ContextArtifactPickerProps) {
  const { activeSpaceId } = useSpace()
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [revocations, setRevocations] = useState<ContextArtifactRevocation[]>([])
  const [loading, setLoading] = useState(false)
  const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null)

  const normalizedFolderId = projectFolderId?.trim() || null
  const normalizedProjectId = projectId?.trim() || null
  const currentScope = useMemo<RevocationScopeRef | null>(() => {
    if (normalizedProjectId) return { scope_type: 'project', scope_id: normalizedProjectId }
    if (normalizedFolderId) return { scope_type: 'project_folder', scope_id: normalizedFolderId }
    return null
  }, [normalizedProjectId, normalizedFolderId])

  const artifactById = useMemo(
    () => new Map(artifacts.map(artifact => [artifact.id, artifact])),
    [artifacts],
  )
  const revocationByArtifactId = useMemo(() => {
    const byId = new Map<string, ContextArtifactRevocation>()
    for (const revocation of revocations) {
      const current = byId.get(revocation.artifact_id)
      if (!current || revocation.scope_type === 'project') byId.set(revocation.artifact_id, revocation)
    }
    return byId
  }, [revocations])

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setArtifacts([])
      setRevocations([])
      return
    }
    setLoading(true)
    try {
      const pages = await Promise.all(CONTEXT_ATTACHABLE_ARTIFACT_TYPES.map(artifactType =>
        artifactsApi.list({
          limit: 100,
          artifact_type: artifactType,
          project_folder_id: normalizedFolderId || undefined,
          project_id: normalizedProjectId || undefined,
        }),
      ))
      const byId = new Map<string, Artifact>()
      for (const page of pages) {
        for (const artifact of page.items) {
          if (isContextAttachableArtifactType(artifact.artifact_type)) byId.set(artifact.id, artifact)
        }
      }
      const loadedArtifacts = [...byId.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      setArtifacts(loadedArtifacts)

      if (normalizedFolderId || normalizedProjectId) {
        const artifactIds = Array.from(new Set([
          ...loadedArtifacts.map(artifact => artifact.id),
          ...selectedArtifactIds,
        ])).slice(0, 100)
        const response = await contextApi.listArtifactRevocations({
          project_folder_id: normalizedFolderId,
          project_id: normalizedProjectId,
          artifact_ids: artifactIds,
        })
        setRevocations(response.items)
      } else {
        setRevocations([])
      }
    } catch (e) {
      toast.error(errMsg(e))
      setArtifacts([])
      setRevocations([])
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId, normalizedProjectId, normalizedFolderId, selectedArtifactIds])

  useEffect(() => { void load() }, [load])

  function toggleArtifact(id: string) {
    if (revocationByArtifactId.has(id)) {
      toast.error('This artifact is revoked for the current context')
      return
    }
    const selected = selectedArtifactIds.includes(id)
    if (selected) {
      onChange(selectedArtifactIds.filter(existing => existing !== id))
      return
    }
    if (selectedArtifactIds.length >= maxSelected) {
      toast.error(`Context artifact attachments are limited to ${maxSelected}`)
      return
    }
    onChange([...selectedArtifactIds, id])
  }

  function removeArtifact(id: string) {
    onChange(selectedArtifactIds.filter(existing => existing !== id))
  }

  async function revokeArtifact(artifact: Artifact) {
    if (!currentScope) return
    setBusyArtifactId(artifact.id)
    try {
      const revocation = await contextApi.revokeArtifact({
        artifact_id: artifact.id,
        scope_type: currentScope.scope_type,
        scope_id: currentScope.scope_id,
      })
      setRevocations(current => [
        revocation,
        ...current.filter(item => !(
          item.artifact_id === revocation.artifact_id &&
          item.scope_type === revocation.scope_type &&
          item.scope_id === revocation.scope_id
        )),
      ])
      removeArtifact(artifact.id)
      toast.success('Context artifact revoked for future attachment')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusyArtifactId(null)
    }
  }

  async function restoreArtifact(revocation: ContextArtifactRevocation) {
    setBusyArtifactId(revocation.artifact_id)
    try {
      await contextApi.unrevokeArtifact(revocation.artifact_id, {
        scope_type: revocation.scope_type,
        scope_id: revocation.scope_id,
      })
      setRevocations(current => current.filter(item => item.id !== revocation.id))
      toast.success('Context artifact restored for future attachment')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusyArtifactId(null)
    }
  }

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{title}</h3>
          {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || !activeSpaceId}>
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {selectedArtifactIds.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Selected ({selectedArtifactIds.length}/{maxSelected})</div>
          <div className="flex flex-wrap gap-2">
            {selectedArtifactIds.map(id => {
              const artifact = artifactById.get(id)
              const revocation = revocationByArtifactId.get(id)
              return (
                <span key={id} className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs">
                  <span className="truncate">{artifact?.title ?? id}</span>
                  <Badge variant={revocation ? 'warning' : 'secondary'}>{revocation ? 'revoked' : artifact?.artifact_type ?? 'artifact'}</Badge>
                  <button type="button" onClick={() => removeArtifact(id)} aria-label="Remove context artifact">
                    <X className="size-3 text-muted-foreground hover:text-foreground" />
                  </button>
                </span>
              )
            })}
          </div>
        </div>
      )}

      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : artifacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {activeSpaceId ? 'No attachable artifacts found in the loaded page.' : 'Select an operational space to load artifacts.'}
        </p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {artifacts.map(artifact => {
            const selected = selectedArtifactIds.includes(artifact.id)
            const revocation = revocationByArtifactId.get(artifact.id)
            const busy = busyArtifactId === artifact.id
            return (
              <div key={artifact.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/artifacts/${artifact.id}${artifact.project_folder_id ? `?project_folder_id=${encodeURIComponent(artifact.project_folder_id)}` : ''}`} className="truncate text-sm font-medium text-accent-foreground hover:underline">
                      {artifact.title}
                    </Link>
                    <Badge variant="secondary">{artifact.artifact_type}</Badge>
                    {artifact.project_folder_id && <Badge variant="outline">folder</Badge>}
                    {artifact.project_id && <Badge variant="outline">project</Badge>}
                    {revocation && <Badge variant="warning">revoked {revocation.scope_type}</Badge>}
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{artifact.id}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={selected ? 'secondary' : 'outline'}
                    onClick={() => toggleArtifact(artifact.id)}
                    disabled={Boolean(revocation)}
                  >
                    {selected ? <CheckCircle2 className="size-3.5" /> : <Plus className="size-3.5" />}
                    {selected ? 'Selected' : 'Attach'}
                  </Button>
                  {enableRevocationControls && currentScope && (
                    revocation ? (
                      <Button size="sm" variant="ghost" onClick={() => void restoreArtifact(revocation)} disabled={busy}>
                        <RotateCcw className="size-3.5" />
                        Restore
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => void revokeArtifact(artifact)} disabled={busy}>
                        <Ban className="size-3.5" />
                        Revoke
                      </Button>
                    )
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
