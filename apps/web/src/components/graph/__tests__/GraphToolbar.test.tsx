import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GraphToolbar } from '../GraphToolbar'

describe('GraphToolbar', () => {
  it('lets users choose layout and renderer options from the toolbar dropdowns', async () => {
    const user = userEvent.setup({ delay: null })
    const onLayoutChange = vi.fn()
    const onRendererChange = vi.fn()

    render(
      <GraphToolbar
        layout="force"
        renderer="canvas"
        onLayoutChange={onLayoutChange}
        onRendererChange={onRendererChange}
      />,
    )

    await user.selectOptions(screen.getByRole('combobox', { name: /graph layout/i }), 'radial')

    expect(onLayoutChange).toHaveBeenCalledWith('radial')

    await user.selectOptions(screen.getByRole('combobox', { name: /graph renderer/i }), 'webgl')

    expect(onRendererChange).toHaveBeenCalledWith('webgl')
  })
})
