import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { hostsApi } from '../../api/client'

// Requests outlive their page. Keep only live operations, scoped to the Host;
// never persist a busy flag that could survive the request which clears it.
const operations = new Map<string, ReadonlySet<string>>()
const listeners = new Set<() => void>()
const empty: ReadonlySet<string> = new Set()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish() { for (const listener of listeners) listener() }

export function useHostToolOperations(hostId: string, onChanged: () => Promise<void> | void, manageable: boolean) {
  const snapshot = useCallback(() => operations.get(hostId) ?? empty, [hostId])
  const localBusy = useSyncExternalStore(subscribe, snapshot)
  const [remoteBusy, setRemoteBusy] = useState<ReadonlySet<string>>(empty)
  const busy = useMemo(() => new Set([...localBusy, ...remoteBusy]), [localBusy, remoteBusy])
  const changed = useRef(onChanged)
  changed.current = onChanged
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let previous: ReadonlySet<string> = empty
    setRemoteBusy(empty)
    async function poll() {
      try {
        const result = await hostsApi.toolOperations(hostId)
        if (cancelled) return
        const next = new Set(result.items.map(item => item.action === 'update_own_tool'
          ? `${item.runtime_key}:own-update`
          : item.action === 'rollback_tool' ? `${item.runtime_key}:rollback` : item.runtime_key))
        setRemoteBusy(next)
        if ([...previous].some(key => !next.has(key))) await changed.current()
        previous = next
      } catch {
        // A failed status read is not evidence that an upgrade has finished.
      } finally {
        if (!cancelled) timer = setTimeout(() => { void poll() }, 2_000)
      }
    }
    if (manageable) void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [hostId, manageable])
  useEffect(() => {
    let previous = snapshot()
    return subscribe(() => {
      const next = snapshot()
      if ([...previous].some(key => !next.has(key))) void Promise.resolve().then(() => changed.current()).catch(() => {})
      previous = next
    })
  }, [snapshot])
  function startBusy(key: string): boolean {
    const current = snapshot()
    if (current.has(key) || remoteBusy.has(key)) return false
    operations.set(hostId, new Set(current).add(key))
    publish()
    return true
  }
  function endBusy(key: string) {
    const next = new Set(snapshot())
    next.delete(key)
    if (next.size) operations.set(hostId, next)
    else operations.delete(hostId)
    publish()
  }
  return { busy, startBusy, endBusy }
}
