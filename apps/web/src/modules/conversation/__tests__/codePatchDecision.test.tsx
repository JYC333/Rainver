import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi} from 'vitest'
const api=vi.hoisted(()=>({get:vi.fn(),accept:vi.fn()}))
vi.mock('../../../api/client',()=>({proposalsApi:api}))
vi.mock('../../../core/spaceNav',async()=>({SpaceLink:(await import('react-router-dom')).Link}))
import {ActionPreviewCards} from '../ActionPreviewCard'
import {ConversationScope} from '../ConversationScope'
it('holds Room continuation until the user reads a completed canonical file receipt',async()=>{
 api.get.mockResolvedValue({id:'patch',status:'pending'})
 api.accept.mockResolvedValue({proposal:{id:'patch',status:'pending'},result_type:'code_patch_pending',result:{status:'pending'}})
 const next=vi.fn()
 render(<MemoryRouter><ConversationScope spaceId="space-1"><ActionPreviewCards previews={[{action_id:'patch',proposal_id:'patch',proposal_type:'code_patch',status:'proposed',title:'Update reviewed file'}]} viewerUserId="owner" onDecision={next}/></ConversationScope></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'Accept'}))
 expect(await screen.findByRole('button',{name:'Refresh decision'})).toBeInTheDocument()
 expect(next).not.toHaveBeenCalled()
 expect(screen.queryByRole('button',{name:'Accept'})).toBeNull()
 api.get.mockResolvedValue({id:'patch',status:'accepted',code_patch_decision:{status:'succeeded'}})
 fireEvent.click(screen.getByRole('button',{name:'Refresh decision'}))
 const proceed=await screen.findByRole('button',{name:/Continue/})
 expect(next).not.toHaveBeenCalled()
 fireEvent.click(proceed)
 await waitFor(()=>expect(next).toHaveBeenCalledTimes(1))
 expect(api.accept).toHaveBeenCalledTimes(1)
})
