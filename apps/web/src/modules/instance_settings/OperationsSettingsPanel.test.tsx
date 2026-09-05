import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { instanceOperationsApi } from '../../api/client'
import { OperationsSettingsPanel } from './OperationsSettingsPanel'

vi.mock('../../api/client', () => ({
  instanceOperationsApi: { get: vi.fn(), update: vi.fn() },
}))

const settings = {
  backup_service_enabled: true,
  backup_interval_hours: 24,
  backup_retention_count: 7,
  backup_include_logs: false,
  backup_on_startup: true,
  content_access_log_retention_enabled: true,
  content_access_log_retention_days: 90,
  updated_at: null,
}

describe('OperationsSettingsPanel', () => {
  beforeEach(() => {
    vi.mocked(instanceOperationsApi.get).mockResolvedValue(settings)
    vi.mocked(instanceOperationsApi.update).mockResolvedValue({ ...settings, backup_interval_hours: 12 })
  })

  it('loads and saves instance backup and access-log policy', async () => {
    const user = userEvent.setup({ delay: null })
    render(<OperationsSettingsPanel />)

    const interval = await screen.findByLabelText('Interval (hours)')
    await user.clear(interval)
    await user.type(interval, '12')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(instanceOperationsApi.update).toHaveBeenCalledWith(expect.objectContaining({
        backup_interval_hours: 12,
        backup_retention_count: 7,
        content_access_log_retention_days: 90,
      })))
  })
})
