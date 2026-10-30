import { toast } from 'sonner'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingItem, ReadingPage } from '@rainver/protocol'
import ReadingWorkspace, { ReadingPreview } from '../ReadingWorkspace'
import { sourceGoalsApi,informationDigestsApi } from '../../../api/client'
import { useReading } from '../useReading'
import { ProjectReadingPreference } from '../ReadingPreferences'
import { readingReturnTo } from '../readingLinks'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))

// Empty guidance has its own source/collection integration coverage.
vi.mock('../ReadingStart', () => ({ ReadingStart: () => <p>No pending recommendations</p> }))
let space = 'space-a'
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: space, preferredSpaceId: space }) }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link, useNavigate } = await import('react-router-dom')
  return { SpaceLink: Link, useSpaceNavigate: useNavigate }
})
vi.mock('../../../api/client', () => ({ sourceGoalsApi:{list:vi.fn().mockResolvedValue({goals:[]})},informationDigestsApi: { reading: vi.fn(), readingState: vi.fn(), readingPreference: vi.fn(), setReadingPreference: vi.fn() }, projectsApi: { list: vi.fn().mockResolvedValue({ items: [{ id: 'project-a', name: 'Project A' }] }) }, projectMonitoringApi: { state: vi.fn().mockResolvedValue({ active: null, latest_run: null }) } }))
const item: ReadingItem = { key: 'server-group', source_item_id: 'article', source_item_ids: ['article','copy'], title: 'A retained recommendation', summary: 'Frozen summary', source_uri: null, occurred_at: '2026-01-01T00:00:00Z', access_level: 'full', reader_origin: 'project', read_status: 'unread', dismissed: false, available_at: '2026-01-02T00:00:00Z', contributions: [{ delivery_id: 'first', source_item_id:'article',kind:'project_initial',project_id:'project-a',project_name:'Project A',digest_id:null,digest_date:null,timezone:null,available_at:'2026-01-02T00:00:00Z',position:0,section:null,summary:null,rationale:'Original initial reason' }, { delivery_id:'daily',source_item_id:'copy',kind:'personal_digest',project_id:null,project_name:null,digest_id:'edition',digest_date:'2026-01-03',timezone:'Asia/Shanghai',available_at:'2026-01-04T00:00:00Z',position:0,section:'interest',summary:null,rationale:'Original daily reason' }], material_links:[], topics:[] }
const page = (items: ReadingItem[] = [item], next_cursor: string | null = null): ReadingPage => ({ items, total: items.length, next_cursor })
function deferred<T>() { let resolve!: (v:T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function QueryLocation() { return <output data-testid="query">{useLocation().search}</output> }
const ui = (projectId?: string) => <MemoryRouter><ReadingWorkspace projectId={projectId} /><QueryLocation /></MemoryRouter>
beforeEach(() => { vi.clearAllMocks(); window.sessionStorage.clear(); window.localStorage.clear(); space = 'space-a'; vi.mocked(informationDigestsApi.reading).mockResolvedValue(page()); vi.mocked(informationDigestsApi.readingState).mockResolvedValue({updated:2}); vi.mocked(informationDigestsApi.readingPreference).mockResolvedValue({show_in_my_reading:false}) })
describe('unified reading presentation', () => {
  it('renders server grouping, all original reasons and distinct initial/edition times, with Reader origin', async () => {
    render(ui())
    const link = await screen.findByRole('link', { name: item.title })
    expect(link).toHaveAttribute('href', expect.stringContaining('from=project'))
    expect(screen.getByText('Original initial reason')).not.toBeVisible()
    fireEvent.click(screen.getByText('Why this is here'))
    expect(screen.getByText('Original initial reason')).toBeVisible()
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

it('keeps goal management accessible without expanding saved setup cards',async()=>{vi.mocked(sourceGoalsApi.list).mockResolvedValueOnce({goals:[{id:'saved-goal',space_id:space,project_id:null,status:'needs_information',intent_json:{intent:'Follow agent products'},execution:{phase:'failed'}}]} as never);render(ui());await screen.findByRole('link',{name:'Following (0)'});expect(screen.getByRole('link',{name:'Following (0)'})).toHaveAttribute('href','/library/reading/goals');expect(screen.queryByText('Follow agent products')).not.toBeInTheDocument()});
it('M2: Reading card labels Agent submissions without claiming independent verification',async()=>{
 vi.mocked(informationDigestsApi.reading).mockResolvedValue(page([{...item,result_provenance:'agent_provided_unverified'}]));render(ui());await screen.findByText('Agent-provided · Not independently verified');expect(screen.getByRole('link',{name:item.title})).toBeInTheDocument();
});

it('keeps many goals in one toolbar destination with following count',async()=>{
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:Array.from({length:30},(_,n)=>({id:'g'+n,space_id:space,project_id:null,status:n<28?'running':'paused',compatibility_json:n===0?{execution_mode:'manual'}:{},intent_json:{intent:'Long objective '+n},execution:{phase:n===0?'working':n===1?'queued':'plan_ready'}}))} as never);
 render(ui());await screen.findByRole('link',{name:'Following (27)'});expect(screen.getAllByRole('link',{name:'Following (27)'})).toHaveLength(1);expect(screen.queryByText(/Long objective/)).not.toBeInTheDocument();const tools=screen.getByRole('navigation',{name:'Reading views'});expect(within(tools).getByRole('link',{name:'Following (27)'})).toBeInTheDocument();expect(within(tools).getByRole('link',{name:'Source management'})).toBeInTheDocument();
});

const topicGoal=(id:string,intent:string,state:Record<string,unknown>,over:Record<string,unknown>={})=>({id,space_id:space,project_id:null,status:'running',intent_json:{intent},compatibility_json:{},follow_state:{intent:'following',phase:'scheduled',...state},...over})
it('counts confirmed following, including background preparation, but never drafts, paused or manual-save topics',async()=>{
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[topicGoal('a','Preparing topic',{phase:'preparing'},{status:'draft'}),topicGoal('b','Followed topic',{}),topicGoal('c','Paused topic',{intent:'paused',phase:'stopped'},{status:'paused'}),topicGoal('d','Draft topic',{intent:'unconfirmed',phase:'none'},{status:'preview_ready'}),topicGoal('e','Manual topic',{},{compatibility_json:{execution_mode:'manual'}})]} as never)
 render(ui());expect(await screen.findByRole('link',{name:'Following (2)'})).toBeInTheDocument()
})
it('filters Reading by one topic with important updates by default, shows why, and returns from Reader to the same filter',async()=>{
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[topicGoal('topic-a','Robot learning',{}),topicGoal('topic-b','Other topic',{})]} as never)
 const linked={...item,topics:[{goal_id:'topic-a',project_id:null,title:'Robot learning',selection_status:'important' as const,selection_reason:'A new benchmark result',judged_by:'collection_agent' as const,delivery_kind:'new_publication' as const,change_evidence_url:null},{goal_id:'topic-b',project_id:null,title:'Other topic',selection_status:'not_selected' as const,selection_reason:null,judged_by:null,delivery_kind:'baseline' as const,change_evidence_url:null}]}
 vi.mocked(informationDigestsApi.reading).mockResolvedValue(page([linked]))
 render(ui());await screen.findByRole('link',{name:item.title});expect(screen.getByRole('link',{name:'Robot learning'})).toHaveAttribute('href','/library/reading/goals/topic-a');expect(screen.getByRole('link',{name:'Other topic'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Topic'}));fireEvent.click(await screen.findByRole('option',{name:'Robot learning'}))
 await waitFor(()=>expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a',expect.objectContaining({view:'pending',topic:'topic-a',topic_selection:'important'}),undefined,expect.anything()))
 expect(screen.getByTestId('query')).toHaveTextContent('?topic=topic-a')
 await waitFor(()=>expect(screen.queryByRole('link',{name:'Other topic'})).not.toBeInTheDocument());expect(screen.getByText('A new benchmark result')).toBeInTheDocument();expect(screen.getByText('New')).toBeInTheDocument()
 expect(screen.getByRole('link',{name:item.title}).getAttribute('href')).toContain('returnTo=%2Flibrary%2Freading%3Ftopic%3Dtopic-a')
 fireEvent.click(screen.getByRole('button',{name:'All collected'}));await waitFor(()=>expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a',expect.objectContaining({topic:'topic-a',topic_selection:'all'}),undefined,expect.anything()))
 expect(screen.getByTestId('query')).toHaveTextContent('?topic=topic-a&topic_selection=all')
 fireEvent.click(screen.getByRole('button',{name:'Read'}));await waitFor(()=>expect(screen.getByRole('link',{name:item.title}).getAttribute('href')).toContain('returnTo=%2Flibrary%2Freading%3Fview%3Dread%26topic%3Dtopic-a%26topic_selection%3Dall'))
})
it('shows a topic-specific empty state instead of first-use guidance',async()=>{
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[topicGoal('topic-a','Robot learning',{})]} as never);vi.mocked(informationDigestsApi.reading).mockResolvedValue(page([]))
 render(<MemoryRouter initialEntries={['/?topic=topic-a']}><ReadingWorkspace/></MemoryRouter>)
 expect(await screen.findByText('No important updates yet. Switch to All collected to see other matching material.')).toBeInTheDocument();expect(screen.queryByText('No pending recommendations')).not.toBeInTheDocument()
})
it('returns from Reader to the submitted search, and the return path passes the bounded check', async () => {
 render(<MemoryRouter initialEntries={['/?view=all&q=%E6%9C%BA%E5%99%A8+%E5%AD%A6%E4%B9%A0+%26+C%2B%2B']}><ReadingWorkspace/></MemoryRouter>)
 const href = (await screen.findByRole('link', { name: item.title })).getAttribute('href')!
 const returnTo = new URL(href, 'https://local.test').searchParams.get('returnTo')!
 expect(new URLSearchParams(returnTo.split('?')[1]).get('q')).toBe('机器 学习 & C++')
 expect(readingReturnTo(returnTo)).toBe(returnTo)
})

describe('Stage 3 list controls', () => {
  const second: ReadingItem = { ...item, key: 'second', source_item_id: 'second', source_item_ids: ['second'], title: 'Second recommendation' }
  it('sorts oldest first as a server query that the Reader returns to', async () => {
    vi.mocked(informationDigestsApi.reading).mockResolvedValue(page([item, second]))
    render(ui())
    await screen.findByRole('link', { name: item.title })
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Oldest first' }))
    await waitFor(() => expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a', expect.objectContaining({ sort: 'oldest' }), undefined, expect.anything()))
    expect(screen.getByTestId('query')).toHaveTextContent('?sort=oldest')
    const href = (await screen.findByRole('link', { name: item.title })).getAttribute('href') ?? ''
    const returnTo = new URLSearchParams(href.split('?')[1]).get('returnTo')
    expect(returnTo).toBe('/library/reading?sort=oldest')
    expect(readingReturnTo(returnTo)).toBe(returnTo)
  })

  it('moves between rows with the arrow keys and remembers a compact list', async () => {
    vi.mocked(informationDigestsApi.reading).mockResolvedValue(page([item, second]))
    const { unmount } = render(ui())
    await screen.findByRole('link', { name: item.title })
    const [first, next] = screen.getAllByRole('listitem').filter(row => row.hasAttribute('data-reading-row'))
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(next).toHaveFocus()
    fireEvent.keyDown(next, { key: 'Home' })
    expect(first).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }))
    expect(screen.getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true')
    unmount()
    render(ui())
    await screen.findByRole('link', { name: item.title })
    expect(screen.getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('comes back to the opened item after the Reader, reloading as many rows as were open', async () => {
    const many = Array.from({ length: 30 }, (_, n) => ({ ...item, key: `row-${n}`, source_item_id: `row-${n}`, source_item_ids: [`row-${n}`], title: `Row ${n}` }))
    const later = { ...item, key: 'row-40', source_item_id: 'row-40', source_item_ids: ['row-40'], title: 'Row 40' }
    window.sessionStorage.setItem('rainver:reading-return', JSON.stringify({ spaceId: 'space-a', returnTo: '/library/reading', key: 'row-40', loaded: 45, at: Date.now() }))
    vi.mocked(informationDigestsApi.reading).mockResolvedValueOnce(page(many, 'c1')).mockResolvedValueOnce(page([...many, later], null))
    render(ui())
    await screen.findByRole('link', { name: 'Row 40' })
    expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-a', expect.objectContaining({ limit: 45 }), undefined, expect.anything())
    await waitFor(() => expect(screen.getByRole('listitem', { name: 'Row 40' })).toHaveFocus())
  })

  it('says so when the opened item is no longer in the list', async () => {
    window.sessionStorage.setItem('rainver:reading-return', JSON.stringify({ spaceId: 'space-a', returnTo: '/library/reading', key: 'gone', loaded: 1, at: Date.now() }))
    render(ui())
    expect(await screen.findByText(/no longer in this list/)).toBeInTheDocument()
  })

  it('labels the list search as a search of this list, not of the text or the document', async () => {
    render(ui())
    expect(await screen.findByRole('textbox', { name: 'Search this list’s titles, summaries and sources (not full text)' })).toBeInTheDocument()
  })
})

describe('Reading item preview', () => {
  it('previews the focused row from authorized list data, while preserving the Reader link', async () => {
    render(ui())
    const row = await screen.findByRole('listitem', { name: item.title })
    fireEvent.focus(row)
    const preview = within(screen.getByRole('complementary', { name: 'Preview' }))
    expect(preview.getByRole('heading', { name: item.title })).toBeInTheDocument()
    expect(preview.getByText('Original initial reason')).toBeInTheDocument()
    expect(preview.getByRole('link', { name: 'Open article' })).toHaveAttribute('href', expect.stringContaining('/library/items/article'))
  })

  it('never offers full-text navigation from a summary-only preview and clears on query changes', async () => {
    vi.mocked(informationDigestsApi.reading).mockResolvedValue(page([{ ...item, access_level: 'summary' }]))
    render(ui())
    fireEvent.focus(await screen.findByRole('listitem', { name: item.title }))
    const preview = within(screen.getByRole('complementary', { name: 'Preview' }))
    expect(preview.queryByRole('link', { name: 'Open article' })).not.toBeInTheDocument()
    expect(preview.getByText('Only the summary is available; full text cannot be opened.')).toBeInTheDocument()
    vi.mocked(informationDigestsApi.reading).mockImplementation(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    await waitFor(() => expect(preview.queryByRole('heading', { name: item.title })).not.toBeInTheDocument())
  })
})


describe('Reading state undo', () => {
  it('keeps Undo available after failure and prevents Sonner from closing it early', async () => {
    render(ui())
    fireEvent.click(await screen.findByRole('button', { name: 'Mark read' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const options = vi.mocked(toast.success).mock.calls[0][1] as unknown as { action: { onClick: (event: { preventDefault: () => void }) => Promise<void> } }
    vi.mocked(informationDigestsApi.readingState).mockRejectedValueOnce(new Error('offline'))
    const preventDefault = vi.fn()
    await act(async () => options.action.onClick({ preventDefault }))
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(toast.dismiss).not.toHaveBeenCalled()
    await act(async () => options.action.onClick({ preventDefault }))
    expect(informationDigestsApi.readingState).toHaveBeenCalledTimes(3)
    expect(toast.dismiss).toHaveBeenCalledOnce()
  })

  it('an old Undo cannot bypass a currently pending mutation', async () => {
    const other = { ...item, key: 'second', source_item_id: 'second', title: 'Second' }
    vi.mocked(informationDigestsApi.reading).mockResolvedValue(page([item, other]))
    render(ui())
    fireEvent.click((await screen.findAllByRole('button', { name: 'Mark read' }))[0])
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const options = vi.mocked(toast.success).mock.calls[0][1] as unknown as { action: { onClick: () => Promise<void> } }
    const pending = deferred<{ updated: number }>()
    vi.mocked(informationDigestsApi.readingState).mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark read' })[1])
    await act(async () => options.action.onClick())
    expect(informationDigestsApi.readingState).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve({ updated: 1 }))
    await act(async () => options.action.onClick())
    expect(informationDigestsApi.readingState).toHaveBeenCalledTimes(3)
  })

  it('undoes setting aside through the state API', async () => {
    render(ui())
    fireEvent.click(await screen.findByRole('button', { name: 'Set aside for me' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const options = vi.mocked(toast.success).mock.calls[0][1] as unknown as { action: { onClick: () => Promise<void> } }
    await act(async () => options.action.onClick())
    expect(informationDigestsApi.readingState).toHaveBeenLastCalledWith('space-a', 'article', { dismissed: false }, undefined)
  })

  it('undoes a confirmed read state through the real state API, once', async () => {
    render(ui())
    fireEvent.click(await screen.findByRole('button', { name: 'Mark read' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Marked as read', expect.anything()))
    const options = vi.mocked(toast.success).mock.calls[vi.mocked(toast.success).mock.calls.length - 1]?.[1] as unknown as { action: { onClick: () => Promise<void> } }
    await act(async () => { await options.action.onClick(); await options.action.onClick() })
    expect(informationDigestsApi.readingState).toHaveBeenCalledTimes(2)
    expect(informationDigestsApi.readingState).toHaveBeenLastCalledWith('space-a', 'article', { read_status: item.read_status }, undefined)
  })
  it('offers no successful undo notification for a refused update', async () => {
    vi.mocked(informationDigestsApi.readingState).mockRejectedValueOnce(new Error('denied'))
    render(ui())
    fireEvent.click(await screen.findByRole('button', { name: 'Mark read' }))
    await screen.findByRole('alert')
    expect(toast.success).not.toHaveBeenCalled()
  })
})


it('does not apply an old undo after leaving and returning to the same list view', async () => {
  render(ui())
  fireEvent.click(await screen.findByRole('button', { name: 'Mark read' }))
  await waitFor(() => expect(toast.success).toHaveBeenCalled())
  const options = vi.mocked(toast.success).mock.calls[0][1] as unknown as { action: { onClick: () => Promise<void> } }
  fireEvent.click(screen.getByRole('button', { name: 'Read' }))
  await waitFor(() => expect(screen.getByTestId('query')).toHaveTextContent('view=read'))
  fireEvent.click(screen.getByRole('button', { name: 'To read' }))
  await waitFor(() => expect(screen.getByTestId('query')).not.toHaveTextContent('view=read'))
  await act(async () => { await options.action.onClick() })
  expect(informationDigestsApi.readingState).toHaveBeenCalledTimes(1)
})

it('main Reading replaces only unread arrival status, keeping the existing metadata badge count',async()=>{
 const link={goal_id:'topic-a',project_id:null,title:'Following',selection_status:'important' as const,selection_reason:null,judged_by:'collection_agent' as const,delivery_kind:'unknown_freshness' as const,new_in_latest_collection:true,change_evidence_url:null};
 const row=(key:string,read_status:ReadingItem['read_status'],fresh:boolean):ReadingItem=>({...item,key,source_item_id:key,source_item_ids:[key],title:key,contributions:[],topics:[{...link,new_in_latest_collection:fresh}],read_status,result_provenance:'agent_provided_unverified'});
 vi.mocked(informationDigestsApi.reading).mockResolvedValue(page([row('Latest article','unread',true),row('Older article','unread',false),row('Opened article','skimmed',true),row('Read article','read',true)]));render(ui());
 const fresh=await screen.findByRole('listitem',{name:'Latest article'});const old=screen.getByRole('listitem',{name:'Older article'});
 expect(within(fresh).getByText('Just collected')).toBeVisible();expect(within(fresh).queryByText('Unread')).not.toBeInTheDocument();expect(within(old).getByText('Unread')).toBeVisible();
 expect(fresh.querySelectorAll('[class*="rounded-full"]').length).toBe(old.querySelectorAll('[class*="rounded-full"]').length);
 expect(within(screen.getByRole('listitem',{name:'Opened article'})).queryByText('Just collected')).not.toBeInTheDocument();expect(within(screen.getByRole('listitem',{name:'Read article'})).queryByText('Just collected')).not.toBeInTheDocument();
 expect(fresh.querySelector('details')).not.toHaveAttribute('open');
});
it('a filtered Reading topic does not borrow a new-arrival marker from another topic',async()=>{
 const base={project_id:null,title:'Following',selection_status:'important' as const,selection_reason:null,judged_by:null,delivery_kind:'baseline' as const,change_evidence_url:null};
 vi.mocked(informationDigestsApi.reading).mockResolvedValue(page([{...item,topics:[{...base,goal_id:'topic-a'},{...base,goal_id:'topic-b',new_in_latest_collection:true}]}]));
 render(<MemoryRouter initialEntries={['/?topic=topic-a']}><ReadingWorkspace/></MemoryRouter>);const card=await screen.findByRole('listitem',{name:item.title});expect(within(card).getByText('Unread')).toBeVisible();expect(within(card).queryByText('Just collected')).not.toBeInTheDocument();
});
