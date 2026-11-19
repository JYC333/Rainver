import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {roomsApi} from '../../api/client'
import i18n from '../../i18n'
import {ConversationCollaborationLine} from './ConversationCollaborationLine'

vi.mock('../../api/client',()=>({roomsApi:{collaboration:vi.fn(),setCollaborationStatus:vi.fn()}}))
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}))
const view=(over:Record<string,unknown>={})=>({invalid:false,collaboration:{group_id:'group',group_status:'active',task_id:'task',task_title:'Ship reminders',task_status:'in_progress',
 delegations_used:130,turns_used:260,next_reminder_at:200,participant_agent_ids:['codex','antigravity'],active:true,stop_reason:null,can_manage:true,...over}})
const scope={spaceId:'space'}
beforeEach(async()=>{vi.clearAllMocks();await i18n.changeLanguage('en')})

const details=async()=>fireEvent.click(await screen.findByTestId('conversation-collaboration-toggle'))

it('keeps a normal collaboration to one small entry whose details and controls open on demand',async()=>{
 vi.mocked(roomsApi.collaboration).mockResolvedValue(view() as never)
 render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]}/>)
 const toggle=await screen.findByTestId('conversation-collaboration-toggle')
 expect(toggle).toHaveAttribute('aria-expanded','false')
 expect(screen.getByTestId('conversation-collaboration-status')).toHaveTextContent('running')
 expect(screen.queryByText('130 handoffs')).not.toBeInTheDocument()
 expect(screen.getAllByRole('button')).toEqual([toggle])
 fireEvent.click(toggle)
 expect(toggle).toHaveAttribute('aria-expanded','true')
 expect(screen.getByText('130 handoffs')).toBeVisible()
 expect(screen.getByText('· 260 Agent turns')).toBeVisible()
 expect(screen.getByText('· next reminder at 200, no total limit')).toBeVisible()
 expect(screen.getByText('Ship reminders')).toBeVisible()
 const line=screen.getByTestId('conversation-collaboration-line').textContent ?? ''
 expect(line).not.toMatch(/limit \d+|Remove limit|reminder mode|confirm/i)
 expect(screen.getAllByRole('button').slice(1).map(b=>b.textContent)).toEqual(['Pause','Stop'])
 // Closing the details withdraws a stop confirmation opened from them.
 fireEvent.click(screen.getByRole('button',{name:'Stop'}))
 expect(screen.getByRole('button',{name:'Confirm'})).toBeVisible()
 fireEvent.click(toggle)
 expect(screen.queryByRole('button',{name:'Confirm'})).not.toBeInTheDocument()
 expect(screen.queryByTestId('conversation-collaboration-details')).not.toBeInTheDocument()
})

it('shows a pause or a real admission stop with its reason and available actions without opening',async()=>{
 vi.mocked(roomsApi.collaboration).mockResolvedValue(view({group_status:'paused',active:false,stop_reason:'paused'}) as never)
 const {unmount}=render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]}/>)
 expect(await screen.findByRole('status')).toHaveTextContent('paused')
 expect(screen.getByRole('button',{name:'Resume'})).toBeVisible()
 expect(screen.getByRole('button',{name:'Stop'})).toBeVisible()
 expect(screen.queryByTestId('conversation-collaboration-details')).not.toBeInTheDocument()
 unmount()
 vi.mocked(roomsApi.collaboration).mockResolvedValue(view({active:false,stop_reason:'repeated_failures'}) as never)
 render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]}/>)
 expect(await screen.findByRole('status')).toHaveTextContent('not admitting new handoffs (three handoffs in a row without a result)')
 expect(screen.getByRole('button',{name:'Pause'})).toBeVisible()
 expect(screen.getByRole('button',{name:'Stop'})).toBeVisible()
})

it('folds an ended collaboration into an entry with details on demand and no controls',async()=>{
 vi.mocked(roomsApi.collaboration).mockResolvedValue(view({group_status:'succeeded'}) as never)
 render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]}/>)
 expect(await screen.findByTestId('conversation-collaboration-status')).toHaveTextContent('finished')
 expect(screen.queryByText('130 handoffs')).not.toBeInTheDocument()
 await details()
 expect(screen.getByText('130 handoffs')).toBeVisible()
 expect(screen.getAllByRole('button')).toHaveLength(1)
})

it('pauses, resumes and stops through the group status command, stop only after confirmation',async()=>{
 vi.mocked(roomsApi.collaboration).mockResolvedValueOnce(view() as never)
  .mockResolvedValueOnce(view({group_status:'paused',active:false,stop_reason:'paused'}) as never)
  .mockResolvedValue(view() as never)
 vi.mocked(roomsApi.setCollaborationStatus).mockResolvedValue({} as never)
 render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]}/>)
 await details()
 fireEvent.click(await screen.findByRole('button',{name:'Pause'}))
 await waitFor(()=>expect(roomsApi.setCollaborationStatus).toHaveBeenCalledWith('group','paused',expect.any(String),scope))
 // Paused shows Resume without opening anything.
 fireEvent.click(await screen.findByRole('button',{name:'Resume'}))
 await waitFor(()=>expect(roomsApi.setCollaborationStatus).toHaveBeenCalledWith('group','active',expect.any(String),scope))
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Resume'})).not.toBeInTheDocument())
 await details()
 fireEvent.click(await screen.findByRole('button',{name:'Stop'}))
 expect(roomsApi.setCollaborationStatus).toHaveBeenCalledTimes(2)
 fireEvent.click(screen.getByRole('button',{name:'Confirm'}))
 await waitFor(()=>expect(roomsApi.setCollaborationStatus).toHaveBeenCalledWith('group','cancelled',expect.any(String),scope))
 // A successful command reads the server state again.
 await waitFor(()=>expect(roomsApi.collaboration).toHaveBeenCalledTimes(4))
})

it('shows a closed, unreadable record instead of hiding it, and nothing for a non-manager',async()=>{
 vi.mocked(roomsApi.collaboration).mockResolvedValue({invalid:true,collaboration:null} as never)
 const {unmount}=render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]}/>)
 expect(await screen.findByRole('status')).toHaveTextContent('cannot be read')
 unmount()
 vi.mocked(roomsApi.collaboration).mockResolvedValue({invalid:false,collaboration:null} as never)
 render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]}/>)
 await waitFor(()=>expect(roomsApi.collaboration).toHaveBeenCalledTimes(2))
 expect(screen.queryByTestId('conversation-collaboration-line')).not.toBeInTheDocument()
})

it('shows state without any control on a read-only surface, with the reason translated',async()=>{
 await i18n.changeLanguage('zh-CN')
 vi.mocked(roomsApi.collaboration).mockResolvedValue(view({active:false,stop_reason:'task_unavailable',task_title:null}) as never)
 render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]} readOnly/>)
 expect(await screen.findByTestId('conversation-collaboration-status')).toHaveTextContent('暂不接受新的交接（此处无法查看该 Task）'.replace('（',' (').replace('）',')'))
 // Only the details entry is a button; it opens state, never a control.
 await details()
 expect(screen.getByText('· 下次在第 200 次交接时提醒，不设总次数上限')).toBeVisible()
 expect(screen.getAllByRole('button')).toEqual([screen.getByTestId('conversation-collaboration-toggle')])
})

it('opens a normal collaboration on a read-only surface without pause or stop',async()=>{
 vi.mocked(roomsApi.collaboration).mockResolvedValue(view() as never)
 render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]} readOnly/>)
 await details()
 expect(screen.getByText('130 handoffs')).toBeVisible()
 expect(screen.getAllByRole('button')).toHaveLength(1)
})

it('discards an open confirmation when the surface becomes read-only or the viewer loses the right to manage',async()=>{
 vi.mocked(roomsApi.collaboration).mockResolvedValue(view() as never)
 const {rerender}=render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[0]}/>)
 await details()
 fireEvent.click(await screen.findByRole('button',{name:'Stop'}))
 expect(screen.getByRole('button',{name:'Confirm'})).toBeVisible()
 rerender(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[0]} readOnly/>)
 const controls=()=>screen.getAllByRole('button').filter(b=>b.dataset.testid!=='conversation-collaboration-toggle')
 expect(controls()).toEqual([])
 // Becoming writable again does not bring the old intent back.
 rerender(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[0]}/>)
 expect(await screen.findByRole('button',{name:'Stop'})).toBeVisible()
 expect(screen.queryByRole('button',{name:'Confirm'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Stop'}))
 vi.mocked(roomsApi.collaboration).mockResolvedValue(view({can_manage:false}) as never)
 rerender(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[1]}/>)
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Confirm'})).not.toBeInTheDocument())
 expect(controls()).toEqual([])
 expect(roomsApi.setCollaborationStatus).not.toHaveBeenCalled()
})

it('never carries a stop confirmation to another conversation or collaboration',async()=>{
 const first=view({delegations_used:3,next_reminder_at:25})
 const other=view({group_id:'other-group',task_id:'other-task',delegations_used:1,next_reminder_at:25})
 vi.mocked(roomsApi.collaboration).mockImplementation(async(_room,conv)=>(conv==='conv'?first:other) as never)
 const {rerender}=render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[0]}/>)
 await details()
 fireEvent.click(await screen.findByRole('button',{name:'Stop'}))
 expect(screen.getByRole('button',{name:'Confirm'})).toBeVisible()
 rerender(<ConversationCollaborationLine roomId="room" conversationId="conv-2" scope={scope} changeSignals={[0]}/>)
 // Opened details do not follow to the other conversation either.
 await waitFor(()=>expect(screen.getByTestId('conversation-collaboration-toggle')).toHaveAttribute('aria-expanded','false'))
 expect(screen.queryByRole('button',{name:'Confirm'})).not.toBeInTheDocument()
 await details()
 expect(await screen.findByText('1 handoffs')).toBeVisible()
 // Back on the first conversation the old intent is gone too.
 rerender(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[0]}/>)
 await details()
 expect(await screen.findByText('3 handoffs')).toBeVisible()
 expect(screen.queryByRole('button',{name:'Confirm'})).not.toBeInTheDocument()
 // The same conversation's collaboration replaced by a new declaration discards it as well.
 fireEvent.click(screen.getByRole('button',{name:'Stop'}))
 vi.mocked(roomsApi.collaboration).mockResolvedValue({...first,collaboration:{...first.collaboration,group_id:'next-group',task_id:'next-task'}} as never)
 rerender(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[1]}/>)
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Confirm'})).not.toBeInTheDocument())
 expect(roomsApi.setCollaborationStatus).not.toHaveBeenCalled()
})

it('lets a late response from an old scope change nothing in the new one',async()=>{
 const first=view({delegations_used:3,next_reminder_at:25})
 const other=view({group_id:'other-group',task_id:'other-task',delegations_used:1,next_reminder_at:25})
 vi.mocked(roomsApi.collaboration).mockImplementation(async(_room,conv)=>(conv==='conv'?first:other) as never)
 let settle:(value:unknown)=>void=()=>{}
 vi.mocked(roomsApi.setCollaborationStatus).mockReturnValue(new Promise(resolve=>{settle=resolve}) as never)
 const {toast}=await import('sonner')
 const {rerender}=render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]}/>)
 await details()
 fireEvent.click(await screen.findByRole('button',{name:'Pause'}))
 expect(roomsApi.setCollaborationStatus).toHaveBeenCalledWith('group','paused',expect.any(String),scope)
 rerender(<ConversationCollaborationLine roomId="room" conversationId="conv-2" scope={{spaceId:'space-2'}} changeSignals={[]}/>)
 await waitFor(()=>expect(screen.getByTestId('conversation-collaboration-toggle')).toHaveAttribute('aria-expanded','false'))
 await details()
 expect(await screen.findByText('1 handoffs')).toBeVisible()
 // The new scope's controls are not held by the old request.
 expect(screen.getByRole('button',{name:'Pause'})).toBeEnabled()
 const reads=vi.mocked(roomsApi.collaboration).mock.calls.length
 settle({})
 await waitFor(()=>expect(roomsApi.setCollaborationStatus).toHaveBeenCalledTimes(1))
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(toast.success).not.toHaveBeenCalled()
 expect(vi.mocked(roomsApi.collaboration).mock.calls.length).toBe(reads)
 expect(screen.getByText('1 handoffs')).toBeVisible()
})

it('names a failed collaboration as stopped, not waiting',async()=>{
 vi.mocked(roomsApi.collaboration).mockResolvedValue(view({group_status:'failed',active:false,stop_reason:'stopped'}) as never)
 render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]}/>)
 expect(await screen.findByTestId('conversation-collaboration-status')).toHaveTextContent('stopped')
 expect(screen.getByTestId('conversation-collaboration-line')).toHaveAttribute('data-phase','ended')
 expect(screen.getAllByRole('button')).toEqual([screen.getByTestId('conversation-collaboration-toggle')])
})

it('withdraws a normal stop confirmation when the collaboration is paused elsewhere', async () => {
  vi.mocked(roomsApi.collaboration).mockResolvedValue(view() as never)
  const { rerender } = render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[0]} />)
  await details()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeVisible()

  vi.mocked(roomsApi.collaboration).mockResolvedValue(view({ group_status: 'paused', active: false, stop_reason: 'paused' }) as never)
  rerender(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[2]} />)
  await screen.findByRole('button', { name: 'Resume' })
  expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeVisible()
})

it('suppresses late status feedback and reload after the conversation unmounts', async () => {
  vi.mocked(roomsApi.collaboration).mockResolvedValue(view() as never)
  let settle: (value: unknown) => void = () => {}
  vi.mocked(roomsApi.setCollaborationStatus).mockReturnValue(new Promise(resolve => { settle = resolve }) as never)
  const { toast } = await import('sonner')
  const { unmount } = render(<ConversationCollaborationLine roomId="room" conversationId="conv" scope={scope} changeSignals={[]} />)
  await details()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(roomsApi.setCollaborationStatus).toHaveBeenCalledOnce()
  unmount()
  const reads = vi.mocked(roomsApi.collaboration).mock.calls.length
  settle({})
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(toast.success).not.toHaveBeenCalled()
  expect(roomsApi.collaboration).toHaveBeenCalledTimes(reads)
})
