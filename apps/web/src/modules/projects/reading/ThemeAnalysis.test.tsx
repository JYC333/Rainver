import {render,screen,fireEvent,act} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {MemoryRouter} from 'react-router-dom'
import {ThemeAnalysis} from './ThemeAnalysis'
import {projectReadingApi} from '../../../api/client'
vi.mock('../../../api/client',()=>({projectReadingApi:{themes:vi.fn(),consent:vi.fn(),retryTheme:vi.fn()}}))
vi.mock('../../../components/agents/AgentExecutionPicker',()=>({AgentExecutionPicker:()=> <p>Execution choices</p>}))
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks()})
const result=(status='complete')=>({analysis:{enabled:true,version_id:'v'},rounds:[{id:'r',status,coverage:{}}]})
async function open(){const view=render(<MemoryRouter><ThemeAnalysis space="s" user="u" goal="g" version="v" canManage/></MemoryRouter>);await act(async()=>{const details=view.container.querySelector('details')!;details.open=true;fireEvent(details,new Event('toggle'))});return view}
it('does not render disabled-analysis setup while current settings are unresolved or refused',async()=>{
 let resolve!:(v:never)=>void;vi.mocked(projectReadingApi.themes).mockImplementationOnce(()=>new Promise(r=>{resolve=r}));await open();
 expect(screen.queryByText('Execution choices')).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull();expect(screen.queryByText('Automatic analysis is not enabled for this purpose version')).toBeNull();
 await act(async()=>resolve(result() as never));expect(screen.getByText('Analysis enabled for this exact purpose version')).toBeVisible();expect(screen.queryByText('Execution choices')).toBeNull();expect(projectReadingApi.consent).not.toHaveBeenCalled()
})
it('refreshes active rounds with reads and stops after completion or unmount',async()=>{
 vi.useFakeTimers();vi.mocked(projectReadingApi.themes).mockResolvedValueOnce(result('collecting') as never).mockResolvedValue(result() as never);const view=await open();
 expect(screen.getByText('Collecting')).toBeVisible();await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});expect(screen.getByText('Check complete')).toBeVisible();
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000)});expect(projectReadingApi.themes).toHaveBeenCalledTimes(2);expect(projectReadingApi.consent).not.toHaveBeenCalled();view.unmount()
})
it('does not display configuration controls when the settings read fails',async()=>{
 vi.mocked(projectReadingApi.themes).mockRejectedValue(Object.assign(new Error('Access revoked'),{status:403}));await open();expect(screen.getByRole('alert')).toHaveTextContent('Access revoked');expect(screen.queryByText('Execution choices')).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull()
})
it('retries failed analysis in this Topic with the exact round and no collection or consent write',async()=>{
 const blocked={...result('blocked'),rounds:[{id:'r',version_id:'v',status:'blocked',coverage:{complete:true},error_code:'briefing_output_invalid'}]};vi.mocked(projectReadingApi.themes).mockResolvedValue(blocked as never);vi.mocked(projectReadingApi.retryTheme).mockResolvedValue(result('generating') as never);await open();
 expect(screen.getByText(/did not pass format or citation checks/)).toBeVisible();expect(screen.getByText(/does not collect articles again/)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Retry analysis'}));await act(async()=>{});expect(projectReadingApi.retryTheme).toHaveBeenCalledWith('g','r',{spaceId:'s'});expect(projectReadingApi.consent).not.toHaveBeenCalled();expect(projectReadingApi.themes).toHaveBeenCalledTimes(2)
})
it.each(['briefing_attempts_exhausted','source_network_failed','theme_execution_changed'])('explains %s without offering an ineffective analysis retry',async error_code=>{
 vi.mocked(projectReadingApi.themes).mockResolvedValue({...result(),rounds:[{id:'r',version_id:'v',status:'blocked',coverage:{complete:true},error_code}]} as never);await open();expect(screen.queryByRole('button',{name:'Retry analysis'})).toBeNull()
})
it('keeps existing retry visible while reopening and revalidating instead of remounting the controls',async()=>{
 const data={...result('awaiting_analysis'),rounds:[{id:'r',version_id:'v',status:'awaiting_analysis',coverage:{complete:true},error_code:null}]};let resolve!:(v:never)=>void;
 vi.mocked(projectReadingApi.themes).mockResolvedValueOnce(data as never).mockImplementationOnce(()=>new Promise(r=>{resolve=r}));const view=await open();const retry=screen.getByRole('button',{name:'Retry analysis'});
 expect(screen.getByText('Awaiting analysis')).toBeVisible();expect(screen.queryByText('Blocked')).toBeNull();expect(screen.queryByText(/did not pass format/)).toBeNull();
 const details=view.container.querySelector('details')!;await act(async()=>{details.open=false;fireEvent(details,new Event('toggle'))});expect(view.container.contains(retry)).toBe(true);
 await act(async()=>{details.open=true;fireEvent(details,new Event('toggle'))});expect(screen.getByRole('button',{name:'Retry analysis'})).toBe(retry);expect(retry).toBeDisabled();expect(projectReadingApi.themes).toHaveBeenCalledTimes(2);
 await act(async()=>resolve(data as never));expect(retry).toBeEnabled();expect(projectReadingApi.retryTheme).not.toHaveBeenCalled();
})
it('removes cached controls if revalidation after reopening revokes access',async()=>{
 vi.mocked(projectReadingApi.themes).mockResolvedValueOnce({...result(),rounds:[{id:'r',version_id:'v',status:'awaiting_analysis',coverage:{complete:true},error_code:null}]} as never).mockRejectedValueOnce(Object.assign(new Error('Access revoked'),{status:403}));const view=await open();const details=view.container.querySelector('details')!;
 await act(async()=>{details.open=false;fireEvent(details,new Event('toggle'))});await act(async()=>{details.open=true;fireEvent(details,new Event('toggle'))});expect(screen.getByRole('alert')).toHaveTextContent('Access revoked');expect(screen.queryByRole('button',{name:'Retry analysis'})).toBeNull();
})
it('stops active-round refreshes while the retained panel is closed',async()=>{
 vi.useFakeTimers();vi.mocked(projectReadingApi.themes).mockResolvedValue(result('collecting') as never);const view=await open();const details=view.container.querySelector('details')!;
 await act(async()=>{details.open=false;fireEvent(details,new Event('toggle'));await vi.advanceTimersByTimeAsync(15000)});expect(projectReadingApi.themes).toHaveBeenCalledTimes(1);view.unmount();
})
