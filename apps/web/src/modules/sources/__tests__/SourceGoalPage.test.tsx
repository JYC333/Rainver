import {clearSessionResidue} from '../../../lib/sessionResidue'
import i18n from '../../../i18n'
import {render,screen,fireEvent,waitFor,within} from '@testing-library/react'
import {MemoryRouter,Routes,Route,useLocation} from 'react-router-dom'
import {it,expect,vi,beforeEach,afterEach} from 'vitest'
import {SourceGoalBudgetSchema,type ReadingItem,type SourceGoalDetail,type SourceGoalFollowState} from '@rainver/protocol'
import SourceGoalPage from '../SourceGoalPage'
import {ApiRequestError,sourceGoalsApi,agentsApi,runsApi,proposalsApi,informationDigestsApi} from '../../../api/client'
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'s',userId:'u'})}))
vi.mock('../../../api/client',async importOriginal=>({ApiRequestError:(await importOriginal<typeof import('../../../api/client')>()).ApiRequestError,proposalsApi:{get:vi.fn(),accept:vi.fn(),reject:vi.fn()},agentsApi:{list:vi.fn(),listRuntimeProfiles:vi.fn(),conversationBackends:vi.fn(),saveConversationSessionConfig:vi.fn()},sourceGoalsApi:{edit:vi.fn(async()=>({id:'edited',revision:2})),follow:vi.fn(async()=>({})),feedback:vi.fn(async()=>({applied:true})),nativeAvailability:vi.fn(async()=>({supported:false})),read:vi.fn(),begin:vi.fn(),message:vi.fn(),action:vi.fn(),check:vi.fn(),findLegacy:vi.fn(),sourceConfirmation:vi.fn(),confirmSource:vi.fn()},runsApi:{streamTurn:vi.fn(),stop:vi.fn(async()=>({}))},informationDigestsApi:{reading:vi.fn(),readingState:vi.fn()}}))
vi.mock('../../conversation/ConversationView',()=>({ConversationView:(p:{entries:{id:string;role:string;content:string;extra:import('react').ReactNode}[];input:string;onInputChange:(s:string)=>void;onSend:()=>void;composerDisabled:boolean})=><div>{p.entries.map(e=><div key={e.id} data-role={e.role}>{e.content}{e.extra}</div>)}<input aria-label="Goal message" value={p.input} onChange={e=>p.onInputChange(e.target.value)} disabled={p.composerDisabled}/><button disabled={p.composerDisabled} onClick={p.onSend}>Send goal</button></div>}))
const results=(over:Partial<SourceGoalFollowState['results']>={}):SourceGoalFollowState['results']=>({items_total:2,important_total:1,unjudged_total:0,not_selected_total:1,judgment_failed_total:0,baseline_total:1,new_publication_total:1,evidenced_change_total:0,unknown_freshness_total:0,changes_total:0,last_outcome:'new_items',last_new_items:1,last_checked_at:'2026-10-28T10:00:00Z',last_success_at:'2026-10-28T10:00:00Z',next_check_at:'2026-10-29T10:00:00Z',...over})
const following=(over:Partial<SourceGoalFollowState>={}):SourceGoalFollowState=>({intent:'following',collections:{queued:0,running:0},pending_adjustment:false,phase:'scheduled',blocked_reason:null,health:'ok',sources:[{binding_id:'b',source_connection_id:'c',status:'active',health:'ok',error:null,failures:0,last_success_at:'2026-10-28T10:00:00Z',retry_at:null}],results:results(),...over})
const spec={source_connection_id:'c',source_channel_id:'ch',reason:'Robotics research feed',supports_history:false,implementation:{kind:'connector' as const}}
const detail=():SourceGoalDetail=>({goal:{display:{version_id:'v',title:'Follow robotics',summary:'Robotics plan'},agent_id:'a',runtime_profile_id:'rp',id:'g',space_id:'s',owner_user_id:'u',project_id:null,intent_json:{intent:'Follow robotics'},budget_json:SourceGoalBudgetSchema.parse({}),status:'running',revision:1,current_version_id:'v',active_version_id:'v',follow_state:following(),follow_json:{confirmed_at:'2026-10-28T09:00:00Z',confirmed_by_user_id:'u',idempotency_key:'k',version_id:null,interval_seconds:86400,requests_per_run:8,items_per_source:20,activated_version_id:'v',reused_preview_id:null,last_error:null}},versions:[{id:'v',revision:1,plan_json:{title:'Follow robotics',summary:'Robotics plan',sources:[spec],limitations:[]}}],previews:[{id:'p',version_id:'v',status:'ready',expires_at:new Date(Date.now()+900000).toISOString(),result_json:{contributions:[{source_connection_id:'c',source_kind:'feed',status:'succeeded',output:{items:[{external_id:'one',title:'Actual sample',source_uri:'https://fixture.test/one',published_at:'2026-10-27T00:00:00Z',excerpt:'Real retained excerpt'}]}}]}}],bindings:[{id:'b',status:'active',spec_json:spec,gaps_json:[],cursor_json:{}}],agent_runs:[],messages:[],repairs:[],runs:[],changes:[]})
const item=(id:string,topic:Partial<ReadingItem['topics'][number]>={}):ReadingItem=>({key:id,source_item_id:id,source_item_ids:[id],result_provenance:'agent_provided_unverified',title:'Paper '+id,source_uri:`https://papers.test/${id}`,occurred_at:'2026-10-28T08:00:00Z',summary:null,access_level:'full',reader_origin:'library',read_status:'unread',dismissed:false,available_at:'2026-10-28T09:00:00Z',contributions:[],material_links:[],topics:[{goal_id:'g',project_id:null,title:'Follow robotics',selection_status:'important',selection_reason:'Directly about robot learning',judged_by:'collection_agent',delivery_kind:'new_publication',change_evidence_url:null,...topic}]})
function Where(){return <p data-testid="where">{useLocation().pathname+useLocation().search}</p>}
function show(path='/library/reading/goals/g'){return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/projects/:projectId/sources/goals/:goalId" element={<><SourceGoalPage/><Where/></>}/><Route path="/library/reading/goals/:goalId" element={<><SourceGoalPage/><Where/></>}/><Route path="*" element={<Where/>}/></Routes></MemoryRouter>)}
const openAdvanced=()=>{fireEvent.click(screen.getByRole('button',{name:'Adjust following'}));fireEvent.mouseDown(screen.getByRole('tab',{name:'Discuss changes'}),{button:0,ctrlKey:false});fireEvent.click(screen.getByText('Planning tools and trial'))}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(sourceGoalsApi.edit).mockResolvedValue({id:'edited',revision:2});sessionStorage.clear();vi.mocked(proposalsApi.get).mockResolvedValue({status:'pending'} as never);vi.mocked(proposalsApi.accept).mockResolvedValue({} as never);vi.mocked(agentsApi.conversationBackends).mockResolvedValue({options:[],binding:null});vi.mocked(agentsApi.list).mockResolvedValue([{id:'a',name:'My search Agent',created_by_user_id:'u',agent_kind:'standard'}] as never);vi.mocked(agentsApi.listRuntimeProfiles).mockResolvedValue([{id:'rp',name:'MiniMax config',enabled:true,runtime_key:'opencode',backend_mode:'model_provider',provider_binding:{model:'MiniMax'}}] as never);vi.mocked(sourceGoalsApi.read).mockResolvedValue(detail());vi.mocked(sourceGoalsApi.action).mockResolvedValue({});vi.mocked(sourceGoalsApi.check).mockResolvedValue({status:'queued'});vi.mocked(sourceGoalsApi.message).mockResolvedValue({run_id:'run',session_id:'session'});vi.mocked(informationDigestsApi.reading).mockResolvedValue({items:[item('one')],total:1,next_cursor:null})})
afterEach(()=>{vi.useRealTimers();return i18n.changeLanguage('en')})

it('presents the active authored summary and analysis purpose rather than conversation input',async()=>{
 const d=detail();d.goal.intent_json.intent='RAW REQUEST\nRetry please';d.goal.compatibility_json={display_title:'UNAPPLIED DRAFT'};
 d.versions[0].plan_json={...d.versions[0].plan_json,title:'Robot learning',summary:'Track robot learning research and product designs.',analysis_brief:'Which designs are reusable, and what evidence supports them?',intent_snapshot:{intent:'RAW REQUEST\nRetry please',includes:[],excludes:[]}};
 d.goal.display={version_id:'v',title:'Robot learning',summary:d.versions[0].plan_json.summary};
 vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();
 expect(await screen.findByRole('heading',{name:'Robot learning'})).toBeInTheDocument();
 const direction=screen.getByRole('region',{name:'Current direction'});
 expect(within(direction).getByText('Track robot learning research and product designs.')).toBeInTheDocument();
 expect(within(direction).getByText('Which designs are reusable, and what evidence supports them?')).toBeInTheDocument();
 expect(screen.queryByText(/RAW REQUEST|Retry please|UNAPPLIED DRAFT/)).not.toBeInTheDocument();
});


it('shows separate status dimensions: phase, health, actual queue, last and next check',async()=>{
 const d=detail();d.goal.follow_state=following({phase:'checking',collections:{queued:1,running:1}});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show()
 expect(await screen.findByText('Checking for updates')).toBeInTheDocument();expect(screen.getByText('Sources healthy')).toBeInTheDocument();expect(screen.getByText('1 waiting · 1 running')).toBeInTheDocument();expect(screen.getByText('1 new in the last check')).toBeInTheDocument();expect(screen.getByText('1 important of 2 collected · 0 changes')).toBeInTheDocument()
})
it('never reports missing permission as no updates and names the affected source with an actionable link',async()=>{
 const d=detail();d.goal.follow_state=following({phase:'waiting_for_permission',health:'needs_permission',results:results({last_outcome:'no_new',last_new_items:0}),sources:[{binding_id:'b',source_connection_id:'c',status:'active',health:'needs_permission',error:'source_credential_decision_required',failures:0,last_success_at:null,retry_at:null}]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show()
 expect(await screen.findByText('A source needs your permission or setup. This is not reported as “no updates”.')).toBeInTheDocument();expect(screen.getByText('Waiting for your permission')).toBeInTheDocument();expect(screen.getAllByText('Needs permission').length).toBeGreaterThan(0);expect(screen.getByRole('link',{name:'Review source'})).toHaveAttribute('href','/spaces/s/sources/c')
})
it('shows a partial failure per source while healthy sources stay listed',async()=>{
 const d=detail();d.bindings.push({id:'b2',status:'cooldown',spec_json:{...spec,source_connection_id:'c2',source_channel_id:'ch2',reason:'Release feed'},gaps_json:[{}],cursor_json:{},retry_at:'2026-10-28T12:00:00Z'});d.goal.follow_state=following({health:'partial',results:results({last_outcome:'partial'}),sources:[following().sources[0],{binding_id:'b2',source_connection_id:'c2',status:'cooldown',health:'backoff',error:'source_timeout',failures:2,last_success_at:null,retry_at:'2026-10-28T12:00:00Z'}]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show()
 expect(await screen.findByText('Some sources have problems')).toBeInTheDocument();const status=within(screen.getByRole('heading',{name:'Sources'}).closest('section')!);const release=status.getByText('Release feed').closest('li')!;expect(within(release).getByText('Backing off')).toBeInTheDocument();expect(within(release).getByText(/retry after/)).toBeInTheDocument();expect(within(release).getByText(/Some past content is still missing/)).toBeInTheDocument();expect(within(status.getByText('Robotics research feed').closest('li')!).getByText('Healthy')).toBeInTheDocument();expect(screen.getByText(/Last check was partial/)).toBeInTheDocument()
})
it.each([['preparing','Preparing sources'],['first_collection','First collection']] as const)('explains an empty %s stream instead of claiming no updates',async(phase,text)=>{
 const d=detail();d.goal.follow_state=following({phase,results:results({items_total:0,important_total:0,last_outcome:'never',last_checked_at:null})});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);vi.mocked(informationDigestsApi.reading).mockResolvedValue({items:[],total:0,next_cursor:null});show();expect(await screen.findByText(text)).toBeInTheDocument()
})
it('shows the recorded no-new outcome without fetching or inventing an article stream',async()=>{
 const d=detail();d.goal.follow_state=following({results:results({last_outcome:'no_new',last_new_items:0})});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();expect(await screen.findByText('Last check found nothing new')).toBeInTheDocument();expect(informationDigestsApi.reading).not.toHaveBeenCalled();
})

it('manages a topic: pause, slower checks, excluded words and deletion keep reading history',async()=>{
 show();await screen.findByRole('heading',{name:'Follow robotics'});fireEvent.click(screen.getByRole('button',{name:'Pause'}));await waitFor(()=>expect(sourceGoalsApi.action).toHaveBeenCalledWith('g','pause',{version_id:'v'},{spaceId:'s'}))
 fireEvent.click(screen.getByRole('button',{name:'Apply'}));await waitFor(()=>expect(sourceGoalsApi.feedback).toHaveBeenCalledWith('g',expect.objectContaining({kind:'slow_down',interval_seconds:259200}),{spaceId:'s'}))
 fireEvent.change(screen.getByRole('textbox',{name:'Exclude a word'}),{target:{value:'webinar'}});fireEvent.click(screen.getByRole('button',{name:'Exclude'}));await waitFor(()=>expect(sourceGoalsApi.feedback).toHaveBeenCalledWith('g',expect.objectContaining({kind:'exclude_term',term:'webinar'}),{spaceId:'s'}))
 expect(screen.queryByRole('button',{name:/faster|more often/i})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Delete goal'}));fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:'Delete goal'}));await waitFor(()=>expect(sourceGoalsApi.action).toHaveBeenCalledWith('g','delete',{},{spaceId:'s'}));expect(await screen.findByTestId('where')).toHaveTextContent('/spaces/s/library/reading/goals')
})
it('resumes a paused topic explicitly and explains its readable history',async()=>{
 const d=detail();d.goal.status='paused';d.goal.follow_state=following({intent:'paused',phase:'stopped'});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);vi.mocked(informationDigestsApi.reading).mockResolvedValue({items:[],total:0,next_cursor:null});show();expect(await screen.findByText('This topic is paused. Collected material stays readable.')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Resume'}));await waitFor(()=>expect(sourceGoalsApi.action).toHaveBeenCalledWith('g','resume',{version_id:'v'},{spaceId:'s'}))
})
it('confirms an unfollowed topic once with frequency and effort, and offers no preview gate',async()=>{
 const d=detail();d.goal.status='preview_ready';d.goal.active_version_id=null;d.goal.follow_json=null;d.goal.follow_state=following({intent:'unconfirmed',phase:'none',health:'unknown',sources:[]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show()
 expect(await screen.findByRole('heading',{name:'Follow this topic'})).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Start following'}))
 await waitFor(()=>expect(sourceGoalsApi.follow).toHaveBeenCalledWith('g',{idempotency_key:expect.stringMatching(/^follow:/),interval_seconds:86400,requests_per_run:8,items_per_source:20},{spaceId:'s'}));expect(sourceGoalsApi.action).not.toHaveBeenCalledWith('g','start',expect.anything(),expect.anything())
})
it('applies a pending adjusted plan through the same follow confirmation',async()=>{
 const d=detail();d.goal.current_version_id='v2';d.versions.unshift({id:'v2',revision:2,plan_json:{title:'Refined robotics',summary:'Refined plan',sources:[spec],limitations:[]}});d.goal.follow_state=following({pending_adjustment:true});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show()
 expect(await screen.findByText('An adjusted plan is ready. The current plan keeps running until you apply it.')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Apply adjusted plan'}));await waitFor(()=>expect(sourceGoalsApi.follow).toHaveBeenCalledWith('g',{version_id:'v2',idempotency_key:'follow:v2'},{spaceId:'s'}))
})
it('lists recorded changes with their evidence and judgment',async()=>{
 const d=detail();d.changes=[{id:'ch1',source_item_id:'one',change_kind:'release',evidence_url:'https://github.test/release/2',delivery_kind:'evidenced_change',selection_status:'important',selection_reason:'Major release',judged_by:'collection_agent',goal_run_id:'gr',agent_run_id:null,detected_at:'2026-10-28T09:30:00Z'}];vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show()
 const changes=(await screen.findByRole('heading',{name:'Change history'})).closest('section')!;expect(within(changes).getByText('Release')).toBeInTheDocument();expect(within(changes).getByText('Changed')).toBeInTheDocument();expect(within(changes).getByText(/Major release/)).toBeInTheDocument();expect(within(changes).getByRole('link',{name:'Change evidence'})).toHaveAttribute('href','https://github.test/release/2')
})
it('keeps a Project topic inside its Project and opens materials with this topic selected',async()=>{
 const d=detail();d.goal.project_id='p';vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show('/projects/p/sources/goals/g');await screen.findByRole('heading',{name:'Follow robotics'});
 expect(informationDigestsApi.reading).not.toHaveBeenCalled();expect(screen.getByRole('link',{name:'View collected articles'})).toHaveAttribute('href','/spaces/s/projects/p/sources?tab=materials&view=all&topic=g');
})

it('shows a safe recoverable load error and clears content when authorization is lost',async()=>{
 vi.mocked(sourceGoalsApi.read).mockRejectedValueOnce(new Error('source_internal_diagnostic'));show();await screen.findByRole('alert');expect(screen.queryByText('source_internal_diagnostic')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Retry'}));await screen.findByRole('heading',{name:'Follow robotics'})
 vi.mocked(sourceGoalsApi.read).mockRejectedValue(Object.assign(new Error('Revoked'),{status:403}));fireEvent.click(screen.getByRole('button',{name:'Pause'}));await screen.findByRole('alert');await waitFor(()=>expect(screen.queryByRole('heading',{name:'Follow robotics'})).not.toBeInTheDocument())
})
it.each([['en','Automatic repair is paused because no permitted, unexpired calibration sample','source_repair_calibration_unavailable'],['zh-CN','缺少政策允许且未过期的校准样本','source_repair_calibration_unavailable'],['en','This source is paused because access or its approved scope changed','source_authority_revoked'],['zh-CN','来源权限或已批准范围已变化','source_authority_revoked'],['en','Automatic repair could not establish enough evidence','source_repair_validation_insufficient'],['zh-CN','自动修复在既定限额内未取得足够验证证据','source_repair_validation_insufficient']] as const)('explains a paused source in topic status without auto-resume (%s: %s)',async(locale,expected,reason)=>{
 await i18n.changeLanguage(locale);const d=detail();d.bindings=[{id:'b',status:'paused',repair_block_reason:reason,spec_json:spec,gaps_json:[],cursor_json:{}}];d.goal.follow_state=following({health:'failing',sources:[{...following().sources[0],status:'paused',health:'failing'}]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByText(new RegExp(expected));expect(sourceGoalsApi.action).not.toHaveBeenCalled();expect(sourceGoalsApi.message).not.toHaveBeenCalled()
})
it('renders the management page in Chinese',async()=>{await i18n.changeLanguage('zh-CN');show();expect(await screen.findByRole('heading',{name:'当前关注方向'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'调整关注'})).toBeInTheDocument();expect(screen.getByRole('link',{name:'查看相关文章'})).toBeInTheDocument()})

// Advanced: plan conversation, optional trial and manual save stay available
// but are never a following gate, and collection progress is not repeated in chat.
it('keeps an optional trial and adjustment conversation without a Start action or duplicate collection progress',async()=>{
 const d=detail();d.native_runs=[{id:'latest',status:'queued',phase:'queued',version_id:'v'},{id:'old',status:'failed',phase:'failed',version_id:'v'}] as never;vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced()
 expect(within(screen.getByRole('dialog')).getByText('Robotics plan',{selector:'p'})).toBeInTheDocument();expect(screen.getByText('Actual sample')).toBeInTheDocument();expect(screen.queryByText(/Search progress:/)).not.toBeInTheDocument();expect(screen.getAllByRole('link',{name:'Execution details'})).toHaveLength(1);expect(screen.getByRole('link',{name:'Execution details'})).toHaveAttribute('href','/spaces/s/runs/latest')
 expect(screen.queryAllByRole('button',{name:'Start following'})).toHaveLength(0)
 fireEvent.click(screen.getByRole('button',{name:'Try this plan'}));await waitFor(()=>expect(sourceGoalsApi.action).toHaveBeenCalledWith('g','preview',{version_id:'v'},{spaceId:'s'}));expect(sourceGoalsApi.message).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'Too broad'}));expect(screen.getByRole('textbox',{name:'Goal message'})).toHaveValue('Please narrow this goal to the most relevant updates.');fireEvent.click(screen.getByRole('button',{name:'Send goal'}));await waitFor(()=>expect(sourceGoalsApi.message).toHaveBeenCalledWith('g','Please narrow this goal to the most relevant updates.',expect.any(String),{spaceId:'s'},{search_path:'api'}))
})
it('saves an Agent-search sample manually through the save action only while not following',async()=>{
 const d=detail();d.versions[0].plan_json.sources=[{...spec,implementation:{kind:'agent_search',query:'robotics'}}];d.goal.status='preview_ready';d.goal.active_version_id=null;d.goal.follow_json=null;d.goal.follow_state=following({intent:'unconfirmed',phase:'none',sources:[]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Follow this topic'});openAdvanced()
 fireEvent.click(screen.getByRole('button',{name:'Save sample to Reading'}));await waitFor(()=>expect(sourceGoalsApi.action).toHaveBeenCalledWith('g','save',{version_id:'v',preview_id:'p',idempotency_key:'manual:v:p'},{spaceId:'s'}))
})
it('offers following a manual-save-only topic and keeps its trial retryable without auto-resume',async()=>{
 const d=detail();d.goal.status='paused';d.goal.compatibility_json={execution_mode:'manual'};d.goal.follow_json=null;d.goal.follow_state=following({intent:'paused',phase:'stopped'});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();expect(await screen.findAllByText('Saved sample only — not followed automatically.')).not.toHaveLength(0);expect(screen.getByRole('heading',{name:'Follow this topic'})).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Resume'})).not.toBeInTheDocument();openAdvanced();expect(screen.getByRole('button',{name:'Try this plan'})).toBeEnabled();expect(sourceGoalsApi.action).not.toHaveBeenCalled()
})
it('restores an interrupted canonical user message and reuses its exact dispatch key',async()=>{const d=detail();d.messages=[{id:'message',role:'user',content:'Follow robotics',run_id:null,metadata_json:{source_goal_message_key:'recover-key',source_goal_dispatch_pending:true}}];vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();await waitFor(()=>expect(screen.getByRole('textbox',{name:'Goal message'})).toHaveValue('Follow robotics'));fireEvent.click(screen.getByRole('button',{name:'Send goal'}));await waitFor(()=>expect(sourceGoalsApi.message).toHaveBeenCalledWith('g','Follow robotics','recover-key',{spaceId:'s'},{search_path:'api'}))})
it.each([[429,'source_goal_exploration_budget_exhausted','This planning round or account budget is exhausted.'],[409,'source_goal_run_in_progress','A planning run is still in progress.'],[409,'source_goal_stopped','This goal has stopped or is no longer accessible.']])('gives actionable guidance for %s/%s',async(status,code,expected)=>{vi.mocked(sourceGoalsApi.message).mockRejectedValue({status,code});show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();fireEvent.change(screen.getByRole('textbox',{name:'Goal message'}),{target:{value:'Refine robotics'}});fireEvent.click(screen.getByRole('button',{name:'Send goal'}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(String(expected)))})
it('shows actual failed planning and its time-limit reason',async()=>{const d=detail();d.goal.execution={run_id:'failed-run',status:'failed',phase:'failed',last_action:'source.goal.write_version',pending_approvals:0,failure_reason:'time_limit',updated_at:'2026-10-27T14:30:00Z'};vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();expect(screen.getByText('Planning failed. The goal and conversation are saved.')).toBeInTheDocument();expect(screen.getByText('The planning run reached its time limit. No completed plan was published.')).toBeInTheDocument()})
it('keeps the stream across Run success until the canonical reply arrives',async()=>{
 const working=detail();working.messages=[{id:'human',role:'user',content:'Refine robotics',run_id:'reply-run'}];working.agent_runs=[{id:'reply-run',status:'running',chat_completed:false}];working.goal.execution={run_id:'reply-run',status:'running',phase:'working',last_action:null,failure_reason:null,pending_approvals:0,updated_at:'2026-10-27T15:00:00Z'}
 let finish!:()=>void;vi.mocked(runsApi.streamTurn).mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve}));vi.mocked(sourceGoalsApi.read).mockResolvedValue(working);show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();await screen.findByText('Agent is working on this goal');await waitFor(()=>expect(runsApi.streamTurn).toHaveBeenCalledTimes(1));expect(screen.getByRole('button',{name:'Send goal'})).toBeDisabled()
 const done={...working,messages:[...working.messages!,{id:'reply',role:'assistant',content:'Here is your focused robotics plan.',run_id:'reply-run'}],agent_runs:[{id:'reply-run',status:'degraded',chat_completed:true}]};vi.mocked(sourceGoalsApi.read).mockResolvedValue(done);finish();await screen.findByText('Here is your focused robotics plan.');expect(screen.getByRole('button',{name:'Send goal'})).toBeEnabled()
})
it('decides one live Source proposal inside the conversation without another continuation',async()=>{const d=detail();d.action_previews=[{action_id:'source.channel.propose_activation',proposal_id:'proposal',proposal_type:'source_channel_activation',status:'proposed',title:'Review new robotics Source'}];vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();await screen.findByText('Review new robotics Source');const accept=await screen.findByRole('button',{name:'Accept'});await waitFor(()=>expect(accept).toBeEnabled());fireEvent.click(accept);await waitFor(()=>expect(proposalsApi.accept).toHaveBeenCalledWith('proposal',expect.objectContaining({spaceId:'s'})));expect(sourceGoalsApi.message).not.toHaveBeenCalled()})
it('explains exhausted trials and prepares an adjustment without starting another Run',async()=>{const d=detail();const p=d.previews[0];d.previews=[1,2,3].map(n=>({...p,id:'p'+n,status:'partial',result_json:{contributions:[{source_connection_id:'c',status:'failed',error:'source_execution_refused'}]}}));vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();expect(screen.getByText(/This version has used its three preview attempts/)).toBeInTheDocument();expect(screen.getByRole('button',{name:'Try this plan'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Adjust this plan'}));expect((screen.getByRole('textbox',{name:'Goal message'}) as HTMLInputElement).value).toContain('Please fix this plan');expect(sourceGoalsApi.action).not.toHaveBeenCalled()})
it('saves an existing goal runtime mode through canonical session settings without starting a Run',async()=>{
 const d=detail();d.goal.session_id='session';vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);const selected=[{id:'mode',type:'select' as const,category:'mode',value:'plan'}]
 vi.mocked(agentsApi.conversationBackends).mockResolvedValue({options:[{runtime_profile_id:'rp',name:'Native',runtime_key:'opencode',session_config_options:[{id:'mode',name:'Mode',description:null,category:'mode',type:'select',current_value:'default',options:[{value:'default',name:'Default mode',description:null,group:null},{value:'plan',name:'Plan mode',description:null,group:null}]}]}],binding:null,session_config:[]})
 vi.mocked(agentsApi.saveConversationSessionConfig).mockResolvedValue({session_config:selected});show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();fireEvent.click(screen.getByText('Agent, model and mode settings'));await screen.findByRole('button',{name:'Mode'});fireEvent.click(screen.getByRole('button',{name:'Mode'}));fireEvent.click(screen.getByRole('option',{name:'Plan mode'}));fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(agentsApi.saveConversationSessionConfig).toHaveBeenCalledWith('a',{session_id:'session',runtime_profile_id:'rp',session_config:selected},{spaceId:'s'}));expect(sourceGoalsApi.message).not.toHaveBeenCalled()
})
it('shows a specific credential failure in the optional trial with its source settings',async()=>{const d=detail();d.previews[0].status='partial';d.previews[0].result_json.contributions=[{source_connection_id:'c',status:'failed',error:'source_credential_unavailable'}];vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();expect(screen.getByText(/This plan uses a search source without a usable API credential/)).toBeInTheDocument();expect(screen.getAllByRole('link',{name:'Open source details'}).some(e=>e.getAttribute('href')==='/spaces/s/sources/c')).toBe(true)})
it.each(['en','zh-CN'])('keeps managing a topic whose Source became unreadable, without its redacted details (%s)',async locale=>{
 await i18n.changeLanguage(locale);const d=detail();d.bindings=[{id:'b',goal_id:'g',source_connection_id:'c',status:'paused',revision:2,unavailable:true,collection_error:'source_unavailable'},{id:'b2',status:'active',spec_json:{...spec,source_connection_id:'c2',source_channel_id:'ch2',reason:'Release feed'},gaps_json:[],cursor_json:{}}];d.goal.follow_state=following({health:'needs_permission',phase:'waiting_for_permission',sources:[{...following().sources[0],status:'paused',health:'needs_permission',error:'source_unavailable'},{binding_id:'b2',source_connection_id:'c2',status:'active',health:'ok',error:null,failures:0,last_success_at:'2026-10-28T10:00:00Z',retry_at:null}]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show()
 const en=locale==='en';const status=within((await screen.findByRole('heading',{name:en?'Sources':'来源'})).closest('section')!)
 const gone=status.getByText(en?'Source no longer available':'来源已不可用').closest('li')!;expect(within(gone).getByText(en?/You can no longer read this source/:/你已无法读取此来源/)).toBeInTheDocument();expect(within(gone).queryByRole('link')).not.toBeInTheDocument()
 expect(within(status.getByText('Release feed').closest('li')!).getByText(en?'Healthy':'正常')).toBeInTheDocument();expect(screen.getByText(en?/not reported as “no updates”/:/不会被报告为“没有更新”/)).toBeInTheDocument()
 expect(screen.getByRole('button',{name:en?'Pause':'暂停'})).toBeEnabled()
})
it('pauses a confirmed topic while it is still preparing, and resumes it through the canonical action',async()=>{
 const d=detail();d.goal.status='exploring';d.goal.active_version_id=null;d.goal.current_version_id=null;d.versions=[];d.bindings=[];d.previews=[];d.goal.follow_state=following({phase:'preparing',health:'unknown',sources:[]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);vi.mocked(informationDigestsApi.reading).mockResolvedValue({items:[],total:0,next_cursor:null});const view=show()
 fireEvent.click(await screen.findByRole('button',{name:'Pause'}));await waitFor(()=>expect(sourceGoalsApi.action).toHaveBeenCalledWith('g','pause',{version_id:null},{spaceId:'s'}));expect(sourceGoalsApi.action).not.toHaveBeenCalledWith('g','resume',expect.anything(),expect.anything());view.unmount()
 const paused=detail();paused.goal.status='paused';paused.goal.active_version_id=null;paused.goal.current_version_id=null;paused.versions=[];paused.bindings=[];paused.previews=[];paused.goal.follow_state=following({intent:'paused',phase:'stopped',health:'unknown',sources:[]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(paused);show()
 fireEvent.click(await screen.findByRole('button',{name:'Resume'}));await waitFor(()=>expect(sourceGoalsApi.action).toHaveBeenCalledWith('g','resume',{version_id:null},{spaceId:'s'}))
})
it('offers no pause or resume for an unconfirmed draft',async()=>{const d=detail();d.goal.status='draft';d.goal.active_version_id=null;d.goal.follow_json=null;d.goal.follow_state=following({intent:'unconfirmed',phase:'none',sources:[]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Follow this topic'});expect(screen.queryByRole('button',{name:'Pause'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Resume'})).not.toBeInTheDocument()})
const changed=(over:Partial<SourceGoalFollowState['sources'][number]>={})=>{const d=detail();d.bindings=[{id:'b',status:'paused',spec_json:spec,gaps_json:[],cursor_json:{}}];d.goal.follow_state=following({phase:'waiting_for_permission',health:'needs_permission',sources:[{binding_id:'b',source_connection_id:'c',status:'paused',health:'needs_permission',error:'source_authority_revoked',failures:0,last_success_at:'2026-10-28T01:11:45Z',retry_at:null,attention:'source_changed',resolvable_by:'you',...over}]});return d}
const reconfirm=(over:Record<string,unknown>={})=>({binding_id:'b',binding_revision:0,resolvable_by:'you',source_name:'Robotics feed',current:{capture_policy:'extract_text',retention_policy:'full_text',source_status:'active',channel_status:'active',uses_credential:false},changed:null,related_changes:[{kind:'source_material_retention',at:'2026-10-28T14:45:51Z'}],authority:'a'.repeat(64),...over})
it('REPORTED: a Source changed after confirmation is explained in the topic and confirmed there, not sent to the Source page',async()=>{
 const d=changed();vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);vi.mocked(sourceGoalsApi.sourceConfirmation).mockResolvedValue(reconfirm() as never);vi.mocked(sourceGoalsApi.confirmSource).mockResolvedValue({binding_id:'b',binding_revision:1,status:'active'} as never);show()
 expect(await screen.findByText(/A source this topic uses changed after you confirmed the topic/)).toBeInTheDocument()
 expect(screen.queryByText('A source needs your permission or setup. This is not reported as “no updates”.')).not.toBeInTheDocument()
 expect(screen.queryByRole('link',{name:'Review source'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Review change and continue'}))
 const dialog=await screen.findByRole('dialog');await within(dialog).findByText('Robotics feed')
 expect(within(dialog).getByText('Full text')).toBeInTheDocument();expect(within(dialog).getByText('Readable text')).toBeInTheDocument()
 expect(within(dialog).getByText(/Saving full text was allowed for this source/)).toBeInTheDocument();expect(within(dialog).getByText(/exact change cannot be listed/)).toBeInTheDocument()
 expect(sourceGoalsApi.confirmSource).not.toHaveBeenCalled()
 const healthy=detail();vi.mocked(sourceGoalsApi.read).mockResolvedValue(healthy)
 fireEvent.click(within(dialog).getByRole('button',{name:'Confirm and continue'}))
 await waitFor(()=>expect(sourceGoalsApi.confirmSource).toHaveBeenCalledWith('g','b',{binding_revision:0,authority:'a'.repeat(64)},{spaceId:'s'}))
 await waitFor(()=>expect(screen.queryByText(/A source this topic uses changed/)).not.toBeInTheDocument());expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('keeps the dialog open on a refused confirmation and shows the current state again after a change (409)',async()=>{
 vi.mocked(sourceGoalsApi.read).mockResolvedValue(changed());vi.mocked(sourceGoalsApi.sourceConfirmation).mockResolvedValueOnce(reconfirm() as never).mockResolvedValueOnce(reconfirm({binding_revision:0,authority:'b'.repeat(64),changed:['retention_policy']}) as never)
 vi.mocked(sourceGoalsApi.confirmSource).mockRejectedValueOnce(new ApiRequestError('source_scope_changed',409,undefined,{error:'source_scope_changed',message:'source_scope_changed'}));show()
 fireEvent.click(await screen.findByRole('button',{name:'Review change and continue'}));const dialog=await screen.findByRole('dialog');await within(dialog).findByText('Robotics feed')
 fireEvent.click(within(dialog).getByRole('button',{name:'Confirm and continue'}))
 expect(await within(dialog).findByRole('alert')).toHaveTextContent('The source changed again since this was shown.');expect(within(dialog).queryByText('source_scope_changed')).not.toBeInTheDocument();await within(dialog).findByText('Changed since the topic was confirmed: What is kept.')
 expect(sourceGoalsApi.sourceConfirmation).toHaveBeenCalledTimes(2);expect(screen.getByRole('dialog')).toBeInTheDocument()
})
it('offers no confirmation when the Source is no longer usable as it is, and says who must act',async()=>{
 vi.mocked(sourceGoalsApi.read).mockResolvedValue(changed({attention:'access',resolvable_by:'source_owner'}));show()
 expect(await screen.findByText(/Its owner or a Space admin must restore it; this topic cannot\./)).toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'Review change and continue'})).not.toBeInTheDocument()
})
it('names a usage limit as a limit, not as a missing permission',async()=>{
 const d=changed({attention:'budget',resolvable_by:'you',health:'failing',error:'source_native_budget_exhausted'});d.goal.follow_state!.health='failing';d.goal.follow_state!.phase='blocked';d.goal.follow_state!.blocked_reason='source_native_budget_exhausted';vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show()
 expect(await screen.findByText(/A usage limit for this topic was reached/)).toBeInTheDocument()
 expect(screen.queryByText(/needs your permission/)).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:'Review source'})).not.toBeInTheDocument()
})


it('checks now using the shown plan, distinguishes queued from completed, and keeps refresh read-only',async()=>{
 show();await screen.findByRole('heading',{name:'Follow robotics'});fireEvent.click(screen.getByRole('button',{name:'Check now'}));
 await waitFor(()=>expect(sourceGoalsApi.check).toHaveBeenCalledWith('g',{expected_version_id:'v'},expect.objectContaining({spaceId:'s',signal:expect.any(AbortSignal)})));
 expect(await screen.findByText('Check queued. Results will appear here when collection finishes.')).toBeInTheDocument();
 vi.mocked(sourceGoalsApi.check).mockClear();fireEvent.click(screen.getByRole('button',{name:'Refresh progress'}));await waitFor(()=>expect(sourceGoalsApi.read).toHaveBeenCalled());expect(sourceGoalsApi.check).not.toHaveBeenCalled();
});
it('disables manual checking while paused or collecting and hides it from non-owners',async()=>{
 const d=detail();d.goal.status='paused';vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);const view=show();expect(await screen.findByRole('button',{name:'Check now'})).toBeDisabled();view.unmount();
 d.goal.status='running';d.goal.follow_state=following({collections:{queued:1,running:0}});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);const second=show();expect(await screen.findByRole('button',{name:'Check in progress'})).toBeDisabled();second.unmount();
 d.goal.owner_user_id='other';vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Follow robotics'});expect(screen.queryByRole('button',{name:/Check now|Check in progress/})).not.toBeInTheDocument();
});
it('keeps manual check failure retryable without claiming it was queued',async()=>{
 vi.mocked(sourceGoalsApi.check).mockRejectedValueOnce(new Error('refused'));show();fireEvent.click(await screen.findByRole('button',{name:'Check now'}));
 expect(await screen.findByRole('alert')).toBeInTheDocument();expect(screen.queryByText('Check queued. Results will appear here when collection finishes.')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Check now'}));expect(await screen.findByText('Check queued. Results will appear here when collection finishes.')).toBeInTheDocument();
});

it('does not submit twice while a manual check acknowledgement is pending',async()=>{
 let finish!:(value:{status:'queued'})=>void;vi.mocked(sourceGoalsApi.check).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
 const view=show();const button=await screen.findByRole('button',{name:'Check now'});fireEvent.click(button);fireEvent.click(button);
 expect(sourceGoalsApi.check).toHaveBeenCalledTimes(1);expect(button).toBeDisabled();
 finish({status:'queued'});expect(await screen.findByText('Check queued. Results will appear here when collection finishes.')).toBeInTheDocument();view.unmount();
});


it('edits a topic manually without sending an Agent message and keeps apply as a separate explicit action',async()=>{
 show();await screen.findByRole('heading',{name:'Follow robotics'});fireEvent.click(screen.getByRole('button',{name:'Adjust following'}));
 const dialog=await screen.findByRole('dialog');
 fireEvent.change(within(dialog).getByRole('textbox',{name:'Topic title'}),{target:{value:'Design comparisons'}});
 fireEvent.change(within(dialog).getByRole('textbox',{name:'Following purpose'}),{target:{value:'Compare product architecture with our project'}});
 fireEvent.change(within(dialog).getByRole('textbox',{name:'Analysis questions and requirements'}),{target:{value:'Use code evidence to identify useful design trade-offs.'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Save draft'}));
 await waitFor(()=>expect(sourceGoalsApi.edit).toHaveBeenCalledWith('g',expect.objectContaining({expected_revision:1,title:'Design comparisons',intent:'Compare product architecture with our project',analysis_brief:'Use code evidence to identify useful design trade-offs.'}),expect.objectContaining({spaceId:'s'})));
 expect(sourceGoalsApi.message).not.toHaveBeenCalled();expect(sourceGoalsApi.follow).not.toHaveBeenCalled();
 await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('preserves a manual draft on a revision conflict and offers both edit routes only to the owner',async()=>{
 vi.mocked(sourceGoalsApi.edit).mockRejectedValue({status:409});const page=show();await screen.findByRole('heading',{name:'Follow robotics'});fireEvent.click(screen.getByRole('button',{name:'Adjust following'}));
 const dialog=await screen.findByRole('dialog');fireEvent.change(within(dialog).getByRole('textbox',{name:'Topic title'}),{target:{value:'Unsaved edit'}});fireEvent.click(within(dialog).getByRole('button',{name:'Save draft'}));
 expect(await within(dialog).findByRole('alert')).toHaveTextContent('The topic changed');expect(within(dialog).getByRole('textbox',{name:'Topic title'})).toHaveValue('Unsaved edit');
 page.unmount();const other=detail();other.goal.owner_user_id='someone-else';vi.mocked(sourceGoalsApi.read).mockResolvedValue(other);show();await screen.findByRole('heading',{name:'Follow robotics'});expect(screen.queryByRole('button',{name:'Adjust following'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Adjust following'})).not.toBeInTheDocument();
});

it('confirms Project analysis only for a prepared exact purpose and explicit execution selection',async()=>{
 const d=detail();d.goal.project_id='p';d.goal.status='preview_ready';d.goal.active_version_id=null;d.goal.follow_json=null;d.goal.follow_state=following({intent:'unconfirmed',phase:'none',sources:[]});vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show('/projects/p/sources/goals/g');await screen.findByRole('heading',{name:'Follow this topic'});
 fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByRole('button',{name:'Start following'})).toBeDisabled();const consent=within(screen.getByRole('group',{name:'Topic analysis and recent rounds'}));fireEvent.click(await consent.findByRole('button',{name:'Agent'}));fireEvent.click(await screen.findByRole('option',{name:'My search Agent'}));fireEvent.click(await consent.findByRole('button',{name:'Runtime configuration'}));fireEvent.click(await screen.findByRole('option',{name:/MiniMax config/}));fireEvent.click(screen.getByRole('button',{name:'Start following'}));
 await waitFor(()=>expect(sourceGoalsApi.follow).toHaveBeenCalledWith('g',expect.objectContaining({version_id:'v',theme_analysis:{enabled:true,agent_id:'a',runtime_profile_id:'rp'}}),{spaceId:'s'}));
});

it('opens a management page without fetching articles and links to all material in Reading',async()=>{
 show();await screen.findByRole('heading',{name:'Current direction'});
 expect(informationDigestsApi.reading).not.toHaveBeenCalled();expect(screen.queryByText('Paper one')).not.toBeInTheDocument();
 expect(screen.getByRole('link',{name:'View collected articles'})).toHaveAttribute('href','/spaces/s/library/reading?view=all&topic=g&topic_selection=all');
 const headings=['Status','Current direction','Sources','Recent checks','Collected material','Manage'].map(name=>screen.getByRole('heading',{name}));
 headings.slice(1).forEach((h,i)=>expect(headings[i].compareDocumentPosition(h)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
 expect(screen.queryByRole('textbox',{name:'Goal message'})).not.toBeInTheDocument();expect(sourceGoalsApi.message).not.toHaveBeenCalled();
});
it('keeps active direction separate from a proposed plan until explicit application',async()=>{
 const d=detail();d.goal.active_version_id='active';d.goal.follow_state=following({pending_adjustment:true});d.versions.unshift({id:'active',revision:0,plan_json:{title:'Follow robotics',summary:'Effective robotics scope',intent_snapshot:{intent:'Keep collecting robotics releases',includes:[],excludes:[]},sources:[spec],limitations:[]}});d.versions[1].plan_json={...d.versions[1].plan_json,intent_snapshot:{intent:'New draft direction for architectures',includes:[],excludes:[]}};vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();
 expect(await screen.findByText('Effective robotics scope')).toBeVisible();expect(screen.getByText('Robotics plan')).not.toBeVisible();expect(screen.queryByText('Keep collecting robotics releases')).not.toBeInTheDocument();
 fireEvent.click(screen.getByText('Review proposed changes'));expect(screen.getByText('Robotics plan')).toBeVisible();expect(screen.queryByText('New draft direction for architectures')).not.toBeInTheDocument();expect(sourceGoalsApi.follow).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Apply adjusted plan'}));await waitFor(()=>expect(sourceGoalsApi.follow).toHaveBeenCalledWith('g',expect.objectContaining({version_id:'v'}),{spaceId:'s'}));
});
it('keeps manual edits while switching between the two adjustment modes',async()=>{
 show();fireEvent.click(await screen.findByRole('button',{name:'Adjust following'}));const modal=screen.getByRole('dialog');
 fireEvent.change(within(modal).getByRole('textbox',{name:'Topic title'}),{target:{value:'Retain this manual draft'}});
 fireEvent.mouseDown(within(modal).getByRole('tab',{name:'Discuss changes'}),{button:0,ctrlKey:false});
 expect(within(modal).getByRole('textbox',{name:'Goal message'})).toBeVisible();
 fireEvent.mouseDown(within(modal).getByRole('tab',{name:'Direct edit'}),{button:0,ctrlKey:false});
 expect(within(modal).getByRole('textbox',{name:'Topic title'})).toHaveValue('Retain this manual draft');expect(sourceGoalsApi.message).not.toHaveBeenCalled();expect(sourceGoalsApi.edit).not.toHaveBeenCalled();expect(sourceGoalsApi.follow).not.toHaveBeenCalled();
});
it('shows recent collection audits without exposing redacted Source content or identifiers',async()=>{
 const d=detail();d.runs=[{id:'audit-internal',binding_id:'b',status:'succeeded',started_at:'2026-10-28T10:00:00Z',result_json:{goal_items_new:4,native_run_id:'collection-run'}},{id:'audit-hidden',binding_id:'missing',status:'failed',started_at:'2026-10-28T09:00:00Z',result_json:{goal_items_new:99,native_run_id:'hidden-run'}}];d.native_runs=[{id:'collection-run',status:'succeeded',version_id:'v'},{id:'hidden-run',status:'failed',version_id:'v'}];vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();
 const region=(await screen.findByRole('heading',{name:'Recent checks'})).closest('section')!;expect(within(region).getByText('4 new materials')).toBeInTheDocument();expect(within(region).queryByText('99 new materials')).not.toBeInTheDocument();expect(within(region).queryByText('audit-internal')).not.toBeInTheDocument();
 fireEvent.click(within(region).getByText('Execution details'));expect(within(region).getByRole('link',{name:'Open execution details'})).toHaveAttribute('href','/spaces/s/runs/collection-run');expect(within(region).queryByRole('link',{name:/hidden-run/})).not.toBeInTheDocument();
});
it('restores an unsent discussion draft after closing and reopening adjustments',async()=>{
 show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();
 fireEvent.change(screen.getByRole('textbox',{name:'Goal message'}),{target:{value:'Keep a broad search across workbench products'}});
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Close'}));await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
 fireEvent.click(screen.getByRole('button',{name:'Adjust following'}));fireEvent.mouseDown(screen.getByRole('tab',{name:'Discuss changes'}),{button:0,ctrlKey:false});
 await waitFor(()=>expect(screen.getByRole('textbox',{name:'Goal message'})).toHaveValue('Keep a broad search across workbench products'));expect(sourceGoalsApi.message).not.toHaveBeenCalled();
});

it('does not resurrect a discussion draft when the session is cleared before the dialog unmounts',async()=>{
 const view=show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();fireEvent.change(screen.getByRole('textbox',{name:'Goal message'}),{target:{value:'A draft belonging to the old session'}});
 clearSessionResidue();view.unmount();show();await screen.findByRole('heading',{name:'Follow robotics'});openAdvanced();expect(screen.getByRole('textbox',{name:'Goal message'})).toHaveValue('');
});
it('keeps earlier recorded checks available behind a disclosure',async()=>{
 const d=detail();d.runs=Array.from({length:7},(_,i)=>({id:`audit-${i}`,binding_id:'b',status:'succeeded',started_at:'2026-10-28T10:00:00Z',result_json:{goal_items_new:i+1}}));vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);show();await screen.findByRole('heading',{name:'Recent checks'});expect(screen.getByText('7 new materials')).not.toBeVisible();fireEvent.click(screen.getByText('Earlier checks (2)'));expect(screen.getByText('7 new materials')).toBeVisible();
});

it.each([403,404])('re-reads a rejected operation (%s) and keeps the independently authorized goal without suggesting credentials',async status=>{
 vi.mocked(sourceGoalsApi.action).mockRejectedValueOnce(new ApiRequestError('Operation refused',status));show();await screen.findByRole('heading',{name:'Follow robotics'});
 fireEvent.click(screen.getByRole('button',{name:'Pause'}));await screen.findByRole('alert');
 await waitFor(()=>expect(sourceGoalsApi.read).toHaveBeenCalledTimes(2));
 expect(screen.getByRole('heading',{name:'Follow robotics'})).toBeInTheDocument();expect(screen.queryByRole('link',{name:'Open secure credentials'})).not.toBeInTheDocument();
})
it('clears a formerly readable goal when re-reading after a rejected write is also refused',async()=>{
 show();await screen.findByRole('heading',{name:'Follow robotics'});
 vi.mocked(sourceGoalsApi.action).mockRejectedValueOnce(new ApiRequestError('Write refused',403));vi.mocked(sourceGoalsApi.read).mockRejectedValue(new ApiRequestError('Read revoked',404));
 fireEvent.click(screen.getByRole('button',{name:'Pause'}));await screen.findByRole('alert');
 await waitFor(()=>expect(screen.queryByRole('heading',{name:'Follow robotics'})).not.toBeInTheDocument());expect(screen.queryByRole('button',{name:'Adjust following'})).not.toBeInTheDocument();
})
it.each(['en','zh-CN'])('explains an inactive source after checking without treating it as a credential problem (%s)',async locale=>{
 await i18n.changeLanguage(locale);vi.mocked(sourceGoalsApi.check).mockRejectedValueOnce(new ApiRequestError('source_goal_source_inactive',409));show();await screen.findByRole('heading',{name:'Follow robotics'});
 fireEvent.click(screen.getByRole('button',{name:locale==='en'?'Check now':'立即检查'}));
 expect(await screen.findByRole('alert')).toHaveTextContent(locale==='en'?'A connected source or its channel is paused or inactive':'连接的来源或频道已暂停或停用');
 expect(screen.getByRole('heading',{name:'Follow robotics'})).toBeInTheDocument();expect(screen.queryByRole('link',{name:locale==='en'?'Open secure credentials':'打开安全凭证'})).not.toBeInTheDocument();
})
it('offers explicit channel restoration through the existing exact-state confirmation without applying it on open',async()=>{
 vi.mocked(sourceGoalsApi.read).mockResolvedValue(changed());vi.mocked(sourceGoalsApi.sourceConfirmation).mockResolvedValue(reconfirm({restore_channel:true,current:{capture_policy:'reference_only',retention_policy:'metadata_only',source_status:'active',channel_status:'paused',uses_credential:false},changed:['channel_status']}) as never);
 show();fireEvent.click(await screen.findByRole('button',{name:'Review change and continue'}));const dialog=await screen.findByRole('dialog');
 await within(dialog).findByRole('heading',{name:'Restore this source channel?'});expect(within(dialog).getByText(/Only the channel is paused/)).toBeInTheDocument();expect(within(dialog).getByText('Paused')).toBeInTheDocument();expect(sourceGoalsApi.confirmSource).not.toHaveBeenCalled();
 fireEvent.click(within(dialog).getByRole('button',{name:'Restore channel and continue'}));
 await waitFor(()=>expect(sourceGoalsApi.confirmSource).toHaveBeenCalledWith('g','b',{binding_revision:0,authority:'a'.repeat(64),restore_channel:true},{spaceId:'s'}));
})

function collectingDetail(){
 const d=detail();d.native_runs=[{id:'collect-run',status:'running',phase:'running',version_id:'v'}];d.runs=[{id:'audit',binding_id:'b',status:'queued',result_json:{native_run_id:'collect-run'}}];
 d.goal.follow_state=following({phase:'checking',collections:{queued:0,running:1}});return d
}
const collectionTurn=(parts:import('@rainver/protocol').TurnPart[]):import('@rainver/protocol').RunTurn=>({schema_version:'run_turn.v1',run_id:'collect-run',source:'run_events',state:'working',blocked_on:null,cursor:3,updated_at:new Date().toISOString(),parts})

it('shows live collection tool activity at the status entry and stops through the canonical Run',async()=>{
 vi.mocked(sourceGoalsApi.read).mockResolvedValue(collectingDetail());
 let update:((turn:import('@rainver/protocol').RunTurn)=>void)|undefined
 vi.mocked(runsApi.streamTurn).mockImplementation(async(_id,options)=>{update=options.onTurn;await new Promise<void>(resolve=>options.signal?.addEventListener('abort',()=>resolve()))})
 show();await screen.findByRole('region',{name:'Collection progress'});
 const tool={type:'tool_call' as const,index:0,call_id:'one',name:'Web search',kind:'search',status:'running' as const,input:null,output:null}
 await waitFor(()=>expect(update).toBeDefined());
 const {act}=await import('@testing-library/react');act(()=>update!(collectionTurn([tool,{type:'reasoning',index:1,text:'PRIVATE REASONING'}])));
 expect(await screen.findByText('Web search')).toBeVisible();expect(screen.queryByText('PRIVATE REASONING')).not.toBeInTheDocument();
 act(()=>update!(collectionTurn([{...tool,status:'succeeded'},{type:'text',index:1,text:'Checking product announcements beyond repositories.'}])));
 expect(await screen.findByText('Tools completed: 1 of 1')).toBeVisible();expect(screen.getByText('Checking product announcements beyond repositories.')).toBeVisible();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Stop collection'}))});await waitFor(()=>expect(runsApi.stop).toHaveBeenCalledWith('collect-run',{spaceId:'s'}));
});

it('treats silence as uncertain activity and never stops a long collection automatically',async()=>{
 vi.mocked(sourceGoalsApi.read).mockResolvedValue(collectingDetail());
 vi.mocked(runsApi.streamTurn).mockImplementation(async(_id,options)=>{
  options.onTurn({...collectionTurn([]),updated_at:new Date(Date.now()-10*60_000).toISOString()});await new Promise<void>(resolve=>options.signal?.addEventListener('abort',()=>resolve()))
 });
 show();expect(await screen.findByText(/silence alone does not mean it is stuck/)).toBeVisible();expect(runsApi.stop).not.toHaveBeenCalled();
});

it('clears live collection details after a refused stream and does not subscribe to withheld collections',async()=>{
 vi.mocked(sourceGoalsApi.read).mockResolvedValue(collectingDetail());
 vi.mocked(runsApi.streamTurn).mockImplementation(async(_id,options)=>{options.onTurn(collectionTurn([{type:'text',index:0,text:'Private collection status'}]));throw new ApiRequestError('Revoked',403)});
 const first=show();expect(await screen.findByText('You no longer have access to this run’s activity.')).toBeVisible();expect(screen.queryByText('Private collection status')).not.toBeInTheDocument();first.unmount();
 vi.mocked(runsApi.streamTurn).mockClear();const withheld=collectingDetail();withheld.bindings=[{id:'b',goal_id:'g',source_connection_id:'c',status:'collecting',revision:1,unavailable:true,collection_error:'source_unavailable'}];withheld.runs[0].result_json=null;vi.mocked(sourceGoalsApi.read).mockResolvedValue(withheld);
 show();await screen.findByRole('heading',{name:'Follow robotics'});expect(screen.queryByRole('region',{name:'Collection progress'})).not.toBeInTheDocument();expect(runsApi.streamTurn).not.toHaveBeenCalled();
});

it('reconnects interrupted and closed waiting streams and resumes visible activity',async()=>{
 vi.useFakeTimers();vi.mocked(sourceGoalsApi.read).mockResolvedValue(collectingDetail());
 let attempts=0
 vi.mocked(runsApi.streamTurn).mockImplementation(async(_id,options)=>{
  attempts++
  if(attempts===1)throw new ApiRequestError('Interrupted',502)
  if(attempts===2){options.onTurn({...collectionTurn([]),state:'blocked',blocked_on:'authorization'});return}
  options.onTurn(collectionTurn([{type:'tool_call',index:0,call_id:'resumed',name:'Resumed public search',kind:'search',status:'running',input:null,output:null}]));await new Promise<void>(resolve=>options.signal?.addEventListener('abort',()=>resolve()))
 })
 const {act}=await import('@testing-library/react');await act(async()=>{show()});expect(screen.getByText('Activity connection interrupted; reconnecting…')).toBeVisible()
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});expect(screen.getByText('Waiting for authorization or resources')).toBeVisible()
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});expect(screen.getByText('Resumed public search')).toBeVisible();expect(attempts).toBe(3);expect(runsApi.stop).not.toHaveBeenCalled()
});

it('offers an explicit collection retry for recoverable failure without sending the user to Source setup',async()=>{
 const d=detail();d.goal.follow_state=following({health:'failing',phase:'blocked',sources:[{binding_id:'b',source_connection_id:'c',status:'cooldown',health:'backoff',error:'source_native_failed',failures:1,last_success_at:null,retry_at:'2026-11-03T16:26:00Z',retryable:true}]});
 d.bindings[0]={id:'b',status:'cooldown',spec_json:spec,gaps_json:[],cursor_json:{},collection_error:'source_native_failed'};vi.mocked(sourceGoalsApi.read).mockResolvedValue(d);
 show();const retry=await screen.findByRole('button',{name:'Retry collection'});expect(screen.getByText(/source setup does not need to be recreated/)).toBeVisible();expect(screen.queryByText('Review source')).not.toBeInTheDocument();
 const {act}=await import('@testing-library/react');await act(async()=>{fireEvent.click(retry)});
 expect(sourceGoalsApi.check).toHaveBeenCalledWith('g',{expected_version_id:'v',retry_failed:true},expect.objectContaining({spaceId:'s'}));expect(sourceGoalsApi.action).not.toHaveBeenCalled();
});
