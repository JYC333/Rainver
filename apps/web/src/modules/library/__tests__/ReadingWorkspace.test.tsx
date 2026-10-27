import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingItem, ReadingPage } from '@rainver/protocol'
import ReadingWorkspace, { ReadingPreview } from '../ReadingWorkspace'
import { informationDigestsApi } from '../../../api/client'
import { useReading } from '../useReading'
import { ProjectReadingPreference } from '../ReadingPreferences'

// Empty guidance has its own source/collection integration coverage.
vi.mock('../ReadingStart', () => ({ ReadingStart: () => <p>No pending recommendations</p> }))
let space = 'space-a'
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: space, preferredSpaceId: space }) }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: Link }
})
vi.mock('../../../api/client', () => ({ informationDigestsApi: { reading: vi.fn(), readingState: vi.fn(), readingPreference: vi.fn(), setReadingPreference: vi.fn() }, projectsApi: { list: vi.fn().mockResolvedValue({ items: [{ id: 'project-a', name: 'Project A' }] }) }, projectMonitoringApi: { state: vi.fn().mockResolvedValue({ active: null, latest_run: null }) } }))
const item: ReadingItem = { key: 'server-group', source_item_id: 'article', source_item_ids: ['article','copy'], title: 'A retained recommendation', summary: 'Frozen summary', source_uri: null, occurred_at: '2026-01-01T00:00:00Z', access_level: 'full', reader_origin: 'project', read_status: 'unread', dismissed: false, available_at: '2026-01-02T00:00:00Z', contributions: [{ delivery_id: 'first', source_item_id:'article',kind:'project_initial',project_id:'project-a',project_name:'Project A',digest_id:null,digest_date:null,timezone:null,available_at:'2026-01-02T00:00:00Z',position:0,section:null,summary:null,rationale:'Original initial reason' }, { delivery_id:'daily',source_item_id:'copy',kind:'personal_digest',project_id:null,project_name:null,digest_id:'edition',digest_date:'2026-01-03',timezone:'Asia/Shanghai',available_at:'2026-01-04T00:00:00Z',position:0,section:'interest',summary:null,rationale:'Original daily reason' }], material_links:[] }
const page = (items: ReadingItem[] = [item], next_cursor: string | null = null): ReadingPage => ({ items, total: items.length, next_cursor })
function deferred<T>() { let resolve!: (v:T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function QueryLocation() { return <output data-testid="query">{useLocation().search}</output> }
const ui = (projectId?: string) => <MemoryRouter><ReadingWorkspace projectId={projectId} /><QueryLocation /></MemoryRouter>
beforeEach(() => { vi.clearAllMocks(); space = 'space-a'; vi.mocked(informationDigestsApi.reading).mockResolvedValue(page()); vi.mocked(informationDigestsApi.readingState).mockResolvedValue({updated:2}); vi.mocked(informationDigestsApi.readingPreference).mockResolvedValue({show_in_my_reading:false}) })
describe('unified reading presentation', () => {
  it('renders server grouping, all original reasons and distinct initial/edition times, with Reader origin', async () => {
    render(ui())
    const link = await screen.findByRole('link', { name: item.title })
    expect(link).toHaveAttribute('href', expect.stringContaining('from=project'))
    expect(screen.getAllByText('Original initial reason')).toHaveLength(1)
    expect(screen.getByText('Original daily reason')).toBeInTheDocument()
    expect(screen.getByRole('link', {name:/Edition:.*Asia\/Shanghai/})).toHaveAttribute('href','/library/digests?date=2026-01-03')
    expect(informationDigestsApi.reading).toHaveBeenCalledWith('space-a',expect.objectContaining({view:'pending'}),undefined,expect.objectContaining({signal:expect.any(AbortSignal)}))
  })
  it('re-reads server pending after completion and restores from the read view without client filtering', async () => {
    vi.mocked(informationDigestsApi.reading).mockResolvedValueOnce(page()).mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([{...item,read_status:'read'}])).mockResolvedValueOnce(page([]))
    render(ui())
    fireEvent.click(await screen.findByRole('button',{name:'Mark read'}))
    await screen.findByText('No pending recommendations')
    expect(informationDigestsApi.readingState).toHaveBeenCalledWith('space-a','article',{read_status:'read'},undefined)
    fireEvent.click(screen.getByRole('button',{name:'Read'}))
    fireEvent.click(await screen.findByRole('button',{name:'Restore unread'}))
    await screen.findByText('No completed reading yet')
    expect(informationDigestsApi.readingState).toHaveBeenLastCalledWith('space-a','article',{read_status:'unread'},undefined)
  })
  it('clears old content after a stale cursor and retries from the first page', async () => {
    vi.mocked(informationDigestsApi.reading).mockResolvedValueOnce(page([item],'opaque-server-cursor')).mockRejectedValueOnce({status:409,message:'changed'}).mockResolvedValueOnce(page())
    render(ui())
    fireEvent.click(await screen.findByRole('button',{name:'Load more'}))
    await screen.findByRole('alert')
    expect(screen.queryByText(item.title)).not.toBeInTheDocument()
    expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a',expect.objectContaining({cursor:'opaque-server-cursor'}),undefined,expect.objectContaining({signal:expect.any(AbortSignal)}))
    fireEvent.click(screen.getByRole('button',{name:'Try again'}))
    await screen.findByText(item.title)
    expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a',expect.objectContaining({cursor:undefined}),undefined,expect.objectContaining({signal:expect.any(AbortSignal)}))
  })
  it('does not show previous Space content or use its cursor while a late page resolves', async () => {
    const late=deferred<ReadingPage>(), next=deferred<ReadingPage>()
    vi.mocked(informationDigestsApi.reading).mockResolvedValueOnce(page([item],'cursor-a')).mockReturnValueOnce(late.promise).mockReturnValueOnce(next.promise)
    const view=render(ui())
    fireEvent.click(await screen.findByRole('button',{name:'Load more'}))
    space='space-b'; view.rerender(ui())
    expect(screen.queryByText(item.title)).not.toBeInTheDocument()
    await act(async()=>late.resolve(page([{...item,title:'Leaked late A'}])))
    expect(screen.queryByText('Leaked late A')).not.toBeInTheDocument()
    await act(async()=>next.resolve(page([{...item,title:'Space B item'}])))
    await screen.findByText('Space B item')
    expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-b',expect.objectContaining({cursor:undefined}),undefined,expect.objectContaining({signal:expect.any(AbortSignal)}))
  })
  it('hides content on permission failure and separates it from empty recommendations', async () => {
    vi.mocked(informationDigestsApi.reading).mockRejectedValueOnce({status:403,message:'revoked'})
    render(ui('project-a'))
    expect(await screen.findByText('Reading is not available to you')).toBeInTheDocument()
    expect(screen.queryByText('No pending recommendations')).not.toBeInTheDocument()
  })
  it('changes only the authenticated preference, shows server value and refreshes personal reading', async () => {
    vi.mocked(informationDigestsApi.setReadingPreference).mockResolvedValue({show_in_my_reading:true})
    render(ui())
    await screen.findByText(item.title)
    fireEvent.click(screen.getByRole('button',{name:'Project reading preferences'}))
    expect(screen.getAllByText('Off by default. This changes only your reading list, never the team’s collection direction, schedule or budget.')).toHaveLength(1)
    const checkbox=await screen.findByRole('checkbox')
    await waitFor(()=>expect(checkbox).toBeEnabled())
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    await waitFor(()=>expect(checkbox).toBeChecked())
    expect(informationDigestsApi.setReadingPreference).toHaveBeenCalledWith('space-a','project-a',true)
    await waitFor(()=>expect(informationDigestsApi.reading).toHaveBeenCalledTimes(2))
  })
  it('does not claim a failed preference was saved', async () => {
    vi.mocked(informationDigestsApi.setReadingPreference).mockRejectedValue(new Error('Could not save'))
    render(<MemoryRouter><ProjectReadingPreference spaceId="space-a" projectId="project-a" /></MemoryRouter>)
    const checkbox=screen.getByRole('checkbox'); await waitFor(()=>expect(checkbox).toBeEnabled()); fireEvent.click(checkbox)
    await screen.findByRole('alert'); expect(checkbox).not.toBeChecked()
  })
  it('uses the same bounded pending API for Home', async () => {
    render(<MemoryRouter><ReadingPreview /></MemoryRouter>)
    await screen.findByText(item.title)
    expect(informationDigestsApi.reading).toHaveBeenCalledWith('space-a',expect.objectContaining({view:'pending',limit:3}),undefined,expect.objectContaining({signal:expect.any(AbortSignal)}))
  })
})

it('does not let an old search response or its cursor replace the new search', async () => {
  const late=deferred<ReadingPage>()
  vi.mocked(informationDigestsApi.reading).mockResolvedValueOnce(page()).mockReturnValueOnce(late.promise).mockResolvedValueOnce(page([{...item,title:'Current match'}]))
  render(ui())
  await screen.findByText(item.title)
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'old'}})
  fireEvent.submit(screen.getByRole('search'))
  await waitFor(()=>expect(informationDigestsApi.reading).toHaveBeenCalledTimes(2))
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'current'}})
  fireEvent.submit(screen.getByRole('search'))
  await screen.findByText('Current match')
  expect(vi.mocked(informationDigestsApi.reading).mock.calls[1][3]?.signal?.aborted).toBe(true)
  await act(async()=>late.resolve(page([{...item,title:'Old match'}],'stale-cursor')))
  expect(screen.queryByText('Old match')).not.toBeInTheDocument()
  expect(screen.queryByRole('button',{name:'Load more'})).not.toBeInTheDocument()
})
it('clears cached content and exposes a failed state change with retry', async () => {
  vi.mocked(informationDigestsApi.readingState).mockRejectedValueOnce(new Error('State write failed'))
  render(ui())
  fireEvent.click(await screen.findByRole('button',{name:'Mark read'}))
  await screen.findByText('State write failed')
  expect(screen.queryByText(item.title)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Try again'}))
  await screen.findByText(item.title)
})
it('keeps summary-only titles outside the Reader links', async () => {
  vi.mocked(informationDigestsApi.reading).mockResolvedValueOnce(page([{...item,access_level:'summary'}]))
  render(ui())
  await screen.findByText('Summary access only')
  expect(screen.queryByRole('link',{name:item.title})).not.toBeInTheDocument()
  expect(screen.queryByRole('link',{name:'Open Reader'})).not.toBeInTheDocument()
})

it('keeps the URL and visible results stable during continuous input, then searches only the submitted query', async () => {
  render(ui())
  await screen.findByText(item.title)
  for (const value of ['m','machine','machine learning']) fireEvent.change(screen.getByRole('textbox'),{target:{value}})
  expect(informationDigestsApi.reading).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('query')).toHaveTextContent('')
  expect(screen.getByText(item.title)).toBeInTheDocument()
  fireEvent.submit(screen.getByRole('search'))
  await waitFor(()=>expect(informationDigestsApi.reading).toHaveBeenCalledTimes(2))
  expect(screen.getByTestId('query')).toHaveTextContent('?q=machine+learning')
  expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a',expect.objectContaining({q:'machine learning'}),undefined,expect.objectContaining({signal:expect.any(AbortSignal)}))
})
it('does not link a summary-only Home preview into Reader', async () => {
  vi.mocked(informationDigestsApi.reading).mockResolvedValueOnce(page([{...item,access_level:'summary'}]))
  render(<MemoryRouter><ReadingPreview /></MemoryRouter>)
  await screen.findByText(item.title)
  expect(screen.queryByRole('link',{name:item.title})).not.toBeInTheDocument()
  expect(screen.getByRole('link',{name:'Open reading'})).toHaveAttribute('href','/library/reading')
})

it.each([
  [{read_status:'read'} as const,'Mark read'],
  [{dismissed:true} as const,'Set aside for me'],
  [{read_status:'unread'} as const,'Restore unread'],
])('retains a loaded multi-page window after %j and continues with the new server cursor',async(body,label)=>{
  const items=Array.from({length:90},(_,i)=>({...item,key:`key-${i}`,source_item_id:`id-${i}`,title:`Window item ${i}`,read_status:label==='Restore unread'?'read' as const:'unread' as const}))
  const refresh=deferred<ReadingPage>()
  vi.mocked(informationDigestsApi.reading).mockResolvedValueOnce(page(items.slice(0,30),'old-first')).mockResolvedValueOnce(page(items.slice(30,60),'old-second')).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(page(items.slice(61),'fresh-end'))
  render(ui())
  fireEvent.click(await screen.findByRole('button',{name:'Load more'}))
  await screen.findByText('Window item 59')
  fireEvent.click(screen.getAllByRole('button',{name:label})[40])
  await waitFor(()=>expect(informationDigestsApi.readingState).toHaveBeenCalledWith('space-a','id-40',body,undefined))
  expect(screen.getByText('Window item 59')).toBeInTheDocument()
  expect(screen.getAllByRole('button',{name:label})[0]).toBeDisabled()
  expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a',expect.objectContaining({limit:60,cursor:undefined}),undefined,expect.any(Object))
  // Deliberately return a server-selected replacement window. The browser may
  // neither infer which group changed nor calculate its own count/cursor.
  await act(async()=>refresh.resolve({items:items.filter(i=>i.source_item_id!=='id-40').slice(0,60),total:789,next_cursor:'fresh-after-sixty'}))
  expect(screen.queryByText('Window item 40')).not.toBeInTheDocument()
  expect(screen.getByText('Window item 60')).toBeInTheDocument()
  expect(screen.getByText('789 items')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Load more'}))
  await screen.findByText('Window item 89')
  expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a',expect.objectContaining({cursor:'fresh-after-sixty',limit:30}),undefined,expect.any(Object))
})
it('publishes a window over 100 only after every freshly authorized page succeeds',async()=>{
  const items=Array.from({length:150},(_,i)=>({...item,key:`large-${i}`,source_item_id:`id-${i}`,title:`Large item ${i}`}))
  vi.mocked(informationDigestsApi.reading)
    .mockResolvedValueOnce(page(items.slice(0,30),'a')).mockResolvedValueOnce(page(items.slice(30,60),'b'))
    .mockResolvedValueOnce(page(items.slice(60,90),'c')).mockResolvedValueOnce(page(items.slice(90,120),'d'))
    .mockResolvedValueOnce(page(items.slice(0,100),'fresh-100')).mockRejectedValueOnce({status:403,message:'Access revoked during revalidation'})
  render(ui())
  for(let i=0;i<3;i++) {fireEvent.click(await screen.findByRole('button',{name:'Load more'}));await screen.findByText(`Large item ${59+i*30}`)}
  fireEvent.click(screen.getAllByRole('button',{name:'Mark read'})[100])
  await screen.findByRole('alert')
  expect(screen.queryByText('Large item 0')).not.toBeInTheDocument()
  expect(screen.queryByText('Large item 119')).not.toBeInTheDocument()
  expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a',expect.objectContaining({limit:20,cursor:'fresh-100'}),undefined,expect.any(Object))
})

function BackgroundRefresh() {
  const feed = useReading('space-a')
  return <><button onClick={() => void feed.refresh()}>Refresh after save</button>{feed.page?.items.map(row => <p key={row.key}>{row.title}</p>)}{feed.error != null && <p role="alert">Refresh failed</p>}</>
}
it('keeps the current reading mounted during post-save refresh and clears it on access failure', async () => {
  const next = deferred<ReadingPage>()
  vi.mocked(informationDigestsApi.reading).mockResolvedValueOnce(page()).mockReturnValueOnce(next.promise).mockRejectedValueOnce({ status: 403 })
  render(<BackgroundRefresh />)
  const title = await screen.findByText(item.title)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh after save' }))
  expect(screen.getByText(item.title)).toBe(title)
  await act(async () => next.resolve(page()))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh after save' }))
  await screen.findByRole('alert')
  expect(screen.queryByText(item.title)).not.toBeInTheDocument()
})
