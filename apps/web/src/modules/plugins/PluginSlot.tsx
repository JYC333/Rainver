import { useEffectivePlugins } from './useEffectivePlugins';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { pluginFrontendEntries, type OfficialPluginListItem } from '@rainver/protocol';
import { pluginsApi, projectsApi, queryPluginOperation, callPluginOperation } from '../../api/client';
import { useSpace } from '../../contexts/SpaceContext';
import { useAppTranslation } from '../../i18n';
import { registerInMemoryResidue, sessionEpoch } from '../../lib/sessionResidue';
import { spacePath } from '../../core/navigation';
import ErrorBoundary from '../../core/ErrorBoundary';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { bundledPlugin, bundledOperationPlugins } from './manifestCatalog';
import type { PluginOps, PluginSlotComponent, PluginSlotContext } from './slotTypes';
type Placement = 'navigation' | 'project.area' | 'project.overview.card';
export function PluginSlot({
  pluginId,
  entryId,
  placement
}: {
  pluginId: string;
  entryId: string;
  placement?: Placement;
}) {
  const params = useParams(),
    {
      userId,
      activeSpaceId,
      preferredSpaceId
    } = useSpace(),
    {
      t
    } = useAppTranslation();
  const spaceId = params.spaceId ?? activeSpaceId ?? preferredSpaceId ?? '',
    projectId = params.projectId ?? null;
  const surface = placement ?? (projectId ? 'project.area' : 'navigation');
  const scope = `${surface}:${userId}:${spaceId}:${projectId}:${pluginId}:${entryId}`;
  return <ScopedSlot key={scope} {...{
    spaceId,
    projectId,
    pluginId,
    entryId,
    scope,
    t,
    placement: surface
  }} />;
}
function ScopedSlot({
  spaceId,
  projectId,
  pluginId,
  entryId,
  scope,
  t,
  placement
}: {
  spaceId: string;
  projectId: string | null;
  pluginId: string;
  entryId: string;
  scope: string;
  t: (key: string) => string;
  placement: Placement;
}) {
  const bundle = bundledPlugin(pluginId),
    entry = bundle?.manifest.web?.entries.find(e => e.id === entryId);
  const lifetime = useRef({
    active: true,
    generation: 0,
    controller: new AbortController()
  });
  useEffect(() => {
    const value = lifetime.current;
    value.active = true;
    if (value.controller.signal.aborted) value.controller = new AbortController();
    return () => {
      value.active = false;
      ++value.generation;
      value.controller.abort();
    };
  }, []);
  const [state, setState] = useState<'loading' | 'enabled' | 'disabled' | 'error'>('loading');
  const [View, setView] = useState<PluginSlotComponent | null>(null),
    [version, setVersion] = useState(0);
  const [catalog, setCatalog] = useState<OfficialPluginListItem | null>(null);
  const denied = useCallback(() => {
    ++lifetime.current.generation;
    lifetime.current.controller.abort();
    setView(null);
    setCatalog(null);
    setState('disabled');
  }, []);
  useEffect(() => registerInMemoryResidue(denied), [denied]);
  useEffect(() => {
    const controller = new AbortController(),
      epoch = sessionEpoch();
    let sequence = 0,
      live = true;
    const refresh = async () => {
      const current = ++sequence;
      try {
        if (!bundle || !entry || !entry.placements.includes(placement) || !spaceId) throw new Error('Unavailable bundled view');
        const [{
          items
        }, project] = await Promise.all([pluginsApi.list({
          spaceId,
          signal: controller.signal
        }), projectId ? projectsApi.get(projectId, {
          spaceId,
          signal: controller.signal
        }) : Promise.resolve(null)]);
        if (!live || epoch !== sessionEpoch() || current !== sequence) return;
        const item = items.find(i => i.descriptor.id === pluginId);
        if (project?.current_user_can_read === false || !item?.effective.enabled) {
          denied();
          return;
        }
        if (item.descriptor.version !== bundle.manifest.version || JSON.stringify(item.descriptor.frontend_entries) !== JSON.stringify(pluginFrontendEntries(bundle.manifest))) throw new Error('Bundled view contract mismatch');
        const components = (await bundle.load()).default;
        if (Object.keys(components).sort().join() !== bundle.manifest.web?.entries.map(e => e.id).sort().join() || !components[entryId]) throw new Error('Declared/registered view mismatch');
        if (!live || epoch !== sessionEpoch() || current !== sequence) return;
        setCatalog(item);
        setView(() => components[entryId]!);
        setState('enabled');
      } catch (error) {
        if (!live || epoch !== sessionEpoch() || current !== sequence) return;
        ++lifetime.current.generation;
        lifetime.current.controller.abort();
        setCatalog(null);
        setView(null);
        setState([401, 403, 404].includes(Number((error as {
          status?: number;
        }).status)) ? 'disabled' : 'error');
      }
    };
    ++lifetime.current.generation;
    setState('loading');
    setView(null);
    void refresh();
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    const timer = window.setInterval(focus, 30000);
    return () => {
      live = false;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [scope, version, bundle, entry, spaceId, projectId, pluginId, entryId, denied]);
  const ctx = useMemo<PluginSlotContext>(() => {
    const epoch = sessionEpoch(),
      bindingGeneration = lifetime.current.generation;
    const invoke = async (kind: 'query' | 'command', id: Parameters<PluginOps['query']>[0], input: unknown, key?: string) => {
      const life = lifetime.current,
        generation = life.generation;
      if (!life.active || bindingGeneration !== life.generation || epoch !== sessionEpoch()) throw new DOMException('Expired view', 'AbortError');
      if (life.controller.signal.aborted) life.controller = new AbortController();
      const controller = life.controller;
      const operation = bundle?.manifest.operations.find(o => o.id === id && o.kind === kind);
      if (!operation || state !== 'enabled' || !catalog) throw new Error('Undeclared or disabled operation');
      const parsed = operation.input_schema.parse(input);
      try {
        if (projectId) {
          const project = await projectsApi.get(projectId, {
            spaceId,
            signal: controller.signal
          });
          if (project.current_user_can_read === false) {
            denied();
            throw new Error('Project access revoked');
          }
        }
        if (!life.active || bindingGeneration !== life.generation || epoch !== sessionEpoch()) throw new DOMException('Expired view', 'AbortError');
        const result = kind === 'query' ? await queryPluginOperation(id, parsed, {
          spaceId,
          signal: controller.signal
        }) : await callPluginOperation(id, parsed, key!, {
          spaceId,
          signal: controller.signal
        });
        if (!life.active || generation !== life.generation || epoch !== sessionEpoch()) throw new DOMException('Obsolete session', 'AbortError');
        if ('status' in result && result.status === 'succeeded') operation.output_schema.parse(result.data);
        return result;
      } catch (error) {
        if ([401, 403, 404].includes(Number((error as {
          status?: number;
        }).status))) denied();
        throw error;
      }
    };
    return {
      spaceId,
      projectId,
      ops: {
        query: ((id, input) => invoke('query', id, input)) as PluginOps['query'],
        command: ((id, input, key) => invoke('command', id, input, key)) as PluginOps['command']
      },
      ui: {
        Button,
        Input,
        Card,
        CardHeader,
        CardTitle,
        CardContent,
        t,
        ProposalLink: ({
          id
        }) => <Button className="max-md:min-h-[44px]" asChild variant="outline" size="sm"><Link to={spacePath(spaceId, `/proposals/${encodeURIComponent(id)}`)}>{t('plugin_ui.review')}</Link></Button>
      }
    };
  }, [bundle, state, catalog, spaceId, projectId, t, denied]);
  const { t: translate } = useAppTranslation();
  const title = entry ? translate(`modules.plugin.${pluginId}.${entry.id}`, { defaultValue: entry.title }) : t('plugin_ui.title');
  return <section className={placement === 'project.overview.card' ? 'space-y-3' : 'p-4 space-y-3'} aria-label={title}>
  <h2 className={placement === 'project.overview.card' ? 'sr-only' : 'text-xl font-semibold'}>{title}</h2>
  {state === 'loading' && <p role="status" className="text-sm text-muted-foreground">{t('plugin_ui.loading')}</p>}
  {state === 'disabled' && <p role="status" className="text-sm text-muted-foreground">{t('plugin_ui.disabled')}</p>}
  {state === 'error' && <Card><CardContent className="space-y-3"><p role="alert">{t('plugin_ui.error')}</p><Button className="max-md:min-h-[44px]" variant="outline" onClick={() => setVersion(v => v + 1)}>{t('plugin_ui.retry')}</Button></CardContent></Card>}
  {state === 'enabled' && View && <ErrorBoundary key={`${scope}:${version}`} fallback={retry => <Card><CardContent className="space-y-3"><p role="alert">{t('plugin_ui.error')}</p><Button className="max-md:min-h-[44px]" variant="outline" onClick={retry}>{t('plugin_ui.retry')}</Button></CardContent></Card>}><View ctx={ctx} /></ErrorBoundary>}
 </section>;
}
export function ProjectPluginPage() {
  const {
    pluginId = '',
    entryId = ''
  } = useParams();
  return <div data-plugin-page><PluginSlot {...{
      pluginId,
      entryId
    }} /></div>;
}
function EnabledProjectPluginSlots({
  placement
}: {
  placement: 'project.area' | 'project.overview.card';
}) {
  const {
    isEnabled
  } = useEffectivePlugins();
  return <>{bundledOperationPlugins.filter(p => isEnabled(p.manifest.id)).flatMap(p => p.manifest.web?.entries.filter(e => e.placements.includes(placement)).map(e => <PluginSlot key={`${p.manifest.id}:${e.id}`} pluginId={p.manifest.id} entryId={e.id} placement={placement} />) ?? [])}</>;
}
export function ProjectPluginSlots({
  placement
}: {
  placement: 'project.area' | 'project.overview.card';
}) {
  if (!bundledOperationPlugins.some(p => p.manifest.web?.entries.some(e => e.placements.includes(placement)))) return null;
  return <EnabledProjectPluginSlots placement={placement} />;
}
