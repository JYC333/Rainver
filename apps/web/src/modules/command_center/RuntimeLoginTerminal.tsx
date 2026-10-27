import { useEffect, useId, useRef, useState } from 'react'
import { hostsApi, type HostLoginTarget, type RuntimeLoginEvent } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { openSafeHttpUrl } from '../../lib/safeHttpUrl'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import LoginTerminalView from './LoginTerminalView'

const PENDING_OUTPUT_MAX_CHARS = 64 * 1024

/**
 * The login terminal for one copy of a runtime on a host: the daemon's PTY
 * stream rendered by a terminal emulator, with every keystroke sent back to
 * the same session in order. Ends when the login command exits.
 */
export default function RuntimeLoginTerminal({
  hostId,
  runtimeKey,
  installation,
  target = null,
  interactive = true,
  onDone,
  onRestart,
}: {
  hostId: string
  runtimeKey: string
  installation: string
  target?: HostLoginTarget | null
  interactive?: boolean
  onDone: (loggedIn: boolean | null) => void
  onRestart?: () => void
}) {
  const callbackId = useId()
  const [disconnected, setDisconnected] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [exit, setExit] = useState<{ exit_code: number; logged_in: boolean | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A login that finishes with an OAuth redirect to the host's own loopback
  // port: a browser on this device cannot deliver it, so the address it lands
  // on is pasted here and the host makes that request itself.
  const [callback, setCallback] = useState<{ port: number; authorize_url: string } | null>(null)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [callbackSent, setCallbackSent] = useState(false)
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
    let finished = false
    void (async () => {
      try {
        for await (const event of hostsApi.loginStream(hostId, runtimeKey, installation, target ?? null, abort.signal)) {
          if (cancelled) break
          if (event.type === 'exit') finished = true
          handle(event)
        }
        if (!cancelled && !finished) { setDisconnected(true); setError('Connection closed before login finished. Start again to reconnect.') }
      } catch (caught) {
        if (!cancelled) { setDisconnected(true); setError(errMsg(caught)) }
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
      if (event.type === 'callback_wanted') setCallback({ port: event.port, authorize_url: event.authorize_url })
      if (event.type === 'error') setError(event.message)
      if (event.type === 'exit') {
        setExit(event)
        onDone(event.logged_in)
      }
    }
    // Agent Auth may continue briefly on the host after this stream closes.
    return () => { cancelled = true; abort.abort() }
    // A terminal is one session; a new host/copy is a new component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, runtimeKey, installation, target?.kind, target?.kind === 'acp' ? target.methodId : null])

  function send(data: string) {
    // Nothing is listening after exit; the emulator is told to stop taking
    // input, and this guards the moment between the exit event and that.
    if (exit) return
    queued.current += data
    sending.current = sending.current
      .then(() => {
        const batch = queued.current
        queued.current = ''
        return batch ? hostsApi.loginInput(hostId, runtimeKey, installation, batch) : null
      })
      .catch(caught => setError(errMsg(caught)))
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2" data-testid="runtime-login-terminal">
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {!started && !exit && <p className="text-xs text-muted-foreground">Starting login…</p>}
      {callback && !exit && !disconnected && (
        <section className="space-y-4 rounded-md border border-border bg-background p-4 text-sm" data-testid="login-callback-panel">
          <div className="space-y-2">
            <p className="font-medium">1. Authorize in your browser</p>
            <Button type="button" variant="outline" onClick={() => openSafeHttpUrl(callback.authorize_url)}>
              Open authorization link
            </Button>
          </div>
          <form className="space-y-2" onSubmit={event => {
            event.preventDefault()
            const url = callbackUrl.trim()
            if (!url || submitting) return
            let parsed: URL
            try { parsed = new URL(url) } catch { setError('Paste the full address from your browser after authorization.'); return }
            if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || Number(parsed.port || '80') !== callback.port) {
              setError('This address does not match the current login. Paste the complete return address from this authorization attempt.')
              return
            }
            setError(null)
            setSubmitting(true)
            setCallbackSent(false)
            hostsApi.loginCallback(hostId, runtimeKey, installation, url)
              .then(() => setCallbackSent(true))
              .catch(caught => setError(errMsg(caught)))
              .finally(() => setSubmitting(false))
          }}>
            <label htmlFor={callbackId} className="block font-medium">2. Paste the return address</label>
            <p id={callbackId + '-help'} className="text-muted-foreground">
              If authorization ends on a “site cannot be reached” page, this is expected for remote login.
              Copy the full address from the browser’s address bar and paste it here.
              If login finishes automatically, no paste is needed.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id={callbackId} aria-label="Callback address" aria-describedby={callbackId + '-help'}
                className="min-w-0 flex-1 font-mono" autoComplete="off" spellCheck={false}
                placeholder={`http://127.0.0.1:${callback.port}/?state=…&code=…`}
                value={callbackUrl} disabled={submitting}
                onChange={event => { setCallbackUrl(event.target.value); setCallbackSent(false); setError(null) }} />
              <Button type="submit" disabled={!callbackUrl.trim() || submitting}>
                {submitting ? 'Sending…' : callbackSent ? 'Retry submission' : 'Complete login'}
              </Button>
            </div>
          </form>
          <p role="status" className="text-muted-foreground">
            {submitting ? 'Sending the return address…' : callbackSent
              ? '3. Waiting for login confirmation. If it does not finish, check login details below or start again.'
              : '3. Login completes after the return address is verified.'}
          </p>
        </section>
      )}
      {interactive ? (
      <LoginTerminalView
        interactive={interactive && !exit && !disconnected}
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
      ) : (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Login details</summary>
      <LoginTerminalView
        interactive={interactive && !exit && !disconnected}
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
        </details>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {onRestart && target?.kind !== 'logout' && (callback || disconnected || (exit && !exit.logged_in)) && (
        <Button type="button" variant="outline" onClick={onRestart}>Start login again</Button>
      )}
      {callback && !exit && <p className="text-xs text-muted-foreground">Closing this panel may leave browser authorization running briefly. Returning starts a new attempt.</p>}
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
