import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { pluginFrontendEntries, type PluginOperationManifest } from '@rainver/protocol';
import { ProjectPluginNavigation } from '../ProjectPluginNavigation';
import { PluginSlot } from '../PluginSlot';
import { ProjectPluginBindingsCard } from '../ProjectPluginBindingsCard';
import { announceProjectPluginBindingsChanged } from '../useProjectPluginBindings';
import { announcePluginStateChanged } from '../pluginStateEvents';
import { callOperation, pluginsApi, projectsApi, queryOperation } from '../../../api/client';

const bound = vi.hoisted(() => ({
  manifest: null as unknown as PluginOperationManifest,
}));
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ userId: 'user', activeSpaceId: 'space', preferredSpaceId: 'space' }),
}));
vi.mock('../useEffectivePlugins', () => ({ useEffectivePlugins: () => ({ isEnabled: () => true }) }));
vi.mock('../manifestCatalog', async () => {
  const { probeManifest, input } = await import('../../../../../../server/test/fixtures/pluginOperation/manifest');
  const manifest = {
    ...probeManifest, id: 'bind_probe', name: 'Applications', project_binding: 'required', jobs: undefined, schedules: undefined, proposalTypes: undefined,
    permissions: { agent: true },
    web: { entries: [{ id: 'records', title: 'Applications', icon: 'notebook', placements: ['project.area', 'project.overview.card'] }] },
    operations: [{ id: 'plugin.bind_probe.record.list', version: 1, title: 'List', description: 'List', kind: 'query', side_effects: 'none', data_class: 'non_sensitive', input_schema: input.pick({}).extend({ project_id: input.shape.key }).strict(), output_schema: input.pick({}), gate_class: null },
      { id: 'plugin.bind_probe.record.write', version: 1, title: 'Write', description: 'Write', kind: 'command', side_effects: 'durable', data_class: 'non_sensitive', input_schema: input.pick({}).extend({ project_id: input.shape.key }).strict(), output_schema: input.pick({}), gate_class: null }],
  };
  const view = { default: { records: () => <div>Bound records view</div> } };
  const plugins = [
    { manifest, load: async () => view },
    { manifest: probeManifest, load: async () => ({ default: { records: () => <div>Probe view</div> } }) },
  ];
  return { bundledOperationPlugins: plugins, bundledPlugin: (id: string) => plugins.find(p => p.manifest.id === id), manifestModules: [] };
});
vi.mock('../../../api/client', () => ({
  pluginsApi: { list: vi.fn() },
  projectsApi: { get: vi.fn() },
  queryOperation: vi.fn(),
  callOperation: vi.fn(),
  queryPluginOperation: vi.fn(),
  callPluginOperation: vi.fn(),
}));

let state: { status: 'bound' | 'unbound' | 'available'; effective: boolean; can_manage: boolean };
const listing = () => ({ status: 'succeeded', data: { project_id: 'project', can_manage: state.can_manage, items: [{ plugin_id: 'bind_probe', name: 'Applications', version: '1.0.0', status: state.status, plugin_enabled: true, effective: state.effective, bound_at: null, unbound_at: null }] } });
beforeEach(async () => {
  vi.resetAllMocks();
  state = { status: 'available', effective: false, can_manage: true };
  const { bundledOperationPlugins } = await import('../manifestCatalog');
  bound.manifest = bundledOperationPlugins[0]!.manifest;
  vi.mocked(queryOperation).mockImplementation(async () => listing() as never);
  vi.mocked(projectsApi.get).mockResolvedValue({ current_user_can_read: true } as never);
  vi.mocked(pluginsApi.list).mockImplementation(async () => {
    const { bundledOperationPlugins } = await import('../manifestCatalog');
    return { items: bundledOperationPlugins.map(p => ({ descriptor: { id: p.manifest.id, version: p.manifest.version, frontend_entries: pluginFrontendEntries(p.manifest) }, effective: { enabled: true } })) } as never;
  });
});
const at = (element: React.ReactNode) => render(<MemoryRouter initialEntries={['/spaces/space/projects/project']}><Routes><Route path="/spaces/:spaceId/projects/:projectId" element={element} /></Routes></MemoryRouter>);

it('offers a Project-level entry only where its binding is effective, beside unbound-model entries', async () => {
  at(<ProjectPluginNavigation onNavigate={() => {}} />);
  await waitFor(() => expect(queryOperation).toHaveBeenCalledWith('official_plugin.project_binding.list', { project_id: 'project' }, { spaceId: 'space' }));
  expect(screen.getByRole('link', { name: 'Records' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Applications' })).toBeNull();
  state = { status: 'bound', effective: true, can_manage: true };
  fireEvent.focus(window);
  await screen.findByRole('link', { name: 'Applications' });
});

it('keeps a Project-level slot closed until the binding is effective', async () => {
  const first = at(<PluginSlot pluginId="bind_probe" entryId="records" />);
  await screen.findByText('This module is disabled or you no longer have access.');
  expect(screen.queryByText('Bound records view')).toBeNull();
  first.unmount();
  state = { status: 'bound', effective: true, can_manage: true };
  at(<PluginSlot pluginId="bind_probe" entryId="records" />);
  await screen.findByText('Bound records view');
});

it('lets an owner-level person bind with one keyed command and shows state only to others', async () => {
  vi.mocked(callOperation).mockResolvedValue({ status: 'succeeded', data: {} } as never);
  const view = at(<ProjectPluginBindingsCard projectId="project" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Bind Applications to this Project' }));
  await waitFor(() => expect(callOperation).toHaveBeenCalledWith('official_plugin.project_binding.bind', { plugin_id: 'bind_probe', project_id: 'project' }, expect.any(String), { spaceId: 'space' }));
  view.unmount();
  state = { status: 'bound', effective: true, can_manage: false };
  at(<ProjectPluginBindingsCard projectId="project" />);
  await screen.findByText('Bound');
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('Only the Project owner or a Space owner/admin can change bindings.')).toBeTruthy();
});

it('closes an independently mounted slot as soon as its Project binding change is announced', async () => {
  state = { status: 'bound', effective: true, can_manage: true };
  at(<PluginSlot pluginId="bind_probe" entryId="records" />);
  await screen.findByText('Bound records view');
  state = { status: 'unbound', effective: false, can_manage: true };
  // Another Project's announcement leaves this slot alone.
  announceProjectPluginBindingsChanged('other-project');
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.getByText('Bound records view')).toBeTruthy();
  announceProjectPluginBindingsChanged('project');
  await screen.findByText('This module is disabled or you no longer have access.');
  expect(screen.queryByText('Bound records view')).toBeNull();
});

it('follows an enable or disable on the Plugins page at once, in Project navigation and a mounted slot', async () => {
  state = { status: 'bound', effective: true, can_manage: true };
  at(<><ProjectPluginNavigation onNavigate={() => {}} /><PluginSlot pluginId="bind_probe" entryId="records" /></>);
  await screen.findByRole('link', { name: 'Applications' });
  await screen.findByText('Bound records view');
  // Disabled in this tab: no focus change, no poll; the announcement alone closes both.
  state = { status: 'bound', effective: false, can_manage: true };
  announcePluginStateChanged();
  await waitFor(() => expect(screen.queryByRole('link', { name: 'Applications' })).toBeNull());
  await screen.findByText('This module is disabled or you no longer have access.');
  expect(screen.queryByText('Bound records view')).toBeNull();
  state = { status: 'bound', effective: true, can_manage: true };
  announcePluginStateChanged();
  await screen.findByRole('link', { name: 'Applications' });
  await screen.findByText('Bound records view');
});

it('lets a Space admin outside the Project manage a binding while saying they cannot open its data', async () => {
  state = { status: 'bound', effective: false, can_manage: true };
  at(<ProjectPluginBindingsCard projectId="project" />);
  await screen.findByRole('button', { name: 'Unbind Applications from this Project' });
  expect(screen.getByText('You can change this binding, but only Project members can open its data.')).toBeTruthy();
});
