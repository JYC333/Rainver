import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OneTimeLink } from '../OneTimeLink'

const LINK = 'https://rainver.test/invitations/claim#token=abc'

function stubClipboard(writeText: ((text: string) => Promise<void>) | null) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  })
}

afterEach(() => stubClipboard(null))

describe('OneTimeLink', () => {
  it('keeps the link on screen and says copied only after the write succeeds', async () => {
    const writeText = vi.fn(async () => undefined)
    stubClipboard(writeText)
    render(<OneTimeLink link={LINK} label="Invitation link" onDismiss={() => undefined} />)
    expect(screen.getByRole('textbox', { name: 'Invitation link' })).toHaveValue(LINK)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(LINK)
  })

  it('asks for a manual copy when the clipboard refuses or is missing, and the link survives', async () => {
    stubClipboard(async () => { throw new Error('denied') })
    const { unmount } = render(<OneTimeLink link={LINK} label="Invitation link" onDismiss={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByText(/copy it yourself/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Invitation link' })).toHaveValue(LINK)
    unmount()

    stubClipboard(null)
    render(<OneTimeLink link={LINK} label="Invitation link" onDismiss={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByText(/copy it yourself/)).toBeInTheDocument())
  })

  it('marks a reset link as a secret and removes it when dismissed', () => {
    const onDismiss = vi.fn()
    render(<OneTimeLink secret link={LINK} label="Password reset link" onDismiss={onDismiss} />)
    expect(screen.getByText(/Handle it as a secret/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss link' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
