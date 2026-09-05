import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { hostsApi, type HostLoginTarget, type RuntimeLoginEvent } from '../../api/client'
import { errMsg } from '../../lib/utils'

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const MAX_CHARS = 20_000
const HTTP_URL_RE = /https?:\/\/[^\s]+/g

function linkedOutput(value: string) {
  const parts: Array<string | ReactElement> = []
  let cursor = 0
  for (const match of value.matchAll(HTTP_URL_RE)) {
    const at = match.index ?? 0
    if (at > cursor) parts.push(value.slice(cursor, at))
    parts.push(
      <a
        key={`${at}:${match[0]}`}
        href={match[0]}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary underline underline-offset-2"
      >
        Open login link
      </a>,
    )
    cursor = at + match[0].length
  }
  if (cursor < value.length) parts.push(value.slice(cursor))
  return parts
}

/**
 * The login terminal for one copy of a runtime on a host. Output is the
 * daemon's PTY stream with escape codes stripped; whatever is typed goes
 * back to the same session. Ends when the login command exits.
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
        const stream = target
          ? hostsApi.loginStream(hostId, adapterType, installation, target)
          : hostsApi.loginStream(hostId, adapterType, installation)
        for await (const event of stream) {
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
  }, [hostId, adapterType, installation, target?.kind, target?.kind === 'acp' ? target.methodId : null])

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
        {output ? linkedOutput(output) : (exit ? '' : 'Starting login…')}
      </pre>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {exit ? (
        <p className="text-xs">
          {exit.logged_in === true ? 'Logged in.' : exit.logged_in === false ? `Login ended without a credential (exit ${exit.exit_code}).` : `Session ended (exit ${exit.exit_code}).`}
        </p>
      ) : interactive ? (
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
      ) : null}
    </div>
  )
}
