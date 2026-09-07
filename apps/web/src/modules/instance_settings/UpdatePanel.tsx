import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, Download, Loader2, RefreshCw, Rocket, X } from 'lucide-react'
import { toast } from 'sonner'
import { deploymentApi } from '../../api/client'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { usePeriodicRefresh } from '../../hooks/usePeriodicRefresh'
import { errMsg } from '../../lib/utils'
import type {
  DeploymentJob,
  DeploymentJobDetail,
  DeploymentJobEvent,
  DeploymentStage,
  DeploymentStatus,
} from '../../types/api'

/** The stages an update reports, in the order the deployer runs them. */
const UPDATE_STAGES: DeploymentStage[] = ['pull', 'drain', 'migrate', 'recreate', 'health']
const STAGE_LABEL: Record<DeploymentStage, string> = {
  pull: 'Pull images',
  drain: 'Wait for running work',
  migrate: 'Back up and migrate',
  recreate: 'Recreate services',
  health: 'Health check',
  remote_check: 'Check the registry',
}

const ACTIVE_POLL_MS = 3000

/**
 * How many more reads to take after a job ends. What the instance is running
 * is only rewritten by the deployer's next heartbeat, so stopping the moment a
 * job goes terminal would leave the panel showing the build it just replaced.
 */
const SETTLE_READS = 6

function shortSha(value: string | null | undefined): string | null {
  if (!value) return null
  const hex = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value
  return hex.slice(0, 12)
}

function whenText(value: string | null | undefined): string {
  if (!value) return 'never'
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? 'never' : at.toLocaleString()
}

function isActive(job: DeploymentJob | null | undefined): boolean {
  return job != null && (job.status === 'queued' || job.status === 'running')
}

const TERMINAL = ['succeeded', 'failed', 'cancelled']

/** The latest reported status of each stage of the job being shown. */
function stageStates(job: DeploymentJob, events: DeploymentJobEvent[]): { stage: DeploymentStage; state: string }[] {
  const stages = job.job_type === 'check_update' ? (['remote_check'] as DeploymentStage[]) : UPDATE_STAGES
  const ended = TERMINAL.includes(job.status)
  return stages.map(stage => {
    const last = [...events].reverse().find(event => event.stage === stage)
    const state = last ? last.status : 'pending'
    // A stage that only ever reported its start, on a job that has ended, did
    // not keep running: the deployer stopped reporting inside it.
    if (state === 'started' && ended) return { stage, state: stage === job.failure_stage ? 'failed' : 'interrupted' }
    return { stage, state }
  })
}

/**
 * A job the server ended for the deployer, not the deployer for itself.
 * `deployer_lost` and `deployer_unavailable` are written by the heartbeat and
 * the sweep, so the job has no failing stage of its own.
 */
function isLost(job: DeploymentJob): boolean {
  return job.error_text === 'deployer_lost' || job.error_text === 'deployer_unavailable'
}

function failureHeadline(job: DeploymentJob): string {
  if (job.error_text === 'deployer_unavailable') return 'No deployer picked this up'
  if (isLost(job)) {
    return job.failure_stage
      ? `Interrupted during ${STAGE_LABEL[job.failure_stage]}`
      : 'The deployer stopped reporting'
  }
  return job.failure_stage ? `Failed at ${STAGE_LABEL[job.failure_stage]}` : 'The deployer never reported a stage'
}

function failureNote(job: DeploymentJob): string {
  if (job.error_text === 'deployer_unavailable') return 'Nothing ran on the instance.'
  if (isLost(job)) {
    return 'The deployer stopped reporting. Whatever it had already started may still have run — check the instance on the host.'
  }
  if (!job.failure_stage) return 'Nothing ran on the instance.'
  return job.job_type === 'check_update'
    ? 'Only the registry was read; the instance was not touched.'
    : 'Nothing was rolled back. Recovery is a host operation.'
}

function BuildBox({ label, digest, detail }: { label: string; digest: string | null; detail?: string | null }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm">{digest ?? 'unknown'}</div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  )
}

export function UpdatePanel() {
  const [status, setStatus] = useState<DeploymentStatus | null>(null)
  const [detail, setDetail] = useState<DeploymentJobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  // The reads race each other: a manual Refresh, the interval, and the read
  // after a button. Only the newest one may write.
  const readSeq = useRef(0)
  const wasActive = useRef(false)
  const [settle, setSettle] = useState(0)

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    const seq = ++readSeq.current
    // A manual read says so; a poll must not put a spinner over what is drawn.
    if (!options.quiet) setLoading(true)
    try {
      const next = await deploymentApi.status()
      const shown = next.active_job ?? next.last_job
      const nextDetail = shown ? await deploymentApi.job(shown.id) : null
      if (seq !== readSeq.current) return
      setStatus(next)
      setDetail(nextDetail)
      const nowActive = isActive(next.active_job)
      if (nowActive) setSettle(0)
      else if (wasActive.current) setSettle(SETTLE_READS)
      else setSettle(current => (current > 0 ? current - 1 : 0))
      wasActive.current = nowActive
    } catch (error) {
      // A read failure must not stop the loop: the recreate stage restarts the
      // very server this reads from, so failing reads are expected mid-update.
      if (!options.quiet) toast.error(errMsg(error))
    } finally {
      if (seq === readSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const active = status?.active_job ?? null
  const quietRefresh = useCallback(() => load({ quiet: true }), [load])
  usePeriodicRefresh(quietRefresh, ACTIVE_POLL_MS, isActive(active) || settle > 0)

  async function act(run: () => Promise<unknown>, message: string) {
    setBusy(true)
    try {
      await run()
      toast.success(message)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
      // Refresh either way: a 409 means the panel's idea of the instance is
      // already out of date.
      await load({ quiet: true })
    }
  }

  // `detail.job` is the newer snapshot: it is read after the status body.
  const shown = detail?.job ?? active ?? status?.last_job ?? null
  const server = status?.observations?.services.find(service => service.service === 'server') ?? null
  const deployer = status?.observations?.services.find(service => service.service === 'deployer') ?? null
  const remote = status?.observations?.remote ?? null
  const runningActive = isActive(active)
  const disabled = busy || loading || runningActive
  // Only once a status has been read: before that there is nothing to warn about.
  const offline = status !== null && !status.deployer_online
  const unsupported = status !== null && !status.updates_supported
  // The deployer is the one component an update cannot move (ADR 0020 §6), and
  // the compose files and ops scripts it runs come from the host checkout with
  // it — so this is the signal that the host step is due.
  const behind = status?.deployer_behind === true
  // "since never" is not a sentence: an instance that has never seen a deployer
  // and one whose deployer went quiet are different things to look into.
  const offlineDetail = status?.observations
    ? `The deployer has not reported since ${whenText(status.observations.observed_at)}.`
    : 'No deployer has ever reported to this instance.'
  const failed = shown?.status === 'failed'
  const dumpPath = typeof shown?.result_json?.dump_path === 'string' ? shown.result_json.dump_path : null
  const failures = detail?.events.filter(event => event.status === 'failed') ?? []
  const failureTail = failures.length > 0 ? failures[failures.length - 1]!.log_tail : null

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Rocket className="size-3.5" /> Instance update</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Pulls the images for the configured channel, waits for running work, backs up and migrates the
            database, then recreates the services. Switching channel and rolling back are host operations.
          </p>
        </div>
        {status?.update_available === true && <Badge variant="warning">update available</Badge>}
        {status?.update_available === false && <Badge variant="success">up to date</Badge>}
        {status !== null && status.update_available === null && (
          <Badge variant="muted" title="Either build is unknown, or the last registry read was for a different channel">
            availability unknown
          </Badge>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <BuildBox
          label="Running build"
          digest={shortSha(server?.digest)}
          detail={server?.revision ? `commit ${shortSha(server.revision)}` : null}
        />
        <BuildBox
          label={`Latest on ${remote?.tag ? `“${remote.tag}”` : 'this channel'}`}
          digest={shortSha(remote?.digest)}
          detail={`read ${whenText(remote?.checked_at)}`}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Seen {whenText(status?.observations?.observed_at)}
        {deployer?.digest ? ` · deployer image ${shortSha(deployer.digest)}` : ''}
      </p>

      {(offline || unsupported || behind) && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {unsupported && (
            <li className="flex items-start gap-1.5">
              <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Instance updates run on a production instance. This one builds its images from a
              checkout the deployer does not mount — update it on the host.
            </li>
          )}
          {offline && (
            <li className="flex items-start gap-1.5 text-destructive">
              <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {offlineDetail} An update cannot start, and scheduled work would be paused while it
              waited.
            </li>
          )}
          {behind && (
            <li className="flex items-start gap-1.5">
              <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              The deployer is running a different build from the server. It never updates itself, and
              the compose files and ops scripts come from the host checkout with it: run
              <span className="font-mono"> git pull &amp;&amp; ops/scripts/start.sh --prod </span>
              on the host.
            </li>
          )}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={busy}>
          {loading ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <RefreshCw aria-hidden className="size-3.5" />} Refresh
        </Button>
        {shown?.status === 'queued' && (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void act(() => deploymentApi.cancelJob(shown.id), 'Deployment job cancelled')}
          >
            <X aria-hidden className="size-3.5" /> Cancel
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => void act(() => deploymentApi.createJob('check_update'), 'Checking for updates')}
        >
          <Download aria-hidden className="size-3.5" /> Check for updates
        </Button>
        <Button
          size="sm"
          disabled={disabled || offline || unsupported}
          onClick={() => void act(() => deploymentApi.createJob('update'), 'Update started')}
        >
          {runningActive ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Rocket aria-hidden className="size-3.5" />} Update now
        </Button>
      </div>

      {runningActive && active?.job_type === 'update' && (
        <p className="mt-2 text-xs text-muted-foreground">
          Scheduled and automated work is paused until this job ends. Conversations keep running.
        </p>
      )}

      {shown && detail && (
        <section className="mt-4 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold">
              {shown.job_type === 'update' ? 'Update' : 'Update check'} — {whenText(shown.requested_at)}
            </h4>
            <StatusBadge status={shown.status} />
          </div>
          {shown.target_tag && <p className="mt-1 text-xs text-muted-foreground">channel {shown.target_tag}</p>}
          <ul className="mt-2 divide-y divide-border" aria-live="polite">
            {stageStates(shown, detail.events).map(({ stage, state }) => (
              <li key={stage} className="flex items-center justify-between gap-3 py-1">
                <span className="text-sm">{STAGE_LABEL[stage]}</span>
                <StatusBadge status={state === 'started' ? 'running' : state} />
              </li>
            ))}
          </ul>
          {failed && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-destructive">
                <CircleAlert aria-hidden className="size-3.5" />
                {failureHeadline(shown)}
              </div>
              {shown.error_text && <p className="mt-1 text-xs font-mono">{shown.error_text}</p>}
              <p className="mt-1 text-xs text-muted-foreground">{failureNote(shown)}</p>
              {dumpPath && (
                <p className="mt-1 text-xs">
                  Pre-migration backup: <span className="font-mono">{dumpPath}</span>
                </p>
              )}
              {failureTail && (
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                  {failureTail}
                </pre>
              )}
            </div>
          )}
        </section>
      )}
    </Card>
  )
}
