import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import { LOGIN_TERMINAL_COLS, LOGIN_TERMINAL_ROWS } from '@rainver/protocol'
import { errMsg } from '../../lib/utils'

/**
 * A real terminal for one login session: the daemon's PTY byte stream is
 * rendered as a terminal, and every keystroke — arrow keys, Enter, Ctrl-C —
 * goes back as the byte sequence a terminal would send. The emulator loads
 * on first use so it is not part of the initial bundle.
 *
 * What this component receives and emits is bytes for one fixed login
 * program; which program is decided by the adapter spec on the server and
 * the daemon, never here.
 */
export default function LoginTerminalView({
  interactive,
  onData,
  onReady,
  onError,
}: {
  interactive: boolean
  /** Bytes the person typed, already encoded the way a terminal sends them. */
  onData: (data: string) => void
  /** Called once with the writer that feeds the daemon's output into the terminal. */
  onReady: (write: (data: string) => void) => void
  /** The emulator could not be loaded; nothing will ever be rendered here. */
  onError?: (message: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  // The parent's handlers close over its state (a finished session drops
  // input), so the terminal calls whatever the latest render passed.
  const latest = useRef({ onData, onReady, onError, interactive })
  latest.current = { onData, onReady, onError, interactive }
  const terminalRef = useRef<Terminal | null>(null)

  // The session ends while the terminal stays on screen: stop taking input
  // then, or a stray keystroke posts to a closed session and surfaces an error.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.disableStdin = !interactive
    terminal.options.cursorBlink = interactive
  }, [interactive])

  useEffect(() => {
    let disposed = false
    let dispose: (() => void) | null = null
    void (async () => {
      try {
        const [{ Terminal }, { WebLinksAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-web-links'),
          import('@xterm/xterm/css/xterm.css'),
        ])
        if (disposed || !host.current) return
        // Read at construction, not from the mount closure: the session may
        // have ended while the emulator was still downloading.
        const live = latest.current.interactive
        const terminal = new Terminal({
          cols: LOGIN_TERMINAL_COLS,
          rows: LOGIN_TERMINAL_ROWS,
          disableStdin: !live,
          cursorBlink: live,
          fontSize: 11,
          lineHeight: 1.1,
          scrollback: 2000,
          theme: { background: '#0f1117' },
        })
        terminal.loadAddon(new WebLinksAddon((event, uri) => {
          event.preventDefault()
          window.open(uri, '_blank', 'noopener,noreferrer')
        }))
        terminal.open(host.current)
        terminalRef.current = terminal
        const data = terminal.onData(chunk => latest.current.onData(chunk))
        latest.current.onReady(chunk => terminal.write(chunk))
        if (live) terminal.focus()
        dispose = () => { data.dispose(); terminal.dispose(); terminalRef.current = null }
      } catch (caught) {
        if (!disposed) latest.current.onError?.(`The terminal could not be loaded: ${errMsg(caught)}`)
      }
    })()
    return () => { disposed = true; dispose?.() }
    // One terminal per session; the parent remounts for a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The terminal owns its own vertical scroll (scrollback). The dark box hugs
  // the grid instead of spanning the card, and only scrolls sideways when
  // the card is narrower than the grid.
  return <div ref={host} aria-label="Login terminal" className="inline-block max-w-full overflow-x-auto rounded-sm bg-[#0f1117] p-1 align-top" />
}
