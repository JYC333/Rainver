import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { SettingsNavigation } from './SettingsNavigation'

vi.mock('../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-a', preferredSpaceId: 'space-a' }) }))

it.each([
  ['/spaces/space-a/usage', 'Settings', '/settings'],
  ['/spaces/space-a/providers/provider-a', 'Settings', '/settings'],
  ['/settings/security', 'Settings', '/settings'],
  ['/spaces/space-a/plugins', 'Space Settings', '/spaces/space-a/space-settings'],
  ['/spaces/space-a/prompts', 'Space Settings', '/spaces/space-a/space-settings'],
  ['/instance-settings/details', 'Instance Settings', '/instance-settings'],
])('returns a directly opened child %s to its settings parent', async (path, parent, target) => {
  render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path={target} element={<p>Parent destination</p>} />
    <Route path="*" element={<SettingsNavigation />} />
  </Routes></MemoryRouter>)
  const navigation = screen.getByRole('navigation', { name: 'Settings navigation' })
  const back = within(navigation).getByRole('link', { name: `Back to ${parent}` })
  expect(back).toHaveAttribute('href', target)
  expect(within(navigation).getAllByRole('link')).toHaveLength(1)
  await userEvent.click(back)
  expect(await screen.findByText('Parent destination')).toBeInTheDocument()
})

it.each(['/settings', '/instance-settings', '/spaces/space-a/space-settings'])('keeps %s free of the extra navigation row', path => {
  render(<MemoryRouter initialEntries={[path]}><SettingsNavigation /></MemoryRouter>)
  expect(screen.queryByRole('navigation')).toBeNull()
})

it('does not add settings chrome to unrelated project pages', () => {
  render(<MemoryRouter initialEntries={['/spaces/space-a/projects/project-a']}><SettingsNavigation /></MemoryRouter>)
  expect(screen.queryByRole('navigation')).toBeNull()
})

it.each(['/prompts?reading_method=1', '/prompts?item_id=item-a&reader=%2Flibrary', '/prompts?project_id=project-a'])(
  'leaves contextual workbench return navigation to its page: %s', path => {
    render(<MemoryRouter initialEntries={[`/spaces/space-a${path}`]}><SettingsNavigation /></MemoryRouter>)
    expect(screen.queryByRole('navigation')).toBeNull()
  },
)
