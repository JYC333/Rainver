import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { SearchableMultiSelect } from './searchable-multi-select'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'

describe('SearchableMultiSelect', () => {
  it('closes only its own menu on Escape inside a dialog, keeping the dialog and its selections', async () => {
    const user = userEvent.setup({ delay: null })
    const onOpenChange = vi.fn()
    function Harness() {
      const [value, setValue] = useState<string[]>([])
      return (
        <SearchableMultiSelect
          options={[{ value: 'user-1', label: 'Ada' }, { value: 'user-2', label: 'Grace' }]}
          value={value}
          onChange={setValue}
          ariaLabel="Members"
        />
      )
    }
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Who can see this?</DialogTitle>
          <DialogDescription>Pick people</DialogDescription>
          <Harness />
        </DialogContent>
      </Dialog>,
    )
    await user.click(screen.getByRole('button', { name: 'Members' }))
    await user.click(screen.getByRole('option', { name: /Ada/ }))
    expect(screen.getByRole('button', { name: 'Members' })).toHaveTextContent('1 selected')

    // The first Escape is for the open menu, not the dialog around it.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('option', { name: /Ada/ })).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Members' })).toHaveTextContent('1 selected')

    // With the menu closed, Escape reaches the dialog as usual.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the menu open while selecting an option from the portal', async () => {
    const user = userEvent.setup({ delay: null })
    function Harness() {
      const [value, setValue] = useState<string[]>([])
      return (
        <SearchableMultiSelect
          options={[{ value: 'monitor-1', label: 'Agent memory', description: 'all:"agent memory"', meta: 'arXiv' }]}
          value={value}
          onChange={setValue}
          ariaLabel="Literature monitors"
        />
      )
    }

    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
          <DialogDescription>Test description</DialogDescription>
          <Harness />
        </DialogContent>
      </Dialog>,
    )
    await user.click(screen.getByRole('button', { name: 'Literature monitors' }))
    const option = screen.getByRole('option', { name: /Agent memory/ })
    await user.click(option)

    expect(screen.getByRole('button', { name: 'Literature monitors' })).toHaveTextContent('1 selected')
    expect(screen.getByRole('option', { name: /Agent memory/ })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('option', { name: /Agent memory/ })).toBeNull()
  })
})
