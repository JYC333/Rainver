import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {ROOM_OPERATION_SCHEMAS} from '@rainver/protocol'
import {roomsApi} from '../../api/client'
import type {RoomDetail} from '../../types/api'
import {RoomConversationDefaults} from './RoomConversationDefaults'
vi.mock('../../api/client',()=>({roomsApi:{conversationDefaults:vi.fn(),saveConversationDefaults:vi.fn()}}))
const model=(value:string)=>[{id:'model',type:'select' as const,category:'model',value}]
const x={agent_id:'x',participating:true,runtime_profile_id:'profile-x',session_config:model('withdrawn')}
const y={agent_id:'y',participating:true,runtime_profile_id:'profile-y',session_config:model('a')}
const detail={room:{id:'room',space_id:'space'},viewer_can_write:true,agent_members:[{agent_id:'x',agent_name:'X',role:'manager'},{agent_id:'y',agent_name:'Y',role:'member'}]} as RoomDetail
beforeEach(()=>vi.resetAllMocks())
it.each(['foreign Host','offline Host','missing profile','withdrawn model'])('submits only the edited Y model while X has a %s, then can clear Y explicitly',async reason=>{
 vi.mocked(roomsApi.conversationDefaults).mockResolvedValue({revision:7,defaults:[x,y],agents:[{agent_id:'x',options:reason==='missing profile'?[]:[{runtime_profile_id:'profile-x',usable:reason==='withdrawn model',reason}]},{agent_id:'y',options:[{runtime_profile_id:'profile-y',name:'Y CLI',runtime_key:'claude_code',usable:true,session_config_options:[{id:'model',name:'Model',type:'select',category:'model',current_value:'a',options:[{value:'a'},{value:'b'}]}]}]}]} as never)
 const saved=vi.fn().mockResolvedValue(undefined)
 vi.mocked(roomsApi.saveConversationDefaults).mockImplementation(async(room,defaults,revision)=>{
  ROOM_OPERATION_SCHEMAS['room.defaults.save'].input.parse({room_id:room,defaults,expected_revision:revision})
  expect(defaults.some(item=>item.agent_id==='x')).toBe(false)
 })
 render(<RoomConversationDefaults detail={detail} onChanged={saved}/>)
 fireEvent.click(screen.getByRole('button',{name:'Edit defaults'}))
 fireEvent.click(await screen.findByRole('button',{name:'Model'}))
 fireEvent.click(screen.getByRole('option',{name:'b'}))
 fireEvent.click(screen.getByRole('button',{name:'Save Room defaults'}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 expect(roomsApi.saveConversationDefaults).toHaveBeenLastCalledWith('room',[{...y,session_config:model('b')}],7,{spaceId:'space'})
 fireEvent.click(screen.getByRole('button',{name:'Edit defaults'}))
 fireEvent.click(await screen.findByRole('button',{name:'Y'}))
 fireEvent.click(screen.getByRole('option',{name:'Choose when initializing'}))
 fireEvent.click(screen.getByRole('button',{name:'Save Room defaults'}))
 await waitFor(()=>expect(saved).toHaveBeenCalledTimes(2))
 expect(roomsApi.saveConversationDefaults).toHaveBeenLastCalledWith('room',[{...y,runtime_profile_id:null,session_config:[]}],7,{spaceId:'space'})
})
