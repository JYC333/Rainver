import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { History, ArrowLeft, ShieldAlert, Folder } from 'lucide-react'
import { toast } from 'sonner'
import { projectFoldersApi, projectsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { MemberRole, ProjectFolder, WorkspaceLocation } from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import { SpaceLink as Link } from '../../core/spaceNav'
import { AmbientSessionImportPanel } from './AmbientSessionImportPanel'

function canManageSpace(role: MemberRole | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

function fmt(dt: string) {
  return new Date(dt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function ProjectFolderSettingsPage() {
  const { projectId = '', folderId = '' } = useParams<{ projectId: string; folderId: string }>()
  const { activeSpaceId, spaces } = useSpace()
  const activeSpace = spaces.find(s => s.id === activeSpaceId)
  const manageable = canManageSpace(activeSpace?.role)
  const [projectWritable, setProjectWritable] = useState(false)

  const [folder, setFolder] = useState<ProjectFolder | null>(null)
  const [locations, setLocations] = useState<WorkspaceLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [retentionDays, setRetentionDays] = useState('')
  const [maxCount, setMaxCount] = useState('')
  const [saving, setSaving] = useState(false)
  const [activatingLocationId, setActivatingLocationId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!projectId || !folderId) return
    setLoading(true)
    try {
      const [f, folderLocations, project] = await Promise.all([
        projectFoldersApi.get(projectId, folderId),
        projectFoldersApi.locations(projectId, folderId),
        projectsApi.get(projectId),
      ])
      setFolder(f)
      setLocations(folderLocations)
      setProjectWritable(project.current_user_can_write === true)
      setRetentionDays(f.snapshot_retention_days !== null ? String(f.snapshot_retention_days) : '')
      setMaxCount(f.snapshot_max_count !== null ? String(f.snapshot_max_count) : '')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [projectId, folderId])

  useEffect(() => { void load() }, [load])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!projectId || !folderId) return
    const days = retentionDays.trim() ? parseInt(retentionDays, 10) : null
    const count = maxCount.trim() ? parseInt(maxCount, 10) : null
    if (days !== null && (isNaN(days) || days < 1)) { toast.error('Retention days must be a positive integer'); return }
    if (count !== null && (isNaN(count) || count < 1)) { toast.error('Max count must be a positive integer'); return }
    setSaving(true)
    try {
      await projectFoldersApi.update(projectId, folderId, { snapshot_retention_days: days, snapshot_max_count: count })
      toast.success('Snapshot settings saved')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleActivateLocation(location: WorkspaceLocation) {
    if (!projectId || !folderId || location.status !== 'stale') return
    if (!window.confirm('Use this checkout for new conversations and mark the current active checkout as stale? Existing conversations will stay on their current checkout.')) return
    setActivatingLocationId(location.id)
    try {
      await projectFoldersApi.activateLocation(projectId, folderId, location.id)
      await load()
      toast.success('Workspace Location activated for new conversations')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActivatingLocationId(null)
    }
  }

  return (
    <div className="p-6 space-y-4 max-w-2xl">
      <div className="flex items-center gap-3 pb-4 border-b border-border">
        <Link
          to={`/projects/${projectId}/files`}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Folder className="size-4 text-accent-foreground" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight truncate">
            {loading ? 'Loading…' : (folder?.name ?? 'Project Folder not found')}
          </h1>
          <p className="text-xs text-muted-foreground">Project Folder settings</p>
        </div>
      </div>

      {!loading && folder && (
        <>
          <Card>
            <CardTitle>Info</CardTitle>
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-24 shrink-0">Status</span>
                <Badge variant={folder.status === 'active' ? 'default' : 'muted'} className="text-[10px] px-1.5 py-0">
                  {folder.status}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-24 shrink-0">Kind</span>
                <Badge variant="muted" className="text-[10px] px-1.5 py-0">{folder.kind}</Badge>
                {folder.is_primary && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">primary</Badge>}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-24 shrink-0">Created</span>
                <span className="text-foreground">{fmt(folder.created_at)}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground w-24 shrink-0 mt-0.5">ID</span>
                <span className="font-mono text-xs text-muted-foreground break-all">{folder.id}</span>
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle>Workspace Locations</CardTitle>
            <div className="space-y-2 text-sm">
              {locations.length === 0 && <p className="text-muted-foreground">No execution location registered.</p>}
              {locations.map(location => (
                <div key={location.id} className="rounded border border-border p-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={location.execution_ready ? 'success' : 'muted'}>{location.execution_ready ? 'ready' : 'not ready'}</Badge>
                    <Badge variant="outline">{location.execution_host_kind}</Badge>
                    <Badge variant={location.status === 'active' ? 'secondary' : 'muted'}>{location.status}</Badge>
                    {location.dirty !== null && <span className="text-xs text-muted-foreground">{location.dirty ? 'dirty' : 'clean'}</span>}
                    {projectWritable && location.status === 'stale' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!location.execution_ready || activatingLocationId !== null}
                        onClick={() => void handleActivateLocation(location)}
                      >
                        {activatingLocationId === location.id ? 'Activating…' : 'Use for new conversations'}
                      </Button>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{location.branch ?? 'no branch'} · {location.git_head ?? 'no git head'}</div>
                  {location.display_path && <div className="font-mono text-xs text-muted-foreground break-all">{location.display_path}</div>}
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle className="flex items-center gap-2">
              <History className="size-3.5" /> Snapshot settings
            </CardTitle>
            {!manageable ? (
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <ShieldAlert className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <span>Only space owners and admins can configure snapshot settings.</span>
              </div>
            ) : (
              <form onSubmit={handleSave} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Leave blank to use the space default (see Space Settings).
                </p>
                <div className="flex items-end gap-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                      Retention (days)
                    </label>
                    <Input
                      type="number"
                      min={1}
                      value={retentionDays}
                      onChange={e => setRetentionDays(e.target.value)}
                      className="h-8 w-28 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                      Max snapshots
                    </label>
                    <Input
                      type="number"
                      min={1}
                      value={maxCount}
                      onChange={e => setMaxCount(e.target.value)}
                      className="h-8 w-28 text-sm"
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </form>
            )}
          </Card>

          {locations.map(location => (
            <AmbientSessionImportPanel key={location.id} location={location} />
          ))}
        </>
      )}
    </div>
  )
}
