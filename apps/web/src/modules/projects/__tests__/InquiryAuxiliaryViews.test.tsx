import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {MemoryRouter,Routes,Route,useSearchParams} from 'react-router-dom'
import {beforeEach,it,expect,vi} from 'vitest'
import InquiryAreaPage from '../InquiryAreaPage'
import {inquiryApi} from '../../../api/client'
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'space'})}))
vi.mock('../../../api/client',()=>({inquiryApi:{listThreads:vi.fn(),listCandidates:vi.fn()}}))
vi.mock('../problemWorkspace/ProblemAreaPage',()=>({default:()=>{const [p]=useSearchParams();return <p>Problem {p.get('thread')}</p>}}))
vi.mock('../inquiryArea/MapView',()=>({MapView:({threads,onSelect}:any)=><button onClick={()=>onSelect(threads[0].id)}>Open mapped {threads.length}</button>}))
vi.mock('../inquiryArea/ReviewView',()=>({ReviewView:({candidates,deferredCandidates,onOpenThread}:any)=><button onClick={()=>onOpenThread('question')}>Review {candidates.length}/{deferredCandidates.length}</button>}))
vi.mock('../inquiryArea/dialogs',()=>({CreateThreadDialog:()=>null}))
vi.mock('../KnowledgeReviewPage',()=>({default:()=> <p>Knowledge queue</p>}))
vi.mock('../ExperimentAreaPage',()=>({default:()=> <p>Independent experiments</p>}))
beforeEach(()=>{vi.mocked(inquiryApi.listThreads).mockReset().mockResolvedValue([{id:'question'}] as any);vi.mocked(inquiryApi.listCandidates).mockReset().mockResolvedValue([{id:'candidate'}] as any)})
function mount(view:string){return render(<MemoryRouter initialEntries={[`/projects/project/inquiry?view=${view}`]}><Routes><Route path="/projects/:projectId/inquiry" element={<InquiryAreaPage/>}/></Routes></MemoryRouter>)}
it('preserves Map and opens the selected identity in the sole problem workspace',async()=>{
 mount('map');fireEvent.click(await screen.findByRole('button',{name:'Open mapped 1'}));expect(await screen.findByText('Problem question')).toBeInTheDocument();
 expect(inquiryApi.listThreads).toHaveBeenCalledWith('project');
})
it('preserves both review queues and navigates without an obsolete Advice/work write',async()=>{
 mount('review');fireEvent.click(await screen.findByRole('button',{name:'Review 1/1'}));expect(await screen.findByText('Problem question')).toBeInTheDocument();
 expect(inquiryApi.listCandidates).toHaveBeenCalledWith('project','deferred');
})
it('retains independent experiments without creating a question or a workflow',async()=>{
 mount('experiments');expect(await screen.findByText('Independent experiments')).toBeInTheDocument();await waitFor(()=>expect(inquiryApi.listThreads).toHaveBeenCalledOnce());
})
