import { StrictMode } from 'react';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { beforeEach, it, expect, vi } from 'vitest';
import { probeManifest } from '../../../../../server/test/fixtures/pluginOperation/manifest';
import { pluginFrontendEntries } from '@rainver/protocol';
import { PluginSlot } from './PluginSlot';
import type { PluginSlotContext } from './slotTypes';
import { pluginsApi, projectsApi, queryPluginOperation, callPluginOperation } from '../../api/client';
const captured = vi.hoisted(() => ({
  context: null as PluginSlotContext | null,
  fail: false
}));
vi.mock('../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    userId: 'user',
    activeSpaceId: 'space',
    preferredSpaceId: 'space'
  })
}));
vi.mock('./useEffectivePlugins', () => ({
  useEffectivePlugins: () => ({
    isEnabled: () => true
  })
}));
vi.mock('./manifestCatalog', async () => {
  const {
    probeManifest
  } = await import('../../../../../server/test/fixtures/pluginOperation/manifest');
  const component = ({
    ctx
  }: {
    ctx: PluginSlotContext;
  }) => {
    captured.context = ctx;
    if (captured.fail) throw new Error('private exception detail');
    return <div>Bundled records</div>;
  };
  const bundle = {
    manifest: probeManifest,
    load: async () => ({
      default: {
        records: component
      }
    })
  };
  return {
    bundledPlugin: (id: string) => id === 'operation_probe' ? bundle : undefined,
    bundledOperationPlugins: [bundle],
    manifestModules: []
  };
});
vi.mock('../../api/client', () => ({
  pluginsApi: {
    list: vi.fn()
  },
  projectsApi: {
    get: vi.fn(async () => ({
      current_user_can_read: true
    }))
  },
  queryPluginOperation: vi.fn(),
  callPluginOperation: vi.fn()
}));
function Harness() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate('/spaces/space/projects/other')}>Change Project</button><Routes><Route path="/spaces/:spaceId/projects/:projectId" element={<PluginSlot pluginId="operation_probe" entryId="records" />} /></Routes></>;
}
const mount = () => render(<StrictMode><MemoryRouter initialEntries={['/spaces/space/projects/project']}><Harness /></MemoryRouter></StrictMode>);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(projectsApi.get).mockResolvedValue({
    current_user_can_read: true
  } as never);
  captured.context = null;
  captured.fail = false;
  vi.mocked(pluginsApi.list).mockResolvedValue({
    items: [{
      descriptor: {
        id: 'operation_probe',
        version: probeManifest.version,
        frontend_entries: pluginFrontendEntries(probeManifest)
      },
      effective: {
        enabled: true
      }
    }]
  } as never);
  vi.mocked(queryPluginOperation).mockResolvedValue({
    status: 'succeeded',
    data: {
      values: ['safe']
    }
  });
  vi.mocked(callPluginOperation).mockResolvedValue({
    status: 'succeeded',
    data: {
      values: ['saved']
    }
  });
});
it('hosts a declared local component in StrictMode with only scoped ops/ui ports', async () => {
  mount();
  await screen.findByText('Bundled records');
  const ctx = captured.context!;
  expect(Object.keys(ctx).sort()).toEqual(['ops', 'projectId', 'spaceId', 'ui']);
  expect(ctx.projectId).toBe('project');
  await expect(ctx.ops.query('plugin.operation_probe.record.list', {})).resolves.toEqual({
    status: 'succeeded',
    data: {
      values: ['safe']
    }
  });
  await expect(ctx.ops.query('task.list' as never, {})).rejects.toThrow('Undeclared');
  expect(queryPluginOperation).toHaveBeenCalledTimes(1);
  await ctx.ops.command('plugin.operation_probe.record.write', {
    value: 'saved'
  }, 'explicit-key');
  expect(callPluginOperation).toHaveBeenCalledWith('plugin.operation_probe.record.write', {
    key: 'one',
    value: 'saved'
  }, 'explicit-key', expect.objectContaining({
    spaceId: 'space'
  }));
});
it('expires the old Project port and discards a late response when the route changes', async () => {
  mount();
  await screen.findByText('Bundled records');
  const old = captured.context!;
  let complete!: (value: unknown) => void;
  vi.mocked(queryPluginOperation).mockImplementationOnce(() => new Promise(r => {
    complete = r;
  }) as never);
  const result = old.ops.query('plugin.operation_probe.record.list', {});
  const rejected = expect(result).rejects.toMatchObject({
    name: 'AbortError'
  });
  await waitFor(() => expect(queryPluginOperation).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('Change Project'));
  await waitFor(() => expect(captured.context?.projectId).toBe('other'));
  await act(async () => complete({
    status: 'succeeded',
    data: {
      values: ['old secret']
    }
  }));
  await rejected;
  await expect(old.ops.command('plugin.operation_probe.record.write', {}, 'old-key')).rejects.toMatchObject({
    name: 'AbortError'
  });
});
it('unmounts previously visible content on a real permission refusal', async () => {
  mount();
  await screen.findByText('Bundled records');
  vi.mocked(queryPluginOperation).mockRejectedValueOnce(Object.assign(new Error('not found'), {
    status: 404
  }));
  await act(async () => {
    await expect(captured.context!.ops.query('plugin.operation_probe.record.list', {})).rejects.toThrow('not found');
  });
  expect(screen.queryByText('Bundled records')).toBeNull();
  expect(screen.getByText('This module is disabled or you no longer have access.')).toBeInTheDocument();
});
it('does not load a mismatched descriptor or accept invalid output', async () => {
  mount();
  await screen.findByText('Bundled records');
  vi.mocked(queryPluginOperation).mockResolvedValueOnce({
    status: 'succeeded',
    data: {
      unexpected: true
    }
  } as never);
  await expect(captured.context!.ops.query('plugin.operation_probe.record.list', {})).rejects.toThrow();
  vi.mocked(pluginsApi.list).mockResolvedValue({
    items: []
  } as never);
  act(() => window.dispatchEvent(new Event('focus')));
  await screen.findByText('This module is disabled or you no longer have access.');
  expect(screen.queryByText('Bundled records')).toBeNull();
});
it('fails closed on a bundled/server descriptor mismatch', async () => {
  vi.mocked(pluginsApi.list).mockResolvedValue({
    items: [{
      descriptor: {
        id: 'operation_probe',
        version: '99.0.0',
        frontend_entries: pluginFrontendEntries(probeManifest)
      },
      effective: {
        enabled: true
      }
    }]
  } as never);
  mount();
  await screen.findByText('The module could not be loaded.');
  expect(screen.queryByText('Bundled records')).toBeNull();
});
it('uses the existing error boundary with a generic plugin fallback', async () => {
  captured.fail = true;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mount();
    await screen.findByText('The module could not be loaded.');
    expect(screen.queryByText('private exception detail')).toBeNull();
  } finally {
    log.mockRestore();
  }
});
it('clears the view when the Project preflight itself refuses access', async () => {
  mount();
  await screen.findByText('Bundled records');
  vi.mocked(projectsApi.get).mockRejectedValueOnce(Object.assign(new Error('Project not found'), {
    status: 404
  }));
  await act(async () => {
    await expect(captured.context!.ops.query('plugin.operation_probe.record.list', {})).rejects.toThrow('Project not found');
  });
  expect(screen.queryByText('Bundled records')).toBeNull();
  expect(queryPluginOperation).not.toHaveBeenCalled();
});
it('does not start a write after the Project preflight outlives its scope', async () => {
  mount();
  await screen.findByText('Bundled records');
  const old = captured.context!;
  let finish!: (value: unknown) => void;
  vi.mocked(projectsApi.get).mockImplementationOnce(() => new Promise(r => {
    finish = r;
  }) as never);
  const pending = old.ops.command('plugin.operation_probe.record.write', {
    value: 'old'
  }, 'old-key');
  const refused = expect(pending).rejects.toMatchObject({
    name: 'AbortError'
  });
  fireEvent.click(screen.getByText('Change Project'));
  await waitFor(() => expect(captured.context?.projectId).toBe('other'));
  await act(async () => finish({
    current_user_can_read: true
  }));
  await refused;
  expect(callPluginOperation).not.toHaveBeenCalled();
});


it('uses existing module translations with authored-title fallback', async () => {
  const { default: i18n } = await import('../../i18n');
  await i18n.changeLanguage('zh-CN');
  mount();
  expect(await screen.findByRole('region', {name:'记录'})).toBeTruthy();
  await act(() => i18n.changeLanguage('en'));
  expect(screen.getByRole('region', {name:'Records'})).toBeTruthy();
  expect(i18n.t('modules.plugin.untranslated.entry', {defaultValue:'Authored title'})).toBe('Authored title');
});
