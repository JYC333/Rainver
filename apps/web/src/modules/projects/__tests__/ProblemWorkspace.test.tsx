import userEvent from '@testing-library/user-event';
import i18n from '../../../i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import ProblemAreaPage from '../problemWorkspace/ProblemAreaPage';
import ResearchAreaPage from '../ResearchAreaPage';
import { inquiryApi, projectResearchApi } from '../../../api/client';
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space' }) }));
vi.mock('../../../core/spaceNav', async () => {
    const { Link } = await import('react-router-dom');
    return { SpaceLink: ({ children, ...p }: {
            children: ReactNode;
            to: string;
        }) => <Link {...p}>{children}</Link> };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(),success:vi.fn() } }));
vi.mock('../../../api/client', () => ({
    inquiryApi: { workspaceThreads: vi.fn(), workspaceAccess: vi.fn(), getThread: vi.fn(), problem: vi.fn(), recordProblemWork: vi.fn(), closeProblemRound: vi.fn(), recordIteration: vi.fn(), createThread: vi.fn(), linkedTasks: vi.fn(), linkTask: vi.fn(),taskResult:vi.fn(),referenceTaskResult:vi.fn(), listIterations: vi.fn() },
    notesApi: { list: vi.fn().mockResolvedValue({ items: [] }) }, tasksApi: { list: vi.fn().mockResolvedValue({ items: [] }) }, projectResearchApi: {standing:vi.fn().mockResolvedValue({enabled:true,enabled_binding_count:1,budget:{daily_limit:20,daily_used:3},batches:[],advice:[],recent_inflow:[]}),initializeArea:vi.fn(),retryStandingBatch:vi.fn().mockResolvedValue({}),actionStandingAdvice:vi.fn().mockResolvedValue({}),dismissStandingAdvice:vi.fn().mockResolvedValue({}), problemOperations: vi.fn(), startAcquisition: vi.fn(), checkpoints: vi.fn(), result: vi.fn(), adoptResult: vi.fn() }
}));
const projection = { method_version: 'problem_solving.v1', can_write: true, thread_id: 'thread', version: 1, revision: 2, round_number: 1, round_start_ref: { kind: 'thread', id: 'thread' }, current_focus: null, stages: ['frame', 'plan', 'act', 'verify', 'conclude'].map(stage => ({ stage, worked: false, has_outputs: false, running: false })), steps: [], closeouts: [], next_step_cursor: null, next_closeout_cursor: null };
function Location() { const l = useLocation(); return <output aria-label="Location">{l.pathname + l.search}</output>; }
function page(path = '/projects/project/inquiry?thread=thread') {
    return render(<MemoryRouter initialEntries={[path]}>
    <Location />
    <Routes>
    <Route path="/projects/:projectId/inquiry" element={<ProblemAreaPage />}/>
    <Route path="/projects/:projectId/research" element={<ResearchAreaPage />}/>
    <Route path="/projects/:projectId/inquiry/records" element={<p>Records</p>}/>
    </Routes>
    </MemoryRouter>);
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(inquiryApi.workspaceThreads).mockResolvedValue({ items: [{ id: 'thread', statement: 'Why fail?', kind: 'question', lifecycle_status: 'active', judgment: null }], next_cursor: null } as never); vi.mocked(inquiryApi.workspaceAccess).mockResolvedValue({ can_write: true }); vi.mocked(inquiryApi.getThread).mockResolvedValue({ id: 'thread', kind: 'question', statement: 'Why fail?', lifecycle_status: 'active', question_state: { answer_state: 'open' }, scope_boundary: 'CSV only' } as never); vi.mocked(inquiryApi.problem).mockResolvedValue(projection as never); vi.mocked(inquiryApi.linkedTasks).mockResolvedValue({ items: [], next_cursor: null } as never); vi.mocked(projectResearchApi.problemOperations).mockResolvedValue({ items: [], next_cursor: null }); vi.mocked(inquiryApi.listIterations).mockResolvedValue([]); });
it('stage navigation is read-only; explicit work and skip use canonical versioned commands', async () => {
    page();
    await screen.findByText('CSV only');
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('stage=plan');expect(screen.getByRole('button',{name:'Plan'})).toHaveAttribute('aria-pressed','true');expect(screen.getByRole('button',{name:'Frame'})).toHaveAttribute('aria-pressed','false');
    expect(inquiryApi.recordProblemWork).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Work and reason'), { target: { value: 'Compare approaches' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record selected work' }));
    await waitFor(() => expect(inquiryApi.recordProblemWork).toHaveBeenCalledWith('project', 'thread', expect.objectContaining({ method_version: 'problem_solving.v1', expected_revision: 2, stage: 'plan', reason: 'Compare approaches' })));
});
it('unchanged round uses closeout, while judgment changes use protected Iteration', async () => {
    page();
    await screen.findByText('CSV only');
    fireEvent.click(screen.getByRole('button', { name: 'Conclude' }));
    fireEvent.change(screen.getByLabelText('Summary and remaining gaps'), { target: { value: 'No new evidence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close round' }));
    await waitFor(() => expect(inquiryApi.closeProblemRound).toHaveBeenCalled());
    expect(inquiryApi.recordIteration).not.toHaveBeenCalled();
});
it('read-only problems retain content and task links without write controls', async () => {
    vi.mocked(inquiryApi.problem).mockResolvedValue({ ...projection, can_write: false } as never);
    page();
    await screen.findByText('CSV only');
    expect(screen.queryByRole('button', { name: 'Edit definition' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record selected work' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Linked tasks' }));
    await screen.findByRole('heading', { name: 'Linked Tasks' });
    expect(screen.queryByRole('button', { name: 'Create and link Task' })).not.toBeInTheDocument();
});
it.each([['?research=new&thread=thread&keep=one', '/inquiry?thread=thread&keep=one&section=research'], ['?tab=focus', '/inquiry?section=research'], ['?tab=runs&open=old&workflow_id=wf', '/inquiry/records?tab=runs&open=old&workflow_id=wf'], ['?tab=standing', '/inquiry?section=standing']])('preserves old deep link %s without creating work', async (q, destination) => {
    page('/projects/project/research' + q);
    await waitFor(() => expect(screen.getByLabelText('Location')).toHaveTextContent('/projects/project' + destination));
    expect(inquiryApi.createThread).not.toHaveBeenCalled();
    expect(projectResearchApi.startAcquisition).not.toHaveBeenCalled();
});
it('a late response cannot replace another selected problem', async () => {
    let resolve!: (v: never) => void;
    vi.mocked(inquiryApi.getThread).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    vi.mocked(inquiryApi.workspaceThreads).mockResolvedValue({ items: [{ id: 'other', statement: 'Other problem', kind: 'question' }], next_cursor: null } as never);
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'Other problem' }));
    await screen.findByText('CSV only');
    await act(async () => resolve({ id: 'thread', statement: 'STALE PRIVATE BODY', kind: 'question' } as never));
    expect(screen.queryByText('STALE PRIVATE BODY')).not.toBeInTheDocument();
});

it('creates a linked Task through P4 and references an actual Task result explicitly',async()=>{
 vi.mocked(inquiryApi.linkedTasks).mockResolvedValue({items:[{id:'task',title:'Check import',status:'done',roles:['investigates']}],next_cursor:null} as never);
 vi.mocked(inquiryApi.taskResult).mockResolvedValue({task_id:'task',status:'done',artifacts:[{id:'artifact',role:'output'}],artifacts_truncated:false,task_work_path:'/tasks/task'});
 page();await screen.findByText('CSV only');fireEvent.click(screen.getByRole('button',{name:'Linked tasks'}));fireEvent.change(await screen.findByLabelText('New Task title'),{target:{value:'Verify result'}});fireEvent.click(screen.getByRole('button',{name:'Create and link Task'}));await waitFor(()=>expect(inquiryApi.linkTask).toHaveBeenCalledWith('project','thread',expect.objectContaining({task:{title:'Verify result'}})));
 fireEvent.click(await screen.findByRole('button',{name:'View result'}));fireEvent.change(await screen.findByLabelText('Result applicability and reason'),{target:{value:'Reproduced independently'}});fireEvent.click(screen.getByRole('button',{name:'Reference result for verification'}));await waitFor(()=>expect(inquiryApi.referenceTaskResult).toHaveBeenCalledWith('project','thread','task',expect.objectContaining({stage:'verify',work_kind:'reference_result',output_refs:[{type:'artifact',id:'artifact'}]})));
});
it('changed judgment goes through protected Iteration instead of an ordinary work patch',async()=>{
 page();await screen.findByText('CSV only');fireEvent.click(screen.getByRole('button',{name:'Conclude'}));await userEvent.click(screen.getByLabelText('Judgment change'));await userEvent.click(screen.getByRole('option',{name:'Record a changed judgment'}));fireEvent.change(screen.getByLabelText('Updated answer'),{target:{value:'Malformed CSV input'}});fireEvent.change(screen.getByLabelText('Summary and remaining gaps'),{target:{value:'Reproduction identifies the cause'}});fireEvent.click(screen.getByRole('button',{name:'Close round'}));await waitFor(()=>expect(inquiryApi.recordIteration).toHaveBeenCalledWith('project','thread',expect.objectContaining({round_intent:'close_round',current_answer_summary:'Malformed CSV input',method_version:'problem_solving.v1'})));expect(inquiryApi.closeProblemRound).not.toHaveBeenCalled();
});
it('translates the problem controls without starting work',async()=>{
 await act(async()=>{await i18n.changeLanguage('zh-CN')});try{page();await screen.findByRole('heading',{name:'问题推进'});expect(await screen.findByRole('button',{name:'制定方案'})).toBeInTheDocument();expect(inquiryApi.recordProblemWork).not.toHaveBeenCalled()}finally{await act(async()=>{await i18n.changeLanguage('en')})}
});

it('records explicit skip and return facts without closing a round or changing judgment',async()=>{
 page();await screen.findByText('CSV only');fireEvent.click(screen.getByRole('button',{name:'Plan'}));await userEvent.click(screen.getByLabelText('Work action'));await userEvent.click(screen.getByRole('option',{name:'Skip this stage'}));fireEvent.change(screen.getByLabelText('Work and reason'),{target:{value:'Use a known method'}});fireEvent.click(screen.getByRole('button',{name:'Record selected work'}));await waitFor(()=>expect(inquiryApi.recordProblemWork).toHaveBeenCalledWith('project','thread',expect.objectContaining({stage:'act',work_kind:'select_method',selection_kind:'skip',skipped_stages:['plan']})));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Record selected work'})).toBeDisabled());await userEvent.click(screen.getByLabelText('Work action'));await userEvent.click(screen.getByRole('option',{name:'Return to this stage'}));fireEvent.change(screen.getByLabelText('Work and reason'),{target:{value:'Compare another approach'}});fireEvent.click(screen.getByRole('button',{name:'Record selected work'}));await waitFor(()=>expect(inquiryApi.recordProblemWork).toHaveBeenLastCalledWith('project','thread',expect.objectContaining({stage:'plan',selection_kind:'return'})));expect(inquiryApi.closeProblemRound).not.toHaveBeenCalled();expect(inquiryApi.recordIteration).not.toHaveBeenCalled();
});

it('old standing links reach the real monitoring panel with budget, inflow and actionable advice without creating a Focus workbench',async()=>{
 vi.mocked(projectResearchApi.standing).mockResolvedValue({enabled:true,enabled_binding_count:1,budget:{daily_limit:20,daily_used:3},batches:[{id:'batch',status:'failed',error:'Previous comparison failed'}],advice:[{id:'advice',source_title:'Paper',detail:'New direction',action_id:'source.raise_as_question',affected_sections_json:[]}],recent_inflow:[{source_item_id:'item',title:'Recent material',triage_status:'relevant'}]} as never);
 page('/projects/project/research?tab=standing');await screen.findByRole('heading',{name:'Standing research'});expect(screen.getByText('Recent material')).toBeInTheDocument();await waitFor(()=>expect(screen.getByRole('button',{name:'Retry comparison'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Retry comparison'}));await waitFor(()=>expect(projectResearchApi.retryStandingBatch).toHaveBeenCalledWith('project','batch'));fireEvent.click(screen.getByRole('button',{name:'Create question'}));await waitFor(()=>expect(projectResearchApi.actionStandingAdvice).toHaveBeenCalledWith('project','advice'));fireEvent.click(screen.getByRole('button',{name:'Dismiss advice from Paper'}));await waitFor(()=>expect(projectResearchApi.dismissStandingAdvice).toHaveBeenCalledWith('project','advice'));expect(screen.queryByText('Focus workbench')).not.toBeInTheDocument();
});
it('standing overview remains readable but disables writes for read-only Project access',async()=>{
 vi.mocked(inquiryApi.workspaceAccess).mockResolvedValue({can_write:false});vi.mocked(projectResearchApi.standing).mockResolvedValue({enabled:true,enabled_binding_count:1,budget:{daily_limit:20,daily_used:3},batches:[{id:'batch',status:'failed'}],advice:[],recent_inflow:[]} as never);page('/projects/project/inquiry?section=standing');expect(await screen.findByRole('button',{name:'Retry comparison'})).toBeDisabled();expect(inquiryApi.createThread).not.toHaveBeenCalled();
});
