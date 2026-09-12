import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MessageResponse } from './message'

describe('MessageResponse', () => {
  it('does not turn a javascript URL or raw HTML into an executable node', () => {
    render(
      <MessageResponse>
        {'[click](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n[ok](https://example.com/a)'}
      </MessageResponse>,
    )

    expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(document.querySelector('img[onerror]')).toBeNull()
    expect(screen.getAllByText(/blocked/i).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'ok' })).toBeInTheDocument()
  })
})
