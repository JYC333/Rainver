import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { SCENES, sceneForPath, type FilterScene, type RouteScene } from '../core/navigation'
import { SceneSidebar, SceneTabs } from '../components/shell/SceneSidebar'
import i18n from '../i18n'

const agents = SCENES.find(s => s.id === 'agents') as RouteScene
const inbox = SCENES.find(s => s.id === 'inbox') as FilterScene
const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

function NavigableAgents({ mobile }: { mobile: boolean }) {
  const { pathname } = useLocation()
  const scene = sceneForPath(pathname)
  return <>
    {scene && (mobile ? <SceneTabs scene={scene} spaceId="personal-1" />
      : <SceneSidebar scene={scene} onCollapse={() => {}} spaceId="personal-1" />)}
    <output data-testid="destination">{pathname}</output>
  </>
}

describe('SceneSidebar changes by scene', () => {
  it.each([false, true])('offers the Chinese Skill library link and keeps navigation after clicking (mobile=%s)', async mobile => {
    await i18n.changeLanguage('zh-CN')
    try {
      render(<MemoryRouter initialEntries={['/spaces/personal-1/agents']} future={routerFuture}>
        <NavigableAgents mobile={mobile} />
      </MemoryRouter>)
      const link = screen.getByRole('link', { name: '技能库' })
      expect(link).toHaveAttribute('href', '/spaces/personal-1/skills')
      fireEvent.click(link)
      expect(screen.getByTestId('destination')).toHaveTextContent('/spaces/personal-1/skills')
      expect(screen.getByRole('link', { name: '技能库' })).toHaveAttribute('aria-current', 'page')
      expect(screen.getByRole('link', { name: '能力' })).not.toHaveAttribute('aria-current')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('shows Agents sub-areas on the Agents scene', () => {
    render(<MemoryRouter initialEntries={['/spaces/personal-1/agents']} future={routerFuture}><SceneSidebar scene={agents} onCollapse={() => {}} spaceId="personal-1" /></MemoryRouter>)
    expect(screen.getByText('My agents')).toBeInTheDocument()
    expect(screen.getByText('Runs')).toBeInTheDocument()
    expect(screen.getByText('Templates')).toBeInTheDocument()
    expect(screen.getByText('Capabilities')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('href', '/spaces/personal-1/skills')
    expect(screen.queryByText('Projects')).toBeNull()
    expect(screen.queryByText('Raw')).toBeNull()
  })

  it('shows Inbox items on the Inbox scene', () => {
    render(<MemoryRouter initialEntries={['/spaces/personal-1/activity']} future={routerFuture}><SceneSidebar scene={inbox} onCollapse={() => {}} spaceId="personal-1" /></MemoryRouter>)
    expect(screen.getByText('Raw')).toBeInTheDocument()
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.queryByText('My agents')).toBeNull()
  })
})
