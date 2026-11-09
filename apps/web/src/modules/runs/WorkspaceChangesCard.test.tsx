import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {vi,it,expect,beforeEach} from 'vitest'
import {WorkspaceChangesCard} from './WorkspaceChangesCard'
import {runsApi,callOperation} from '../../api/client'
import {run as fixture} from '../agent_work/fixtures.test-support'
import {workspaceChange} from './workspaceFixtures.test-support'
vi.mock('../../api/client',()=>({runsApi:{get:vi.fn()},callOperation:vi.fn(),ApiRequestError:class extends Error{status=500}}))
const change=workspaceChange()
const run=fixture({id:'workspace-run',status:'succeeded',contract_snapshot_json:{execution_workspace_version:1},workspace_changes:[change]})
beforeEach(()=>{vi.clearAllMocks();vi.mocked(runsApi.get).mockResolvedValue(run);vi.mocked(callOperation).mockResolvedValue({status:'completed',data:{}} as never)})
it('explains an unmatched adoption result instead of silently leaving attention unchanged',async()=>{
 const initial={...run,workspace_changes:[{...change,state:'blocked' as const,integration_id:'integration',integration_revision:9,integration_status:'conflict' as const}]};
 const checked={...initial,workspace_changes:[{...initial.workspace_changes[0],integration_revision:11,integration_detail:{error:'integration_not_yet_adopted'}}]};
 vi.mocked(runsApi.get).mockResolvedValue(initial);
 render(<MemoryRouter><WorkspaceChangesCard run={initial}/></MemoryRouter>);
 await waitFor(()=>expect(runsApi.get).toHaveBeenCalled());
 vi.mocked(runsApi.get).mockResolvedValue(checked);
 fireEvent.click(screen.getByRole('button',{name:'Check whether already integrated'}));
 expect(await screen.findByText(/Later edits or deleted files can prevent a match/)).toBeInTheDocument();
});

it('requires an explicit completion and preserves its idempotency key after an ambiguous error',async()=>{
 vi.mocked(callOperation).mockRejectedValueOnce(new Error('connection lost'))
 render(<MemoryRouter><WorkspaceChangesCard run={run}/></MemoryRouter>)
 expect(await screen.findByText(/Private snapshot/)).toBeInTheDocument();expect(callOperation).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'Finish changes'}));fireEvent.click(screen.getByRole('button',{name:'Confirm'}))
 expect(await screen.findByRole('alert')).toHaveTextContent('connection lost')
 fireEvent.click(screen.getByRole('button',{name:'Confirm'}))
 await waitFor(()=>expect(callOperation).toHaveBeenCalledTimes(2))
 const calls=vi.mocked(callOperation).mock.calls;expect(calls[0]![0]).toBe('workspace.change.complete');expect(calls[0]![1]).toMatchObject({change_set_id:'change',expected_revision:2});expect(calls[0]![2]).toBe(calls[1]![2])
})
it('shows integration and cleanup separately and hides commands without current authority',async()=>{
 const readonly={...run,workspace_changes:[{...change,state:'integrated' as const,can_manage:false,cleanup_state:'blocked' as const,cleanup_errors:['workspace_quarantined']}]};vi.mocked(runsApi.get).mockResolvedValue(readonly)
 render(<MemoryRouter><WorkspaceChangesCard run={readonly}/></MemoryRouter>)
 expect(await screen.findByText('workspace_quarantined')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Finish changes'})).not.toBeInTheDocument();expect(screen.getByText(/Integrated/)).toBeInTheDocument()
})

it('explains a blocked checkpoint and offers retention even without a source commit',async()=>{
 const blocked={...run,workspace_changes:[{...change,state:'blocked' as const,workspace_state:'blocked' as const,integration_detail:{checkpoint_blocked:true}}]};
 vi.mocked(runsApi.get).mockResolvedValue(blocked);
 const view=render(<MemoryRouter><WorkspaceChangesCard run={blocked}/></MemoryRouter>);
 expect(await screen.findByRole('button',{name:'Finish changes'})).toBeDisabled();
 expect(screen.getByText(/A checkpoint needs attention/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Keep without merging'})).toBeEnabled();
 view.unmount();
 const missing={...blocked,workspace_changes:[{...blocked.workspace_changes[0]!,source_commit:null}]};
 vi.mocked(runsApi.get).mockResolvedValue(missing);
 render(<MemoryRouter><WorkspaceChangesCard run={missing}/></MemoryRouter>);
 expect(await screen.findByRole('button',{name:'Keep without merging'})).toBeEnabled();
 expect(screen.queryByText('Saving changes…')).not.toBeInTheDocument();
});

it('explains that a fresh continuation preserves earlier changes separately',async()=>{
 const continued={...run,workspace_changes:[workspaceChange({source_commit:null,integration_detail:{continuation_from_workspace_id:'old-workspace'}}),workspaceChange({change_set_id:'old-change',workspace_id:'old-workspace',state:'blocked',workspace_state:'blocked'})]}
 vi.mocked(runsApi.get).mockResolvedValue(continued)
 render(<MemoryRouter><WorkspaceChangesCard run={continued}/></MemoryRouter>)
 expect(await screen.findByText('This turn uses a fresh workspace. Earlier changes are preserved separately.')).toBeInTheDocument()
 expect(screen.queryByText(/Each folder integrates separately/)).not.toBeInTheDocument()
 expect(screen.getByText('Not saved yet')).toBeInTheDocument()
 expect(screen.queryByText('Saved privately')).not.toBeInTheDocument()
})

it('collects an actual conflict decision instead of silently repeating integration',async()=>{
 const conflict={...run,workspace_changes:[workspaceChange({state:'blocked',integration_id:'integration',integration_revision:7,integration_status:'conflict',integration_detail:{error:'integration_requires_semantic_decision',conflicted_files:['plan.md']}})]}
 vi.mocked(runsApi.get).mockResolvedValue(conflict)
 render(<MemoryRouter><WorkspaceChangesCard run={conflict}/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'Resolve conflict'}))
 expect(screen.getByRole('button',{name:'Confirm'})).toBeDisabled()
 expect(callOperation).not.toHaveBeenCalled()
 fireEvent.change(screen.getByRole('textbox',{name:'Conflict resolution instruction'}),{target:{value:'Keep the dev version of plan.md.'}})
 fireEvent.click(screen.getByRole('button',{name:'Confirm'}))
 await waitFor(()=>expect(callOperation).toHaveBeenCalledWith('workspace.integration.retry',{integration_id:'integration',expected_revision:7,resolution:'Keep the dev version of plan.md.'},expect.any(String),expect.any(Object)))
})

// Workspace publication recovery acceptance.
it('lets people finish changes without entering Git identifiers',async()=>{
 render(<MemoryRouter><WorkspaceChangesCard run={run}/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'Finish changes'}))
 expect(screen.queryByLabelText(/commit ID/i)).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Publish existing commit'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Confirm'}));await waitFor(()=>expect(callOperation).toHaveBeenCalledOnce())
 expect(vi.mocked(callOperation).mock.calls[0]![1]).not.toHaveProperty('commit')
})
it('requests a target adoption check through the existing retry without inventing a resolution',async()=>{
 const blocked={...run,workspace_changes:[{...change,state:'blocked' as const,integration_id:'integration',integration_revision:9,integration_status:'conflict' as const,integration_detail:{conflicted_files:['plan.md']}}]};vi.mocked(runsApi.get).mockResolvedValue(blocked)
 render(<MemoryRouter><WorkspaceChangesCard run={blocked}/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'Check whether already integrated'}))
 await waitFor(()=>expect(callOperation).toHaveBeenCalledOnce())
 expect(vi.mocked(callOperation).mock.calls[0]![1]).toEqual({integration_id:'integration',expected_revision:9,reconcile_only:true})
 expect(await screen.findByText(/This comparison does not call a model/)).toBeInTheDocument()
})
it('keeps completed history in Run details (the conversation summary omits it)',async()=>{
 const done={...run,workspace_changes:[{...change,state:'no_changes' as const,cleanup_state:'cleaned' as const}]};vi.mocked(runsApi.get).mockResolvedValue(done)
 render(<MemoryRouter><WorkspaceChangesCard run={done}/></MemoryRouter>);expect(await screen.findByTestId(`workspace-changes-${run.id}`)).toBeVisible();expect(screen.getByText('No changes')).toBeInTheDocument();expect(screen.queryByLabelText(/commit ID/i)).not.toBeInTheDocument()
})
it('hands native batches to the original Agent instead of opening completion or configuration forms',async()=>{
 const native={...run,workspace_changes:[workspaceChange({native_integration:true})]};vi.mocked(runsApi.get).mockResolvedValue(native);
 render(<MemoryRouter><WorkspaceChangesCard run={native}/></MemoryRouter>);
 expect(await screen.findByRole('button',{name:'Let Agent verify and integrate'})).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Finish changes'})).not.toBeInTheDocument();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(callOperation).not.toHaveBeenCalled();
});

it('shows retention state, reason and time once per workspace with a fenced reclaim command',async()=>{
 const retention={state:'grace' as const,reason:'merged',reclaim_after:'2026-11-08T12:10:00.000Z',hold_until:null,reclaimed_at:null,assessed_at:'2026-11-08T12:00:00.000Z',retained_refs:0,unclaimed_refs:2}
 const graced={...run,workspace_changes:[workspaceChange({state:'integrated',retention}),workspaceChange({change_set_id:'older',state:'no_changes',retention})]}
 vi.mocked(runsApi.get).mockResolvedValue(graced)
 render(<MemoryRouter><WorkspaceChangesCard run={graced}/></MemoryRouter>)
 expect(await screen.findByText(/Reclaims after .* unless used again/)).toHaveTextContent('· because its changes were integrated.')
 expect(screen.getAllByText(/unless used again/)).toHaveLength(1)
 expect(screen.getByText(/manual review: 2/)).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Reclaim now'}))
 await waitFor(()=>expect(callOperation).toHaveBeenCalledWith('workspace.retention.update',{change_set_id:'change',action:'reclaim_now'},expect.any(String),expect.anything()))
 fireEvent.click(screen.getByRole('button',{name:'Keep 7 more days'}))
 await waitFor(()=>expect(callOperation).toHaveBeenCalledWith('workspace.retention.update',{change_set_id:'change',action:'hold',hold_days:7},expect.any(String),expect.anything()))
})

it('keeps unmerged retention visible without an expiry and offers no reclaim without authority',async()=>{
 const retained={...run,workspace_changes:[workspaceChange({state:'abandoned',can_manage:false,cleanup_state:'cleaned',retention:{state:'retained',reason:'kept_without_merging',reclaim_after:null,hold_until:null,reclaimed_at:null,assessed_at:null,retained_refs:3,unclaimed_refs:0}})]}
 vi.mocked(runsApi.get).mockResolvedValue(retained)
 render(<MemoryRouter><WorkspaceChangesCard run={retained}/></MemoryRouter>)
 expect(await screen.findByText(/Branch kept/)).toHaveTextContent('it holds changes kept without merging')
 expect(screen.getByText(/never removes it by age/)).toBeInTheDocument()
 expect(screen.getByText('Recovery refs kept: 3')).toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'Reclaim now'})).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'Keep 7 more days'})).not.toBeInTheDocument()
})

it('replaces the retained-branch cleanup text once the branch was reclaimed',async()=>{
 const reclaimed={...run,workspace_changes:[workspaceChange({state:'integrated',cleanup_state:'cleaned',retention:{state:'reclaimed',reason:'merged',reclaim_after:null,hold_until:null,reclaimed_at:'2026-11-08T12:20:00.000Z',assessed_at:null,retained_refs:0,unclaimed_refs:0}})]}
 vi.mocked(runsApi.get).mockResolvedValue(reclaimed)
 render(<MemoryRouter><WorkspaceChangesCard run={reclaimed}/></MemoryRouter>)
 expect(await screen.findByText(/Workspace and branch reclaimed .* content is in the target/)).toBeInTheDocument()
 expect(screen.queryByText(/saved work retained/)).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'Reclaim now'})).not.toBeInTheDocument()
})
