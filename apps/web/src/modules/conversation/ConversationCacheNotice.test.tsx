import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConversationCacheNotice, isPromptCacheExpired } from './ConversationCacheNotice'
const base = { agent_id: 'claude', runtime_profile_id: 'profile', runtime_key: 'claude_code', runtime_installation: 'own', context_tokens: 1000,
  last_run_ended_at: new Date(Date.now() - 7200000).toISOString(), prompt_cache_ttl_seconds: 3600 }
describe('visible prompt cache expiry', () => {
  it('shows a small non-manager session with expired declared TTL', () => {
    render(<ConversationCacheNotice runtimes={[base]} nameForAgent={() => 'Claude'} disabled={false} onReset={async () => {}} />)
    expect(screen.getByText(/Claude: prompt cache is estimated to have expired/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New session for Claude' })).toBeEnabled()
  })
  it('does not assume every runtime has a one-hour TTL', () => {
    expect(isPromptCacheExpired({ ...base, prompt_cache_ttl_seconds: 14400 })).toBe(false)
    expect(isPromptCacheExpired({ ...base, prompt_cache_ttl_seconds: null })).toBe(false)
    expect(isPromptCacheExpired({ ...base, last_run_ended_at: null })).toBe(false)
  })
  it('does not offer reset while execution is locked or the viewer cannot write', () => {
    render(<ConversationCacheNotice runtimes={[base]} nameForAgent={() => 'Claude'} disabled onReset={async () => {}} />)
    expect(screen.getByRole('button', { name: 'New session for Claude' })).toBeDisabled()
  })
})
