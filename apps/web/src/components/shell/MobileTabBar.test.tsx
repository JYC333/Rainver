import { fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { MobileTabBar } from './MobileTabBar'

function mount(props = {}) {
  return render(<MemoryRouter initialEntries={['/spaces/team/projects/example/conversations']}><MobileTabBar spaceId="team" pendingReviewCount={3} {...props} /></MemoryRouter>)
}

describe('mobile navigation', () => {
  it('links to personal work and scoped projects, keeping project conversations selected', () => {
    mount()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(nav).getAllByRole('link')).toHaveLength(3)
    expect(screen.getByRole('link', { name: 'Agent Work' })).toHaveAttribute('href', '/agent-work')
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/spaces/team/projects')
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page')
    expect(within(screen.getByRole('button', { name: /More/ })).getByRole('status')).toBeInTheDocument()
  })

  it('keeps member destinations accessible and closes More after selection', async () => {
    mount({ pluginModules: [{ id: 'diary', label: 'Diary', path: '/diary', scope: 'space', icon: 'book' }] })
    fireEvent.click(screen.getByRole('button', { name: /More/ }))
    const menu = screen.getByRole('dialog')
    expect(within(menu).getByRole('link', { name: 'Inbox' })).toHaveAttribute('href', '/spaces/team/activity')
    expect(within(menu).getByRole('link', { name: 'Diary' })).toHaveAttribute('href', '/spaces/team/diary')
    expect(within(menu).queryByRole('link', { name: 'Instance Settings' })).not.toBeInTheDocument()
    expect(within(menu).queryByRole('link', { name: 'Space Settings' })).not.toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('link', { name: 'Reading' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /More/ })).toHaveAttribute('aria-current', 'true')
  })

  it('shows authorized admin destinations and supports dismissing the menu', () => {
    mount({ canManageSpace: true, canManageInstance: true })
    fireEvent.click(screen.getByRole('button', { name: /More/ }))
    expect(screen.getByRole('link', { name: 'Space Settings' })).toHaveAttribute('href', '/spaces/team/space-settings')
    expect(screen.getByRole('link', { name: 'Instance Settings' })).toHaveAttribute('href', '/instance-settings')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
