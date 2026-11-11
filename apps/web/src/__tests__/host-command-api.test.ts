// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiRequestError, ambientSessionsApi, hostsApi, ordinaryToolsApi, setSpaceContext } from '../api/client';

/**
 * Host commands from the browser (`.agent/modules/hosts.md` "Host commands"):
 * one keyed command at its retained URL, then read-only polling of the
 * owner-only status read in the receipt's Space. Never resubmitted; an
 * unknown outcome is reported, never shown as success.
 */
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const receipt = (id = 'command/one') => ({ status: 'succeeded', data: { id, space_id: 'original-space', host_id: 'host/one', kind: 'runtime_install', job_id: 'job', status: 'pending' } });
const status = (value: string, extra: Record<string, unknown> = {}) => ({
  id: 'command/one', space_id: 'original-space', host_id: 'host/one', kind: 'runtime_install', job_id: 'job', status: value,
  error: null, result: null, created_at: '2026-11-11T00:00:00.000Z', updated_at: '2026-11-11T00:00:00.000Z', ...extra,
});
beforeEach(() => { setSpaceContext('current-space'); vi.stubGlobal('fetch', vi.fn()); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const calls = () => vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, key: new Headers(init?.headers).get('Idempotency-Key'), space: new Headers(init?.headers).get('X-Rainver-Space-Id') }));

it('installs through one keyed command and releases the result only from the status read', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(receipt(), 202))
    .mockResolvedValueOnce(response(status('dispatched')))
    .mockResolvedValueOnce(response(status('succeeded', { result: { host_id: 'host/one', runtime_key: 'codex', ok: true, error: null, installation: 'managed:1.0.0' } })));
  const done = hostsApi.installRuntime('host/one', 'codex', '1.0.0', 'install-key');
  await vi.runAllTimersAsync();
  expect(await done).toEqual({ host_id: 'host/one', runtime_key: 'codex', ok: true, error: null, installation: 'managed:1.0.0' });
  expect(calls()).toEqual([
    { url: '/api/v1/hosts/host%2Fone/installations/codex', method: 'POST', key: 'install-key', space: 'current-space' },
    { url: '/api/v1/hosts/host%2Fone/commands/command%2Fone', method: 'GET', key: null, space: 'original-space' },
    { url: '/api/v1/hosts/host%2Fone/commands/command%2Fone', method: 'GET', key: null, space: 'original-space' },
  ]);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual({ expected_version: '1.0.0' });
});

it('reports a Host outcome it cannot prove as needing attention, never as success, and does not resubmit', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(receipt(), 202))
    .mockResolvedValueOnce(response(status('needs_attention', { error: { code: 'host_command_outcome_unknown', detail: 'The Host did not answer' } })));
  const done = hostsApi.uninstallRuntime('host/one', 'codex', 'managed:1.0.0', 'remove-key').catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  const error = await done as ApiRequestError;
  expect(error).toBeInstanceOf(ApiRequestError);
  expect(error.message).toMatch(/may have acted/);
  expect(error.payload).toMatchObject({ error: { metadata: { code: 'host_command_outcome_unknown', command_id: 'command/one', status: 'needs_attention' } } });
  expect(calls().filter((call) => call.method !== 'GET')).toEqual([
    { url: '/api/v1/hosts/host%2Fone/installations/codex/managed%3A1.0.0', method: 'DELETE', key: 'remove-key', space: 'current-space' },
  ]);
});

it('surfaces a deterministic admission refusal from the command itself without polling', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({ error: { code: 'operation_conflict', message: 'busy', metadata: { code: 'host_command_busy', command_id: 'earlier' } } }, 409));
  await expect(ordinaryToolsApi.install('host/one', 'gh', 'tool-key')).rejects.toBeInstanceOf(ApiRequestError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reads the account back after a logout command and keeps its logout report', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response({ ...receipt(), data: { ...receipt().data, kind: 'ordinary_account_logout' } }, 202))
    .mockResolvedValueOnce(response(status('succeeded', { kind: 'ordinary_account_logout', result: { host_id: 'host/one', tool_id: 'gh', status: null, logout: { local_cleared: true, remote_revocation: 'not_applicable' } } })))
    .mockResolvedValueOnce(response({ host_id: 'host/one', tool_id: 'gh', availability: 'live', status: { signed_in: false }, reason: null, session_active: false }));
  const done = ordinaryToolsApi.logout('host/one', 'gh', 'logout-key');
  await vi.runAllTimersAsync();
  expect(await done).toMatchObject({ availability: 'live', logout: { local_cleared: true } });
  expect(calls().map((call) => `${call.method} ${call.url}`)).toEqual([
    'POST /api/v1/hosts/host%2Fone/ordinary-tools/gh/account/logout',
    'GET /api/v1/hosts/host%2Fone/commands/command%2Fone',
    'GET /api/v1/hosts/host%2Fone/ordinary-tools/gh/account',
  ]);
});

it('keys the transactional Host and Location commands and returns their exact outputs', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response({ status: 'succeeded', data: { host_id: 'host/one', space_id: 'original-space', provider_proxy_base_url: null } }))
    .mockResolvedValueOnce(response({ status: 'succeeded', data: { location_id: 'loc', space_id: 'original-space', policy: { location_id: 'loc', sync: false } } }))
    .mockResolvedValueOnce(response({ status: 'succeeded', data: { space_id: 'original-space', deleted: 2 } }));
  expect(await hostsApi.setProviderProxyUrl('host/one', '', 'proxy-key')).toEqual({ host_id: 'host/one', provider_proxy_base_url: null });
  expect(await ambientSessionsApi.dismiss('loc', 'dismiss-key')).toEqual({ location_id: 'loc', sync: false });
  expect(await ambientSessionsApi.remove(['a', 'b'], 'delete-key')).toEqual({ deleted: 2 });
  expect(calls().map((call) => [call.method, call.url, call.key])).toEqual([
    ['PUT', '/api/v1/hosts/host%2Fone/provider-proxy-url', 'proxy-key'],
    ['POST', '/api/v1/workspace-locations/loc/ambient-sessions/dismiss', 'dismiss-key'],
    ['POST', '/api/v1/imported-sessions/delete', 'delete-key'],
  ]);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual({ base_url: null });
});

it('answers a history import that committed sessions and then stopped with its real report, never as nothing happened', async () => {
  const report = { location_id: 'loc', runtime_key: 'claude_code', installation: 'own', sessions_seen: 2, sessions_written: 1, records_inserted: 3, records_unchanged: 0,
    records_conflicted: 0, marked_gone: 0, usage_events: 0, usage_failures: 0, malformed_sessions: 0, failed_sessions: 0, error: 'host_disconnected' };
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(receipt(), 202))
    .mockResolvedValueOnce(response(status('needs_attention', { kind: 'ambient_sync', error: { code: 'ambient_sync_partial', detail: 'host_disconnected' }, result: report })))
    .mockResolvedValueOnce(response(receipt('command/two'), 202))
    .mockResolvedValueOnce(response(status('needs_attention', { id: 'command/two', kind: 'ambient_sync', error: { code: 'host_command_outcome_unknown', detail: null } })));
  const partial = ambientSessionsApi.sync('loc', { runtime_key: 'claude_code' }, 'sync-key');
  await vi.runAllTimersAsync();
  expect(await partial).toEqual(report);
  // Without a released report the outcome stays unknown: an error, never a success.
  const unknown = ambientSessionsApi.sync('loc', { runtime_key: 'claude_code' }, 'sync-key-2').catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  const error = await unknown;
  expect(error).toBeInstanceOf(ApiRequestError);
  expect((error as ApiRequestError).message).toMatch(/outcome is unknown/);
  expect(calls().filter((call) => call.method === 'POST').map((call) => call.key)).toEqual(['sync-key', 'sync-key-2']);
});

it('keeps polling through a lost status read instead of reporting the command as failed', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(receipt(), 202))
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(response({ error: { code: 'operation_temporarily_unavailable' } }, 503))
    .mockResolvedValueOnce(response(status('succeeded', { result: { host_id: 'host/one', runtime_key: 'codex', ok: true, error: null, installation: 'managed:1.0.0' } })));
  const done = hostsApi.installRuntime('host/one', 'codex', '1.0.0', 'install-key');
  await vi.runAllTimersAsync();
  expect(await done).toMatchObject({ ok: true, installation: 'managed:1.0.0' });
  expect(calls().filter((call) => call.method === 'POST')).toHaveLength(1);
});
