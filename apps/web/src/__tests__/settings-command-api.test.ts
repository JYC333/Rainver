// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiRequestError, deploymentApi, networkProfilesApi, pluginsApi, providersApi, setSpaceContext } from '../api/client';

/**
 * Settings / tool configuration commands from the browser (`SYSTEM_ACTIONS.md`
 * "System settings and tool configuration commands"): each is one keyed
 * command at its retained URL. Transactional ones answer the outcome
 * envelope; the ones with vendor, filesystem or network IO answer a receipt
 * and the result is read from exactly that command's status, never by
 * resubmitting and never from a list.
 */
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const receipt = (kind: string) => ({ status: 'succeeded', data: { id: 'command/one', space_id: 'original-space', kind, job_id: 'job', status: 'pending' } });
const status = (kind: string, value: string, extra: Record<string, unknown> = {}) => ({
  id: 'command/one', space_id: 'original-space', kind, job_id: 'job', status: value,
  error: null, result: null, created_at: '2026-11-11T00:00:00.000Z', updated_at: '2026-11-11T00:00:00.000Z', ...extra,
});
beforeEach(() => { setSpaceContext('current-space'); vi.stubGlobal('fetch', vi.fn()); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const calls = () => vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, key: new Headers(init?.headers).get('Idempotency-Key'), space: new Headers(init?.headers).get('X-Rainver-Space-Id') }));

it('tests a connection through one keyed command and reads its result from that command only', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(receipt('provider_test'), 202))
    .mockResolvedValueOnce(response(status('provider_test', 'dispatched')))
    .mockResolvedValueOnce(response(status('provider_test', 'succeeded', { result: { success: true, message: 'Connection successful', model: 'm' } })));
  const done = providersApi.test('provider/one', 'test-key');
  await vi.runAllTimersAsync();
  expect(await done).toEqual({ success: true, message: 'Connection successful', model: 'm' });
  expect(calls()).toEqual([
    { url: '/api/v1/providers/provider%2Fone/test', method: 'POST', key: 'test-key', space: 'current-space' },
    { url: '/api/v1/system/commands/command%2Fone', method: 'GET', key: null, space: 'original-space' },
    { url: '/api/v1/system/commands/command%2Fone', method: 'GET', key: null, space: 'original-space' },
  ]);
});

it('reports an unprovable outcome as needing attention and never resubmits', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(receipt('plugin_install'), 202))
    .mockResolvedValueOnce(response(status('plugin_install', 'needs_attention', { error: { code: 'system_command_outcome_unknown', detail: 'did not report' } })));
  const done = pluginsApi.install('diary', 'install-key').catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  const error = await done as ApiRequestError;
  expect(error).toBeInstanceOf(ApiRequestError);
  expect(error.message).toMatch(/outcome is unknown/);
  expect(error.payload).toMatchObject({ error: { metadata: { code: 'system_command_outcome_unknown', command_id: 'command/one', status: 'needs_attention' } } });
  expect(calls().filter((call) => call.method !== 'GET')).toEqual([{ url: '/api/v1/plugins/diary/install', method: 'POST', key: 'install-key', space: 'current-space' }]);
});

it('ends on a refused status read instead of reading on', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(receipt('provider_plan_usage_refresh'), 202))
    .mockResolvedValueOnce(response({ error: { code: 'operation_not_found', message: 'operation not found' } }, 404));
  const done = providersApi.refreshPlanUsage('provider/one', 'plan-key').catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await done).toMatchObject({ status: 404 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('unwraps a transactional command outcome and sends its key', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response({ status: 'succeeded', data: { id: 'job-1', status: 'queued' } }, 201))
    .mockResolvedValueOnce(response({ status: 'succeeded', data: { profile_id: 'np', space_id: 's', deleted: true } }));
  expect(await deploymentApi.createJob('update', 'deploy-key')).toEqual({ id: 'job-1', status: 'queued' });
  await expect(networkProfilesApi.delete('np', 'np-key')).resolves.toBeUndefined();
  expect(calls()).toEqual([
    { url: '/api/v1/deployments/jobs', method: 'POST', key: 'deploy-key', space: 'current-space' },
    { url: '/api/v1/network-profiles/np', method: 'DELETE', key: 'np-key', space: 'current-space' },
  ]);
});

it('surfaces a deterministic refusal with its message and does not poll', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({ error: { code: 'operation_conflict', message: "'goose' is still installed on Desk", metadata: { code: 'acp_agent_installed' } } }, 409));
  const error = await providersApi.create({ name: 'n', provider_type: 'openai', base_url: 'https://x' }, 'k').catch((e: unknown) => e) as ApiRequestError;
  expect(error).toMatchObject({ status: 409, code: 'operation_conflict', message: "'goose' is still installed on Desk" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
