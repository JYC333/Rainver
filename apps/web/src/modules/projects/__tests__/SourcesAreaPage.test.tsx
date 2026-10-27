import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import SourcesAreaPage from '../SourcesAreaPage'
vi.mock('../../../core/spaceNav',async()=>({SpaceLink:(await import('react-router-dom')).Link}))
vi.mock('../../library/ReadingWorkspace',()=>({default:()=> <div>Unified reading</div>}))
vi.mock('../sourcesArea/MonitoringPanel',()=>({default:({mode='config'}:{mode?:string})=><div>{mode==='results'?'Recommended reading':mode==='config'?'Configure collection':'All candidates'}</div>}))
vi.mock('../ProjectSourcesPage',()=>({default:({view}:{view:string})=><div>{view==='materials'?'Project material':'Linked source manager'}</div>}))
vi.mock('../ProjectRawMaterialPage',()=>({default:()=> <div>Approval queue</div>}))
vi.mock('../ProjectDigestPage',()=>({default:()=> <div>Frozen daily edition</div>}))
function Location(){const l=useLocation();return <output>{l.pathname+l.search}</output>}
function page(search='') {render(<MemoryRouter initialEntries={['/projects/project-1/sources'+search]}><Routes><Route path="/projects/:projectId/sources" element={<><SourcesAreaPage/><Location/></>}/><Route path="/projects/:projectId" element={<Location/>}/></Routes></MemoryRouter>)}
describe('Project reading entry',()=>{
  it('lands on the unified reading API consumer instead of monitoring candidates',()=>{
    page()
    expect(screen.getByText('Unified reading')).toBeInTheDocument()
    expect(screen.queryByText('All candidates')).not.toBeInTheDocument()
    expect(screen.queryByText('Configure collection')).not.toBeInTheDocument()
  })
  it('keeps old materials links on the complete unified material consumer',()=>{
    page('?tab=materials&keep=choice')
    expect(screen.getByText('Unified reading')).toBeInTheDocument()
    expect(screen.queryByText('Project material')).not.toBeInTheDocument()
  })
  it.each([['sources','Configure collection'],['raw','All candidates'],['digest','Frozen daily edition']])('preserves the existing %s destination', (tab,text)=>{
    page('?tab='+tab)
    expect(screen.getByText(text)).toBeInTheDocument()
  })
})

it('returns directly to project reading from a directly opened source manager',()=>{
  page('?tab=settings')
  fireEvent.click(screen.getByRole('link',{name:'Back to project reading'}))
  expect(screen.getByText('Unified reading')).toBeInTheDocument()
  expect(screen.getByRole('status').textContent).toBe('/projects/project-1/sources')
})
it('preserves the settings return while switching source-management tabs',()=>{
  page('?tab=settings&from=settings')
  fireEvent.click(screen.getByRole('button',{name:'All monitoring candidates'}))
  expect(screen.getByText('All candidates')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('link',{name:'Back to project settings'}))
  expect(screen.getByRole('status').textContent).toBe('/projects/project-1?settings=project')
})
