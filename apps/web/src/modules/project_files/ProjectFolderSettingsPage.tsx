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
import { useAppTranslation } from '../../i18n'
import { formatDate } from '../../i18n/format'

function canManageSpace(role: MemberRole | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

export default function ProjectFolderSettingsPage() {
  const { t } = useAppTranslation()
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
    if (days !== null && (isNaN(days) || days < 1)) { toast.error(t('management_ui.folder_settings.retention_invalid')); return }
    if (count !== null && (isNaN(count) || count < 1)) { toast.error(t('management_ui.folder_settings.max_invalid')); return }
    setSaving(true)
    try {
      await projectFoldersApi.update(projectId, folderId, { snapshot_retention_days: days, snapshot_max_count: count })
      toast.success(t('management_ui.folder_settings.saved'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleActivateLocation(location: WorkspaceLocation) {
    if (!projectId || !folderId || location.status !== 'stale') return
    if (!window.confirm(t('management_ui.folder_settings.activate_confirm'))) return
    setActivatingLocationId(location.id)
    try {
      await projectFoldersApi.activateLocation(projectId, folderId, location.id)
      await load()
      toast.success(t('management_ui.folder_settings.activated'))
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
            {loading ? t('management_ui.folder_settings.loading') : (folder?.name ?? t('management_ui.folder_settings.not_found'))}
          </h1>
          <p className="text-xs text-muted-foreground">{t('management_ui.folder_settings.title')}</p>
        </div>
      </div>

      {!loading && folder && (
        <>
          <Card>
            <CardTitle>{t('management_ui.folder_settings.info')}</CardTitle>
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-24 shrink-0">{t('management_ui.folder_settings.status')}</span>
                <Badge variant={folder.status === 'active' ? 'default' : 'muted'} className="text-[10px] px-1.5 py-0">
                  {folder.status}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-24 shrink-0">{t('management_ui.folder_settings.kind')}</span>
                <Badge variant="muted" className="text-[10px] px-1.5 py-0">{folder.kind}</Badge>
                {folder.is_primary && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{t('management_ui.folder_settings.primary')}</Badge>}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-24 shrink-0">{t('management_ui.folder_settings.created')}</span>
                <span className="text-foreground">{formatDate(folder.created_at)}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground w-24 shrink-0 mt-0.5">{t('management_ui.folder_settings.id')}</span>
                <span className="font-mono text-xs text-muted-foreground break-all">{folder.id}</span>
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle>{t('management_ui.folder_settings.locations')}</CardTitle>
            <div className="space-y-2 text-sm">
              {locations.length === 0 && <p className="text-muted-foreground">{t('management_ui.folder_settings.no_locations')}</p>}
              {locations.map(location => (
                <div key={location.id} className="rounded border border-border p-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={location.execution_ready ? 'success' : 'muted'}>{location.execution_ready ? t('management_ui.folder_settings.ready') : t('management_ui.folder_settings.not_ready')}</Badge>
                    <Badge variant="outline">{location.execution_host_kind}</Badge>
                    <Badge variant={location.status === 'active' ? 'secondary' : 'muted'}>{location.status}</Badge>
                    {location.dirty !== null && <span className="text-xs text-muted-foreground">{location.dirty ? t('management_ui.folder_settings.dirty') : t('management_ui.folder_settings.clean')}</span>}
                    {projectWritable && location.status === 'stale' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!location.execution_ready || activatingLocationId !== null}
                        onClick={() => void handleActivateLocation(location)}
                      >
                        {activatingLocationId === location.id ? t('management_ui.folder_settings.activating') : t('management_ui.folder_settings.use_for_new')}
                      </Button>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{location.branch ?? t('management_ui.folder_settings.no_branch')} · {location.git_head ?? t('management_ui.folder_settings.no_git_head')}</div>
                  {location.display_path && <div className="font-mono text-xs text-muted-foreground break-all">{location.display_path}</div>}
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle className="flex items-center gap-2">
              <History className="size-3.5" /> {t('management_ui.folder_settings.snapshot_settings')}
            </CardTitle>
            {!manageable ? (
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <ShieldAlert className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <span>{t('management_ui.folder_settings.admins_only')}</span>
              </div>
            ) : (
              <form onSubmit={handleSave} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t('management_ui.folder_settings.blank_default')}
                </p>
                <div className="flex items-end gap-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                      {t('management_ui.folder_settings.retention_days')}
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
                      {t('management_ui.folder_settings.max_snapshots')}
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
                    {saving ? t('management_ui.folder_settings.saving') : t('management_ui.folder_settings.save')}
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
