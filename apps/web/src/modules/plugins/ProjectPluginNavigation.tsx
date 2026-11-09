import { useAppTranslation } from '../../i18n';
import { NavLink, useParams } from 'react-router-dom';
import { pluginFrontendEntries } from '@rainver/protocol';
import { bundledOperationPlugins } from './manifestCatalog';
import { useEffectivePlugins } from './useEffectivePlugins';
import { spacePath } from '../../core/navigation';
import { cn } from '../../lib/utils';
function EnabledProjectPluginNavigation({
  onNavigate
}: {
  onNavigate: () => void;
}) {
  const {
      spaceId = '',
      projectId = ''
    } = useParams(),
    {
      isEnabled
    } = useEffectivePlugins();
  const { t } = useAppTranslation();
  return <>{bundledOperationPlugins.filter(p => isEnabled(p.manifest.id)).flatMap(p => pluginFrontendEntries(p.manifest).filter(e => e.placements.includes('project.area')).map(e => <NavLink key={e.module_id} onClick={onNavigate} to={spacePath(spaceId, `/projects/${projectId}/plugins/${p.manifest.id}/${e.entry_id}`)} className={({
      isActive
    }) => cn('block rounded-md px-2 py-1.5 text-sm', isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>{t(`modules.${e.module_id}`, { defaultValue: e.label })}</NavLink>))}</>;
}
export function ProjectPluginNavigation({
  onNavigate
}: {
  onNavigate: () => void;
}) {
  if (!bundledOperationPlugins.some(p => p.manifest.web?.entries.some(e => e.placements.includes('project.area')))) return null;
  return <EnabledProjectPluginNavigation onNavigate={onNavigate} />;
}
