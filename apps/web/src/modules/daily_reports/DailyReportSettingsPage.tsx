import { useEffect, useState } from 'react'
import { SpaceLink as Link } from '../../core/spaceNav'
import { dailyReportApi } from '../../api/client'
import type {
  DailyCaptureReportSettingOut,
  DailyReportRunResponse,
  DailyReportArtifactItem,
} from '../../types/api'

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return 'Unknown error'
}

export default function DailyReportSettingsPage() {
  const [setting, setSetting] = useState<DailyCaptureReportSettingOut | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<DailyReportRunResponse | null>(null)
  const [reports, setReports] = useState<DailyReportArtifactItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      dailyReportApi.getSettings(),
      dailyReportApi.listReports(5),
    ])
      .then(([s, r]) => {
        setSetting(s)
        setReports(r)
      })
      .catch(e => setError(errMsg(e)))
      .finally(() => setLoading(false))
  }, [])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function toggleEnabled() {
    if (!setting) return
    setSaving(true)
    setError(null)
    try {
      const updated = await dailyReportApi.updateSettings({ enabled: !setting.enabled })
      setSetting(updated)
      showToast(updated.enabled ? 'Daily Report enabled.' : 'Daily Report disabled.')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  /** Resolves whether the server took the schedule, so the editor keeps unsaved input on failure. */
  async function saveSchedule(local_time: string, timezone: string): Promise<boolean> {
    setSaving(true)
    setError(null)
    try {
      const updated = await dailyReportApi.updateSettings({ local_time, timezone })
      setSetting(updated)
      showToast('Schedule saved.')
      return true
    } catch (e) {
      setError(errMsg(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function toggleExperienceProposals() {
    if (!setting) return
    setSaving(true)
    setError(null)
    try {
      const updated = await dailyReportApi.updateSettings({
        create_experience_proposals: !setting.create_experience_proposals,
      })
      setSetting(updated)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  async function toggleMemoryProposals() {
    if (!setting) return
    setSaving(true)
    setError(null)
    try {
      const updated = await dailyReportApi.updateSettings({
        create_memory_proposals: !setting.create_memory_proposals,
      })
      setSetting(updated)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  async function runNow() {
    setRunning(true)
    setError(null)
    try {
      const result = await dailyReportApi.run({ force: false })
      setLastRun(result)
      showToast(`Report ${result.status}: ${result.capture_count} captures.`)
      const updated = await dailyReportApi.listReports(5)
      setReports(updated)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setRunning(false)
    }
  }

  if (loading) return <div className="p-4 text-sm text-gray-500">Loading…</div>
  if (!setting) return <div className="p-4 text-sm text-red-500">{error || 'Failed to load settings.'}</div>

  return (
    <div className="max-w-xl mx-auto p-4 space-y-6">
      {toast && (
        <div className="fixed top-4 right-4 bg-green-100 border border-green-300 text-green-800 text-sm px-4 py-2 rounded shadow z-50">
          {toast}
        </div>
      )}

      <div>
        <h1 className="text-lg font-semibold">Daily Capture Report</h1>
        <p className="text-sm text-gray-500 mt-1">
          Automatically generate a structured daily report from your captures.
          When enabled, the scheduled report runs at your configured local time each day.
          Experience and memory proposals are optional and require your review.
        </p>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}

      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Enable scheduled report</div>
          <div className="text-xs text-gray-500">Run automatically at your configured time</div>
        </div>
        <button
          onClick={toggleEnabled}
          disabled={saving}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            setting.enabled ? 'bg-blue-600' : 'bg-gray-300'
          } disabled:opacity-50`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              setting.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Schedule */}
      <ScheduleEditor
        localTime={setting.local_time}
        timezone={setting.timezone}
        onSave={saveSchedule}
        disabled={saving}
      />

      {/* Proposal toggles */}
      <div className="space-y-3">
        <div className="text-sm font-medium">Proposal outputs</div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm">Create experience proposals</div>
            <div className="text-xs text-gray-500">Default on. Proposals require your review before being saved.</div>
          </div>
          <button
            onClick={toggleExperienceProposals}
            disabled={saving}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              setting.create_experience_proposals ? 'bg-blue-600' : 'bg-gray-300'
            } disabled:opacity-50`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                setting.create_experience_proposals ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm">Create memory proposals</div>
            <div className="text-xs text-gray-500">Default off. Memory proposals require your review before being saved.</div>
          </div>
          <button
            onClick={toggleMemoryProposals}
            disabled={saving}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              setting.create_memory_proposals ? 'bg-blue-600' : 'bg-gray-300'
            } disabled:opacity-50`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                setting.create_memory_proposals ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Manual run */}
      <div className="border-t pt-4 space-y-3">
        <div className="text-sm font-medium">Generate today's report</div>
        <button
          onClick={runNow}
          disabled={running}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {running ? 'Generating…' : 'Generate now'}
        </button>

        {lastRun && (
          <div className="text-sm text-gray-600 space-y-1">
            <div>Status: <span className="font-medium">{lastRun.status}</span></div>
            <div>Captures: {lastRun.capture_count}</div>
            {lastRun.artifact_id && (
              <div>
                <Link to={`/artifacts/${lastRun.artifact_id}`} className="text-blue-600 underline text-xs">
                  View artifact
                </Link>
              </div>
            )}
            {lastRun.run_id && (
              <div>
                <Link to={`/runs/${lastRun.run_id}`} className="text-blue-600 underline text-xs">
                  View run
                </Link>
              </div>
            )}
            {lastRun.proposal_ids.length > 0 && (
              <div>
                <Link to="/proposals" className="text-blue-600 underline text-xs">
                  Review {lastRun.proposal_ids.length} proposal{lastRun.proposal_ids.length !== 1 ? 's' : ''}
                </Link>
              </div>
            )}
            {lastRun.summary_preview && (
              <div className="text-xs text-gray-500 italic mt-1">{lastRun.summary_preview}</div>
            )}
          </div>
        )}
      </div>

      {/* Recent reports */}
      {reports.length > 0 && (
        <div className="border-t pt-4 space-y-2">
          <div className="text-sm font-medium">Recent reports</div>
          {reports.map(r => (
            <div key={r.id} className="flex items-center justify-between text-sm">
              <span className="text-gray-700">{r.report_date || r.title}</span>
              <Link to={`/artifacts/${r.id}`} className="text-blue-600 underline text-xs">
                View
              </Link>
            </div>
          ))}
        </div>
      )}

      {setting.last_report_date && (
        <div className="text-xs text-gray-400">Last report: {setting.last_report_date}</div>
      )}
      {setting.next_run_at && (
        <div className="text-xs text-gray-400">
          Next scheduled run: {new Date(setting.next_run_at).toLocaleString()}
        </div>
      )}
    </div>
  )
}

function ScheduleEditor({
  localTime,
  timezone,
  onSave,
  disabled,
}: {
  localTime: string
  timezone: string
  onSave: (time: string, tz: string) => Promise<boolean>
  disabled: boolean
}) {
  const [time, setTime] = useState(localTime)
  const [tz, setTz] = useState(timezone)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setTime(localTime)
    setTz(timezone)
    setDirty(false)
  }, [localTime, timezone])

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Schedule</div>
      <div className="flex gap-3 items-end">
        <div>
          <label className="text-xs text-gray-500">Time (HH:MM)</label>
          <input
            type="time"
            value={time}
            onChange={e => { setTime(e.target.value); setDirty(true) }}
            className="block border rounded px-2 py-1 text-sm mt-0.5"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500">Timezone</label>
          <input
            type="text"
            value={tz}
            onChange={e => { setTz(e.target.value); setDirty(true) }}
            placeholder="UTC"
            className="block border rounded px-2 py-1 text-sm mt-0.5 w-40"
          />
        </div>
        {dirty && (
          <button
            onClick={() => { void onSave(time, tz).then(saved => { if (saved) setDirty(false) }) }}
            disabled={disabled}
            className="px-2 py-1 text-xs bg-gray-100 border rounded hover:bg-gray-200 disabled:opacity-50"
          >
            Save
          </button>
        )}
      </div>
    </div>
  )
}
