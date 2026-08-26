import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { hostsApi, type RuntimeLoginEvent } from '../../api/client'
import { errMsg } from '../../lib/utils'

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const MAX_CHARS = 20_000

/**
 * The login terminal for one copy of a runtime on a host. Output is the
 * daemon's PTY stream with escape codes stripped; whatever is typed goes
 * back to the same session. Ends when the login command exits.
 */
export default function RuntimeLoginTerminal({
  hostId,
  adapterType,
  installation,
  onDone,
}: {
  hostId: string
  adapterType: string
  installation: string
  onDone: (loggedIn: boolean | null) => void
}) {
  const [output, setOutput] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [exit, setExit] = useState<{ exit_code: number; logged_in: boolean | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [line, setLine] = useState('')
  const pre = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        for await (const event of hostsApi.loginStream(hostId, adapterType, installation)) {
          if (cancelled) break
          handle(event)
        }
      } catch (caught) {
        if (!cancelled) setError(errMsg(caught))
      }
    })()
    function handle(event: RuntimeLoginEvent) {
      if (event.type === 'output') setOutput(previous => (previous + event.data.replace(ANSI_RE, '')).slice(-MAX_CHARS))
      if (event.type === 'hint') setHint(event.text)
      if (event.type === 'error') setError(event.message)
      if (event.type === 'exit') {
        setExit(event)
        onDone(event.logged_in)
      }
    }
    return () => { cancelled = true }
    // A terminal is one session; a new host/copy is a new component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, adapterType, installation])

  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [output])

  async function send() {
    const data = `${line}\n`
    setLine('')
    try {
      await hostsApi.loginInput(hostId, adapterType, installation, data)
    } catch (caught) {
      setError(errMsg(caught))
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2" data-testid="runtime-login-terminal">
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <pre ref={pre} className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-snug" aria-label="Login terminal">
        {output || (exit ? '' : 'Starting login…')}
      </pre>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {exit ? (
        <p className="text-xs">
          {exit.logged_in === true ? 'Logged in.' : exit.logged_in === false ? `Login ended without a credential (exit ${exit.exit_code}).` : `Session ended (exit ${exit.exit_code}).`}
        </p>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={event => { event.preventDefault(); void send() }}
        >
          <Input
            aria-label="Login input"
            value={line}
            onChange={event => setLine(event.target.value)}
            placeholder="Type here and press Enter — codes, answers, commands"
            autoFocus
          />
          <Button type="submit" size="sm" variant="outline">Send</Button>
        </form>
      )}
    </div>
  )
}
