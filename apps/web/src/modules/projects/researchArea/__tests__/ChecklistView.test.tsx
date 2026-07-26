import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ResearchChecklistItem } from '../../../../types/api'
import { ChecklistView, moveChecklistItem } from '../ChecklistView'

function makeItem(
  id: string,
  sortOrder: number,
  status: ResearchChecklistItem['status'] = 'open',
): ResearchChecklistItem {
  return {
    id,
    text: `Task ${id}`,
    status,
    sort_order: sortOrder,
    origin: 'user',
    origin_run_id: null,
    created_at: '',
    updated_at: '',
  }
}

describe('moveChecklistItem', () => {
  const items = [makeItem('a', 0), makeItem('b', 1), makeItem('c', 2)]

  it('moves an item to the hovered position and resequences every item', () => {
    expect(moveChecklistItem(items, 'a', 'open', 'c').map(item => [item.id, item.sort_order])).toEqual([
      ['b', 0],
      ['c', 1],
      ['a', 2],
    ])
  })

  it('moves an item across board columns and appends to an empty column', () => {
    const moved = moveChecklistItem(items, 'b', 'done', null)
    expect(moved.map(item => [item.id, item.status, item.sort_order])).toEqual([
      ['a', 'open', 0],
      ['c', 'open', 1],
      ['b', 'done', 0],
    ])
  })

  it('returns the original list for an invalid or unchanged drop', () => {
    expect(moveChecklistItem(items, 'b', 'open', 'b')).toBe(items)
    expect(moveChecklistItem(items, 'missing', 'open', 'a')).toBe(items)
  })
})

describe('ChecklistView drag handles', () => {
  it('uses dnd-kit handles instead of native draggable rows', () => {
    const { container } = render(
      <MemoryRouter>
        <ChecklistView
          projectId="project-1"
          items={[makeItem('a', 0), makeItem('b', 1)]}
          onChange={vi.fn()}
        />
      </MemoryRouter>,
    )

    expect(screen.getByText('Task a').closest('[role="button"]')).toHaveAttribute('aria-roledescription', 'draggable')
    expect(screen.getByText('Task b').closest('[role="button"]')).toHaveAttribute('aria-roledescription', 'draggable')
    expect(screen.getByRole('region', { name: 'Open checklist items' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Done checklist items' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Dismissed checklist items' })).toBeInTheDocument()
    expect(container.querySelector('[draggable="true"]')).toBeNull()
  })
})
