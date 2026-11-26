import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,expect,it,vi} from 'vitest'
const api=vi.hoisted(()=>({get:vi.fn(),accept:vi.fn(),reject:vi.fn()}))
vi.mock('../../../api/client',()=>({proposalsApi:api}))
vi.mock('../../../core/spaceNav',async()=>({SpaceLink:(await import('react-router-dom')).Link}))
import {ActionPreviewCards} from '../ActionPreviewCard'
import {ConversationScope} from '../ConversationScope'

const card=(next:()=>Promise<void>)=>render(<MemoryRouter><ConversationScope spaceId="space-1"><ActionPreviewCards previews={[{action_id:'plugin.phd_application.application.propose_status',proposal_id:'p',proposal_type:'plugin_proposal',status:'proposed',title:'Mark submitted'}]} viewerUserId="owner" onDecision={next}/></ConversationScope></MemoryRouter>)
beforeEach(()=>{vi.resetAllMocks()})

it.each([
 ['operation_approval_superseded','superseded','Duplicate · merged','Not applied: this request changed after the proposal was made'],
 ['operation_approval_expired','pending','Expired · not applied','Not applied: this proposal expired before it was approved'],
])('an accept decided as %s shows the actual state and never continues',async(code,status,label,message)=>{
 api.get.mockResolvedValue({id:'p',status:'pending',expired:false})
 api.accept.mockResolvedValue({proposal:{id:'p',status,expired:status==='pending'},result_type:'operation_failure',result:{error:{code,request_id:'r'}}})
 const next=vi.fn(async()=>{})
 card(next)
 fireEvent.click(await screen.findByRole('button',{name:'Accept'}))
 expect(await screen.findByText(new RegExp(message))).toBeInTheDocument()
 expect(screen.getByText(label)).toBeInTheDocument()
 expect(screen.queryByText('Accepted')).toBeNull()
 expect(screen.queryByRole('button',{name:/Continue/})).toBeNull()
 expect(screen.queryByRole('button',{name:'Accept'})).toBeNull()
 expect(next).not.toHaveBeenCalled()
})

it('an expired Proposal offers no decision; a refused reject shows the live state instead of stale buttons',async()=>{
 api.get.mockResolvedValue({id:'p',status:'pending',expired:true})
 const next=vi.fn(async()=>{})
 const view=card(next)
 expect(await screen.findByText('Expired · not applied')).toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'Accept'})).toBeNull()
 expect(screen.queryByRole('button',{name:'Reject'})).toBeNull()
 view.unmount()
 // Expiry found only by the decision: the 404 leads to the live state, not to a continuation.
 api.get.mockResolvedValueOnce({id:'p',status:'pending',expired:false}).mockResolvedValue({id:'p',status:'pending',expired:true})
 api.reject.mockRejectedValue(new Error('Proposal not found'))
 card(next)
 fireEvent.click(await screen.findByRole('button',{name:'Reject'}))
 expect(await screen.findByText('Expired · not applied')).toBeInTheDocument()
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Reject'})).toBeNull())
 expect(next).not.toHaveBeenCalled()
})
