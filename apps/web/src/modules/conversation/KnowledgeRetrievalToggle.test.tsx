import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeRetrievalToggle } from './KnowledgeRetrievalToggle'
import { runtimeContextApi } from '../../api/client'

vi.mock('../../api/client', () => ({
  runtimeContextApi: {
    retrievalSwitch: vi.fn(),
    setRetrievalSwitch: vi.fn(),
  },
}))

const SCOPE = '11111111-1111-4111-8111-111111111111'

describe('KnowledgeRetrievalToggle', () => {
  beforeEach(() => {
    vi.mocked(runtimeContextApi.retrievalSwitch).mockReset()
    vi.mocked(runtimeContextApi.setRetrievalSwitch).mockReset()
  })

  it('starts off for a new conversation and keeps the person\'s choice on the server', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(runtimeContextApi.retrievalSwitch).mockResolvedValue({ work_context_scope_id: SCOPE, enabled: false, preferred_domains: [], setup_version: null })
    vi.mocked(runtimeContextApi.setRetrievalSwitch).mockResolvedValue({ work_context_scope_id: SCOPE, enabled: true, preferred_domains: [], setup_version: 1 })
    render(<KnowledgeRetrievalToggle scopeId={SCOPE} />)

    const button = await screen.findByRole('button', { name: /Knowledge: off/ })
    await waitFor(() => expect(button).toBeEnabled())
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await user.click(button)
    expect(runtimeContextApi.setRetrievalSwitch).toHaveBeenCalledWith(SCOPE, { enabled: true })
    expect(await screen.findByRole('button', { name: /Knowledge: on/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Search in' })).toBeInTheDocument()
  })

  it('narrows the searched domains from the full set', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(runtimeContextApi.retrievalSwitch).mockResolvedValue({ work_context_scope_id: SCOPE, enabled: true, preferred_domains: [], setup_version: 2 })
    vi.mocked(runtimeContextApi.setRetrievalSwitch).mockResolvedValue({ work_context_scope_id: SCOPE, enabled: true, preferred_domains: ['knowledge', 'sources', 'projects', 'inquiry'], setup_version: 3 })
    render(<KnowledgeRetrievalToggle scopeId={SCOPE} />)

    await user.click(await screen.findByRole('button', { name: 'Search in' }))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Memory' }))
    expect(runtimeContextApi.setRetrievalSwitch).toHaveBeenCalledWith(SCOPE, {
      enabled: true,
      preferred_domains: ['knowledge', 'sources', 'projects', 'inquiry'],
    })
  })

  it('cannot be set before the conversation exists', () => {
    render(<KnowledgeRetrievalToggle scopeId={null} />)
    expect(screen.getByRole('button', { name: /Knowledge: off/ })).toBeDisabled()
    expect(runtimeContextApi.retrievalSwitch).not.toHaveBeenCalled()
  })
})
