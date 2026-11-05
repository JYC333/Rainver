import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { Select } from './select'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'

const OPTIONS = [
  { value: 'builtin', label: 'Server Runtime' },
  { value: 'offline', label: 'Old laptop', disabled: true },
  { value: 'desk', label: 'Desk workstation' },
]

function Harness({ portal, onChange }: { portal?: boolean; onChange?: (value: string) => void }) {
  const [value, setValue] = useState('builtin')
  return (
    <>
      <Select ariaLabel="Host" options={OPTIONS} value={value} portal={portal} onChange={(next) => { setValue(next); onChange?.(next) }} />
      <button type="button">After</button>
    </>
  )
}

describe('Select by keyboard', () => {
  it('opens on the selected option, skips disabled ones, and chooses with Enter', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Host' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('option', { name: 'Server Runtime' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Desk workstation' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('desk')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Host' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Host' })).toHaveTextContent('Desk workstation')
  })

  it('opens with an arrow key; Escape closes and returns to the trigger; Tab leaves from the trigger', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Harness />)
    await user.tab()
    await user.keyboard('{ArrowDown}')
    expect(await screen.findByRole('option', { name: 'Server Runtime' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Host' })).toHaveFocus()

    // The portaled menu sits at the end of the document; Tab still moves on
    // from the trigger's place in the page.
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('option', { name: 'Server Runtime' })).toHaveFocus()
    await user.tab()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
    // Shift+Tab from the menu goes back to the trigger's predecessor; there is none here.
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: 'Host' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('option', { name: 'Server Runtime' })).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Host' })).toHaveFocus()
  })

  it('an in-place menu (portal off, or inside a dialog) closes on Tab and focus moves on past it', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Harness portal={false} />)
    await user.tab()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('option', { name: 'Server Runtime' })).toHaveFocus()
    await user.tab()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('inside a dialog, Escape closes only the menu', async () => {
    const user = userEvent.setup({ delay: null })
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Pick a Host</DialogTitle>
          <DialogDescription>Where the agent runs</DialogDescription>
          <Harness />
        </DialogContent>
      </Dialog>,
    )
    await user.click(screen.getByRole('button', { name: 'Host' }))
    expect(await screen.findByRole('option', { name: 'Server Runtime' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('inside a dialog, Tab from the menu stays in the dialog and moves past the control', async () => {
    const user = userEvent.setup({ delay: null })
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Pick a Host</DialogTitle>
          <DialogDescription>Where the agent runs</DialogDescription>
          <Harness />
        </DialogContent>
      </Dialog>,
    )
    screen.getByRole('button', { name: 'Host' }).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('option', { name: 'Server Runtime' })).toHaveFocus()
    await user.tab()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('a pointer choice still works and a disabled control does not open', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    const { unmount } = render(<Harness onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Host' }))
    await user.click(screen.getByRole('option', { name: 'Desk workstation' }))
    expect(onChange).toHaveBeenCalledWith('desk')
    expect(screen.queryByRole('listbox')).toBeNull()
    unmount()
    render(<Select ariaLabel="Host" options={OPTIONS} value="builtin" disabled onChange={onChange} />)
    await user.keyboard('{ArrowDown}')
    await user.click(screen.getByRole('button', { name: 'Host' }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
