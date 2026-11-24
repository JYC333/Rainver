import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { DatePicker } from './date-picker'

it('moves date focus across months and restores trigger focus on Escape and selection', () => {
  const onChange = vi.fn()
  render(<DatePicker value="2026-11-30" ariaLabel="Start date" onChange={onChange} />)
  const trigger = screen.getByRole('button', { name: 'Start date' })
  fireEvent.click(trigger)
  const selected = screen.getByRole('button', { pressed: true })
  expect(selected).toHaveFocus()
  fireEvent.keyDown(selected, { key: 'ArrowRight' })
  const next = screen.getByRole('button', { name: /December 1, 2026/ })
  expect(next).toHaveFocus()
  fireEvent.keyDown(next, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  expect(onChange).not.toHaveBeenCalled()

  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { pressed: true }))
  expect(onChange).toHaveBeenCalledWith('2026-11-30')
  expect(trigger).toHaveFocus()
})
