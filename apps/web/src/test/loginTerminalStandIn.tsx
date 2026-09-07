import React from 'react'

/**
 * jsdom cannot host the terminal emulator. This stand-in keeps
 * LoginTerminalView's contract — it shows what the daemon sent and forwards
 * typed lines as data — so page tests exercise the login flow without xterm.
 * Use it with `vi.mock('../LoginTerminalView', () => import('../../../test/loginTerminalStandIn'))`.
 */
export default function LoginTerminalStandIn({
  interactive,
  onData,
  onReady,
}: {
  interactive: boolean
  onData: (data: string) => void
  onReady: (write: (data: string) => void) => void
  onError?: (message: string) => void
}) {
  const [text, setText] = React.useState('')
  const [line, setLine] = React.useState('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => { onReady(chunk => setText(previous => previous + chunk)) }, [])
  return (
    <div>
      <pre aria-label="Login terminal">{text}</pre>
      {interactive && (
        <input
          aria-label="Login input"
          value={line}
          onChange={event => setLine(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { onData(`${line}\n`); setLine('') } }}
        />
      )}
    </div>
  )
}
