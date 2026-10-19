import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JobQueuePage from './JobQueuePage'
import i18n from '../../i18n'
import { formatDateTime } from '../../i18n/format'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))
vi.mock('../../api/client', () => ({
  jobsApi: {
    list: vi.fn(async () => ({
      total: 2,
      items: [
        { id: 'job-1', job_type: 'extract_text', status: 'failed', error: 'boom', attempts: 2, max_attempts: 3,
          created_at: '2026-07-25T08:00:00.000Z', started_at: '2026-07-25T08:00:00.000Z', completed_at: '2026-07-25T08:01:05.000Z', result: null },
        { id: 'job-2', job_type: 'connection_scan', status: 'completed', error: null, attempts: 1, max_attempts: 1,
          created_at: '2026-07-25T09:00:00.000Z', started_at: '2026-07-25T09:00:00.000Z', completed_at: '2026-07-25T09:00:00.400Z', result: null },
      ],
    })),
    events: vi.fn(async () => []),
    cancel: vi.fn(),
  },
}))

afterEach(async () => { await i18n.changeLanguage('en') })

describe('Job queue', () => {
  it('reads in English by default, with attempt counts and elapsed time', async () => {
    render(<JobQueuePage />)
    expect(await screen.findByText('attempt 2/3')).toBeInTheDocument()
    expect(screen.getByText('1m 5s')).toBeInTheDocument()
    expect(screen.getByText('400 ms')).toBeInTheDocument()
    expect(screen.getByText(formatDateTime('2026-07-25T08:00:00.000Z'))).toBeInTheDocument()
  })

  it('reads in Chinese, with retry counts, durations and dates in the Chinese locale', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<JobQueuePage />)
    expect(screen.getByRole('heading', { name: '任务队列' })).toBeInTheDocument()
    expect(await screen.findByText('第 2/3 次尝试')).toBeInTheDocument()
    expect(screen.getByText('1 分 5 秒')).toBeInTheDocument()
    expect(screen.getByText('全部任务 · 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已完成' })).toBeInTheDocument()
    expect(screen.getByText(formatDateTime('2026-07-25T08:00:00.000Z'))).toBeInTheDocument()
  })
})
