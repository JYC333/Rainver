import { useEffect, useRef, useState } from 'react'
import { hostsApi, type HostLoginTarget, type RuntimeLoginEvent } from '../../api/client'
import { errMsg } from '../../lib/utils'
import LoginTerminalView from './LoginTerminalView'

const PENDING_OUTPUT_MAX_CHARS = 64 * 1024

/**
 * The login terminal for one copy of a runtime on a host: the daemon's PTY
 * stream rendered by a terminal emulator, with every keystroke sent back to
 * the same session in order. Ends when the login command exits.
 */
export default function RuntimeLoginTerminal({
  hostId,
  adapterType,
  installation,
  target = null,
  interactive = true,
  onDone,
}: {
  hostId: string
  adapterType: string
  installation: string
  target?: HostLoginTarget | null
  interactive?: boolean
  onDone: (loggedIn: boolean | null) => void
}) {
  const [hint, setHint] = useState<string | null>(null)
  const [exit, setExit] = useState<{ exit_code: number; logged_in: boolean | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  const startedRef = useRef(false)
  // Output can arrive before the emulator has loaded; hold its tail until
  // then. A fresh terminal only needs what is on screen, and a TUI that
  // repaints at full speed would otherwise grow this without bound.
  const writer = useRef<((data: string) => void) | null>(null)
  const pending = useRef('')
  // Keystrokes travel one request at a time, in order; keys typed while a
  // request is in flight are sent together in the next one.
  const queued = useRef('')
  const sending = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of hostsApi.loginStream(hostId, adapterType, installation, target ?? null, abort.signal)) {
          if (cancelled) break
          handle(event)
        }
      } catch (caught) {
        if (!cancelled) setError(errMsg(caught))
      }
    })()
    function handle(event: RuntimeLoginEvent) {
      if (event.type === 'output') {
        if (!startedRef.current) {
          startedRef.current = true
          setStarted(true)
        }
        if (writer.current) writer.current(event.data)
        else pending.current = (pending.current + event.data).slice(-PENDING_OUTPUT_MAX_CHARS)
      }
      if (event.type === 'hint') setHint(event.text)
      if (event.type === 'error') setError(event.message)
      if (event.type === 'exit') {
        setExit(event)
        onDone(event.logged_in)
      }
    }
    // Leaving closes the response, which is what ends the daemon's login
    // session; a login program is never left waiting on the host.
    return () => { cancelled = true; abort.abort() }
    // A terminal is one session; a new host/copy is a new component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, adapterType, installation, target?.kind, target?.kind === 'acp' ? target.methodId : null])

  function send(data: string) {
    // Nothing is listening after exit; the emulator is told to stop taking
    // input, and this guards the moment between the exit event and that.
    if (exit) return
    queued.current += data
    sending.current = sending.current
      .then(() => {
        const batch = queued.current
        queued.current = ''
        return batch ? hostsApi.loginInput(hostId, adapterType, installation, batch) : null
      })
      .catch(caught => setError(errMsg(caught)))
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2" data-testid="runtime-login-terminal">
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {!started && !exit && <p className="text-xs text-muted-foreground">Starting login…</p>}
      <LoginTerminalView
        interactive={interactive && !exit}
        onData={send}
        onError={setError}
        onReady={write => {
          writer.current = write
          if (pending.current) {
            write(pending.current)
            pending.current = ''
          }
        }}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      {exit && (
        <p className="text-xs">
          {target?.kind === 'logout'
            ? exit.exit_code === 0 ? 'Logged out.' : `Logout ended with exit ${exit.exit_code}.`
            : exit.logged_in === true ? 'Logged in.' : exit.logged_in === false ? `Login ended without a credential (exit ${exit.exit_code}).` : `Session ended (exit ${exit.exit_code}).`}
        </p>
      )}
    </div>
  )
}
