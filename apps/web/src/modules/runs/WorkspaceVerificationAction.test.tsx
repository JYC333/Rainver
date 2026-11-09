import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {WorkspaceVerificationAction} from './WorkspaceVerificationAction'
import {ConversationScope} from '../conversation/ConversationScope'
import {roomsApi,agentsApi,queryOperation} from '../../api/client'
import i18n from '../../i18n'
vi.mock('../../api/client',()=>({queryOperation:vi.fn(),roomsApi:{sendMessage:vi.fn()},agentsApi:{chat:vi.fn()}}))
const state={integration_id:'integration',change_set_id:'change',project_id:'project',folder_id:'folder',folder_name:'Code',config_version:null,test_commands:[],build_commands:[],validation_recipe_id:null,integration_revision:9,can_retry:true,integration_status:'verification_failed',conversation_id:'conversation',room_id:'room',agent_id:'agent',source_commit:'a'.repeat(40)}
beforeEach(async()=>{vi.clearAllMocks();await i18n.changeLanguage('en');vi.mocked(queryOperation).mockResolvedValue({status:'succeeded',data:state} as never);vi.mocked(roomsApi.sendMessage).mockResolvedValue({status:'succeeded',data:{}} as never)})
it('hands the saved integration to the Agent with one action and no command or ID form',async()=>{
 const retried=vi.fn();render(<ConversationScope spaceId="source"><WorkspaceVerificationAction integrationId="integration" onRetried={retried}/></ConversationScope>)
 expect(screen.queryByRole('textbox')).not.toBeInTheDocument();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(roomsApi.sendMessage).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'Let Agent verify and integrate'}))
 expect(await screen.findByRole('status')).toHaveTextContent('original conversation')
 expect(queryOperation).toHaveBeenCalledWith('workspace.integration.verification.get',{integration_id:'integration'},expect.objectContaining({spaceId:'source'}))
 expect(roomsApi.sendMessage).toHaveBeenCalledWith('room','conversation',expect.objectContaining({recipient_segments:[{recipient_agent_ids:['agent'],content:expect.stringContaining('before replying')}]}),expect.objectContaining({spaceId:'source',idempotencyKey:expect.any(String)}))
 expect(retried).toHaveBeenCalledOnce();expect(screen.queryByText(/integrated into dev/)).not.toBeInTheDocument()
})
it('replays the same command after an ambiguous response without requiring configuration',async()=>{
 vi.mocked(roomsApi.sendMessage).mockRejectedValueOnce(new Error('connection lost'))
 render(<WorkspaceVerificationAction integrationId="integration"/>)
 fireEvent.click(screen.getByRole('button'));expect(await screen.findByRole('alert')).toHaveTextContent('connection lost')
 fireEvent.click(screen.getByRole('button'));await screen.findByRole('status')
 const calls=vi.mocked(roomsApi.sendMessage).mock.calls;expect(calls).toHaveLength(2);expect(calls[0]?.[3]?.idempotencyKey).toBe(calls[1]?.[3]?.idempotencyKey);expect(queryOperation).toHaveBeenCalledOnce()
})
it('follows already-running integration without enqueuing a duplicate',async()=>{
 vi.mocked(queryOperation).mockResolvedValue({status:'succeeded',data:{...state,can_retry:false,integration_status:'resolving'}} as never)
 render(<WorkspaceVerificationAction integrationId="integration"/>);fireEvent.click(screen.getByRole('button'))
 expect(await screen.findByRole('status')).toHaveTextContent('current task is processing');expect(roomsApi.sendMessage).not.toHaveBeenCalled()
})
it('ignores a response after switching to another integration',async()=>{
 let resolve!:(value:never)=>void;vi.mocked(queryOperation).mockReturnValueOnce(new Promise(r=>{resolve=r}))
 const view=render(<WorkspaceVerificationAction integrationId="old"/>);fireEvent.click(screen.getByRole('button'))
 view.rerender(<WorkspaceVerificationAction integrationId="new"/>);resolve({status:'succeeded',data:state} as never)
 await waitFor(()=>expect(screen.getByRole('button')).toBeEnabled());expect(roomsApi.sendMessage).not.toHaveBeenCalled();expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('does not claim processing when a blocked record cannot actually retry',async()=>{
 vi.mocked(queryOperation).mockResolvedValue({status:'succeeded',data:{...state,can_retry:false}} as never)
 render(<WorkspaceVerificationAction integrationId="integration"/>);fireEvent.click(screen.getByRole('button'))
 expect(await screen.findByRole('alert')).toHaveTextContent('cannot currently restart');expect(screen.queryByRole('status')).not.toBeInTheDocument();expect(roomsApi.sendMessage).not.toHaveBeenCalled()
})
it('recognizes an already integrated result without claiming to have started work',async()=>{
 vi.mocked(queryOperation).mockResolvedValue({status:'succeeded',data:{...state,can_retry:false,integration_status:'merged'}} as never)
 render(<WorkspaceVerificationAction integrationId="integration"/>);fireEvent.click(screen.getByRole('button'))
 expect(await screen.findByRole('status')).toHaveTextContent('already integrated');expect(roomsApi.sendMessage).not.toHaveBeenCalled()
})

it('uses the normal direct-chat ingress for an original direct conversation',async()=>{
 vi.mocked(queryOperation).mockResolvedValue({status:'succeeded',data:{...state,room_id:null}} as never)
 vi.mocked(agentsApi.chat).mockImplementation(async(_agent,_body,options)=>{options?.onAccepted?.({session_id:'conversation'} as never);return {} as never})
 render(<WorkspaceVerificationAction integrationId="integration"/>);fireEvent.click(screen.getByRole('button'))
 expect(await screen.findByRole('status')).toHaveTextContent('original conversation');expect(roomsApi.sendMessage).not.toHaveBeenCalled();expect(agentsApi.chat).toHaveBeenCalledWith('agent',expect.objectContaining({session_id:'conversation',message:expect.stringContaining('before replying')}),expect.objectContaining({idempotencyKey:expect.any(String)}))
})
it('uses the current workspace query to continue an open native batch through the ordinary conversation',async()=>{
 render(<WorkspaceVerificationAction changeSetId="native-change"/>);fireEvent.click(screen.getByRole('button'));
 expect(await screen.findByRole('status')).toHaveTextContent('original conversation');
 expect(queryOperation).toHaveBeenCalledWith('workspace.change.get',{change_set_id:'native-change'},expect.any(Object));expect(roomsApi.sendMessage).toHaveBeenCalledOnce();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
