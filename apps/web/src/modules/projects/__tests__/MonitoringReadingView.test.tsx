import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import type { ProjectMonitoringState } from '@rainver/protocol'
import { MonitoringReadingView } from '../sourcesArea/MonitoringReadingView'
vi.mock('../../../core/spaceNav',async()=>({SpaceLink:(await import('react-router-dom')).Link}))
vi.mock('../../../api/client',()=>({projectMonitoringApi:{}}))
it('opens either candidate Reader link with project origin and a source-management return destination',()=>{
  const state={active:{config:{objective:'Following direction'}},draft:null,can_write:false,latest_run:null,candidates:[{id:'candidate-a',title:'A relevant candidate',summary:'Summary',reason:'Relevance reason',relevance:'relevant',recommended:false,read_status:'unread'}]} as unknown as ProjectMonitoringState
  render(<MemoryRouter initialEntries={['/projects/project-a/sources?tab=candidates']}><Routes><Route path="/projects/:projectId/sources" element={<MonitoringReadingView state={state} mode="candidates" busy={false} action={async()=>{}} more={async()=>{}} />} /></Routes></MemoryRouter>)
  for(const name of ['A relevant candidate','Open Reader']) {
    const href=screen.getByRole('link',{name}).getAttribute('href')!
    const url=new URL(href,'https://app.test')
    expect(url.searchParams.get('from')).toBe('project')
    expect(url.searchParams.get('returnTo')).toBe('/projects/project-a/sources?tab=candidates')
  }
  expect(screen.getByText('Not selected')).toBeInTheDocument()
})
