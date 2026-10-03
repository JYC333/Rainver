import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DailyReportSettingsPage from '../DailyReportSettingsPage'
import { dailyReportApi } from '../../../api/client'
import type { DailyCaptureReportSettingOut } from '../../../types/api'

vi.mock('../../../api/client', () => ({
  dailyReportApi: { getSettings: vi.fn(), listReports: vi.fn(), updateSettings: vi.fn(), run: vi.fn() },
}))

const setting = {
  id: 'setting-1', space_id: 'space-1', user_id: 'user-1', enabled: false, local_time: '09:00', timezone: 'UTC',
  include_source_types: [], create_experience_proposals: false, create_memory_proposals: false,
  experience_confidence_threshold: 0.8, memory_confidence_threshold: 0.8,
  max_experience_proposals_per_day: 3, max_memory_proposals_per_day: 3, last_report_date: null,
} as unknown as DailyCaptureReportSettingOut

describe('DailyReportSettingsPage schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(dailyReportApi.getSettings).mockResolvedValue(setting)
    vi.mocked(dailyReportApi.listReports).mockResolvedValue([])
  })

  it('keeps a schedule the server refused unsaved, and clears the error once a save succeeds', async () => {
    vi.mocked(dailyReportApi.updateSettings)
      .mockRejectedValueOnce(new Error('400 invalid timezone'))
      .mockResolvedValueOnce({ ...setting, timezone: 'Asia/Shanghai' })
    render(<DailyReportSettingsPage />)

    fireEvent.change(await screen.findByDisplayValue('UTC'), { target: { value: 'Asia/Shanghaii' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('400 invalid timezone')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('Asia/Shanghaii'), { target: { value: 'Asia/Shanghai' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Schedule saved.')).toBeInTheDocument()
    expect(screen.queryByText('400 invalid timezone')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})
