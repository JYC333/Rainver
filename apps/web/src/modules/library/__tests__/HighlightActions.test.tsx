import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import type { BriefingAdoptionPreview, BriefingAdoptionResult, BriefingFollowUpPreview } from '@rainver/protocol'
import { HighlightActions, type HighlightActionApi } from '../briefing/HighlightActions'
import { projectsApi, roomsApi } from '../../../api/client'
import { toast } from 'sonner'

const navigate = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../core/spaceNav', () => ({ useSpaceNavigate: () => navigate }))
vi.mock('../../../api/client', () => ({
  projectsApi: { mainlineRoom: vi.fn(), list: vi.fn() },
  roomsApi: { create: vi.fn(), attachReferences: vi.fn(), sendMessage: vi.fn() },
}))
const projects = vi.mocked(projectsApi)
const rooms = vi.mocked(roomsApi)

const followUp: BriefingFollowUpPreview = { briefing_id: 'b1', highlight: 2, scope_type: 'project', project_id: 'p1', title: 'Gripper launch', preview: 'Gripper launch — high importance\n[S1] Launch report' }
const adoption: BriefingAdoptionPreview = { briefing_id: 'b1', highlight: 2, project_id: 'p1', visibility: 'space_shared', title: 'Gripper launch', description: 'What changed: launched [S1]', preview_hash: 'h'.repeat(64), existing_task_id: null }
function scopedApi() {
  return {
    followUp: vi.fn<HighlightActionApi['followUp']>().mockResolvedValue(followUp),
    previewAdoption: vi.fn<HighlightActionApi['previewAdoption']>().mockResolvedValue(adoption),
    adopt: vi.fn<HighlightActionApi['adopt']>().mockResolvedValue({ created: true, task: { id: 't1', title: 'Gripper launch', project_id: 'p1' } }),
  }
}
const ui = (api: HighlightActionApi, scope: Parameters<typeof HighlightActions>[0]['scope'] = { type: 'project', projectId: 'p1' }, canAdopt = true) =>
  <MemoryRouter><HighlightActions briefingId="b1" index={2} scope={scope} api={api} canAdopt={canAdopt} /></MemoryRouter>

beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear() })

it('shows the exact follow-up text first, then only holds it for the Project Room draft — nothing is sent or attached', async () => {
  const api = scopedApi()
  projects.mainlineRoom.mockResolvedValue({ room: { id: 'room-main' } } as never)
  render(ui(api))
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }))
  expect(await screen.findByTestId('follow-up-preview')).toHaveTextContent('[S1] Launch report')
  expect(api.followUp).toHaveBeenCalledWith('b1', 2)
  fireEvent.click(screen.getByRole('button', { name: 'Open draft' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/projects/p1/rooms?room=room-main&new=1&reference=1'))
  expect(JSON.parse(sessionStorage.getItem('rainver.reference.room.room-main')!)).toEqual([{ kind: 'briefing_highlight', id: 'b1', highlight: 2 }])
  expect(rooms.attachReferences).not.toHaveBeenCalled()
  expect(rooms.sendMessage).not.toHaveBeenCalled()
  expect(rooms.create).not.toHaveBeenCalled()
})

it('takes a personal highlight only to a private Room in the Project the reader chooses', async () => {
  const api = scopedApi()
  api.followUp.mockResolvedValue({ ...followUp, scope_type: 'personal', project_id: null })
  projects.list.mockResolvedValue({ items: [{ id: 'p1', name: 'Robotics' }, { id: 'p2', name: 'Warehouse' }] } as never)
  rooms.create.mockResolvedValue({ room: { id: 'room-mine' } } as never)
  render(ui(api, { type: 'personal' }, false))
  expect(screen.queryByRole('button', { name: 'Adopt as Task' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }))
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'p2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open draft' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/projects/p2/rooms?room=room-mine&new=1&reference=1'))
  expect(rooms.create).toHaveBeenCalledWith({ project_id: 'p2', title: 'Briefing follow-up', personal: true })
  expect(projects.mainlineRoom).not.toHaveBeenCalled()
})

it('creates a Task only on Confirm, bound to the previewed draft, and shows a refusal without losing the dialog', async () => {
  const api = scopedApi()
  api.adopt.mockRejectedValueOnce(new Error('This highlight changed since it was previewed; preview it again'))
  render(ui(api))
  fireEvent.click(screen.getByRole('button', { name: 'Adopt as Task' }))
  expect(await screen.findByTestId('adoption-preview')).toHaveTextContent('What changed: launched [S1]')
  expect(api.adopt).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This highlight changed since it was previewed; preview it again'))
  expect(screen.getByRole('button', { name: 'Create Task' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Task created')
  expect(api.adopt).toHaveBeenLastCalledWith('b1', 2, 'h'.repeat(64))
  fireEvent.click(screen.getByRole('button', { name: 'Open Task' }))
  expect(navigate).toHaveBeenCalledWith('/projects/p1/tasks/t1')
})

it('drops a preview that arrives after its dialog was dismissed or the component left', async () => {
  const api = scopedApi()
  let finish: ((value: BriefingFollowUpPreview) => void) | undefined
  api.followUp.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const rendered = render(ui(api))
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }))
  rendered.unmount()
  await act(async () => { finish?.(followUp) })
  expect(screen.queryByTestId('follow-up-preview')).not.toBeInTheDocument()
})

/** A request the test resolves by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const closeDialog = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

it('works under StrictMode: the replayed effect leaves the actions live', async () => {
  const api = scopedApi()
  render(<StrictMode>{ui(api)}</StrictMode>)
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }))
  expect(await screen.findByTestId('follow-up-preview')).toHaveTextContent('[S1] Launch report')
  expect(screen.getByRole('button', { name: 'Open draft' })).toBeEnabled()
})

it('releases the buttons when the dialog is closed mid-request, drops the late reply, and opens again', async () => {
  const api = scopedApi()
  const pending = deferred<BriefingAdoptionResult>()
  api.adopt.mockReturnValueOnce(pending.promise)
  render(<StrictMode>{ui(api)}</StrictMode>)
  fireEvent.click(screen.getByRole('button', { name: 'Adopt as Task' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Create Task' }))
  expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled()
  closeDialog()
  await waitFor(() => expect(screen.queryByTestId('adoption-preview')).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Adopt as Task' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Ask about this' })).toBeEnabled()
  await act(async () => { pending.resolve({ created: true, task: { id: 't1', title: 'Gripper launch', project_id: 'p1' } }) })
  expect(toast.success).not.toHaveBeenCalled()
  // Re-openable after the close, and again after a failure.
  api.previewAdoption.mockRejectedValueOnce(new Error('Refused'))
  fireEvent.click(screen.getByRole('button', { name: 'Adopt as Task' }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Refused'))
  expect(screen.getByRole('button', { name: 'Adopt as Task' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Adopt as Task' }))
  expect(await screen.findByTestId('adoption-preview')).toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('lets only the newest request release the buttons: an earlier one finishing late does not', async () => {
  const api = scopedApi()
  const first = deferred<BriefingAdoptionResult>()
  const second = deferred<BriefingAdoptionPreview>()
  api.adopt.mockReturnValueOnce(first.promise)
  render(ui(api))
  fireEvent.click(screen.getByRole('button', { name: 'Adopt as Task' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Create Task' }))
  closeDialog()
  await waitFor(() => expect(screen.queryByTestId('adoption-preview')).not.toBeInTheDocument())
  api.previewAdoption.mockReturnValueOnce(second.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Adopt as Task' }))
  expect(screen.getByRole('button', { name: 'Ask about this' })).toBeDisabled()
  await act(async () => { first.resolve({ created: true, task: { id: 't1', title: 'Gripper launch', project_id: 'p1' } }) })
  expect(screen.getByRole('button', { name: 'Ask about this' })).toBeDisabled()
  await act(async () => { second.resolve(adoption) })
  expect(await screen.findByTestId('adoption-preview')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Create Task' })).toBeEnabled()
})

it('belongs to one highlight: re-rendered for another, it drops the open preview and a pending reply, and acts on the new one', async () => {
  const api = scopedApi()
  const late = deferred<BriefingFollowUpPreview>()
  const at = (briefingId: string, index: number) =>
    <MemoryRouter><HighlightActions briefingId={briefingId} index={index} scope={{ type: 'project', projectId: 'p1' }} api={api} canAdopt /></MemoryRouter>
  const rendered = render(at('b1', 2))
  fireEvent.click(screen.getByRole('button', { name: 'Adopt as Task' }))
  expect(await screen.findByTestId('adoption-preview')).toBeInTheDocument()
  // Another highlight of the same briefing, in place: the old preview may not drive its adoption.
  rendered.rerender(at('b1', 3))
  await waitFor(() => expect(screen.queryByTestId('adoption-preview')).not.toBeInTheDocument())
  expect(api.adopt).not.toHaveBeenCalled()
  // A pending follow-up for one briefing lands after the switch to another: dropped.
  api.followUp.mockReturnValueOnce(late.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }))
  rendered.rerender(at('b2', 3))
  expect(screen.getByRole('button', { name: 'Ask about this' })).toBeEnabled()
  await act(async () => { late.resolve({ ...followUp, highlight: 3 }) })
  expect(screen.queryByTestId('follow-up-preview')).not.toBeInTheDocument()
  api.previewAdoption.mockResolvedValueOnce({ ...adoption, briefing_id: 'b2', highlight: 3, preview_hash: 'k'.repeat(64) })
  fireEvent.click(screen.getByRole('button', { name: 'Adopt as Task' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Create Task' }))
  await waitFor(() => expect(api.adopt).toHaveBeenCalledWith('b2', 3, 'k'.repeat(64)))
  expect(api.previewAdoption).toHaveBeenLastCalledWith('b2', 3)
})
