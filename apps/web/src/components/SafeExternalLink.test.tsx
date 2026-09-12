import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SafeExternalLink } from './SafeExternalLink'

describe('SafeExternalLink', () => {
  it('renders http(s) and omits javascript URLs', () => {
    const { rerender } = render(<SafeExternalLink href="javascript:alert(1)">bad</SafeExternalLink>)
    expect(screen.queryByText('bad')).not.toBeInTheDocument()

    rerender(<SafeExternalLink href="https://example.com/a">good</SafeExternalLink>)
    const link = screen.getByRole('link', { name: 'good' })
    expect(link).toHaveAttribute('href', 'https://example.com/a')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
