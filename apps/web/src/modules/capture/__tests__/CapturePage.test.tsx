import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {toast} from 'sonner'
import { activityApi } from '../../../api/client'
import CapturePage from '../CapturePage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ personalSpaceId: 'personal-1' }) }))
vi.mock('../../../api/client', () => ({ activityApi: { create: vi.fn(), upload: vi.fn() } }))

const track = { stop: vi.fn() }
const recorders: Array<{ stop: () => void; ondataavailable: (event: { data: Blob }) => void }> = []

beforeEach(() => {
  recorders.length = 0
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function stubRecorder(construct: () => void = () => {}) {
  vi.stubGlobal('MediaRecorder', vi.fn(function (this: Record<string, unknown>) {
    construct()
    this.state = 'inactive'
    this.mimeType = 'audio/webm'
    this.start = vi.fn(() => { this.state = 'recording' })
    this.stop = vi.fn(() => {
      this.state = 'inactive'
      ;(this.onstop as (() => void) | null)?.()
    })
    recorders.push(this as never)
  }))
}

function renderPage() {
  return render(<MemoryRouter><CapturePage /></MemoryRouter>)
}

describe('CapturePage voice recording', () => {
  it.each([false, true])('only uploads a recording when Stop & save was used (%s)', async shouldSave => {
    stubRecorder()
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Record voice/ }))
    const save = await screen.findByRole('button', { name: /Stop & save/ })
    recorders[0]!.ondataavailable({ data: new Blob(['voice']) })
    if (shouldSave) fireEvent.click(save)
    else act(() => { recorders[0]!.stop() })

    if (shouldSave) {
      await waitFor(() => expect(activityApi.upload).toHaveBeenCalledWith(expect.any(File), { kind: 'voice', spaceId: 'personal-1' }))
    } else {
      expect(activityApi.upload).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith('Recording stopped before it was saved')
      expect(screen.getByRole('button', { name: /Record voice/ })).toBeEnabled()
    }
  })

  it('releases the microphone when the page is left mid-recording, saving nothing', async () => {
    stubRecorder()
    const view = renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Record voice/ }))
    await screen.findByText(/Recording/)

    view.unmount()

    expect(recorders[0]!.stop).toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalled()
    expect(activityApi.upload).not.toHaveBeenCalled()
  })

  it('releases late permission after leaving and requests it only once', async () => {
    stubRecorder()
    let grant!: (stream: MediaStream) => void
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(
      new Promise(resolve => { grant = resolve }),
    )
    const view = renderPage()
    const button = screen.getByRole('button', { name: /Record voice/ })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1)
    view.unmount()
    grant({ getTracks: () => [track] } as unknown as MediaStream)
    await waitFor(() => expect(track.stop).toHaveBeenCalledTimes(1))
    expect(recorders).toHaveLength(0)
    expect(activityApi.upload).not.toHaveBeenCalled()
  })

  it('releases the microphone when the recorder cannot be created', async () => {
    stubRecorder(() => { throw new Error('unsupported mime type') })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Record voice/ }))

    await waitFor(() => expect(track.stop).toHaveBeenCalled())
  })
})

it('describes an admitted upload as queued before opening the Activity Inbox',async()=>{
 const file=new File(['capture'],'notes.bin',{type:'application/octet-stream'});
 vi.mocked(activityApi.upload).mockResolvedValue({job_id:'job',activity_id:'activity',status:'queued'});
 const view=renderPage();
 fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[file]}});
 await waitFor(()=>expect(toast.success).toHaveBeenCalledWith('Upload queued for Activity Inbox'));
 expect(activityApi.upload).toHaveBeenCalledWith(file,{kind:'file',spaceId:'personal-1'});
});
