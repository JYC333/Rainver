import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authApi } from '../../api/client'
import { setLocale } from '../../i18n'
import { UsersSecurityPanel } from './UsersSecurityPanel'

describe('Instance invitation entry in Users & Security', () => {
  beforeEach(() => {
    setLocale('en')
    vi.spyOn(authApi, 'adminUsers').mockResolvedValue([])
    vi.spyOn(authApi, 'adminRegistrationIntents').mockResolvedValue([])
  })
  afterEach(() => vi.restoreAllMocks())

  it('creates a fragment invitation beside account controls without joining a Space', async () => {
    const invite = vi.spyOn(authApi, 'adminInvite').mockResolvedValue({ id: 'invitation-1', invited_email: 'new@example.test', token: 'one-use-token', expires_at: '2026-11-12T00:00:00Z' })
    render(<UsersSecurityPanel />)
    expect(screen.getByText('Users & Security')).toBeInTheDocument()
    expect(screen.getByText('Pending registration intents')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Invited email' }), { target: { value: 'new@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate invitation' }))
    const link = await screen.findByRole('textbox', { name: 'Registration invitation for new@example.test' })
    expect(invite).toHaveBeenCalledWith('new@example.test')
    expect(link).toHaveValue(`${window.location.origin}/invitations/claim#token=one-use-token`)
    expect(screen.getByRole('textbox', { name: 'Invited email' })).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss link' }))
    expect(screen.queryByDisplayValue(/one-use-token/)).not.toBeInTheDocument()
  })

  it('keeps the email for retry after failure, with translated guidance', async () => {
    setLocale('zh-CN')
    const invite = vi.spyOn(authApi, 'adminInvite').mockRejectedValue(new Error('Forbidden'))
    render(<UsersSecurityPanel />)
    fireEvent.change(screen.getByRole('textbox', { name: '受邀邮箱' }), { target: { value: 'new@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法生成邀请')
    expect(screen.getByRole('textbox', { name: '受邀邮箱' })).toHaveValue('new@example.test')
    await waitFor(() => expect(screen.getByRole('button', { name: '生成邀请链接' })).toBeEnabled())
    expect(invite).toHaveBeenCalledTimes(1)
  })
})
