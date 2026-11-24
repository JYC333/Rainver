import {MemoryRouter} from 'react-router-dom'
import {act,fireEvent,render as rtlRender,screen,waitFor} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {sessionsApi} from '../../api/client'
import type {ConversationExecutionSummary,ConversationExecutionRuntimeProfile,RoomDetail} from '../../types/api'
import {ConversationParticipantsEditor} from './ConversationParticipantsEditor'
import {SESSION_OPERATION_SCHEMAS} from '@rainver/protocol'
import {ConversationScope} from './ConversationScope'
function render(ui: React.ReactNode) { return rtlRender(ui,{wrapper:MemoryRouter}) }
vi.mock('../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'space'})}))
vi.mock('../../api/client',()=>({sessionsApi:{initializeExecution:vi.fn()}}))
const manager={agent_id:'manager',runtime_profile_id:'manager-profile',runtime_key:'claude_code',runtime_installation:'own'}
const worker={...manager,agent_id:'worker',runtime_profile_id:'worker-profile'}
const summary={session_id:'session',state:'initialized',host:{host_id:'host'},primary:{kind:'managed'},runtime:worker,runtimes:[{...manager,session_config:[],context_tokens:123,last_run_ended_at:'2026-11-13T00:00:00Z'},worker],participant_agent_ids:['manager','worker','hidden'],participants_revision:'version-1'} as ConversationExecutionSummary
const detail={viewer_can_write:true,agent_members:[{agent_id:'manager',agent_name:'Assistant',role:'manager'},{agent_id:'worker',agent_name:'Worker',role:'member'},{agent_id:'hidden',agent_name:'Private Agent',role:'member'}]} as RoomDetail
const profiles=[manager,worker].map(runtime=>({...runtime,execution_host_id:'host',workspace_mode:'managed',usable:true,retained_binding:true})) as ConversationExecutionRuntimeProfile[]
beforeEach(()=>vi.clearAllMocks())
it('sends only explicit authorized changes with the editing version, uses the real manager, and preserves hidden participants',async()=>{
 const saved=vi.fn().mockResolvedValue(undefined)
 render(<ConversationScope spaceId="space"><ConversationParticipantsEditor summary={summary} profiles={profiles} detail={detail} onSaved={saved}/></ConversationScope>)

 expect(screen.getByText('Host')).toBeVisible()
 expect(screen.getAllByRole('button',{name:'Remove'})[1]).toBeDisabled()
 fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0])
 fireEvent.click(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]).toEqual(['session',expect.objectContaining({runtime:manager,participants_revision:'version-1',participant_changes:[{agent_id:'worker',participating:false}],additional_runtimes:[]}),expect.objectContaining({spaceId:'space'})])
 expect(SESSION_OPERATION_SCHEMAS['conversation.execution.initialize'].input.safeParse({session_id:'session',...vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1]}).success).toBe(true)
 expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1]).not.toHaveProperty('participant_agent_ids')
})
it('retains the editing revision, then requires a fresh read and explicit selection after conflict',async()=>{
 vi.mocked(sessionsApi.initializeExecution).mockRejectedValue(Object.assign(new Error('Participants changed; refresh and retry'), {status:409}))
 const saved=vi.fn().mockResolvedValue(true)
 const view=render(<ConversationParticipantsEditor summary={summary} profiles={profiles} detail={detail} onSaved={saved}/>)
 fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0])
 view.rerender(<ConversationParticipantsEditor summary={{...summary,participants_revision:'version-2'}} profiles={profiles} detail={detail} onSaved={saved}/>)
 fireEvent.click(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/}))
 await screen.findByRole('alert')
 expect(saved).not.toHaveBeenCalled()
 expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1].participants_revision).toBe('version-1')
 expect(screen.queryByRole('button',{name:/^(Add to conversation|Confirm removal)$/})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Retry'}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 vi.mocked(sessionsApi.initializeExecution).mockResolvedValue({} as never)
 fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0])
 fireEvent.click(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/}))
 await waitFor(()=>expect(sessionsApi.initializeExecution).toHaveBeenCalledTimes(2))
 expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[1]![1].participants_revision).toBe('version-2')
})

it('shows recovery guidance when the manager runtime is missing',async()=>{
 render(<ConversationParticipantsEditor summary={{...summary,runtimes:[worker]}} profiles={profiles} detail={detail} onSaved={vi.fn()}/>)

 fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0])
 fireEvent.click(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/}))
 expect(await screen.findByRole('alert')).toHaveTextContent('reload the conversation')
 expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
})

it.each([false,true])('joins with a different default Folder or a retained binding (%s)',async retained=>{
 const saved=vi.fn().mockResolvedValue(undefined)
 vi.mocked(sessionsApi.initializeExecution).mockResolvedValue({} as never)
 const joiningProfiles = profiles.map(profile => ({
   ...profile,
   workspace_mode: !retained && profile.agent_id === worker.agent_id ? 'location' as const : profile.workspace_mode,
   workspace_location_id: !retained && profile.agent_id === worker.agent_id ? 'other-location' : null,
   retained_binding: retained,
 }))
 render(<ConversationParticipantsEditor summary={{...summary,runtime:manager,runtimes:[{...manager,session_config:[]}],participant_agent_ids:['manager']}} profiles={joiningProfiles} detail={detail} onSaved={saved}/>)

 fireEvent.click(screen.getByRole('button',{name:'Add Agent from Room'}))
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'Worker'}})
 fireEvent.click(screen.getByRole('button',{name:'Worker'}))
 fireEvent.click(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 const payload=vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1]
 SESSION_OPERATION_SCHEMAS['conversation.execution.initialize'].input.parse({session_id:'session',...payload})
 expect(payload.participant_changes).toEqual([{agent_id:'worker',participating:true}])
 expect(payload.additional_runtimes).toEqual(retained?[]:[worker])
})

it('requires an explicit runtime choice when compatible options are ambiguous',async()=>{
 const alternate={...profiles[1]!,runtime_profile_id:'alternate',runtime_key:'codex',retained_binding:false}
 render(<ConversationParticipantsEditor summary={{...summary,runtime:manager,runtimes:[manager],participant_agent_ids:['manager']}} profiles={[{...profiles[1]!,retained_binding:false},alternate]} detail={detail} onSaved={vi.fn()}/>)
 fireEvent.click(screen.getByRole('button',{name:'Add Agent from Room'}))
 fireEvent.click(screen.getByRole('button',{name:'Worker'}))
 expect(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/})).toBeDisabled()
 expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
})
it('keeps an unavailable candidate inspectable with its server reason and a Host repair path',()=>{
 render(<ConversationParticipantsEditor summary={{...summary,runtime:manager,runtimes:[manager],participant_agent_ids:['manager']}} profiles={[{...profiles[1]!,usable:false,retained_binding:false,reason:'Host permission revoked'}]} detail={detail} onSaved={vi.fn()}/>)
 fireEvent.click(screen.getByRole('button',{name:'Add Agent from Room'}))
 fireEvent.click(screen.getByRole('button',{name:'Worker'}))
 expect(screen.getAllByText('Host permission revoked').length).toBeGreaterThan(0)
 expect(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/})).toBeDisabled()
 expect(screen.getByRole('link',{name:'Configure or reconnect Host'})).toHaveAttribute('href',expect.stringContaining('host=host'))
})

it.each([false,true])('allows authorized removal or retained restoration without usable runtime: join=%s',async join=>{
 const visibleProfiles=profiles.map(profile=>({...profile,usable:false,reason:'CLI unavailable'}))
 const current=join?{...summary,runtime:manager,runtimes:[manager],participant_agent_ids:['manager']}:summary
 const saved=vi.fn().mockResolvedValue(true)
 vi.mocked(sessionsApi.initializeExecution).mockResolvedValue({} as never)
 render(<ConversationParticipantsEditor summary={current} profiles={visibleProfiles} detail={detail} onSaved={saved}/>)
 if(join){fireEvent.click(screen.getByRole('button',{name:'Add Agent from Room'}));fireEvent.click(screen.getByRole('button',{name:'Worker'}))}
 else fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0])
 fireEvent.click(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 const body=vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1]
 expect(body.participant_changes).toEqual([{agent_id:'worker',participating:join}])
 expect(body.additional_runtimes).toEqual([])
 SESSION_OPERATION_SCHEMAS['conversation.execution.initialize'].input.parse({session_id:'session',...body})
})
it('does not authorize a hidden retained participant and omits empty runtime controls',()=>{
 render(<ConversationParticipantsEditor summary={{...summary,runtimes:[manager],participant_agent_ids:['manager']}} profiles={[profiles[0]!]} detail={detail} onSaved={vi.fn()}/>)
 fireEvent.click(screen.getByRole('button',{name:'Add Agent from Room'}));fireEvent.click(screen.getByRole('button',{name:'Private Agent'}))
 expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/})).toBeDisabled()
 expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
})
it('reports successful write plus failed refresh without replaying the consumed revision',async()=>{
 vi.mocked(sessionsApi.initializeExecution).mockResolvedValue({} as never)
 const saved=vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
 render(<ConversationParticipantsEditor summary={summary} profiles={profiles} detail={detail} onSaved={saved}/>)
 fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0]);fireEvent.click(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/}))
 expect(await screen.findByRole('alert')).toHaveTextContent('Saved. Refresh failed')
 expect(screen.queryByRole('button',{name:/^(Add to conversation|Confirm removal)$/})).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'Add Agent from Room'})).toBeDisabled()
 fireEvent.click(screen.getByRole('button',{name:'Retry'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Add Agent from Room'})).toBeEnabled())
 expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce()
})
it.each([true,false])('uses authoritative permission and retained-thread metadata with an empty runtime catalog: join=%s',async join=>{
 vi.mocked(sessionsApi.initializeExecution).mockResolvedValue({} as never)
 const saved=vi.fn().mockResolvedValue(true)
 render(<ConversationParticipantsEditor summary={join?{...summary,runtimes:[manager],participant_agent_ids:['manager']}:summary} profiles={[]} availableAgents={[{agent_id:'manager',retained_thread:true},{agent_id:'worker',retained_thread:true}]} detail={detail} onSaved={saved}/>)
 if(join){fireEvent.click(screen.getByRole('button',{name:'Add Agent from Room'}));fireEvent.click(screen.getByRole('button',{name:'Worker'}))}
 else fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0])
 fireEvent.click(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1].participant_changes).toEqual([{agent_id:'worker',participating:join}])
})
it('ignores a late failed refresh from the old permission scope after a successful write',async()=>{
 let finish!: (value:boolean)=>void
 const saved=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve}))
 vi.mocked(sessionsApi.initializeExecution).mockResolvedValue({} as never)
 const panel=(role:string)=><ConversationScope actionRole={role}><ConversationParticipantsEditor summary={summary} profiles={profiles} detail={detail} onSaved={saved}/></ConversationScope>
 const view=render(panel('member'))
 fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0]);fireEvent.click(screen.getByRole('button',{name:/^(Add to conversation|Confirm removal)$/}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 view.rerender(panel('viewer'))
 await act(async()=>finish(false))
 expect(screen.queryByRole('alert')).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'Add Agent from Room'})).toBeDisabled()
})
