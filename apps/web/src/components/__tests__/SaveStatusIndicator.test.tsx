import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveStatusIndicator } from '../SaveStatusIndicator'

describe('SaveStatusIndicator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows Unsaved while dirty, Saving… while saving, then Saved that auto-hides', () => {
    const { rerender } = render(<SaveStatusIndicator state="dirty" onRetry={vi.fn()} />)
    expect(screen.getByText('Unsaved')).toBeInTheDocument()

    rerender(<SaveStatusIndicator state="saving" onRetry={vi.fn()} />)
    expect(screen.getByText(/Saving/)).toBeInTheDocument()

    rerender(<SaveStatusIndicator state="saved" onRetry={vi.fn()} />)
    expect(screen.getByText('Saved')).toBeInTheDocument()

    // Still showing just before the hide delay elapses…
    act(() => { vi.advanceTimersByTime(1999) })
    expect(screen.getByText('Saved')).toBeInTheDocument()

    // …and gone once it does, with no new state change.
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('keeps the error state visible (with retry) — it never auto-hides', () => {
    const onRetry = vi.fn()
    render(<SaveStatusIndicator state="error" onRetry={onRetry} />)
    expect(screen.getByText('Save failed')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(screen.getByText('Save failed')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Retry' }).click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows the checkmark again if a new change arrives while the previous "Saved" was fading out', () => {
    const { rerender } = render(<SaveStatusIndicator state="saved" onRetry={vi.fn()} />)
    act(() => { vi.advanceTimersByTime(1500) })
    rerender(<SaveStatusIndicator state="dirty" onRetry={vi.fn()} />)
    expect(screen.getByText('Unsaved')).toBeInTheDocument()

    rerender(<SaveStatusIndicator state="saved" onRetry={vi.fn()} />)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1999) })
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })
})
