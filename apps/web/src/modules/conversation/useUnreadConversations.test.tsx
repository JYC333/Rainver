import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { agentAttentionApi } from '../../api/client'
import { AttentionStore } from '../agent_work/attentionStore'
import { page, work } from '../agent_work/fixtures.test-support'
import { useUnreadConversations } from './useUnreadConversations'

let context: { store: AttentionStore } | null
vi.mock('../agent_work/AgentAttentionProvider', () => ({
  useOptionalAttention: () => context,
  useAttention: () => context,
}))
vi.mock('../../api/client', async original => {
  const actual = await original<typeof import('../../api/client')>()
  return { ...actual, agentAttentionApi: { ...actual.agentAttentionApi, list: vi.fn() } }
})
beforeEach(() => { vi.clearAllMocks(); context = { store: new AttentionStore() } })

it('loads later work pages and projects Task replies without marking anything read', async () => {
  const sessionWork = work({ identity: { kind: 'session', source_id: 'session-one' } })
  const taskWork = work({ work_key: 'task-key', identity: { kind: 'task', source_id: 'task' }, unread_session_ids: ['session-two'] })
  vi.mocked(agentAttentionApi.list)
    .mockResolvedValueOnce(page([sessionWork], { next_cursor: 'next' }))
    .mockResolvedValueOnce(page([taskWork, work({ work_key: 'other', space_id: 'other-space', identity: { kind: 'session', source_id: 'hidden' } })]))
  const { result } = renderHook(() => useUnreadConversations('space-b', 'project-b'))
  await waitFor(() => expect([...result.current].sort()).toEqual(['session-one', 'session-two']))
  expect(agentAttentionApi.list).toHaveBeenCalledTimes(2)
  expect(vi.mocked(agentAttentionApi.list).mock.calls[1][0]).toMatchObject({ cursor: 'next' })
  // The canonical reading store changes, as when an actual conversation is read elsewhere.
  act(() => context!.store.update(sessionWork.work_key, { ...sessionWork.read_states[0]!, unread: false, state_version: 1 }))
  await waitFor(() => expect([...result.current]).toEqual(['session-two']))
  act(() => context!.store.update(taskWork.work_key, { ...taskWork.read_states[0]!, unread: false, state_version: 1 }))
  expect(result.current.size).toBe(0)
})

it('renders safely without an account provider and does not request account data', () => {
  context = null
  const { result } = renderHook(() => useUnreadConversations('space-b', 'project-b'))
  expect(result.current.size).toBe(0)
  expect(agentAttentionApi.list).not.toHaveBeenCalled()
})
