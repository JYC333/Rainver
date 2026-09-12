import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UserAvatar } from './UserAvatar'

describe('UserAvatar', () => {
  it('renders an https avatar', () => {
    const { container } = render(
      <UserAvatar avatarUrl="https://lh3.googleusercontent.com/a/abc" displayName="Ada" />,
    )
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://lh3.googleusercontent.com/a/abc')
  })

  it('falls back to initials for data and javascript URLs', () => {
    const { rerender } = render(
      <UserAvatar avatarUrl="data:image/svg+xml,<svg></svg>" displayName="Ada Lovelace" />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('AD')).toBeInTheDocument()

    rerender(<UserAvatar avatarUrl="javascript:alert(1)" displayName="Ada Lovelace" />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('AD')).toBeInTheDocument()
  })
})
