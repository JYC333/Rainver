import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { SearchableMultiSelect } from './searchable-multi-select'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'

describe('SearchableMultiSelect', () => {
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
