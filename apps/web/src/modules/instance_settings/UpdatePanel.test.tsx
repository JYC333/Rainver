import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deploymentApi } from '../../api/client'
import { UpdatePanel } from './UpdatePanel'
import type { DeploymentJob, DeploymentJobDetail, DeploymentStatus } from '../../types/api'

vi.mock('../../api/client', () => ({
  deploymentApi: { status: vi.fn(), createJob: vi.fn(), job: vi.fn(), cancelJob: vi.fn() },
}))

const observations: DeploymentStatus['observations'] = {
  services: [
    { service: 'server', image_ref: 'ghcr.io/x/rainver-server:stable', digest: 'sha256:1111aaaa2222bbbb', revision: 'abc1234def567890', surface: 'surface-1' },
    { service: 'deployer', image_ref: 'ghcr.io/x/rainver-deployer:stable', digest: 'sha256:dddd0000eeee1111', revision: 'abc1234def567890', surface: 'surface-1' },
  ],
  remote: { tag: 'stable', digest: 'sha256:9999cccc8888dddd', checked_at: '2026-09-07T10:00:00.000Z' },
  docker_version: '27.0.0',
  observed_at: '2026-09-07T10:00:30.000Z',
}

function job(overrides: Partial<DeploymentJob> = {}): DeploymentJob {
  return {
    id: 'job-1',
    job_type: 'update',
    status: 'running',
    requested_by_user_id: 'admin',
    requested_at: '2026-09-07T10:01:00.000Z',
    started_at: '2026-09-07T10:01:05.000Z',
    ended_at: null,
    current_stage: 'drain',
    failure_stage: null,
    error_text: null,
    target_tag: 'stable',
    drain_timeout_seconds: 600,
    result_json: {},
    last_progress_at: '2026-09-07T10:01:20.000Z',
    ...overrides,
  }
}

function detail(value: DeploymentJob, events: DeploymentJobDetail['events'] = []): DeploymentJobDetail {
  return { job: value, events }
}

function status(overrides: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    observations,
    update_available: false,
    updates_supported: true,
    deployer_online: true,
    deployer_behind: false,
    active_job: null,
    last_job: null,
    ...overrides,
  }
}

describe('UpdatePanel', () => {
  beforeEach(() => {
    vi.mocked(deploymentApi.status).mockResolvedValue(status())
    vi.mocked(deploymentApi.job).mockResolvedValue(detail(job()))
    vi.mocked(deploymentApi.createJob).mockResolvedValue(job({ status: 'queued' }))
    vi.mocked(deploymentApi.cancelJob).mockResolvedValue(job({ status: 'cancelled' }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('compares two digests, not a digest against a commit', async () => {
    render(<UpdatePanel />)

    expect(await screen.findByText('up to date')).toBeInTheDocument()
    // Both boxes show the same kind of identifier, which is what the badge
    // compares; the commit is offered beside it, not instead of it.
    expect(screen.getByText('1111aaaa2222')).toBeInTheDocument()
    expect(screen.getByText('9999cccc8888')).toBeInTheDocument()
    expect(screen.getByText('commit abc1234def56')).toBeInTheDocument()
    expect(screen.getByText(/deployer image dddd0000eeee/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Update now/ })).toBeEnabled()
    expect(screen.queryByText('Pull images')).not.toBeInTheDocument()
  })

  it('says an update is available when the channel moved', async () => {
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ update_available: true }))
    render(<UpdatePanel />)

    expect(await screen.findByText('update available')).toBeInTheDocument()
    expect(screen.getByText(/Latest on “stable”/)).toBeInTheDocument()
  })

  it('reports the availability as unknown rather than up to date', async () => {
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ update_available: null }))
    render(<UpdatePanel />)

    expect(await screen.findByText('availability unknown')).toBeInTheDocument()
  })

  it('shows each stage of a running job, warns that automation is paused, and refuses a second job', async () => {
    const running = job()
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ update_available: true, active_job: running }))
    vi.mocked(deploymentApi.job).mockResolvedValue(detail(running, [
      { seq: 0, event_id: 'e0', stage: 'pull', status: 'started', at: '2026-09-07T10:01:06.000Z', log_tail: null },
      { seq: 1, event_id: 'e1', stage: 'pull', status: 'succeeded', at: '2026-09-07T10:01:40.000Z', log_tail: null },
      { seq: 2, event_id: 'e2', stage: 'drain', status: 'started', at: '2026-09-07T10:01:41.000Z', log_tail: null },
    ]))

    render(<UpdatePanel />)

    expect(await screen.findByText('Pull images')).toBeInTheDocument()
    expect(screen.getByText('Wait for running work')).toBeInTheDocument()
    expect(screen.getByText('Health check')).toBeInTheDocument()
    expect(screen.getAllByText('succeeded')).toHaveLength(1)
    expect(screen.getAllByText('running')).toHaveLength(2) // the drain stage and the job badge
    expect(screen.getAllByText('pending')).toHaveLength(3) // migrate, recreate, health
    expect(screen.getByText(/Scheduled and automated work is paused/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Update now/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Check for updates/ })).toBeDisabled()
  })

  it('names the failing stage, its output, and the backup a recovery would restore', async () => {
    // The reachable shape: migrate succeeded and recorded its dump, health then
    // failed. A failed stage never records a result, only its log tail.
    const failed = job({
      status: 'failed',
      current_stage: 'health',
      failure_stage: 'health',
      error_text: 'health failed',
      ended_at: '2026-09-07T10:09:00.000Z',
      result_json: { dump_path: '/rainver/db/dumps/pre-migrate-20260907.dump' },
    })
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ update_available: true, last_job: failed }))
    vi.mocked(deploymentApi.job).mockResolvedValue(detail(failed, [
      { seq: 0, event_id: 'e0', stage: 'migrate', status: 'succeeded', at: '2026-09-07T10:03:00.000Z', log_tail: null },
      { seq: 1, event_id: 'e1', stage: 'recreate', status: 'succeeded', at: '2026-09-07T10:06:00.000Z', log_tail: null },
      { seq: 2, event_id: 'e2', stage: 'health', status: 'failed', at: '2026-09-07T10:09:00.000Z', log_tail: 'server did not become healthy within 120s' },
    ]))

    render(<UpdatePanel />)

    expect(await screen.findByText(/Failed at Health check/)).toBeInTheDocument()
    expect(screen.getByText('health failed')).toBeInTheDocument()
    expect(screen.getByText('/rainver/db/dumps/pre-migrate-20260907.dump')).toBeInTheDocument()
    expect(screen.getByText(/did not become healthy/)).toBeInTheDocument()
    // A terminal job does not block the next attempt.
    expect(screen.getByRole('button', { name: /Update now/ })).toBeEnabled()
  })

  it('does not claim a deployment ran when the job was never picked up', async () => {
    const swept = job({
      status: 'failed',
      current_stage: null,
      failure_stage: null,
      error_text: 'deployer_unavailable',
      ended_at: '2026-09-07T10:31:00.000Z',
    })
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ last_job: swept }))
    vi.mocked(deploymentApi.job).mockResolvedValue(detail(swept, []))

    render(<UpdatePanel />)

    expect(await screen.findByText(/No deployer picked this up/)).toBeInTheDocument()
    expect(screen.getByText('deployer_unavailable')).toBeInTheDocument()
    expect(screen.getByText('Nothing ran on the instance.')).toBeInTheDocument()
  })

  it('does not describe a failed update check as an interrupted deployment', async () => {
    const checked = job({
      job_type: 'check_update',
      status: 'failed',
      current_stage: 'remote_check',
      failure_stage: 'remote_check',
      error_text: 'reading ghcr.io/x/rainver-server:stable failed: unauthorized',
      ended_at: '2026-09-07T10:02:00.000Z',
    })
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ update_available: null, last_job: checked }))
    vi.mocked(deploymentApi.job).mockResolvedValue(detail(checked, [
      { seq: 0, event_id: 'e0', stage: 'remote_check', status: 'failed', at: '2026-09-07T10:02:00.000Z', log_tail: 'unauthorized' },
    ]))

    render(<UpdatePanel />)

    expect(await screen.findByText(/Failed at Check the registry/)).toBeInTheDocument()
    expect(screen.getByText('Only the registry was read; the instance was not touched.')).toBeInTheDocument()
    expect(screen.queryByText(/Nothing was rolled back/)).not.toBeInTheDocument()
  })

  it('does not leave a stage running under a job that has ended', async () => {
    const lost = job({
      status: 'failed',
      current_stage: 'recreate',
      failure_stage: 'recreate',
      error_text: 'deployer_lost',
      ended_at: '2026-09-07T11:05:00.000Z',
    })
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ last_job: lost }))
    vi.mocked(deploymentApi.job).mockResolvedValue(detail(lost, [
      { seq: 0, event_id: 'e0', stage: 'pull', status: 'succeeded', at: '2026-09-07T10:02:00.000Z', log_tail: null },
      { seq: 1, event_id: 'e1', stage: 'drain', status: 'started', at: '2026-09-07T10:03:00.000Z', log_tail: null },
      { seq: 2, event_id: 'e2', stage: 'recreate', status: 'started', at: '2026-09-07T10:04:00.000Z', log_tail: null },
    ]))

    render(<UpdatePanel />)

    // The deployer stopped reporting: the stage it was inside failed, and the
    // one it never finished is interrupted, not still running.
    expect(await screen.findByText('deployer_lost')).toBeInTheDocument()
    // The stage it was inside is named as interrupted, not as the stage that
    // failed on its own: the server ended this job, the deployer did not.
    expect(screen.getByText(/Interrupted during Recreate services/)).toBeInTheDocument()
    expect(screen.getByText(/may still have run/)).toBeInTheDocument()
    expect(screen.queryByText('running')).not.toBeInTheDocument()
    expect(screen.getByText('interrupted')).toBeInTheDocument()
    expect(screen.getAllByText('failed')).toHaveLength(2) // the recreate stage and the job badge
  })

  it('offers Cancel only while the job is still queued', async () => {
    const queued = job({ status: 'queued', current_stage: null })
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ active_job: queued }))
    vi.mocked(deploymentApi.job).mockResolvedValue(detail(queued, []))
    const user = userEvent.setup({ delay: null })

    render(<UpdatePanel />)

    await user.click(await screen.findByRole('button', { name: /Cancel/ }))
    await waitFor(() => expect(deploymentApi.cancelJob).toHaveBeenCalledWith('job-1'))
  })

  it('creates the job the button names and refreshes even when the request is refused', async () => {
    const user = userEvent.setup({ delay: null })
    render(<UpdatePanel />)
    await screen.findByText('up to date')
    vi.mocked(deploymentApi.status).mockClear()

    await user.click(screen.getByRole('button', { name: /Update now/ }))
    await waitFor(() => expect(deploymentApi.createJob).toHaveBeenCalledWith('update'))
    await waitFor(() => expect(deploymentApi.status).toHaveBeenCalled())

    vi.mocked(deploymentApi.createJob).mockRejectedValueOnce(new Error('A deployment job is already queued or running'))
    vi.mocked(deploymentApi.status).mockClear()
    await user.click(screen.getByRole('button', { name: /Check for updates/ }))
    // A 409 means the panel's idea of the instance is already stale.
    await waitFor(() => expect(deploymentApi.status).toHaveBeenCalled())
  })

  it('refuses to start an update while the deployer is not reporting', async () => {
    // A queued update defers every unattended Run from the moment it exists, so
    // offering one that nothing will claim would pause scheduled work for the
    // half hour it takes the sweep to fail it.
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ deployer_online: false }))
    render(<UpdatePanel />)

    expect(await screen.findByText(/has not reported since/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Update now/ })).toBeDisabled()
    // Reading the registry costs the instance nothing, so it stays available.
    expect(screen.getByRole('button', { name: /Check for updates/ })).toBeEnabled()
  })

  it('says an update is a production operation instead of letting the button fail', async () => {
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ updates_supported: false }))
    render(<UpdatePanel />)

    expect(await screen.findByText(/run on a production instance/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Update now/ })).toBeDisabled()
  })

  it('asks for the host step when the deployer is behind the server', async () => {
    // ADR 0020 §6: an update never moves the deployer, and the compose files and
    // ops scripts it runs come from the host checkout with it.
    vi.mocked(deploymentApi.status).mockResolvedValue(status({ deployer_behind: true }))
    render(<UpdatePanel />)

    expect(await screen.findByText(/different build from the server/)).toBeInTheDocument()
    expect(screen.getByText(/start.sh --prod/)).toBeInTheDocument()
    // It is a host step, not a reason to stop updating the rest of the instance.
    expect(screen.getByRole('button', { name: /Update now/ })).toBeEnabled()
  })

  describe('following a job', () => {
    /** One poll interval at a time: a single long advance would schedule past
     * the interval the render inside it creates. */
    async function ticks(count: number) {
      for (let i = 0; i < count; i += 1) await vi.advanceTimersByTimeAsync(3000)
    }

    it('keeps reading while the job runs, survives the restart it causes, and stops once it settles', async () => {
      const running = job()
      vi.mocked(deploymentApi.status).mockResolvedValue(status({ active_job: running }))
      vi.mocked(deploymentApi.job).mockResolvedValue(detail(running, []))

      // Fake timers before mount: the interval that follows the job is created
      // by the render that first sees it.
      vi.useFakeTimers()
      const { unmount } = render(<UpdatePanel />)
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.mocked(deploymentApi.status)).toHaveBeenCalledTimes(1)

      // The recreate stage restarts the server this reads from, so a failed
      // read must not stop the loop.
      vi.mocked(deploymentApi.status).mockRejectedValueOnce(new Error('Failed to fetch'))
      await ticks(4)
      expect(vi.mocked(deploymentApi.status).mock.calls.length).toBeGreaterThanOrEqual(3)

      // The job ends. The panel keeps reading a little longer, because what the
      // instance runs is only rewritten by the deployer's next heartbeat.
      const done = job({ status: 'succeeded', ended_at: '2026-09-07T10:08:00.000Z' })
      vi.mocked(deploymentApi.status).mockResolvedValue(status({ last_job: done }))
      vi.mocked(deploymentApi.job).mockResolvedValue(detail(done, []))
      await ticks(1)
      const afterTerminal = vi.mocked(deploymentApi.status).mock.calls.length
      await ticks(3)
      expect(vi.mocked(deploymentApi.status).mock.calls.length).toBeGreaterThan(afterTerminal)

      // ...and then stops.
      await ticks(10)
      const settled = vi.mocked(deploymentApi.status).mock.calls.length
      await ticks(5)
      expect(vi.mocked(deploymentApi.status).mock.calls.length).toBe(settled)

      unmount()
      await ticks(5)
      expect(vi.mocked(deploymentApi.status).mock.calls.length).toBe(settled)
    })
  })
})
