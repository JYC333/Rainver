import { useAppTranslation } from '../../i18n';
import { NavLink, useParams } from 'react-router-dom';
import { pluginFrontendEntries } from '@rainver/protocol';
import { bundledOperationPlugins } from './manifestCatalog';
import { useEffectivePlugins } from './useEffectivePlugins';
import { hasProjectBoundPlugins, useProjectPluginBindings } from './useProjectPluginBindings';
import { spacePath } from '../../core/navigation';
import { cn } from '../../lib/utils';
import ErrorBoundary from '../../core/ErrorBoundary';
/**
 * Which bundled packages reach this Project: a Project-level package needs this
 * Project's effective binding (bound and enabled for this person); any other
 * package follows its Space/user enablement as before. The server rechecks both
 * on every operation; this only decides what is offered.
 */
export function useProjectPluginReach(projectId: string | null) {
  const { isEnabled } = useEffectivePlugins();
  const bound = useProjectPluginBindings(hasProjectBoundPlugins() ? projectId : null);
  // Both follow an enable/disable in this tab at once; neither stale answer alone keeps an entry offered.
  return (manifest: (typeof bundledOperationPlugins)[number]['manifest']) => manifest.project_binding === 'required' ? bound.isBound(manifest.id) && isEnabled(manifest.id) : isEnabled(manifest.id);
}
function EnabledProjectPluginNavigation({
  onNavigate
}: {
  onNavigate: () => void;
}) {
  const {
      spaceId = '',
      projectId = ''
    } = useParams(),
    reaches = useProjectPluginReach(projectId || null);
  const { t } = useAppTranslation();
  return <>{bundledOperationPlugins.filter(p => reaches(p.manifest)).flatMap(p => pluginFrontendEntries(p.manifest).filter(e => e.placements.includes('project.area')).map(e => <NavLink key={e.module_id} onClick={onNavigate} to={spacePath(spaceId, `/projects/${projectId}/plugins/${p.manifest.id}/${e.entry_id}`)} className={({
      isActive
    }) => cn('block rounded-md px-2 py-1.5 text-sm', isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>{t(`modules.${e.module_id}`, { defaultValue: e.label })}</NavLink>))}</>;
}
export function ProjectPluginNavigation({
  onNavigate
}: {
  onNavigate: () => void;
}) {
  if (!bundledOperationPlugins.some(p => p.manifest.web?.entries.some(e => e.placements.includes('project.area')))) return null;
  // A failing plugin contribution never takes the core Project navigation down with it.
  return <ErrorBoundary fallback={() => null}><EnabledProjectPluginNavigation onNavigate={onNavigate} /></ErrorBoundary>;
}
