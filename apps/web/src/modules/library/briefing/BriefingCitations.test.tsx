import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { expect, it } from 'vitest'
import type { BriefingEvidence } from '@rainver/protocol'
import { BriefingRefs, BriefingText, type CitationSources } from './BriefingCitations'

const evidence: BriefingEvidence[] = ['CrewAI docs: hierarchical orchestration and event-driven workflows', 'Phoenix CLI platform', 'Control-plane architecture'].map((title, index) => ({
  key: `S${index + 1}`, title, excerpt: 'This article explains how hierarchical teams coordinate roles and respond to events.', source_item_id: `source-${index}`, original_snapshot_id: `original-${index}`, source_domain: 'docs.example.test', occurred_at: null, delta_class: 'baseline', unverified: index === 0, lenses: [],
}))
const sources: CitationSources = {
  evidence: new Map(evidence.map(item => [item.key, item])),
  context: new Map([['C1', { key: 'C1', kind: 'project_goal', label: 'Agreed project goal' }]]),
  evidenceHref: item => `/reader/${item.source_item_id}?version=${item.original_snapshot_id}`,
  contextHref: key => `/report?composition=exact#briefing-ref-${key}`,
}
const sourceLink = () => screen.getByRole('link', { name: `View source: ${evidence[0].title}` })
function Location() { const location = useLocation();return <output data-testid="location">{location.pathname + location.search + location.hash}</output> }
const renderRefs = (keys = ['S1']) => render(<MemoryRouter><BriefingRefs keys={keys} {...sources}/><Location/></MemoryRouter>)

it('keeps the first two references recognizable and expands every remaining unique source on demand', () => {
  renderRefs(['S1', 'S2', 'S1', 'S3', 'S999'])
  expect(sourceLink()).toHaveTextContent('CrewAI docs:')
  expect(screen.queryByRole('link', { name: /View source: Control-plane/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show remaining sources (1)' }))
  expect(screen.getByRole('link', { name: 'View source: Control-plane architecture' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
  expect(screen.queryByRole('link', { name: /View source: Control-plane/ })).toBeNull()
  expect(screen.queryByText('S999')).toBeNull()
})

it('opens the full source on hover, keeps the card reachable across the gap, and preserves the exact original link', async () => {
  const user = userEvent.setup({ delay: null });renderRefs()
  await user.hover(sourceLink())
  const card = await screen.findByRole('dialog', { name: evidence[0].title })
  expect(within(card).getByText('docs.example.test · In the baseline window')).toBeVisible()
  expect(within(card).getByText('Rests on agent-provided material that nobody verified.')).toBeVisible()
  await user.hover(card)
  expect(within(card).getByRole('link', { name: evidence[0].title })).toHaveAttribute('href', '/reader/source-0?version=original-0')
  expect(within(card).getByRole('link')).toHaveTextContent(evidence[0].excerpt!)
  expect(within(card).queryByRole('button')).toBeNull()
  await user.unhover(card)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it.each([0, 1])('navigates inline citation %s on click to its own original version', async index => {
  const user = userEvent.setup({ delay: null });renderRefs(['S1', 'S2'])
  await user.click(screen.getByRole('link', { name: `View source: ${evidence[index].title}` }))
  expect(screen.getByTestId('location')).toHaveTextContent(`/reader/source-${index}?version=original-${index}`)
})

it('preserves direct navigation for a touch tap and keyboard Enter', async () => {
  const user = userEvent.setup({ delay: null });const view = renderRefs()
  const touch = new Event('pointerover', { bubbles: true })
  Object.defineProperty(touch, 'pointerType', { value: 'touch' })
  fireEvent(sourceLink(), touch)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(sourceLink())
  expect(screen.getByTestId('location')).toHaveTextContent('/reader/source-0?version=original-0')
  view.unmount();renderRefs()
  await user.tab();await user.keyboard('{Enter}')
  expect(screen.getByTestId('location')).toHaveTextContent('/reader/source-0?version=original-0')
})

it('supports keyboard focus and opens authorized context in the pinned full report', async () => {
  const user = userEvent.setup({ delay: null });renderRefs(['C1'])
  await user.tab()
  const card = await screen.findByRole('dialog', { name: 'Agreed project goal' })
  expect(within(card).getByRole('link', { name: 'Agreed project goal' })).toHaveAttribute('href', '/report?composition=exact#briefing-ref-C1')
  await user.tab()
  expect(within(card).getByRole('link')).toHaveFocus()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('link', { name: 'View source: Agreed project goal' })).toHaveFocus()
})

it('resolves body tokens and adjacent citation clusters, avoids trailing duplicates, and leaves unknown text intact', () => {
  render(<MemoryRouter><p><BriefingText text="Evidence [S1] [S2] [S3]. S999 is unavailable; XS1 and S1000 stay literal." keys={['S1', 'S2', 'S3']} {...sources}/></p></MemoryRouter>)
  expect(screen.getAllByRole('link', { name: /View source:/ })).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Show remaining sources (1)' })).toBeVisible()
  expect(screen.getByText(/S999 is unavailable; XS1 and S1000 stay literal/)).toBeVisible()
})

it('removes an open source card when refreshed authorization no longer includes that source', async () => {
  const view = renderRefs();fireEvent.focus(sourceLink())
  expect(await screen.findByRole('dialog')).toBeVisible()
  view.rerender(<MemoryRouter><BriefingRefs keys={['S1']} {...sources} evidence={new Map()}/></MemoryRouter>)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText(evidence[0].title)).toBeNull()
})

it('keeps excerpt controls outside clamped text and collects both inline and structured references once', () => {
  render(<MemoryRouter><p><BriefingText text="Based on S1." keys={['S1', 'S2', 'S3']} excerpt {...sources}/></p></MemoryRouter>)
  expect(screen.getByText(`Based on ${evidence[0].title}.`)).toBeVisible()
  expect(screen.getAllByRole('link', { name: /View source:/ })).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Show remaining sources (1)' }))
  expect(screen.getByRole('link', { name: 'View source: Control-plane architecture' })).toBeVisible()
})
