import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activityApi } from '../../../api/client'
import CapturePage from '../CapturePage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ personalSpaceId: 'personal-1' }) }))
vi.mock('../../../api/client', () => ({ activityApi: { create: vi.fn(), upload: vi.fn() } }))

const track = { stop: vi.fn() }
const recorders: Array<{ stop: ReturnType<typeof vi.fn>; state: string }> = []

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

  it('releases the microphone when the recorder cannot be created', async () => {
    stubRecorder(() => { throw new Error('unsupported mime type') })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Record voice/ }))

    await waitFor(() => expect(track.stop).toHaveBeenCalled())
  })
})
