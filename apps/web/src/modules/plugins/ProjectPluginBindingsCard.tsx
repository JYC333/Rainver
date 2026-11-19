import { useState } from 'react'
import { toast } from 'sonner'
import { callOperation } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { announceProjectPluginBindingsChanged, hasProjectBoundPlugins, useProjectPluginBindings } from './useProjectPluginBindings'

/**
 * Project settings: which Project-level plugins this Project uses. Only a
 * Project owner-level person changes a binding (a Space owner/admin outside the
 * Project included, who still cannot open its data); everyone else sees the state.
 * Each change is one keyed core command; the list is read again afterwards.
 * Renders nothing when no bundled package needs a Project binding.
 */
export function ProjectPluginBindingsCard({ projectId }: { projectId: string }) {
  if (!hasProjectBoundPlugins()) return null
  return <BindingsCard projectId={projectId} />
}

function BindingsCard({ projectId }: { projectId: string }) {
  const { t } = useAppTranslation()
  const { activeSpaceId, preferredSpaceId } = useSpace()
  const spaceId = activeSpaceId ?? preferredSpaceId ?? ''
  const { bindings, failed, loading, refresh } = useProjectPluginBindings(projectId)
  const [busy, setBusy] = useState<string | null>(null)
  if (loading || bindings?.items.length === 0) return null
  async function change(pluginId: string, bind: boolean) {
    setBusy(pluginId)
    try {
      const result = await callOperation(bind ? 'official_plugin.project_binding.bind' : 'official_plugin.project_binding.unbind', { plugin_id: pluginId, project_id: projectId }, crypto.randomUUID(), { spaceId })
      if (!('status' in result) || result.status !== 'succeeded') throw new Error('not completed')
      toast.success(t('plugin_ui.project_binding.changed'))
    } catch {
      toast.error(t('plugin_ui.project_binding.failed'))
    } finally {
      setBusy(null)
      announceProjectPluginBindingsChanged(projectId)
      refresh()
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('plugin_ui.project_binding.title')}</CardTitle>
        <p className="text-xs text-muted-foreground">{t('plugin_ui.project_binding.hint')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {failed && <p role="status" className="text-sm text-muted-foreground">{t('plugin_ui.project_binding.unavailable')}</p>}
        {bindings?.items.map(item => {
          const bound = item.status === 'bound'
          return (
            <div key={item.plugin_id} className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {item.name}
                  <Badge variant={bound ? 'default' : 'outline'}>{t(`plugin_ui.project_binding.${item.status}`)}</Badge>
                </div>
                {!item.plugin_enabled && <p className="text-xs text-muted-foreground">{t('plugin_ui.project_binding.not_enabled')}</p>}
                {/* Bound and enabled yet not effective: the server says this person does not read the Project (a Space owner/admin outside it). */}
                {bound && item.plugin_enabled && !item.effective && <p className="text-xs text-muted-foreground">{t('plugin_ui.project_binding.not_reader')}</p>}
              </div>
              {bindings.can_manage && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !bound && !item.plugin_enabled}
                  aria-label={t(bound ? 'plugin_ui.project_binding.unbind_label' : 'plugin_ui.project_binding.bind_label', { plugin: item.name })}
                  onClick={() => void change(item.plugin_id, !bound)}
                >
                  {t(bound ? 'plugin_ui.project_binding.unbind' : 'plugin_ui.project_binding.bind')}
                </Button>
              )}
            </div>
          )
        })}
        {bindings && !bindings.can_manage && bindings.items.length > 0 && <p className="text-xs text-muted-foreground">{t('plugin_ui.project_binding.manage_hint')}</p>}
      </CardContent>
    </Card>
  )
}
