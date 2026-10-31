import userEvent from '@testing-library/user-event'
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,it,expect,vi} from 'vitest'
import type {ReadingMethodContext} from '@rainver/protocol'
import ReadingMethodWorkbench from '../ReadingMethodWorkbench'
import {readingMethodsApi} from '../../../api/client'
import {clearSessionResidue} from '../../../lib/sessionResidue'
let viewer='u';
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'s',preferredSpaceId:'s',userId:viewer})}))
vi.mock('../../../api/client',()=>({informationDigestsApi:{reading:vi.fn().mockResolvedValue({items:[],total:0,next_cursor:null})},providersApi:{usable:vi.fn().mockResolvedValue([])},readingMethodsApi:{generate:vi.fn(),context:vi.fn(),initialize:vi.fn(),draft:vi.fn(),sample:vi.fn(),trial:vi.fn(),judge:vi.fn(),promote:vi.fn(),cancel:vi.fn(),rollback:vi.fn()}}))
const value=():ReadingMethodContext=>({item_id:'i',item_title:'Original',project_id:'p',project_name:'Robotics',can_manage:true,initialized:true,effective_version_id:'baseline',effective_version:1,effective_scope:'system',method:'Investigate mechanisms and evidence, not a homepage rewrite.',result_provenance:null,versions:[],cases:[],trials:[],runtimes:[{agent_id:'a',runtime_profile_id:'r',name:'Analyst · Local',usable:true,reason:null}]})
const mount=()=>render(<MemoryRouter initialEntries={['/prompts?reading_method=1&item_id=i&project_id=p']}><ReadingMethodWorkbench/></MemoryRouter>)
beforeEach(()=>{viewer='u';vi.clearAllMocks();vi.mocked(readingMethodsApi.context).mockResolvedValue(value())})
it('opens without starting a model and saves a readable child draft without promotion',async()=>{mount();await screen.findByText('Advanced');expect(readingMethodsApi.trial).not.toHaveBeenCalled();fireEvent.click(screen.getByText('Advanced'));fireEvent.click(screen.getByRole('button',{name:'Edit manually'}));fireEvent.change(screen.getByLabelText('Problem / reason for change'),{target:{value:'Only homepage evidence'}});fireEvent.change(screen.getByLabelText('Reading method'),{target:{value:'Read primary documentation and explain actual mechanisms and costs.'}});vi.mocked(readingMethodsApi.draft).mockResolvedValue({id:'child'});fireEvent.click(screen.getByRole('button',{name:'Save draft (production unchanged)'}));await waitFor(()=>expect(readingMethodsApi.draft).toHaveBeenCalledWith(expect.objectContaining({parent_version_id:'baseline',reason:'Only homepage evidence'})));expect(readingMethodsApi.promote).not.toHaveBeenCalled();expect(readingMethodsApi.trial).not.toHaveBeenCalled();})
it('uses explicit sample and runtime, makes one request for duplicate clicks, and separates quality judgment',async()=>{const data=value();data.versions=[{id:'child',version:2,status:'draft',method:'Candidate',reason:'Docs',content_hash:'a'.repeat(64)}];data.cases=[{id:'case',name:'Homepage + docs'}];vi.mocked(readingMethodsApi.context).mockResolvedValue(data);let finish!:(v:never)=>void;vi.mocked(readingMethodsApi.trial).mockReturnValue(new Promise(r=>{finish=r}));mount();await screen.findByText('Advanced');await userEvent.click(screen.getByRole('tab',{name:'Comparison'}));fireEvent.click(screen.getByRole('button',{name:'Candidate method'}));fireEvent.click(screen.getByRole('option',{name:'v2 · Docs'}));fireEvent.click(screen.getByRole('button',{name:'Sample'}));fireEvent.click(screen.getByRole('option',{name:'Homepage + docs'}));const start=screen.getByRole('button',{name:'Start two-run comparison'});fireEvent.click(start);fireEvent.click(start);expect(readingMethodsApi.trial).toHaveBeenCalledTimes(1);expect(readingMethodsApi.trial).toHaveBeenCalledWith({item_id:'i',project_id:'p',candidate_version_id:'child',candidate_content_hash:'a'.repeat(64),case_id:'case',target_key:'reading.project_investigation'});await act(async()=>finish({} as never));})
it('drops derived comparison and editing text on logout and ignores a pending reply',async()=>{mount();await screen.findByText('Advanced');fireEvent.click(screen.getByText('Advanced'));fireEvent.click(screen.getByRole('button',{name:'Edit manually'}));fireEvent.change(screen.getByLabelText('Problem / reason for change'),{target:{value:'PRIVATE_EDIT'}});await act(async()=>clearSessionResidue());expect(screen.queryByDisplayValue('PRIVATE_EDIT')).not.toBeInTheDocument();expect(screen.queryByText(value().method!)).not.toBeInTheDocument()})
it('a permission refusal while refreshing clears earlier material and remains retryable',async()=>{const data=value();data.trials=[{id:'e',candidate_version_id:'c',baseline_version_id:'b',status:'queued',stale:false,visibility:'visible',baseline:null,candidate:null,judgment:null,reason:null,case_name:'case'}];vi.mocked(readingMethodsApi.context).mockResolvedValueOnce(data).mockRejectedValue(Object.assign(new Error('denied'),{status:403}));vi.useFakeTimers({shouldAdvanceTime:true});const r=mount();await screen.findByText('Advanced');await act(async()=>{vi.advanceTimersByTime(2600)});await waitFor(()=>expect(screen.queryByText(data.method!)).not.toBeInTheDocument());expect(screen.getByRole('alert')).toHaveTextContent('denied');r.unmount();vi.useRealTimers()})
it('shows the actual effective method before feedback and has one independent advanced area at the end',async()=>{
 mount();const current=await screen.findByRole('region',{name:'Current method'});
 const method=screen.getByText(value().method!);expect(method).toBeVisible();expect(current).toContainElement(method);
 const feedback=screen.getByLabelText('What went wrong, and what should change?');expect(method.compareDocumentPosition(feedback)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 const summary=screen.getByText('Advanced',{exact:true});const details=summary.closest('details')!;
 expect(details.open).toBe(false);expect(screen.getAllByText('Advanced',{exact:true})).toHaveLength(1);expect(feedback.compareDocumentPosition(details)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(summary);expect(details.open).toBe(true);expect(screen.getByRole('link',{name:'Open advanced workspace'})).toBeVisible();
 expect(screen.queryByRole('textbox',{name:'Reading method'})).not.toBeInTheDocument();
 expect(screen.getByRole('textbox',{name:'What went wrong, and what should change?'})).toBeEnabled();expect(readingMethodsApi.trial).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Edit manually'}));expect(screen.getByRole('textbox',{name:'Reading method'})).toHaveFocus();expect(screen.getByRole('textbox',{name:'What went wrong, and what should change?'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Cancel editing'}));expect(screen.queryByRole('textbox',{name:'Reading method'})).not.toBeInTheDocument();expect(screen.getByRole('textbox',{name:'What went wrong, and what should change?'})).toBeEnabled();
});
it('read-only viewers see the effective method and provenance without manual controls or invented source links',async()=>{
 const data=value();data.can_manage=false;vi.mocked(readingMethodsApi.context).mockResolvedValue(data);mount();expect(await screen.findByText(data.method!)).toBeVisible();
 fireEvent.click(screen.getByText('Advanced',{exact:true}));expect(screen.queryByRole('button',{name:'Edit manually'})).not.toBeInTheDocument();expect(screen.queryByRole('textbox',{name:'Reading method'})).not.toBeInTheDocument();expect(screen.queryByText('Technical and source information')).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:'View originating Run'})).not.toBeInTheDocument();
});
it('comparison revision opens and focuses the final editor for the selected immutable child, then saves back to comparison',async()=>{
 const data=value();data.versions=[{id:'child',version:2,status:'draft',method:'Candidate method with different evidence and primary API examples.',reason:'Docs',content_hash:'a'.repeat(64)}];vi.mocked(readingMethodsApi.context).mockResolvedValue(data);vi.mocked(readingMethodsApi.draft).mockResolvedValue({id:'grandchild'});mount();await screen.findByText(data.method!);
 await userEvent.click(screen.getByRole('tab',{name:'Comparison'}));fireEvent.click(screen.getByRole('button',{name:'Candidate method'}));fireEvent.click(screen.getByRole('option',{name:'v2 · Docs'}));fireEvent.click(screen.getByRole('button',{name:'Revise method (save a new draft)'}));
 const editor=screen.getByRole('textbox',{name:'Reading method'});expect(editor).toBeVisible();expect(editor).toHaveFocus();expect(editor).toHaveValue(data.versions[0].method);expect(editor.closest('details')).toHaveAttribute('open');
 fireEvent.change(screen.getByLabelText('Problem / reason for change'),{target:{value:'Better evidence'}});fireEvent.click(screen.getByRole('button',{name:'Save draft (production unchanged)'}));await waitFor(()=>expect(readingMethodsApi.draft).toHaveBeenCalledWith(expect.objectContaining({parent_version_id:'child'})));expect(screen.getByRole('tab',{name:'Comparison'})).toHaveAttribute('aria-selected','true');expect(screen.queryByRole('textbox',{name:'Reading method'})).not.toBeInTheDocument();
});
it('pending activation and running comparisons cannot open a writable manual form',async()=>{
 const data=value();data.versions=[{id:'c',version:2,status:'candidate',method:'Candidate method',content_hash:'a'.repeat(64),reason:'Docs'}];data.trials=[{id:'pair',candidate_version_id:'c',baseline_version_id:'baseline',status:'queued',stale:false,visibility:'visible',baseline:null,candidate:null,judgment:null,reason:null,case_name:'case'}];vi.mocked(readingMethodsApi.context).mockResolvedValue(data);
 const r=mount();await screen.findByText(data.method!);fireEvent.click(screen.getByText('Advanced',{exact:true}));expect(screen.getByRole('button',{name:'Edit manually'})).toBeDisabled();r.unmount();
 data.trials[0].status='passed';data.promotion={id:'proposal',status:'pending',candidate_version_id:'c'};mount();await screen.findByText(data.method!);fireEvent.click(screen.getByText('Advanced',{exact:true}));expect(screen.getByRole('button',{name:'Edit manually'})).toBeDisabled();
});

it('scope change discards the expanded editor and ignores a late save from the previous viewer',async()=>{
 let finish!:(v:{id:string})=>void;vi.mocked(readingMethodsApi.draft).mockReturnValue(new Promise(r=>{finish=r}));const r=mount();await screen.findByText(value().method!);fireEvent.click(screen.getByText('Advanced',{exact:true}));fireEvent.click(screen.getByRole('button',{name:'Edit manually'}));fireEvent.change(screen.getByLabelText('Problem / reason for change'),{target:{value:'PRIVATE_REASON'}});fireEvent.click(screen.getByRole('button',{name:'Save draft (production unchanged)'}));
 viewer='other';r.rerender(<MemoryRouter initialEntries={['/prompts?reading_method=1&item_id=i&project_id=p']}><ReadingMethodWorkbench/></MemoryRouter>);await screen.findByText(value().method!);await act(async()=>finish({id:'OLD_CHILD'}));expect(screen.queryByDisplayValue('PRIVATE_REASON')).not.toBeInTheDocument();expect(screen.getByText('Advanced',{exact:true}).closest('details')).not.toHaveAttribute('open');expect(screen.getByRole('tab',{name:'Current method'})).toHaveAttribute('aria-selected','true');
});
it('technical information preserves actual source version and Run navigation without entering editing',async()=>{
 const data=value();data.result_provenance={version_id:'recorded-version',version:7,run_id:'origin-run',content_hash:null};vi.mocked(readingMethodsApi.context).mockResolvedValue(data);mount();await screen.findByText(data.method!);fireEvent.click(screen.getByText('Advanced',{exact:true}));expect(screen.getByText('v7 · recorded-version')).toBeVisible();expect(screen.getByRole('link',{name:'View originating Run'})).toHaveAttribute('href',expect.stringContaining('/runs/origin-run'));expect(screen.getByRole('textbox',{name:'What went wrong, and what should change?'})).toBeEnabled();expect(screen.queryByRole('textbox',{name:'Reading method'})).not.toBeInTheDocument();
});

it('opens, reads and saves a shared method without selecting a result',async()=>{
 const data={...value(),item_id:null,item_title:''};
 vi.mocked(readingMethodsApi.context).mockResolvedValue(data);
 render(<MemoryRouter initialEntries={['/prompts?reading_method=1&project_id=p']}><ReadingMethodWorkbench/></MemoryRouter>);
 await screen.findByText(data.method!);
 expect(readingMethodsApi.context).toHaveBeenCalledWith(null,'p',null,'reading.project_investigation');
 fireEvent.click(screen.getByText('Advanced',{exact:true}));fireEvent.click(screen.getByRole('button',{name:'Edit manually'}));
 fireEvent.change(screen.getByLabelText('Problem / reason for change'),{target:{value:'Shared method feedback'}});
 fireEvent.change(screen.getByLabelText('Reading method',{exact:true}),{target:{value:data.method+' Use primary examples.'}});
 fireEvent.click(screen.getByRole('button',{name:'Save draft (production unchanged)'}));
 await waitFor(()=>expect(readingMethodsApi.draft).toHaveBeenCalledWith(expect.objectContaining({item_id:null,project_id:'p',reason:'Shared method feedback'})));
 expect(readingMethodsApi.sample).not.toHaveBeenCalled();expect(readingMethodsApi.trial).not.toHaveBeenCalled();
});
it('comparison material cannot silently change the method maintenance scope',async()=>{
 const data={...value(),project_id:'another-project'};vi.mocked(readingMethodsApi.context).mockResolvedValue(data);
 render(<MemoryRouter initialEntries={['/prompts?reading_method=1&item_id=i&project_id=p&candidate_id=child&method_tab=compare']}><ReadingMethodWorkbench/></MemoryRouter>);
 expect(await screen.findByRole('alert')).toHaveTextContent('This material belongs to a different method scope');
 expect(screen.queryByText(data.method!)).not.toBeInTheDocument();expect(readingMethodsApi.trial).not.toHaveBeenCalled();
});
