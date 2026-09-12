import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SpaceLink } from './spaceNav'

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', preferredSpaceId: 'space-1' }),
}))

describe('SpaceLink', () => {
  it('prefixes a logical in-space path', () => {
    render(
      <MemoryRouter>
        <SpaceLink to="/runs/run-1">Open run</SpaceLink>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', '/spaces/space-1/runs/run-1')
  })

  it('does not navigate for protocol-relative or scheme hrefs', () => {
    render(
      <MemoryRouter>
        <SpaceLink to="//evil.example/x">Bad</SpaceLink>
        <SpaceLink to="https://evil.example/x">Also bad</SpaceLink>
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Bad')).toBeInTheDocument()
    expect(screen.getByText('Also bad')).toBeInTheDocument()
  })
})
