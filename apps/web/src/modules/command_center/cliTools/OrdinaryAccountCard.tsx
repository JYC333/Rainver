import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import type { HostOrdinaryAccountResponse, OrdinaryAccountStatus } from '@rainver/protocol'
import { ordinaryToolsApi } from '../../../api/client'
import { useAppTranslation } from '../../../i18n'
import { Button } from '../../../components/ui/button'
import { Badge } from '../../../components/ui/badge'
import { errMsg } from '../../../lib/utils'

type Authorization = { url: string; user_code: string | null; expires_in: number | null }

/** While the account is busy (another operation, a Run, a session finishing), it is read again this often. */
const BUSY_POLL_MS = 3_000
/** How many reads an account that disagrees with the tool's state gets before the card says so. */
const SYNC_READS = 10

/**
 * The signed-in person's own account for one CLI on one Host. The server
 * derives whose account it is; this card never names a user.
 *
 * Every write to the account state carries the generation it was started
 * under: a read, an action (verify/logout) and a session's end each take a new
 * one, so an older answer that arrives late never overwrites a newer result.
 * `toolState` changes when the tool is installed, updated or removed; the
 * card then reads its account again without remounting, so an open session
 * is not interrupted. Mount it keyed by Host: leaving aborts any open stream,
 * which ends the session on the Host.
 *
 * The account endpoint checks the tool against the server's record of the
 * Host's heartbeat, which can trail an install or removal the Host already
 * reported. While the account disagrees with `toolAvailable` it is read again
 * (a bounded number of times, then Retry), and a stale account is not shown.
 */
export default function OrdinaryAccountCard({ hostId, toolId, toolState, toolAvailable }: {
  hostId: string; toolId: string; toolState: string; toolAvailable: boolean
}) {
  const { t } = useAppTranslation()
  const [account, setAccount] = useState<HostOrdinaryAccountResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'verify' | 'logout' | null>(null)
  const [session, setSession] = useState<{ flow: 'init' | 'login'; authorization: Authorization | null } | null>(null)
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [syncReads, setSyncReads] = useState(0)
  const generation = useRef(0)
  const stream = useRef<AbortController | null>(null)
  const alive = useRef(true)
  // A verify/logout in flight; a quiet read asked for meanwhile runs after it.
  const acting = useRef(false)
  const readAfterAction = useRef(false)
  const sectionRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const messageRef = useRef<HTMLParagraphElement>(null)

  /** A read. `quiet` reads (polling, a tool change) do not block the actions. */
  const load = useCallback(async (quiet = false) => {
    if (quiet && acting.current) { readAfterAction.current = true; return }
    const mine = ++generation.current
    if (!quiet) setLoading(true)
    try {
      const next = await ordinaryToolsApi.account(hostId, toolId)
      if (alive.current && mine === generation.current) { setAccount(next); setLoadError(null) }
    } catch (error) {
      if (alive.current && mine === generation.current) setLoadError(errMsg(error))
    } finally {
      if (alive.current && mine === generation.current) setLoading(false)
    }
  }, [hostId, toolId])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      generation.current += 1
      stream.current?.abort()
    }
  }, [])

  // First read, and again whenever the tool's installed state changes.
  const firstRead = useRef(true)
  useEffect(() => {
    const quiet = !firstRead.current
    firstRead.current = false
    setSyncReads(0)
    void load(quiet)
  }, [load, toolState])

  // The account still answers for the tool's previous state: an installed
  // tool reported unavailable, or a removed one still reached.
  const behind = Boolean(account) && (toolAvailable
    ? account?.availability === 'tool_unavailable'
    : account?.availability === 'live' || account?.availability === 'busy' || account?.availability === 'error')
  const syncExhausted = behind && syncReads >= SYNC_READS
  // Busy is temporary, and so is an account behind the tool: keep reading
  // until neither holds, unless something else is in progress here.
  const accountBusy = account?.availability === 'busy' || (account?.session_active === true && !session)
  useEffect(() => {
    if (session || busy) return
    if (behind ? syncExhausted : !accountBusy) return
    const timer = setTimeout(() => {
      if (behind) setSyncReads((count) => count + 1)
      void load(true)
    }, BUSY_POLL_MS)
    return () => clearTimeout(timer)
  }, [behind, syncExhausted, accountBusy, account, session, busy, load])

  // The button that started or ended a session disappears with it; keep the
  // keyboard focus here instead of losing it to the page.
  const sessionOpen = session !== null
  useEffect(() => {
    const active = document.activeElement
    if (sessionOpen) { if (active === document.body || sectionRef.current?.contains(active)) cancelRef.current?.focus() }
    else if (active === document.body) messageRef.current?.focus()
  }, [sessionOpen])

  const startSession = async (flow: 'init' | 'login') => {
    if (acting.current) return
    stream.current?.abort()
    const controller = new AbortController()
    stream.current = controller
    // A read still in flight belongs to the state before this session.
    generation.current += 1
    setMessage(null)
    setSession({ flow, authorization: null })
    const current = () => alive.current && stream.current === controller
    try {
      for await (const event of ordinaryToolsApi.sessionStream(hostId, toolId, flow, controller.signal)) {
        if (!current()) return
        if (event.type === 'authorization') {
          // Only an https link is shown; the Host already accepts only the official ones.
          if (/^https:\/\//.test(event.url)) setSession({ flow, authorization: { url: event.url, user_code: event.user_code, expires_in: event.expires_in } })
          continue
        }
        stream.current = null
        setSession(null)
        setMessage(event.outcome === 'completed' ? { tone: 'info', text: t('cli_tools.session_completed') }
          : event.outcome === 'cancelled' ? { tone: 'info', text: t('cli_tools.session_cancelled') }
            : event.outcome === 'timed_out' ? { tone: 'error', text: t('cli_tools.session_timed_out') }
              : { tone: 'error', text: t('cli_tools.session_failed', { detail: event.error ?? '' }) })
        if (event.status) {
          generation.current += 1
          setAccount((previous) => previous ? { ...previous, availability: 'live', status: event.status, session_active: false } : previous)
        }
        void load(true)
        return
      }
      // The stream ended without an exit (closed by us or the network).
      if (current()) { stream.current = null; setSession(null); void load(true) }
    } catch (error) {
      if (!current()) return
      stream.current = null
      setSession(null)
      setMessage({ tone: 'error', text: errMsg(error) })
      void load(true)
    }
  }

  const cancelSession = () => {
    // Closing the stream is what cancels the session on the Host. The Host
    // may still be finishing it: the next read may say busy, which is polled.
    stream.current?.abort()
    stream.current = null
    setSession(null)
    setMessage({ tone: 'info', text: t('cli_tools.session_cancelled') })
    void load(true)
  }

  const act = async (action: 'verify' | 'logout') => {
    // This action's answer is newer than any read already on its way.
    if (acting.current) return
    const mine = ++generation.current
    acting.current = true
    readAfterAction.current = false
    setBusy(action)
    setMessage(null)
    try {
      const result = action === 'verify'
        ? await ordinaryToolsApi.verify(hostId, toolId)
        : await ordinaryToolsApi.logout(hostId, toolId)
      if (!alive.current || mine !== generation.current) return
      setAccount(result)
      if (action === 'logout') {
        const logout = (result as { logout?: { local_cleared: boolean } }).logout
        setMessage({ tone: 'info', text: logout?.local_cleared ? t('cli_tools.logout_done') : t('cli_tools.logout_nothing') })
      }
    } catch (error) {
      if (alive.current && mine === generation.current) setMessage({ tone: 'error', text: errMsg(error) })
    } finally {
      acting.current = false
      if (alive.current) {
        setBusy(null)
        // The tool changed while the action ran: read what is there now.
        if (readAfterAction.current) { readAfterAction.current = false; void load(true) }
      }
    }
  }

  // What an account behind the tool says is not shown as the person's state.
  const shown = behind ? null : account
  const status: OrdinaryAccountStatus | null = shown?.status ?? null
  const live = shown?.availability === 'live'
  const blocked = shown && shown.availability !== 'live'
    ? t(`cli_tools.account_${shown.availability}`)
    : null
  const canStart = live && !session && !busy && !loading
  const name = status?.account?.user_name
  // Offline or an error is not retried by itself: the person decides when.
  const offerRetry = !session && !busy && !loading
    && (Boolean(loadError) || syncExhausted || shown?.availability === 'offline' || shown?.availability === 'error'
      // The Host answered, but could not read the account (timeout, CLI error).
      || (live && status?.state === 'error'))

  return (
    <section ref={sectionRef} aria-label={t('cli_tools.account_title')} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="text-xs font-medium">{t('cli_tools.account_title')}</h5>
        {status && <Badge variant={status.state === 'signed_in' ? 'secondary' : 'outline'}>{t(`cli_tools.state_${status.state}`)}</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">{t('cli_tools.account_hint')}</p>
      {loading && !account && !loadError ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('cli_tools.account_loading')}</p>
      ) : null}
      {/* Translated here: the server's reason text is English and not shown as copy. */}
      {blocked && <p className="text-xs text-muted-foreground">{blocked}</p>}
      {behind && !syncExhausted && !session && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('cli_tools.account_syncing')}</p>
      )}
      {syncExhausted && !session && <p role="status" className="text-xs text-muted-foreground">{t('cli_tools.account_sync_stalled')}</p>}
      {loadError && <p role="alert" className="text-xs text-destructive">{loadError}</p>}
      {offerRetry && <Button size="sm" variant="outline" onClick={() => { setSyncReads(0); void load() }}>{t('cli_tools.retry')}</Button>}
      {status && (
        <div className="text-xs space-y-0.5">
          {name && status.state === 'signed_in' && <p>{t('cli_tools.signed_in_as', { name })}</p>}
          {status.account?.expires_at && <p className="text-xs text-muted-foreground">{t('cli_tools.expires', { time: new Date(status.account.expires_at).toLocaleString() })}</p>}
          {status.account?.refresh_pending && <p className="text-xs text-muted-foreground">{t('cli_tools.refresh_pending')}</p>}
          {status.account?.verified && <p className="text-xs text-muted-foreground">{t('cli_tools.verified')}</p>}
        </div>
      )}
      {session && (
        <div className="rounded-md bg-muted/50 p-3 space-y-2" role="status">
          {session.authorization ? (
            <>
              <Button asChild size="sm" variant="outline">
                <a href={session.authorization.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5 mr-1" />{t('cli_tools.authorize_open')}
                </a>
              </Button>
              {session.authorization.user_code && <p className="text-sm">{t('cli_tools.authorize_code', { code: session.authorization.user_code })}</p>}
              {session.authorization.expires_in && <p className="text-xs text-muted-foreground">{t('cli_tools.authorize_expires', { minutes: Math.ceil(session.authorization.expires_in / 60) })}</p>}
              <p className="text-xs text-muted-foreground">{t('cli_tools.authorize_waiting')}</p>
            </>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('cli_tools.working')}</p>
          )}
          <Button ref={cancelRef} size="sm" variant="ghost" onClick={cancelSession}>{t('cli_tools.cancel_session')}</Button>
        </div>
      )}
      {live && !session && (
        <div className="flex flex-wrap gap-2">
          {status?.state === 'not_configured' && <Button size="sm" disabled={!canStart} onClick={() => void startSession('init')}>{t('cli_tools.setup')}</Button>}
          {status && ['not_logged_in', 'expired', 'verify_failed'].includes(status.state) && (
            <Button size="sm" disabled={!canStart} onClick={() => void startSession('login')}>{t('cli_tools.login')}</Button>
          )}
          {status?.state === 'signed_in' && (
            <>
              <Button size="sm" variant="outline" disabled={!canStart} onClick={() => void act('verify')}>{busy === 'verify' ? t('cli_tools.working') : t('cli_tools.verify')}</Button>
              <Button size="sm" variant="outline" disabled={!canStart} onClick={() => void act('logout')}>{busy === 'logout' ? t('cli_tools.working') : t('cli_tools.logout')}</Button>
              <Button size="sm" variant="ghost" disabled={!canStart} onClick={() => void startSession('login')}>{t('cli_tools.relogin')}</Button>
            </>
          )}
        </div>
      )}
      {message && <p ref={messageRef} tabIndex={-1} role={message.tone === 'error' ? 'alert' : 'status'} className={`text-xs outline-none ${message.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{message.text}</p>}
    </section>
  )
}
