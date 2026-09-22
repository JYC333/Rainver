import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, History, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ambientSessionsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type {
  AmbientImportPolicy,
  AmbientSessionCount,
  ImportedSession,
  WorkspaceLocation,
} from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Select } from '../../components/ui/select'

/**
 * Consent and state for importing one folder's ambient CLI history from one
 * machine.
 *
 * It lives on the Location because that is what the consent is about — this
 * folder, on this machine, for this runtime. The sessions it produces belong
 * to the Project and are read there.
 */
export function AmbientSessionImportPanel({ location }: { location: WorkspaceLocation }) {
  const [policy, setPolicy] = useState<AmbientImportPolicy | null>(null)
  const [counts, setCounts] = useState<AmbientSessionCount[]>([])
  const [sessions, setSessions] = useState<ImportedSession[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /**
   * The one consent gate this feature has, keyed per runtime copy because the
   * setting is: one panel-wide choice would republish a runtime the person
   * had deliberately kept private the moment they touched a different one.
   * It states the consequence at the point of choice, because there is
   * deliberately no second confirmation later.
   */
  const [visibility, setVisibility] = useState<Record<string, 'private' | 'space_shared'>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [offer, listed] = await Promise.all([
        ambientSessionsApi.offer(location.id),
        ambientSessionsApi.list(location.id),
      ])
      setPolicy(offer.policy)
      setCounts(offer.counts)
      setSessions(listed.sessions)
      setVisibility(current => ({
        ...Object.fromEntries(
          offer.policy.entries.map(entry => [`${entry.runtime_key}:${entry.installation}`, entry.default_visibility]),
        ),
        ...current,
      }))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [location.id])

  useEffect(() => { void load() }, [load])

  // A server-host checkout runs managed profiles and has no ambient history
  // at all, so the whole surface is absent there rather than empty.
  if (location.execution_host_kind !== 'remote') return null

  const runtimes = countedRuntimes(counts, policy)
  const visibilityFor = (runtimeKey: string, installation: string): 'private' | 'space_shared' =>
    visibility[`${runtimeKey}:${installation}`] ?? 'space_shared'
  const autoExtractFor = (runtimeKey: string, installation: string): boolean =>
    (policy?.entries ?? []).some(entry =>
      entry.runtime_key === runtimeKey && entry.installation === installation && entry.auto_extract)

  /**
   * Records the choice, not just the control's state.
   *
   * The picker is the one consent gate this feature has, and a background sync
   * reads the *stored* default — so a choice held only in this component would
   * be honoured by the import the person is watching and then quietly reversed
   * by the next one they are not.
   */
  async function chooseVisibility(
    runtimeKey: string,
    installation: string,
    next: 'private' | 'space_shared',
    sync: boolean,
  ) {
    const key = `${runtimeKey}:${installation}`
    setVisibility(current => ({ ...current, [key]: next }))
    setBusy(key)
    try {
      setPolicy(await ambientSessionsApi.setPolicy(location.id, {
        runtime_key: runtimeKey,
        installation,
        sync,
        default_visibility: next,
        auto_extract: autoExtractFor(runtimeKey, installation),
      }))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(null)
    }
  }

  async function toggleAutoExtract(runtimeKey: string, installation: string, autoExtract: boolean) {
    setBusy(`${runtimeKey}:${installation}`)
    try {
      setPolicy(await ambientSessionsApi.setPolicy(location.id, {
        runtime_key: runtimeKey,
        installation,
        sync: runtimes.some(runtime =>
          runtime.runtime_key === runtimeKey && runtime.installation === installation && runtime.sync),
        default_visibility: visibilityFor(runtimeKey, installation),
        auto_extract: autoExtract,
      }))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(null)
    }
  }

  async function toggleSync(runtimeKey: string, installation: string, sync: boolean) {
    setBusy(`${runtimeKey}:${installation}`)
    try {
      setPolicy(await ambientSessionsApi.setPolicy(location.id, {
        runtime_key: runtimeKey, installation, sync, default_visibility: visibilityFor(runtimeKey, installation),
      }))
      toast.success(sync ? 'New conversations in this folder will be imported' : 'Syncing stopped; nothing was deleted')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(null)
    }
  }

  async function runSync(runtimeKey: string, installation: string) {
    setBusy(`${runtimeKey}:${installation}`)
    try {
      const report = await ambientSessionsApi.sync(location.id, {
        runtime_key: runtimeKey, installation, visibility: visibilityFor(runtimeKey, installation),
      })
      const rejected = report.malformed_sessions + report.failed_sessions
      const summary = `${report.sessions_written} session${report.sessions_written === 1 ? '' : 's'}, `
        + `${report.records_inserted} new record${report.records_inserted === 1 ? '' : 's'}`
      if (report.error) toast.error(`Import finished with an error: ${report.error}`)
      // Said rather than swallowed: a short total for a reason must not read
      // as a short total because nothing happened.
      else if (rejected > 0) toast.warning(`${summary} — ${rejected} session${rejected === 1 ? '' : 's'} could not be read`)
      else toast.success(summary)
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(null)
    }
  }

  async function removeSelected() {
    const ids = [...selected]
    if (ids.length === 0) return
    // Stated before the action, not after: the host's own copy may already be
    // gone, and anything already extracted keeps its text while its citations
    // stop resolving.
    const confirmed = window.confirm(
      `Delete ${ids.length} imported session${ids.length === 1 ? '' : 's'}?\n\n`
      + 'This machine may no longer have them, so this can be the only copy that exists. '
      + 'Anything already extracted into the Brief keeps its text, but its citations will stop resolving.',
    )
    if (!confirmed) return
    setBusy('delete')
    try {
      const { deleted } = await ambientSessionsApi.remove(ids)
      toast.success(`Deleted ${deleted} session${deleted === 1 ? '' : 's'}`)
      setSelected(new Set())
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="space-y-4 p-4" data-testid="ambient-import-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="size-4" />Imported CLI history
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Sessions you had with your own coding CLI in this folder on this machine. Read-only here; they are
            never continued in place.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="size-4" />Refresh
        </Button>
      </div>

      {runtimes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {loading ? 'Looking…' : 'This machine has reported no CLI history for this folder yet.'}
        </p>
      ) : (
        <div className="space-y-2">
          {runtimes.map(runtime => (
            <div key={`${runtime.runtime_key}:${runtime.installation}`} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {runtime.runtime_key}
                  {runtime.installation !== 'own' && <Badge variant="outline" className="text-[11px]">{runtime.installation}</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {runtime.error
                    ? `Could not be asked: ${runtime.error}`
                    : `${runtime.session_count} session${runtime.session_count === 1 ? '' : 's'} in the last 30 days`}
                  {runtime.newest_updated_at && ` · newest ${new Date(runtime.newest_updated_at).toLocaleDateString()}`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span>Who can read it</span>
                  <Select
                    ariaLabel={`Who can read it \u2014 ${runtime.runtime_key} ${runtime.installation}`}
                    size="sm"
                    className="min-w-[16rem]"
                    value={visibilityFor(runtime.runtime_key, runtime.installation)}
                    disabled={busy !== null}
                    onChange={value => void chooseVisibility(
                      runtime.runtime_key,
                      runtime.installation,
                      value as 'private' | 'space_shared',
                      runtime.sync,
                    )}
                    options={[
                      { value: 'space_shared', label: 'Project shared — members can read it, and it feeds the Brief' },
                      { value: 'private', label: 'Only me — a read-only archive, never used for extraction' },
                    ]}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={runtime.sync}
                    disabled={busy !== null}
                    onChange={event => void toggleSync(runtime.runtime_key, runtime.installation, event.target.checked)}
                  />
                  Keep syncing
                </label>
                <label
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                  title="Off by default: extraction spends model budget, and a background spend nobody asked for is not a small thing."
                >
                  <input
                    type="checkbox"
                    checked={autoExtractFor(runtime.runtime_key, runtime.installation)}
                    disabled={busy !== null}
                    onChange={event => void toggleAutoExtract(runtime.runtime_key, runtime.installation, event.target.checked)}
                  />
                  Extract automatically
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || runtime.error !== null}
                  onClick={() => void runSync(runtime.runtime_key, runtime.installation)}
                >
                  <Download className="size-4" />Import now
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">{sessions.length} imported session{sessions.length === 1 ? '' : 's'}</h3>
            {selected.size > 0 && (
              <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void removeSelected()}>
                <Trash2 className="size-4" />Delete {selected.size}
              </Button>
            )}
          </div>
          <div className="space-y-1">
            {sessions.map(session => (
              <div key={session.id} className="flex items-center gap-3 rounded-md border p-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Select ${session.title ?? session.vendor_session_id}`}
                  checked={selected.has(session.id)}
                  onChange={event => {
                    const next = new Set(selected)
                    if (event.target.checked) next.add(session.id)
                    else next.delete(session.id)
                    setSelected(next)
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{session.title ?? session.vendor_session_id}</div>
                  <div className="text-xs text-muted-foreground">
                    {session.runtime_key} · {session.record_count} record{session.record_count === 1 ? '' : 's'}
                    {session.last_record_at && ` · ${new Date(session.last_record_at).toLocaleDateString()}`}
                  </div>
                </div>
                {session.visibility === 'private' && <Badge variant="outline" className="text-[11px]">Only you</Badge>}
                {session.load_state === 'partial' && (
                  <Badge variant="outline" className="text-[11px]" title={session.last_error ?? undefined}>Partial</Badge>
                )}
                {session.source_state === 'gone' && (
                  <Badge variant="outline" className="flex items-center gap-1 text-[11px]">
                    <AlertTriangle className="size-3" />No longer on host
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

/** Counts the daemon reported, joined with whatever consent already exists for each. */
function countedRuntimes(counts: AmbientSessionCount[], policy: AmbientImportPolicy | null) {
  const entries = policy?.entries ?? []
  const byKey = new Map(counts.map(count => [`${count.runtime_key}:${count.installation}`, count]))
  for (const entry of entries) {
    const key = `${entry.runtime_key}:${entry.installation}`
    if (byKey.has(key)) continue
    // Consent exists for a runtime the host has not reported on lately; the
    // switch must still be visible so it can be turned off.
    byKey.set(key, {
      location_id: '',
      runtime_key: entry.runtime_key,
      installation: entry.installation,
      session_count: 0,
      oldest_updated_at: null,
      newest_updated_at: null,
      error: null,
    })
  }
  return [...byKey.values()].map(count => ({
    ...count,
    sync: entries.some(entry =>
      entry.runtime_key === count.runtime_key && entry.installation === count.installation && entry.sync),
  }))
}
