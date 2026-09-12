import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequireInstanceAdmin, RequireSpaceAdmin } from './RequireRole'

const spaceState = vi.hoisted(() => ({
  spaces: [{ id: 'space-1', role: 'member' as string }],
  activeSpaceId: 'space-1',
}))
const authState = vi.hoisted(() => ({
  currentUser: { id: 'u1', is_instance_admin: false } as { id: string; is_instance_admin?: boolean } | null,
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => spaceState,
}))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authState,
}))

describe('RequireSpaceAdmin', () => {
  beforeEach(() => {
    spaceState.spaces = [{ id: 'space-1', role: 'member' }]
    spaceState.activeSpaceId = 'space-1'
  })

  it('hides the page from a member', () => {
    render(<RequireSpaceAdmin><div>secret</div></RequireSpaceAdmin>)
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
    expect(screen.getByText(/space admin required/i)).toBeInTheDocument()
  })

  it('shows the page to an owner', () => {
    spaceState.spaces = [{ id: 'space-1', role: 'owner' }]
    render(<RequireSpaceAdmin><div>secret</div></RequireSpaceAdmin>)
    expect(screen.getByText('secret')).toBeInTheDocument()
  })
})

describe('RequireInstanceAdmin', () => {
  beforeEach(() => {
    authState.currentUser = { id: 'u1', is_instance_admin: false }
  })

  it('hides the page from a non-admin', () => {
    render(<RequireInstanceAdmin><div>secret</div></RequireInstanceAdmin>)
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
    expect(screen.getByText(/instance admin required/i)).toBeInTheDocument()
  })

  it('shows the page to the instance admin', () => {
    authState.currentUser = { id: 'u1', is_instance_admin: true }
    render(<RequireInstanceAdmin><div>secret</div></RequireInstanceAdmin>)
    expect(screen.getByText('secret')).toBeInTheDocument()
  })
})
