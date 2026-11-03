import {render,screen,fireEvent,waitFor,act,within} from '@testing-library/react'
import {MemoryRouter,Routes,Route} from 'react-router-dom'
import {beforeEach,it,expect,vi} from 'vitest'
import ProjectReadingPage from './ProjectReadingPage'
import {projectReadingApi,sourceGoalsApi,informationDigestsApi,projectsApi} from '../../../api/client'
import {useReadingResource} from './useReadingResource'
import {clearSessionResidue} from '../../../lib/sessionResidue'
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'space',userId:'reader'})}))
vi.mock('../../../core/spaceNav',async()=>({SpaceLink:(await import('react-router-dom')).Link}))
vi.mock('../../../api/client',()=>({projectsApi:{get:vi.fn()},projectReadingApi:{retryComposition:vi.fn(),composition:vi.fn(),operations:vi.fn(),favorite:vi.fn(),favoriteStatus:vi.fn(),records:vi.fn(),record:vi.fn(),purposes:vi.fn(),start:vi.fn(),cancel:vi.fn()},sourceGoalsApi:{list:vi.fn()},informationDigestsApi:{reading:vi.fn(),readingState:vi.fn()}}))
const editionVersion={id:'edition',revision:2,edition_date:'2026-01-01',timezone:'UTC',day_revision:2,created_at:'2026-01-01T00:00:00Z',previous_id:null,reason:'theme_terminal'}
const composition={date:'2026-01-01',today:'2026-01-01',composition_status:'failed',latest:{id:'edition',revision:2,edition_date:'2026-01-01',timezone:'UTC',day_revision:2,created_at:'2026-01-01T00:00:00Z',previous_id:null,reason:'theme_terminal',sections:[]},history:[editionVersion],rounds:[],cross_theme_status:'not_generated'}
const goal={display:{version_id:'v',title:'Robot learning',summary:'Research and product designs'},id:'g',project_id:'p',owner_user_id:'reader',status:'running',intent_json:{intent:'Robot learning'}}
const item={key:'m',source_item_id:'m',source_item_ids:['m'],title:'Author evidence',source_uri:'https://example.test/article',occurred_at:null,summary:null,access_level:'full' as const,reader_origin:'project' as const,read_status:'unread' as const,dismissed:false,favorite:false,available_at:'2026-01-01T00:00:00Z',contributions:[],topics:[],material_links:[]}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(projectsApi.get).mockResolvedValue({current_user_can_write:false} as never);vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[]});vi.mocked(projectReadingApi.composition).mockResolvedValue(composition as never);vi.mocked(informationDigestsApi.reading).mockResolvedValue({items:[item],total:1,next_cursor:null});vi.mocked(projectReadingApi.operations).mockResolvedValue({items:[],next_offset:null,limits:{}} as never);vi.mocked(projectReadingApi.favorite).mockResolvedValue({});vi.mocked(projectReadingApi.purposes).mockResolvedValue({choices:[],truncated:false});vi.mocked(projectReadingApi.start).mockResolvedValue({status:'queued',processing_id:'op'})})
function page(search=''){return render(<MemoryRouter initialEntries={['/projects/p/sources'+search]}><Routes><Route path="/projects/:projectId/sources" element={<ProjectReadingPage/>}/></Routes></MemoryRouter>)}
it('opens the durable composition by default without acquiring materials or executing',async()=>{page();expect(await screen.findByText(/Version 2/)).toBeVisible();expect(projectReadingApi.composition).toHaveBeenCalledWith('space','p',undefined,expect.anything());expect(informationDigestsApi.reading).not.toHaveBeenCalled();expect(projectReadingApi.start).not.toHaveBeenCalled()})
it('keeps both concrete versions when switching to an older body and back to the latest of that day',async()=>{
 const old={...editionVersion,id:'old',revision:1,day_revision:1,created_at:'2026-01-01T00:00:00Z'};
 vi.mocked(projectReadingApi.composition).mockImplementation(async(_space,_project,id)=>({...composition,today:'2026-01-02',latest:{...(id==='old'?old:editionVersion),sections:[]},history:[editionVersion,old]}) as never);
 page('?date=2026-01-01');
 const select=await screen.findByRole('button',{name:'Version history'});
 expect(select).toHaveTextContent('Version 2 · Latest');fireEvent.click(select);
 expect(screen.getAllByRole('option')).toHaveLength(2);
 fireEvent.click(screen.getByRole('option',{name:/Version 1/}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Version history'})).toHaveTextContent('Version 1'));
 fireEvent.click(screen.getByRole('button',{name:'Version history'}));
 expect(screen.getAllByRole('option')).toHaveLength(2);
 expect(screen.getByRole('option',{name:/Version 2 · Latest/})).toBeVisible();
 expect(screen.queryByRole('option',{name:/^Latest$/})).toBeNull();
 fireEvent.click(screen.getByRole('option',{name:/Version 2 · Latest/}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Version history'})).toHaveTextContent('Version 2 · Latest'));
 expect(projectReadingApi.composition).toHaveBeenLastCalledWith('space','p',undefined,expect.objectContaining({date:'2026-01-01'}));
 expect(projectReadingApi.start).not.toHaveBeenCalled();expect(projectReadingApi.retryComposition).not.toHaveBeenCalled();
});
it('favorites and explicit deep requests stay independent; filters are server queries',async()=>{page('?tab=materials');expect(await screen.findByRole('link',{name:'Author evidence'})).toHaveAttribute('href',expect.stringContaining('original=1'));fireEvent.click(screen.getByRole('button',{name:'Favorite'}));await waitFor(()=>expect(projectReadingApi.favorite).toHaveBeenCalledWith('space','p','m',true));expect(projectReadingApi.start).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Favorites only'}));await waitFor(()=>expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space',expect.objectContaining({favorite:'only'}),'p',expect.anything()));fireEvent.click(screen.getByRole('button',{name:'Deep read'}));expect(await screen.findByRole('dialog')).toBeVisible();expect(projectReadingApi.start).not.toHaveBeenCalled();fireEvent.click(screen.getAllByRole('button',{name:'Deep read'}).slice(-1)[0]);await waitFor(()=>expect(projectReadingApi.start).toHaveBeenCalledWith('space','p','m',{following:null}));expect(await screen.findByText(/No private deep readings/)).toBeVisible()})
it('private list is available independently of favorites and page opens never start a Run',async()=>{page('?tab=deep');expect(await screen.findByText(/No private deep readings/)).toBeVisible();expect(projectReadingApi.operations).toHaveBeenCalled();expect(projectReadingApi.start).not.toHaveBeenCalled();expect(projectReadingApi.favorite).not.toHaveBeenCalled()})
it('scope changes, A→B→A and logout discard late results; transient errors retain authorized history',async()=>{
 const pending:Array<{resolve:(v:string)=>void;reject:(e:unknown)=>void}>=[];let key='A';const read=()=>new Promise<string>((resolve,reject)=>pending.push({resolve,reject}));let reload=()=>{}
 function Probe(){const r=useReadingResource(key,read);reload=r.reload;return <p>{r.data??'empty'}</p>}
 const p=render(<Probe/>);key='B';p.rerender(<Probe/>);key='A';p.rerender(<Probe/>);await act(async()=>{pending[0].resolve('old secret');pending[2].resolve('current')});expect(await screen.findByText('current')).toBeVisible();expect(screen.queryByText('old secret')).toBeNull();await act(async()=>reload());await waitFor(()=>expect(pending).toHaveLength(4));await act(async()=>pending[3].reject({status:500}));expect(await screen.findByText('current')).toBeVisible();await act(async()=>reload());await waitFor(()=>expect(pending).toHaveLength(5));await act(async()=>pending[4].reject({status:403}));expect(await screen.findByText('empty')).toBeVisible();await act(async()=>reload());await waitFor(()=>expect(pending).toHaveLength(6));await act(async()=>{clearSessionResidue();pending[5].resolve('logout secret')});await waitFor(()=>expect(screen.queryByText('logout secret')).toBeNull());p.unmount()
})

it('needs-consent failure keeps the explicit request open and does not pretend it queued',async()=>{
 vi.mocked(projectReadingApi.start).mockResolvedValue({status:'needs_consent'});page('?tab=materials');await screen.findByRole('link',{name:'Author evidence'});fireEvent.click(screen.getByRole('button',{name:'Deep read'}));await screen.findByRole('dialog');fireEvent.click(screen.getAllByRole('button',{name:'Deep read'}).slice(-1)[0]);expect(await screen.findByText(/Source does not currently permit retained analysis/)).toBeVisible();expect(screen.getByRole('dialog')).toBeVisible();expect(projectReadingApi.operations).not.toHaveBeenCalled()
})

it('a content refusal clears private labels yet retains only owned cancellation handles until logout',async()=>{
 vi.mocked(projectReadingApi.operations).mockResolvedValueOnce({items:[{id:'owned-op',item_id:'m',run_id:'r',project_id:'p',title:'PRIVATE TITLE',purpose_version_id:'v',purpose_label:'PRIVATE PURPOSE',status:'running',withheld:false,report:null,created_at:'2026-01-01T00:00:00Z',generation:1,original:null}],next_offset:null,limits:{attemptsPerInput:3,runSeconds:600}} as never).mockRejectedValue({status:403});
 vi.mocked(projectReadingApi.cancel).mockResolvedValue({});page('?tab=deep');expect(await screen.findByText('PRIVATE TITLE')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Refresh'}));expect(await screen.findByText(/Previously visible private requests/)).toBeVisible();expect(screen.queryByText('PRIVATE TITLE')).toBeNull();expect(screen.queryByText(/PRIVATE PURPOSE/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Cancel'}));await waitFor(()=>expect(projectReadingApi.cancel).toHaveBeenCalledWith('space','p','owned-op'));expect(await screen.findByText(/Cancellation requested/)).toBeVisible();await act(async()=>clearSessionResidue());expect(screen.queryByText(/Cancellation requested/)).toBeNull()
})

it('selects the exact Following connection, including two memberships of the same purpose version',async()=>{
 vi.mocked(projectReadingApi.purposes).mockResolvedValue({choices:[{goal_id:'g',version_id:'v',connection_id:'one',label:'Primary membership'},{goal_id:'g',version_id:'v',connection_id:'two',label:'Second membership'}],truncated:false});page('?tab=materials');await screen.findByRole('link',{name:'Author evidence'});fireEvent.click(screen.getByRole('button',{name:'Deep read'}));const purpose=await screen.findByRole('button',{name:'Purpose for this reading'});fireEvent.click(purpose);fireEvent.click(await screen.findByRole('option',{name:'Second membership'}));fireEvent.click(screen.getAllByRole('button',{name:'Deep read'}).slice(-1)[0]);await waitFor(()=>expect(projectReadingApi.start).toHaveBeenCalledWith('space','p','m',{following:{goal_id:'g',version_id:'v',connection_id:'two'}}));
})

it('returns from an exact report to its supplied original, not a later author version',async()=>{
 const {ProjectReaderTools}=await import('./ProjectReaderTools');const report={snapshot_id:'report',artifact_id:'d',captured_at:'2026-01-01T00:00:00Z',role:'analysis',original_snapshot_id:'used-v1'};const data={original:{snapshot_id:'later-v2',artifact_id:'a2'},items:[report],next_offset:null};vi.mocked(projectReadingApi.records).mockResolvedValue(data as never);vi.mocked(projectReadingApi.record).mockResolvedValue(data as never);vi.mocked(projectReadingApi.favoriteStatus).mockResolvedValue({item_id:'m',favorite:false});const choose=vi.fn();render(<MemoryRouter><ProjectReaderTools space="space" user="reader" project="p" item="m" version="report" currentArtifact="d" onChoose={choose} onDenied={vi.fn()}/></MemoryRouter>);fireEvent.click(await screen.findByRole('button',{name:'Read original used for this report'}));expect(choose).toHaveBeenCalledWith('used-v1');expect(choose).not.toHaveBeenCalledWith('later-v2');
});

it('viewer and unknown capability keep a real composition without a retry control; history is read-only',async()=>{
 const value={...composition,rounds:[{id:'r',goal_id:'g',status:'complete',error_code:null,coverage:{}}]};vi.mocked(projectReadingApi.composition).mockResolvedValue(value as never);const p=page();await screen.findByText(/Version 2/);expect(screen.queryByRole('button',{name:'Retry composition only'})).toBeNull();p.unmount();vi.mocked(projectsApi.get).mockResolvedValue({current_user_can_write:true} as never);page('?composition=old');await screen.findByText(/Historical · read only/);expect(screen.queryByRole('button',{name:'Retry composition only'})).toBeNull();
});
it('writer retry runs once; a rejected write revalidates reads instead of inventing an empty composition; refresh recovers',async()=>{
 const value={...composition,rounds:[{id:'r',goal_id:'g',status:'complete',error_code:null,coverage:{}}]};vi.mocked(projectsApi.get).mockResolvedValue({current_user_can_write:true} as never);vi.mocked(projectReadingApi.composition).mockResolvedValue(value as never);vi.mocked(projectReadingApi.retryComposition).mockRejectedValue(Object.assign(new Error('Write permission changed'),{status:404}));page();await screen.findByText(/Version 2/);fireEvent.click(await screen.findByRole('button',{name:'Retry composition only'}));await screen.findByText('Write permission changed');await waitFor(()=>expect(projectReadingApi.composition).toHaveBeenCalledTimes(2));expect(screen.getByText(/Version 2/)).toBeVisible();expect(screen.queryByText('Start with a topic and a purpose')).toBeNull();expect(projectReadingApi.retryComposition).toHaveBeenCalledTimes(1);
 vi.mocked(projectReadingApi.composition).mockRejectedValueOnce(Object.assign(new Error('Read revoked'),{status:403}));fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await screen.findByText('Read revoked');expect(screen.queryByText(/Version 2/)).toBeNull();vi.mocked(projectReadingApi.composition).mockResolvedValue(value as never);vi.mocked(projectReadingApi.retryComposition).mockResolvedValue({});fireEvent.click(screen.getByRole('button',{name:'Refresh'}));expect(await screen.findByText(/Version 2/)).toBeVisible();expect(screen.queryByText('Write permission changed')).toBeNull();fireEvent.click(await screen.findByRole('button',{name:'Retry composition only'}));await waitFor(()=>expect(projectReadingApi.retryComposition).toHaveBeenCalledTimes(2));
});
it('never exposes retry while Project capability is unresolved or missing',async()=>{
 let resolve!:(v:never)=>void;vi.mocked(projectsApi.get).mockImplementationOnce(()=>new Promise(r=>{resolve=r}));vi.mocked(projectReadingApi.composition).mockResolvedValue({...composition,rounds:[{id:'r',goal_id:'g',status:'complete',error_code:null,coverage:{}}]} as never);page();await screen.findByText(/Version 2/);expect(screen.queryByRole('button',{name:'Retry composition only'})).toBeNull();await act(async()=>resolve({} as never));expect(screen.queryByRole('button',{name:'Retry composition only'})).toBeNull();expect(screen.getByText(/Version 2/)).toBeVisible();
});

it.each(['','?date=2026-01-01'])('shows progress without yesterday\'s body or a version, then the first published analysis (%s)',async search=>{
 vi.useFakeTimers();try{
  vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[goal]} as never);
  const waiting={...composition,today:'2026-01-02',latest:null,history:[],composition_status:'waiting_for_analysis',rounds:[{id:'r',goal_id:'g',status:'generating',error_code:null,coverage:{}}]};
  vi.mocked(projectReadingApi.composition).mockResolvedValueOnce(waiting as never).mockResolvedValue({...composition,today:'2026-01-02',latest:{...composition.latest,day_revision:1,sections:[section('g')]},history:[{...editionVersion,day_revision:1}],composition_status:'complete',rounds:[{id:'r',goal_id:'g',status:'complete',error_code:null,coverage:{}}]} as never);
  let view!:ReturnType<typeof page>;await act(async()=>{view=page(search)});
  expect(screen.queryByRole('button',{name:'Version history'})).toBeNull();expect(screen.queryByText('Summary for g')).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});
  expect(screen.getByRole('button',{name:'Version history'})).toHaveTextContent('Version 1');expect(screen.getByText('Summary for g')).toBeVisible();
  expect(projectReadingApi.start).not.toHaveBeenCalled();expect(projectReadingApi.retryComposition).not.toHaveBeenCalled();view.unmount();
 }finally{vi.useRealTimers()}
});

it('refreshes current collecting composition reads until complete without starting or retrying work',async()=>{
 vi.useFakeTimers();try{
  vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[goal]} as never);
  vi.mocked(projectReadingApi.composition).mockResolvedValueOnce({...composition,rounds:[{id:'r',goal_id:'g',status:'collecting',error_code:null,coverage:{}}]} as never).mockResolvedValue({...composition,rounds:[{id:'r',goal_id:'g',status:'complete',error_code:null,coverage:{}}]} as never);
  let view!:ReturnType<typeof page>;await act(async()=>{view=page()});expect(screen.getByText(/Collecting/)).toBeVisible();
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});expect(screen.queryByText(/Collecting/)).toBeNull();expect(screen.getByText('No analysis has been published for this topic. Collected materials remain available.')).toBeVisible();await act(async()=>{await vi.advanceTimersByTimeAsync(10000)});
  expect(projectReadingApi.composition).toHaveBeenCalledTimes(2);expect(projectReadingApi.retryComposition).not.toHaveBeenCalled();view.unmount()
 }finally{vi.useRealTimers()}
})
it('routes an upstream analysis failure to its Topic instead of offering composition retry',async()=>{
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[goal]} as never);
 vi.mocked(projectsApi.get).mockResolvedValue({current_user_can_write:true} as never);vi.mocked(projectReadingApi.composition).mockResolvedValue({...composition,composition_status:'waiting_for_analysis',rounds:[{id:'r',goal_id:'g',status:'blocked',error_code:'briefing_output_invalid',coverage:{complete:true}}]} as never);page();
 expect(await screen.findByText(/did not pass format or citation checks/)).toBeVisible();expect(screen.queryByText('Daily editions record completed collection checks. Topic analysis is optional and uses its own authorization. Opening this page starts nothing.')).toBeNull();expect(screen.getByRole('link',{name:'Open topic to resolve'})).toHaveAttribute('href','/projects/p/sources/goals/g#topic-analysis');expect(screen.queryByRole('button',{name:'Retry composition only'})).toBeNull();expect(projectReadingApi.retryComposition).not.toHaveBeenCalled()
})
it.each(['idle','complete','queued','running','waiting_for_analysis'])('does not offer composition retry for %s',async composition_status=>{
 vi.mocked(projectsApi.get).mockResolvedValue({current_user_can_write:true} as never);vi.mocked(projectReadingApi.composition).mockResolvedValue({...composition,composition_status,rounds:[{id:'r',goal_id:'g',status:'complete',error_code:null,coverage:{}}]} as never);const view=page();await screen.findByText(/Version 2/);expect(screen.queryByRole('button',{name:'Retry composition only'})).toBeNull();view.unmount()
})

function section(id:string){
 return {goal_id:id,published_at:'2026-01-01T12:00:00Z',purpose_text:'Frozen purpose',visibility:'visible',briefing:{id:'brief-'+id,status:'ready',scope_type:'project',visibility:'visible',comparison:'baseline',outcome:'briefing',context_outdated:false,hidden_units:0,
  topic:{quick_line:'REDUNDANT QUICK LINE',summary:'Summary for '+id,stop_reason:'Evidence limits'},overview:{text:'Complete evidence-based overview',refs:['S1']},
  highlights:[0,1,2,3].map(index=>({index,title:`Finding ${id} ${index}`,what_changed:`Discovery ${index}`,refs:['S1'],rests_on_unverified:index===0,statements:[],novelty:'baseline',importance:'high',source_domains:1,why_it_matters:'Purpose relevance',impact:{assessment:'insufficient_context',text:'Unknown impact',context_refs:[]},suggested_action:'watch'})),
  evidence:[{key:'S1',title:'Exact retained source',source_item_id:'m',original_snapshot_id:'frozen-original',source_domain:'example.test',delta_class:'new',lenses:[{kind:'following',label:'OLD RAW REQUEST — retry again'}],unverified:true}],context:[],open_questions:[],coverage:{included:1,complete:true}}}
}
it('shows each topic once with bounded cited findings and its own failed check beside retained content',async()=>{
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[goal]} as never)
 vi.mocked(projectReadingApi.composition).mockResolvedValue({...composition,composition_status:'waiting_for_analysis',latest:{...composition.latest,sections:[section('g'),section('two')]},rounds:[{goal_id:'g',status:'blocked',error_code:'briefing_output_invalid',coverage:{complete:true}}]} as never)
 const view=page();await screen.findByText('Summary for g')
 expect(screen.getAllByRole('heading',{name:'Robot learning'})).toHaveLength(1)
 expect(screen.queryByText('At a glance')).toBeNull();expect(screen.queryByText('Latest collection and analysis checks')).toBeNull();expect(screen.queryByText('REDUNDANT QUICK LINE')).toBeNull()
 expect(screen.queryByText('Finding g 3')).toBeNull();expect(screen.getByText('Finding two 0')).toBeVisible()
 fireEvent.focus(screen.getAllByRole('link',{name:'View source: Exact retained source'})[0])
 expect(await screen.findByRole('dialog',{name:'Exact retained source'})).toBeVisible()
 expect(within(screen.getByRole('dialog',{name:'Exact retained source'})).getByRole('link',{name:'Exact retained source'})).toHaveAttribute('href',expect.stringContaining('version=frozen-original'))
 expect(screen.getByText('The previous published analysis is retained.')).toBeVisible()
 expect(screen.getByRole('link',{name:'Open topic to resolve'})).toHaveAttribute('href','/projects/p/sources/goals/g#topic-analysis')
 expect(screen.queryByTestId('briefing-view')).toBeNull();expect(projectReadingApi.retryComposition).not.toHaveBeenCalled();view.unmount()
})
it('opens a pinned full analysis, restores its entry focus, and clears report content after a read refusal',async()=>{
 const value={...composition,composition_status:'complete',latest:{...composition.latest,sections:[section('g')]}}
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[goal]} as never);vi.mocked(projectReadingApi.composition).mockResolvedValue(value as never)
 page();const entry=await screen.findByRole('link',{name:'Read full analysis'});fireEvent.click(entry)
 expect(await screen.findByTestId('briefing-view')).toBeVisible();expect(screen.queryByText(/OLD RAW REQUEST/)).toBeNull();expect(projectReadingApi.composition).toHaveBeenCalledWith('space','p','edition',expect.anything())
 expect(within(screen.getByRole('region',{name:'Evidence'})).getByText(/Robot learning/)).toBeVisible()
 expect(screen.getAllByRole('heading',{name:'Robot learning'})).toHaveLength(1)
 expect(screen.getByRole('link',{name:'Exact retained source'})).toHaveAttribute('href',expect.stringContaining('analysisVersion%3Dedition'))
 fireEvent.click(screen.getByRole('link',{name:'Back to overview'}));await waitFor(()=>expect(screen.queryByTestId('briefing-view')).toBeNull());expect(entry).toHaveFocus()
 vi.mocked(projectReadingApi.composition).mockRejectedValue(Object.assign(new Error('Report access revoked'),{status:403}));fireEvent.click(entry);await screen.findByText('Report access revoked');await waitFor(()=>expect(screen.queryByTestId('briefing-view')).toBeNull());fireEvent.click(screen.getByRole('link',{name:'Back to overview'}));await waitFor(()=>expect(screen.queryByText('Summary for g')).toBeNull());expect(screen.queryByText('No analysis has been published for this topic. Collected materials remain available.')).toBeNull()
})
it('historical topic sections never inherit a current failed run or unanalysed goal',async()=>{
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[goal]} as never)
 vi.mocked(projectReadingApi.composition).mockResolvedValue({...composition,latest:{...composition.latest,sections:[section('two')]},rounds:[]} as never)
 page('?composition=old');await screen.findByText('Summary for two');expect(screen.queryByRole('heading',{name:'Robot learning'})).toBeNull();expect(screen.queryByText(/did not pass format/)).toBeNull()
})
