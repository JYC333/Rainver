import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, it, expect, vi } from 'vitest';
import { ProblemResearch } from '../problemWorkspace/ProblemResearch';
import { projectResearchApi } from '../../../api/client';
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../../core/spaceNav', () => ({ SpaceLink: ({ children, to }: {
        children: React.ReactNode;
        to: string;
    }) => <a href={to}>{children}</a> }));
vi.mock('../../../api/client', () => ({ projectResearchApi: { problemOperations: vi.fn(), checkpoints: vi.fn(), startAcquisition: vi.fn(), cancelOperation: vi.fn(), retryOperation: vi.fn(), reconcileOperation: vi.fn(), updateItemLimit: vi.fn(), rescanBackfill: vi.fn(), result: vi.fn(), adoptResult: vi.fn() } }));
const op = { id: 'op', title: 'Authorized invocation', kind: 'research', status: 'active', progress_json: { workflow_id: 'wf', run_kind: 'baseline', current_stage: 'historical_backfill', history: { max_items: 50 }, partial: false }, steps: [], links: [] };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(projectResearchApi.problemOperations).mockResolvedValue({ items: [op], next_cursor: null } as never); vi.mocked(projectResearchApi.checkpoints).mockResolvedValue([]); });
function show(editable = true) {
    return render(<MemoryRouter>
    <ProblemResearch project="project" thread="thread" kind="question" projection={{ version: 2, revision: 3 } as never} editable={editable} refresh={vi.fn().mockResolvedValue(undefined)}/>
    </MemoryRouter>);
}
it('keeps full progress controls and uses the real bound operation for limit, rescan and cancel', async () => {
    show();
    fireEvent.click(await screen.findByText('Authorized invocation'));
    fireEvent.change(screen.getByLabelText('New item limit'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update limit' }));
    await waitFor(() => expect(projectResearchApi.updateItemLimit).toHaveBeenCalledWith('project', 'op', 80));
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    await waitFor(() => expect(projectResearchApi.rescanBackfill).toHaveBeenCalledWith('project', 'op'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(projectResearchApi.cancelOperation).toHaveBeenCalledWith('project', 'op'));
});
it('withheld metadata keeps a stop entry but no content, limit or result controls', async () => {
    vi.mocked(projectResearchApi.problemOperations).mockResolvedValue({ items: [{ ...op, title: 'Research invocation', progress_json: { content_withheld: true } }], next_cursor: null } as never);
    show();
    fireEvent.click(await screen.findByText('Research invocation'));
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read result' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New item limit')).not.toBeInTheDocument();
    expect(projectResearchApi.checkpoints).not.toHaveBeenCalled();expect(screen.queryByText('Stage 1 of 5')).not.toBeInTheDocument();
});
it('read-only removes mutations and partial calls cannot rescan', async () => {
    vi.mocked(projectResearchApi.problemOperations).mockResolvedValue({ items: [{ ...op, progress_json: { ...op.progress_json, partial: true } }], next_cursor: null } as never);
    show(false);
    fireEvent.click(await screen.findByText('Authorized invocation'));
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start research call' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rescan' })).not.toBeInTheDocument();
});
it('result adoption names the current version and applicability without bypassing Iteration', async () => {
    vi.mocked(projectResearchApi.problemOperations).mockResolvedValue({ items: [{ ...op, status: 'completed' }], next_cursor: null } as never);
    vi.mocked(projectResearchApi.result).mockResolvedValue({ status: 'completed', applicability: 'requires_assessment', partial: false, findings: [{ report_id: 'report', summary: 'Evidence' }], limitations: ['Old snapshot'] } as never);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Read result' }));
    await screen.findByText('Problem or round changed. Reassess applicability.');
    fireEvent.change(screen.getByLabelText('Assessment reason'), { target: { value: 'Useful with limits' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record applicability in Verify' }));
    await waitFor(() => expect(projectResearchApi.adoptResult).toHaveBeenCalledWith('project', 'op', expect.objectContaining({ expected_version: 2, expected_revision: 3, applicability: 'limited', reason: 'Useful with limits' })));
    expect(vi.mocked(projectResearchApi.adoptResult).mock.calls[0]![2]).not.toHaveProperty('method_version');
});

it('keeps acquisition limits separate from each operation edit',async()=>{
 show();await screen.findByText('Authorized invocation');fireEvent.change(screen.getByLabelText('Item limit, optional'),{target:{value:'12'}});fireEvent.change(screen.getByLabelText('New item limit'),{target:{value:'80'}});expect(screen.getByLabelText('Item limit, optional')).toHaveValue(12);fireEvent.click(screen.getByRole('button',{name:'Update limit'}));await waitFor(()=>expect(projectResearchApi.updateItemLimit).toHaveBeenCalledWith('project','op',80));expect(screen.getByLabelText('Item limit, optional')).toHaveValue(12);
});
