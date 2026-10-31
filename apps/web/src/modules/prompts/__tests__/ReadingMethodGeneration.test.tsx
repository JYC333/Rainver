import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {beforeEach,it,expect,vi} from 'vitest';
import type {ReadingMethodContext,ReadingMethodGenerationView} from '@rainver/protocol';
import ReadingMethodWorkbench from '../ReadingMethodWorkbench';
import {readingMethodsApi} from '../../../api/client';
import {clearSessionResidue} from '../../../lib/sessionResidue';
let viewer='u';
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'s',preferredSpaceId:'s',userId:viewer})}));
vi.mock('../../../api/client',()=>({providersApi:{usable:vi.fn().mockResolvedValue([])},readingMethodsApi:{cliOptions:vi.fn().mockResolvedValue([]),context:vi.fn(),initialize:vi.fn(),draft:vi.fn(),sample:vi.fn(),trial:vi.fn(),judge:vi.fn(),promote:vi.fn(),cancel:vi.fn(),rollback:vi.fn(),generate:vi.fn(),generation:vi.fn(),cancelGeneration:vi.fn()}}));
const context=():ReadingMethodContext=>({item_id:'i',item_title:'Original',project_id:'p',project_name:'Robotics',can_manage:true,initialized:true,effective_version_id:'base',effective_content_hash:'a'.repeat(64),effective_version:1,effective_scope:'system',method:'Investigate mechanisms using primary evidence and actual examples.',result_provenance:null,versions:[],cases:[],trials:[],runtimes:[{agent_id:'a',runtime_profile_id:'r',name:'Analyst · Local',usable:true,reason:null}],generations:[]});
const generation=(status='queued'):ReadingMethodGenerationView=>({id:'g',status,visibility:'visible',stale:false,description:'Inspect documentation instead of rewriting a homepage.',parent_version_id:'base',candidate_version_id:status==='ready'?'child':null,candidate_version:status==='ready'?2:null,method:status==='ready'?'Investigate primary documentation and actual examples, explaining evidence and unknowns.':null,baseline_method:'Investigate mechanisms using primary evidence and actual examples.',summary:status==='ready'?'Adds primary evidence.':null,changes:status==='ready'?['Adds an actual API example.']:[],execution_name:'Analyst · Local',seconds:null,cost_usd:null});
const mount=()=>render(<MemoryRouter initialEntries={['/prompts?reading_method=1&item_id=i&project_id=p']}><ReadingMethodWorkbench/></MemoryRouter>);
async function fill(){await screen.findByLabelText('What went wrong, and what should change?');fireEvent.change(screen.getByLabelText('What went wrong, and what should change?'),{target:{value:generation().description}});}
beforeEach(()=>{viewer='u';vi.clearAllMocks();vi.mocked(readingMethodsApi.context).mockResolvedValue(context());});
it('description is the default; explicit generation creates no trial/promotion and leads to the saved candidate comparison',async()=>{
 const data=context();vi.mocked(readingMethodsApi.generate).mockImplementation(async()=>generation('ready'));vi.mocked(readingMethodsApi.context).mockImplementation(async()=>({...data,versions:[{id:'child',version:2,status:'draft',method:generation('ready').method!,reason:'Generated',content_hash:'b'.repeat(64)}]}));
 mount();await fill();expect(screen.queryByLabelText('Problem / reason for change')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));await screen.findByText('Adds primary evidence.');expect(readingMethodsApi.generate).toHaveBeenCalledWith({source_kind:'description',item_id:'i',project_id:'p',parent_version_id:'base',parent_content_hash:'a'.repeat(64),description:generation().description,target_key:undefined});expect(readingMethodsApi.trial).not.toHaveBeenCalled();expect(readingMethodsApi.promote).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Next: compare this candidate'}));await screen.findByText('v2 · Generated');
});
it('double clicks share one request, failure preserves feedback, retry/cancel and refresh recovery are explicit',async()=>{
 let finish!:(v:ReadingMethodGenerationView)=>void;vi.mocked(readingMethodsApi.generate).mockReturnValue(new Promise(r=>{finish=r;}));const r=mount();await fill();const button=screen.getByRole('button',{name:'Generate candidate version'});fireEvent.click(button);fireEvent.click(button);expect(readingMethodsApi.generate).toHaveBeenCalledTimes(1);await act(async()=>finish(generation('failed')));expect(screen.getByDisplayValue(generation().description!)).toBeInTheDocument();vi.mocked(readingMethodsApi.generate).mockResolvedValue(generation());fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));await screen.findByRole('button',{name:'Cancel generation'});expect(readingMethodsApi.generate).toHaveBeenLastCalledWith(expect.objectContaining({retry_of:'g'}));vi.mocked(readingMethodsApi.cancelGeneration).mockResolvedValue(generation('cancelled'));fireEvent.click(screen.getByRole('button',{name:'Cancel generation'}));await screen.findByText('Generation: Cancelled');r.unmount();
 const data=context();data.generations=[generation()];vi.mocked(readingMethodsApi.context).mockResolvedValue(data);mount();await screen.findByRole('button',{name:'Cancel generation'});expect(screen.getByDisplayValue(generation().description!)).toBeInTheDocument();expect(readingMethodsApi.generate).toHaveBeenCalledTimes(2);
});
it('logout and unmount ignore a late generated method and never select or reload it',async()=>{
 let finish!:(v:ReadingMethodGenerationView)=>void;vi.mocked(readingMethodsApi.generate).mockReturnValue(new Promise(r=>{finish=r;}));const r=mount();await fill();fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));await act(async()=>clearSessionResidue());await act(async()=>finish(generation('ready')));expect(screen.queryByText('Adds primary evidence.')).not.toBeInTheDocument();expect(readingMethodsApi.context).toHaveBeenCalledTimes(1);r.unmount();
});
it('permission refusal clears feedback and generated wording; retryable errors preserve the description',async()=>{
 vi.mocked(readingMethodsApi.generate).mockRejectedValueOnce(Object.assign(new Error('Try later'),{status:503}));mount();await fill();fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));await screen.findByText('Try later');expect(screen.getByDisplayValue(generation().description!)).toBeInTheDocument();vi.mocked(readingMethodsApi.generate).mockRejectedValueOnce(Object.assign(new Error('No authority'),{status:403}));fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));await screen.findByText('Access changed. The description, generated method and explanation are hidden.');expect(screen.queryByDisplayValue(generation().description!)).not.toBeInTheDocument();
});
it('manual editing remains inside the advanced disclosure and saves a child without starting generation',async()=>{
 mount();const summary=await screen.findByText('Advanced');fireEvent.click(summary);fireEvent.click(screen.getByRole('button',{name:'Edit manually'}));fireEvent.change(screen.getByLabelText('Problem / reason for change'),{target:{value:'Manual reason'}});fireEvent.change(screen.getByLabelText('Reading method'),{target:{value:'Inspect primary documentation with mechanisms and adaptation costs explicitly.'}});vi.mocked(readingMethodsApi.draft).mockResolvedValue({id:'manual'});fireEvent.click(screen.getByRole('button',{name:'Save draft (production unchanged)'}));await waitFor(()=>expect(readingMethodsApi.draft).toHaveBeenCalled());expect(readingMethodsApi.generate).not.toHaveBeenCalled();
});
it('a user ABA never lets the earlier generation select a candidate or reload the new mount',async()=>{
 let finish!:(v:ReadingMethodGenerationView)=>void;vi.mocked(readingMethodsApi.generate).mockReturnValue(new Promise(r=>{finish=r;}));const r=mount();await fill();fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));
 const tree=()=><MemoryRouter initialEntries={['/prompts?reading_method=1&item_id=i&project_id=p']}><ReadingMethodWorkbench/></MemoryRouter>;
 viewer='other';r.rerender(tree());await screen.findByLabelText('What went wrong, and what should change?');expect(screen.queryByDisplayValue(generation().description!)).not.toBeInTheDocument();viewer='u';r.rerender(tree());await screen.findByLabelText('What went wrong, and what should change?');const reads=vi.mocked(readingMethodsApi.context).mock.calls.length;await act(async()=>finish(generation('ready')));expect(screen.queryByText('Adds primary evidence.')).not.toBeInTheDocument();expect(readingMethodsApi.context).toHaveBeenCalledTimes(reads);
});
it('polling survives a same-state manual refresh, and an older refused poll cannot erase a retried generation',async()=>{
 vi.useFakeTimers({shouldAdvanceTime:true});let rejectOld!:(e:Error)=>void;vi.mocked(readingMethodsApi.generate).mockResolvedValue(generation());const r=mount();
 try{
  await fill();fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));await screen.findByRole('button',{name:'Cancel generation'});
  vi.mocked(readingMethodsApi.generation).mockResolvedValueOnce(generation());fireEvent.click(screen.getByRole('button',{name:'Refresh generation'}));await waitFor(()=>expect(readingMethodsApi.generation).toHaveBeenCalledTimes(1));await waitFor(()=>expect(screen.getByRole('button',{name:'Cancel generation'})).toBeEnabled());
  vi.mocked(readingMethodsApi.generation).mockReturnValueOnce(new Promise((_,reject)=>{rejectOld=reject;}));await act(async()=>{vi.advanceTimersByTime(2100);});expect(readingMethodsApi.generation).toHaveBeenCalledTimes(2);
  vi.mocked(readingMethodsApi.cancelGeneration).mockResolvedValueOnce(generation('cancelled'));fireEvent.click(screen.getByRole('button',{name:'Cancel generation'}));await screen.findByText('Generation: Cancelled');vi.mocked(readingMethodsApi.generate).mockResolvedValueOnce({...generation(),id:'new'});fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));await screen.findByRole('button',{name:'Cancel generation'});
  await act(async()=>rejectOld(Object.assign(new Error('Old permission refusal'),{status:403})));expect(screen.queryByText('Old permission refusal')).not.toBeInTheDocument();expect(screen.getByDisplayValue(generation().description!)).toBeInTheDocument();expect(screen.getByRole('button',{name:'Cancel generation'})).toBeInTheDocument();
 }finally{r.unmount();vi.useRealTimers();}
});
it('degraded is localized, retains feedback after refresh, and explicitly retries in both locales',async()=>{
 const {default:i18n}=await import('../../../i18n');
 try{for(const cn of [false,true]){
  await i18n.changeLanguage(cn?'zh-CN':'en');const data=context();data.generations=[generation('degraded')];vi.mocked(readingMethodsApi.context).mockResolvedValue(data);vi.mocked(readingMethodsApi.generation).mockResolvedValue(generation('degraded'));vi.mocked(readingMethodsApi.generate).mockResolvedValue({...generation(),id:'retry'});vi.mocked(readingMethodsApi.generate).mockClear();
  const r=mount();await screen.findByText(cn?'生成状态: 生成未完成，需明确重试':'Generation: Generation incomplete — retry required');expect(screen.getByText(cn?'未保存候选。请刷新生效方法、检查执行配置后明确重试；描述仍保留。':'No candidate was saved. Refresh the effective method, check execution configuration, then explicitly retry. Your description is retained.')).toBeInTheDocument();expect(screen.getByDisplayValue(generation().description!)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:cn?'刷新生成状态':'Refresh generation'}));await waitFor(()=>expect(screen.getByRole('button',{name:cn?'刷新生成状态':'Refresh generation'})).toBeEnabled());expect(readingMethodsApi.generate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:cn?'生成候选版本':'Generate candidate version'}));await screen.findByRole('button',{name:cn?'取消生成':'Cancel generation'});expect(readingMethodsApi.generate).toHaveBeenCalledWith(expect.objectContaining({description:generation().description,retry_of:'g'}));r.unmount();
 }}finally{await i18n.changeLanguage('en');}
});
it('missing default API disables only generation; manual editing and the visible method stay usable',async()=>{
 const data=context();data.runtimes=[];data.api_execution={usable:false,name:null,reason:'No default chat API'};vi.mocked(readingMethodsApi.context).mockResolvedValue(data);mount();await screen.findByText(data.method!);expect(screen.queryByRole('button',{name:'Generation execution configuration'})).not.toBeInTheDocument();fireEvent.change(screen.getByLabelText('What went wrong, and what should change?'),{target:{value:'Clarify evidence'}});expect(screen.getByRole('button',{name:'Generate candidate version'})).toBeDisabled();expect(screen.getByRole('link',{name:'Configure API Providers'})).toBeVisible();await act(async()=>fireEvent.click(screen.getByText('Advanced',{exact:true})));fireEvent.click(screen.getByRole('button',{name:'Edit manually'}));expect(screen.getByRole('textbox',{name:'Reading method'})).toBeEnabled();expect(readingMethodsApi.generate).not.toHaveBeenCalled();
});
it('the system revision workspace generates for its distinct target without an Agent or Profile',async()=>{
 const data=context();data.target_key='prompt.revision.method';data.effective_version_id='revision-base';data.method='Revise the supplied prompt while preserving evidence, language and code-owned constraints.';data.runtimes=[];data.api_execution={usable:true,name:'Default API',reason:null};vi.mocked(readingMethodsApi.context).mockResolvedValue(data);vi.mocked(readingMethodsApi.generate).mockResolvedValue({...generation(),parent_version_id:'revision-base'});
 render(<MemoryRouter initialEntries={['/prompts?reading_method=1&item_id=i&project_id=p&target_key=prompt.revision.method']}><ReadingMethodWorkbench/></MemoryRouter>);await screen.findByRole('heading',{name:'System prompt revision method'});fireEvent.change(screen.getByLabelText('What went wrong, and what should change?'),{target:{value:'Preserve evidence requirements'}});fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));await screen.findByRole('button',{name:'Cancel generation'});expect(readingMethodsApi.generate).toHaveBeenCalledWith(expect.objectContaining({target_key:'prompt.revision.method',parent_version_id:'revision-base'}));expect(vi.mocked(readingMethodsApi.generate).mock.calls[0][0]).not.toHaveProperty('agent_id');expect(vi.mocked(readingMethodsApi.generate).mock.calls[0][0]).not.toHaveProperty('runtime_profile_id');
});

it.each(['en', 'zh-CN'])('description examples and delivery guidance match the selected target in %s', async locale => {
 const {default:i18n}=await import('../../../i18n');
 const cn=locale==='zh-CN';
 try {
  await i18n.changeLanguage(locale);
  for(const meta of [false,true]) {
   const data=context();data.target_key=meta?'prompt.revision.method':'reading.project_investigation';
   vi.mocked(readingMethodsApi.context).mockResolvedValue(data);
   const view=render(<MemoryRouter initialEntries={[`/prompts?reading_method=1&item_id=i&project_id=p&target_key=${data.target_key}`]}><ReadingMethodWorkbench/></MemoryRouter>);
   const input=await screen.findByRole('textbox',{name:cn?'哪里不好，希望怎样改？':'What went wrong, and what should change?'});
   const example=meta
    ? cn?'例如：保留已有输入、输出与语言约束，将反馈转化为可执行的 Prompt 改写策略。':'For example: preserve existing input, output and language constraints, and turn feedback into an executable prompt revision strategy.'
    : cn?'例如：结果只改写了主页简介。希望调查相关文档和示例，说明证据与未知。':'For example: the result only paraphrased a homepage. Investigate relevant documentation and examples, and explain evidence and unknowns.';
   expect(input).toHaveAttribute('placeholder',example);
   const note=cn?'完整调查正文沿 Source 材料进入 Reader。简报仍消费有限摘要，不代表综合质量已升级。':'Investigation text is delivered through Source materials to Reader. Briefings still consume bounded excerpts; this is not a briefing-quality upgrade.';
   if(meta)expect(screen.queryByText(note)).not.toBeInTheDocument();
   else expect(screen.getByText(note)).toBeVisible();
   view.unmount();
  }
 } finally {await i18n.changeLanguage('en');}
});

it('CLI is explicitly selected without API, clears API fields, and switching back cannot send CLI identity',async()=>{
 const data=context();data.api_execution={usable:false,name:null,reason:'No API'};vi.mocked(readingMethodsApi.context).mockResolvedValue(data);
 vi.mocked(readingMethodsApi.cliOptions).mockResolvedValue([{agent_id:'a',runtime_profile_id:'r',name:'codex_cli · My Host · Native',usable:true,reason:null}]);
 vi.mocked(readingMethodsApi.generate).mockResolvedValue(generation('failed'));
 mount();await fill();expect(readingMethodsApi.cliOptions).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('Advanced',{exact:true}));
 fireEvent.click(await screen.findByRole('button',{name:'Execution method'}));fireEvent.click(screen.getByRole('option',{name:'CLI runtime'}));
 await waitFor(()=>expect(readingMethodsApi.cliOptions).toHaveBeenCalledWith('p'));
 fireEvent.click(screen.getByRole('button',{name:'CLI runtime'}));fireEvent.click(await screen.findByRole('option',{name:'codex_cli · My Host · Native'}));
 fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));await screen.findByText('Generation: Generation failed');
 expect(readingMethodsApi.generate).toHaveBeenCalledWith(expect.objectContaining({agent_id:'a',runtime_profile_id:'r'}));expect(vi.mocked(readingMethodsApi.generate).mock.calls[0][0]).not.toHaveProperty('provider_id');
 fireEvent.click(await screen.findByRole('button',{name:'Execution method'}));fireEvent.click(screen.getByRole('option',{name:'Use authorized Space default API'}));
 expect(screen.getByRole('button',{name:'Generate candidate version'})).toBeDisabled();
});
it('generates a shared-method draft without selecting any article or starting a comparison',async()=>{
 const data={...context(),item_id:null,item_title:''};vi.mocked(readingMethodsApi.context).mockResolvedValue(data);vi.mocked(readingMethodsApi.generate).mockResolvedValue(generation());
 render(<MemoryRouter initialEntries={['/prompts?reading_method=1&project_id=p']}><ReadingMethodWorkbench/></MemoryRouter>);
 await fill();fireEvent.click(screen.getByRole('button',{name:'Generate candidate version'}));
 await waitFor(()=>expect(readingMethodsApi.generate).toHaveBeenCalledWith(expect.objectContaining({item_id:null,project_id:'p',description:generation().description})));
 expect(readingMethodsApi.sample).not.toHaveBeenCalled();expect(readingMethodsApi.trial).not.toHaveBeenCalled();
});
