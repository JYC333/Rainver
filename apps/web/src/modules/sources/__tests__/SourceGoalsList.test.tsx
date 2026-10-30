import {render,screen,within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi,beforeEach} from 'vitest'
import SourceGoalsList from '../SourceGoalsList'
import {sourceGoalsApi} from '../../../api/client'
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'s',userId:'u'})}))
vi.mock('../../../api/client',()=>({sourceGoalsApi:{list:vi.fn(async()=>({goals:[]})),action:vi.fn(async()=>({}))},sourcesApi:{channels:vi.fn()}}))
const results={items_total:5,important_total:2,unjudged_total:0,not_selected_total:3,judgment_failed_total:0,baseline_total:5,new_publication_total:0,evidenced_change_total:0,unknown_freshness_total:0,changes_total:1,last_outcome:'no_new' as const,last_new_items:0,last_checked_at:'2026-10-28T10:00:00Z',last_success_at:'2026-10-28T10:00:00Z',next_check_at:'2026-10-29T10:00:00Z'}
const goal=(id:string,over:Record<string,unknown>={})=>({id,space_id:'s',owner_user_id:'u',project_id:null,intent_json:{intent:'Robotics '+id},budget_json:{requests_per_run:8,items_per_source:20,agent_attempts:2,repair_attempts:2,interval_seconds:86400},status:'running',revision:1,current_version_id:'v',active_version_id:'v',follow_state:{intent:'following',collections:{queued:0,running:0},pending_adjustment:false,phase:'scheduled',blocked_reason:null,health:'ok',sources:[],results},...over})
beforeEach(()=>{vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[]});vi.mocked(sourceGoalsApi.action).mockClear()})
it.each([[undefined,'/spaces/s/library/reading'],['p','/spaces/s/projects/p/sources']])('provides a top scoped return link for %s',async(projectId,href)=>{
 render(<MemoryRouter initialEntries={['/spaces/s/library/reading/goals']}><SourceGoalsList projectId={projectId}/></MemoryRouter>);expect(await screen.findByRole('link',{name:'Back to reading'})).toHaveAttribute('href',href);expect(screen.getByRole('link',{name:'Follow a topic'})).toBeInTheDocument();
})
it('lists each topic with its server follow state, counts and canonical pause/resume',async()=>{
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[goal('a'),goal('b',{status:'paused',follow_state:{...goal('b').follow_state,intent:'paused',phase:'stopped'}}),goal('c',{project_id:'other'})]} as never)
 render(<MemoryRouter><SourceGoalsList/></MemoryRouter>)
 const a=(await screen.findByRole('link',{name:'Robotics a'})).closest('li')!;expect(within(a).getByText('Following')).toBeInTheDocument();expect(within(a).getByText(/2 important of 5 collected · 1 changes/)).toBeInTheDocument()
 const b=screen.getByRole('link',{name:'Robotics b'}).closest('li')!;expect(within(b).getByText('Paused')).toBeInTheDocument()
 expect(screen.queryByText('Robotics c')).not.toBeInTheDocument()
 await userEvent.click(within(a).getByRole('button',{name:'Pause'}));expect(sourceGoalsApi.action).toHaveBeenCalledWith('a','pause',{version_id:'v'},{spaceId:'s'})
 await userEvent.click(within(b).getByRole('button',{name:'Resume'}));expect(sourceGoalsApi.action).toHaveBeenCalledWith('b','resume',{version_id:'v'},{spaceId:'s'})
})
it('a confirmed topic still preparing can be paused from the list, and its paused form resumes',async()=>{
 const preparing=goal('p',{status:'exploring',active_version_id:null,current_version_id:null,follow_json:{idempotency_key:'k'},follow_state:{...goal('p').follow_state,phase:'preparing'}});const pausedPrep=goal('q',{status:'paused',active_version_id:null,current_version_id:null,follow_json:{idempotency_key:'k'},follow_state:{...goal('q').follow_state,intent:'paused',phase:'stopped'}});const draft=goal('d',{status:'draft',active_version_id:null,follow_json:null,follow_state:{...goal('d').follow_state,intent:'unconfirmed',phase:'none'}})
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[preparing,pausedPrep,draft]} as never);render(<MemoryRouter><SourceGoalsList/></MemoryRouter>)
 const p=(await screen.findByRole('link',{name:'Robotics p'})).closest('li')!;await userEvent.click(within(p).getByRole('button',{name:'Pause'}));expect(sourceGoalsApi.action).toHaveBeenCalledWith('p','pause',{version_id:null},{spaceId:'s'})
 const q=screen.getByRole('link',{name:'Robotics q'}).closest('li')!;await userEvent.click(within(q).getByRole('button',{name:'Resume'}));expect(sourceGoalsApi.action).toHaveBeenCalledWith('q','resume',{version_id:null},{spaceId:'s'})
 const d=screen.getByRole('link',{name:'Robotics d'}).closest('li')!;expect(within(d).queryByRole('button',{name:/Pause|Resume/})).not.toBeInTheDocument()
})

it('uses the Agent short title while preserving original intent as a fallback for older topics',async()=>{
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[goal('a',{compatibility_json:{display_title:'Robot learning'},intent_json:{intent:'Please keep following a long detailed robotics research question'}}),goal('old')]} as never);
 render(<MemoryRouter><SourceGoalsList/></MemoryRouter>);
 expect(await screen.findByRole('link',{name:'Robot learning'})).toBeInTheDocument();
 expect(screen.queryByText('Please keep following a long detailed robotics research question')).not.toBeInTheDocument();
 expect(screen.getByRole('link',{name:'Robotics old'})).toBeInTheDocument();
});
it('REPORTED: the list names a changed Source and a usage limit the same way the topic does, not as a generic permission',async()=>{
 const src=(over:Record<string,unknown>)=>({binding_id:'b',source_connection_id:'c',status:'paused',health:'needs_permission',error:'source_authority_revoked',failures:0,last_success_at:null,retry_at:null,...over})
 vi.mocked(sourceGoalsApi.list).mockResolvedValue({goals:[goal('a',{follow_state:{...goal('a').follow_state,phase:'waiting_for_permission',health:'needs_permission',sources:[src({attention:'source_changed',resolvable_by:'you'})]}}),goal('b',{follow_state:{...goal('b').follow_state,phase:'blocked',health:'failing',blocked_reason:'source_native_budget_exhausted',sources:[src({health:'failing',error:'source_native_budget_exhausted',attention:'budget',resolvable_by:'you'})]}})]} as never)
 render(<MemoryRouter><SourceGoalsList/></MemoryRouter>)
 expect(await screen.findByText('Source changed — confirm')).toBeInTheDocument();expect(screen.getByText('Usage limit reached')).toBeInTheDocument();expect(screen.queryByText('Needs permission')).not.toBeInTheDocument()
})
