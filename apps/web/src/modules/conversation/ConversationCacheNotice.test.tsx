import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConversationCacheNotice, isPromptCacheExpired } from './ConversationCacheNotice'
const base = { agent_id: 'claude', runtime_profile_id: 'profile', runtime_key: 'claude_code', runtime_installation: 'own', context_tokens: 1000,
  last_run_ended_at: new Date(Date.now() - 7200000).toISOString(), prompt_cache_ttl_seconds: 3600 }
describe('visible prompt cache expiry', () => {
  it('shows a small non-manager session with expired declared TTL', () => {
    render(<ConversationCacheNotice runtimes={[base]} nameForAgent={() => 'Claude'} disabled={false} onReset={async () => {}} />)
    expect(screen.getByText('Prompt cache estimated expired (1)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New session for Claude' })).not.toBeVisible()
    fireEvent.click(screen.getByText('Prompt cache estimated expired (1)'))
    expect(screen.getByRole('button', { name: 'New session for Claude' })).toBeEnabled()
  })
  it('aggregates multiple agents into one default row and removes it when none expire', () => {
    const { rerender } = render(<ConversationCacheNotice runtimes={[base, { ...base, agent_id: 'other' }]} nameForAgent={id => id} disabled={false} onReset={async () => {}} />)
    expect(screen.getByText('Prompt cache estimated expired (2)')).toBeInTheDocument()
    for (const button of screen.getAllByRole('button')) expect(button).not.toBeVisible()
    rerender(<ConversationCacheNotice runtimes={[]} nameForAgent={id => id} disabled={false} onReset={async () => {}} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('does not assume every runtime has a one-hour TTL', () => {
    expect(isPromptCacheExpired({ ...base, prompt_cache_ttl_seconds: 14400 })).toBe(false)
    expect(isPromptCacheExpired({ ...base, prompt_cache_ttl_seconds: null })).toBe(false)
    expect(isPromptCacheExpired({ ...base, last_run_ended_at: null })).toBe(false)
  })
  it('does not offer reset while execution is locked or the viewer cannot write', () => {
    render(<ConversationCacheNotice runtimes={[base]} nameForAgent={() => 'Claude'} disabled onReset={async () => {}} />)
    fireEvent.click(screen.getByText('Prompt cache estimated expired (1)'))
    expect(screen.getByRole('button', { name: 'New session for Claude' })).toBeDisabled()
  })
})
