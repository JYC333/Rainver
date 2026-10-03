import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Pagination } from './pagination'

describe('Pagination', () => {
  it('renders nothing for a single page viewed from its start', () => {
    const onChange = vi.fn()
    const { container } = render(<Pagination total={10} limit={30} offset={0} onChange={onChange} />)
    expect(container).toBeEmptyDOMElement()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('brings an offset that fell past the last page back onto it', () => {
    // The caller was on page two with one item, which an action then moved
    // out of the filtered list: total is 30 again, offset still 30. With no
    // control rendered the person was stuck on an empty page.
    const onChange = vi.fn()
    render(<Pagination total={30} limit={30} offset={30} onChange={onChange} />)
    expect(onChange).toHaveBeenCalledWith(0)

    const further = vi.fn()
    render(<Pagination total={45} limit={30} offset={90} onChange={further} />)
    expect(further).toHaveBeenCalledWith(30)
  })

  it('leaves an offset inside the range alone and shows the controls', () => {
    const onChange = vi.fn()
    render(<Pagination total={45} limit={30} offset={30} onChange={onChange} />)
    expect(screen.getByText('31–45 of 45')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
