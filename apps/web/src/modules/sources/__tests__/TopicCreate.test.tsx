import i18n from '../../../i18n'
import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {MemoryRouter,Routes,Route,useLocation} from 'react-router-dom'
import {it,expect,vi,beforeEach,afterEach} from 'vitest'
import SourceGoalPage from '../SourceGoalPage'
import {sourceGoalsApi,agentsApi} from '../../../api/client'
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'s',userId:'u'})}))
vi.mock('../../../api/client',()=>({agentsApi:{list:vi.fn(),listRuntimeProfiles:vi.fn(),conversationBackends:vi.fn(),saveConversationSessionConfig:vi.fn()},sourceGoalsApi:{follow:vi.fn(),nativeAvailability:vi.fn(async()=>({supported:true})),read:vi.fn(),begin:vi.fn(),message:vi.fn(),action:vi.fn(),findLegacy:vi.fn(),legacy:vi.fn(),findCreation:vi.fn()},informationDigestsApi:{reading:vi.fn()},runsApi:{streamTurn:vi.fn()},proposalsApi:{get:vi.fn()}}))
vi.mock('../topics/TopicDetail',()=>({TopicDetail:({id}:{id:string})=><p>Topic page {id}</p>}))
function Where(){return <p data-testid="where">{useLocation().pathname}</p>}
function show(path='/library/reading/goals/new'){return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/library/reading/goals/:goalId" element={<SourceGoalPage/>}/><Route path="/projects/:projectId/sources/goals/:goalId" element={<SourceGoalPage/>}/><Route path="*" element={<Where/>}/></Routes></MemoryRouter>)}
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();vi.mocked(agentsApi.list).mockResolvedValue([{id:'managed',name:'Room assistant',created_by_user_id:'u',agent_kind:'system_assistant'},{id:'a',name:'My search Agent',created_by_user_id:'u',agent_kind:'standard'}] as never);vi.mocked(agentsApi.listRuntimeProfiles).mockResolvedValue([{id:'rp',name:'Default OpenCode',enabled:true,is_default:true,runtime_key:'opencode',backend_mode:'runtime_native',provider_binding:{model:null}}] as never);vi.mocked(agentsApi.conversationBackends).mockResolvedValue({options:[],binding:null});vi.mocked(sourceGoalsApi.findLegacy).mockResolvedValue({goal_id:null});vi.mocked(sourceGoalsApi.findCreation).mockResolvedValue({goal_id:null});vi.mocked(sourceGoalsApi.read).mockResolvedValue({messages:[]} as never);vi.mocked(sourceGoalsApi.begin).mockResolvedValue({id:'g',space_id:'s'});vi.mocked(sourceGoalsApi.follow).mockResolvedValue({goal_id:'g',status:'draft',activated:false,prepare:true} as never)})
afterEach(()=>i18n.changeLanguage('en'))
const describe=(value:string)=>fireEvent.change(screen.getByRole('textbox',{name:'Topic'}),{target:{value}})
async function pick(name:string,option:string){fireEvent.click(screen.getByRole('button',{name}));fireEvent.click(await screen.findByRole('option',{name:option}))}

it('creates nothing until one confirmation, then creates and follows atomically with the chosen frequency and effort',async()=>{
 show('/projects/project/sources/goals/new');await screen.findByRole('heading',{name:'Follow a topic'})
 describe('Open-source robotics releases');expect(sourceGoalsApi.begin).not.toHaveBeenCalled();expect(sourceGoalsApi.findCreation).not.toHaveBeenCalled()
 await pick('How often to check','Weekly');await pick('Effort per check','Light — up to 4 source reads and 10 items per source')
 fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 // The server's default Agent configuration is used: no Agent is sent unless chosen.
 await waitFor(()=>expect(sourceGoalsApi.begin).toHaveBeenCalledWith({intent:'Open-source robotics releases',project_id:'project',idempotency_key:expect.any(String),search_path:'agent',follow:{interval_seconds:604800,requests_per_run:4,items_per_source:10}},{spaceId:'s'}))
 expect(sourceGoalsApi.follow).not.toHaveBeenCalled();expect(sourceGoalsApi.message).not.toHaveBeenCalled();expect(sourceGoalsApi.action).not.toHaveBeenCalled()
 expect(await screen.findByTestId('where')).toHaveTextContent('/spaces/s/projects/project/sources/goals/g')
 expect(sessionStorage.length).toBe(0)
})
it('uses an explicitly chosen owned Agent and never offers the managed Room assistant',async()=>{
 show();await screen.findByRole('heading',{name:'Follow a topic'});fireEvent.click(screen.getByText('Advanced: search path and Agent'))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Agent'})).not.toBeDisabled());fireEvent.click(screen.getByRole('button',{name:'Agent'}));expect(screen.queryByRole('option',{name:'Room assistant'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('option',{name:'My search Agent'}))
 await screen.findByText(/Default OpenCode/);describe('Robotics');fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 await waitFor(()=>expect(sourceGoalsApi.begin).toHaveBeenCalledWith(expect.objectContaining({agent_id:'a',runtime_profile_id:'rp',search_path:'agent'}),{spaceId:'s'}))
})
it('refuses a recognized key before any write and never stores the topic text',async()=>{
 show();await screen.findByRole('heading',{name:'Follow a topic'});describe('api_key=FIXTURE_SECRET_ONLY_123456789');fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 await screen.findByText('This looks like a password or key. Remove it from the message and use secure credentials.')
 expect(sourceGoalsApi.begin).not.toHaveBeenCalled();expect(sourceGoalsApi.follow).not.toHaveBeenCalled();expect(Object.values(sessionStorage).join(' ')).not.toContain('FIXTURE_SECRET')
})
it('shows setup guidance and opens Advanced when the default configuration cannot search',async()=>{
 vi.mocked(sourceGoalsApi.begin).mockRejectedValue({status:409,code:'source_goal_execution_setup_required'});show();await screen.findByRole('heading',{name:'Follow a topic'});describe('Robotics');fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 await screen.findByText(/Choose an enabled Agent and its existing runtime profile/);expect(screen.getByText('Advanced: search path and Agent').closest('details')).toHaveAttribute('open');expect(sourceGoalsApi.follow).not.toHaveBeenCalled()
})
it('a lost response that the server committed opens that topic by its key, never a second topic',async()=>{
 vi.mocked(sourceGoalsApi.begin).mockRejectedValueOnce(new Error('connection lost after commit'));vi.mocked(sourceGoalsApi.findCreation).mockResolvedValue({goal_id:'g',space_id:'s'})
 show();await screen.findByRole('heading',{name:'Follow a topic'});describe('Robotics');fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 expect(await screen.findByTestId('where')).toHaveTextContent('/spaces/s/library/reading/goals/g')
 const key=vi.mocked(sourceGoalsApi.begin).mock.calls[0][0].idempotency_key;expect(sourceGoalsApi.findCreation).toHaveBeenCalledWith(key,null,expect.anything());expect(sourceGoalsApi.begin).toHaveBeenCalledTimes(1);expect(sessionStorage.length).toBe(0)
})
it('an uncommitted confirmation survives leaving: choices and key are restored without the topic text, and resubmission reuses the key',async()=>{
 vi.mocked(sourceGoalsApi.begin).mockRejectedValueOnce(new Error('connection lost before commit'))
 const first=show();await screen.findByRole('heading',{name:'Follow a topic'});describe('Private robotics plans');await pick('How often to check','Weekly');fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 await screen.findByRole('alert');const key=vi.mocked(sourceGoalsApi.begin).mock.calls[0][0].idempotency_key;expect(Object.values(sessionStorage).join(' ')).not.toContain('Private robotics');first.unmount()
 show();expect(await screen.findByText(/did not reach the server, so nothing was created/)).toBeInTheDocument();expect(sourceGoalsApi.findCreation).toHaveBeenCalledWith(key,null,expect.anything());expect(screen.getByRole('textbox',{name:'Topic'})).toHaveValue('');expect(screen.getByRole('button',{name:'How often to check'})).toHaveTextContent('Weekly')
 expect(sourceGoalsApi.begin).toHaveBeenCalledTimes(1);describe('Private robotics plans');fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 await waitFor(()=>expect(sourceGoalsApi.begin).toHaveBeenCalledTimes(2));expect(vi.mocked(sourceGoalsApi.begin).mock.calls[1][0]).toMatchObject({idempotency_key:key,follow:{interval_seconds:604800}})
})
it('a committed creation found on return opens its topic without any new write',async()=>{
 sessionStorage.setItem('source-topic-create:s::',JSON.stringify({key:'k1',choice:{interval_seconds:86400,effort:'standard'},search_path:'agent',execution:{agent_id:'',runtime_profile_id:''}}));vi.mocked(sourceGoalsApi.findCreation).mockResolvedValue({goal_id:'g',space_id:'s'})
 show();expect(await screen.findByTestId('where')).toHaveTextContent('/spaces/s/library/reading/goals/g');expect(sourceGoalsApi.begin).not.toHaveBeenCalled();expect(sourceGoalsApi.follow).not.toHaveBeenCalled()
})
it('binds explicitly chosen model and mode with the same creation request',async()=>{
 vi.mocked(agentsApi.conversationBackends).mockResolvedValue({options:[{runtime_profile_id:'rp',name:'Native',runtime_key:'opencode',session_config_options:[{id:'model',name:'Model',description:null,category:'model',type:'select',current_value:'first',options:[{value:'first',name:'First',description:null,group:null},{value:'chosen',name:'Chosen model',description:null,group:null}]},{id:'mode',name:'Mode',description:null,category:'mode',type:'select',current_value:'default',options:[{value:'default',name:'Default mode',description:null,group:null},{value:'plan',name:'Plan mode',description:null,group:null}]}]}],binding:null})
 show();await screen.findByRole('heading',{name:'Follow a topic'});fireEvent.click(screen.getByText('Advanced: search path and Agent'))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Agent'})).not.toBeDisabled());await pick('Agent','My search Agent');await screen.findByRole('button',{name:'Model'});await pick('Model','Chosen model');await pick('Mode','Plan mode')
 describe('Robotics');fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 await waitFor(()=>expect(sourceGoalsApi.begin).toHaveBeenCalledWith(expect.objectContaining({agent_id:'a',runtime_profile_id:'rp',session_config:expect.arrayContaining([{id:'model',type:'select',category:'model',value:'chosen'},{id:'mode',type:'select',category:'mode',value:'plan'}])}),{spaceId:'s'}))
})
it('legacy: an interrupted follow after the topic message committed is continued on return, once',async()=>{
 vi.mocked(sourceGoalsApi.legacy).mockResolvedValue({goal:{id:'legacy-goal'}});vi.mocked(sourceGoalsApi.message).mockResolvedValue({run_id:'r',session_id:'x'});vi.mocked(sourceGoalsApi.follow).mockRejectedValueOnce(new Error('connection lost before follow persisted'))
 const first=show('/library/reading/goals/new?channel_id=channel');await waitFor(()=>expect(screen.getByRole('button',{name:'Start following'})).toBeDisabled());describe('Robotics feed');await waitFor(()=>expect(screen.getByRole('button',{name:'Start following'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 await screen.findByRole('alert');expect(sourceGoalsApi.follow).toHaveBeenCalledTimes(1);const key=vi.mocked(sourceGoalsApi.message).mock.calls[0][2];first.unmount()
 vi.mocked(sourceGoalsApi.findLegacy).mockResolvedValue({goal_id:'legacy-goal'});vi.mocked(sourceGoalsApi.read).mockResolvedValue({messages:[{id:'m',role:'user',content:'Robotics feed',metadata_json:{source_goal_message_key:key}}]} as never);vi.mocked(sourceGoalsApi.follow).mockResolvedValue({} as never)
 show('/library/reading/goals/new?channel_id=channel');expect(await screen.findByTestId('where')).toHaveTextContent('/spaces/s/library/reading/goals/legacy-goal')
 expect(sourceGoalsApi.follow).toHaveBeenCalledTimes(2);expect(vi.mocked(sourceGoalsApi.follow).mock.calls[1][1]).toEqual(vi.mocked(sourceGoalsApi.follow).mock.calls[0][1]);expect(sourceGoalsApi.message).toHaveBeenCalledTimes(1);expect(sourceGoalsApi.legacy).toHaveBeenCalledTimes(1)
})
it('legacy: if the topic message never committed, return restores the form instead of following the mapped Source',async()=>{
 sessionStorage.setItem('source-topic-create:s::channel',JSON.stringify({key:'k2',choice:{interval_seconds:86400,effort:'standard'},search_path:'api',execution:{agent_id:'',runtime_profile_id:''},legacy_goal_id:'legacy-goal'}));vi.mocked(sourceGoalsApi.findLegacy).mockResolvedValue({goal_id:'legacy-goal'})
 show('/library/reading/goals/new?channel_id=channel');expect(await screen.findByText(/did not reach the server/)).toBeInTheDocument();expect(sourceGoalsApi.follow).not.toHaveBeenCalled();expect(screen.queryByTestId('where')).not.toBeInTheDocument()
})
it('opens an existing legacy mapping through a read-only lookup without creating anything',async()=>{
 vi.mocked(sourceGoalsApi.findLegacy).mockResolvedValueOnce({goal_id:'mapped'});show('/library/reading/goals/new?channel_id=channel');expect(await screen.findByTestId('where')).toHaveTextContent('/spaces/s/library/reading/goals/mapped');expect(sourceGoalsApi.begin).not.toHaveBeenCalled();expect(sourceGoalsApi.legacy).not.toHaveBeenCalled()
})
it('maps an unmapped legacy Source with the described topic, then follows it',async()=>{
 vi.mocked(sourceGoalsApi.legacy).mockResolvedValue({goal:{id:'legacy-goal'}});vi.mocked(sourceGoalsApi.message).mockResolvedValue({run_id:'r',session_id:'x'});show('/library/reading/goals/new?channel_id=channel');await waitFor(()=>expect(screen.getByRole('button',{name:'Start following'})).toBeDisabled());describe('Robotics feed');await waitFor(()=>expect(screen.getByRole('button',{name:'Start following'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 await waitFor(()=>expect(sourceGoalsApi.follow).toHaveBeenCalledWith('legacy-goal',expect.objectContaining({interval_seconds:86400,requests_per_run:8}),{spaceId:'s'}));expect(sourceGoalsApi.message).toHaveBeenCalledWith('legacy-goal','Robotics feed',expect.any(String),{spaceId:'s'},{search_path:'agent'});expect(sourceGoalsApi.begin).not.toHaveBeenCalled()
})
it('renders the create journey in Chinese',async()=>{
 await i18n.changeLanguage('zh-CN');show();expect(await screen.findByRole('heading',{name:'关注一个主题'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'开始关注'})).toBeDisabled();expect(screen.getByText(/确认之前不会采集任何内容/)).toBeInTheDocument()
})
