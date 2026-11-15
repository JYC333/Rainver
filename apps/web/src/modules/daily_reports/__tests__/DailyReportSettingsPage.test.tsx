import {MemoryRouter} from 'react-router-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DailyReportSettingsPage from '../DailyReportSettingsPage'
import { dailyReportApi } from '../../../api/client'
import type { DailyCaptureReportSettingOut } from '../../../types/api'

vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'space-1',preferredSpaceId:'space-1'})}))

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
    // Let initial settings and the schedule synchronization effect settle
    // before editing; otherwise that effect can clear this edit under load.
    await act(async () => { render(<DailyReportSettingsPage />) })

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

it('shows the accepted report intent with its Run link while the provider works asynchronously',async()=>{
 vi.mocked(dailyReportApi.getSettings).mockResolvedValue(setting);
 vi.mocked(dailyReportApi.listReports).mockResolvedValue([]);
 vi.mocked(dailyReportApi.run).mockResolvedValue({job_id:'job',run_id:'run',user_id:'person',status:'queued'});
 await act(async()=>{render(<MemoryRouter><DailyReportSettingsPage /></MemoryRouter>)});
 fireEvent.click(await screen.findByRole('button',{name:'Generate now'}));
 expect(await screen.findByText('Report queued. View the run for its result.')).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'View run'})).toHaveAttribute('href','/spaces/space-1/runs/run');
 expect(screen.queryByText('View artifact')).not.toBeInTheDocument();
});

it.each(['running','completed'] as const)('shows an existing %s report truthfully and keeps the Run link',async status=>{
 vi.mocked(dailyReportApi.run).mockResolvedValue({job_id:'job',run_id:'run',user_id:'person',status});
 await act(async()=>{render(<MemoryRouter><DailyReportSettingsPage /></MemoryRouter>)});
 fireEvent.click(await screen.findByRole('button',{name:'Generate now'}));
 expect(await screen.findByText(status==='completed'?'Report already completed. View the run for its result.':'Report running. View the run for its result.')).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'View run'})).toHaveAttribute('href','/spaces/space-1/runs/run');
});
