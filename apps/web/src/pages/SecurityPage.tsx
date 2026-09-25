import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { KeyRound, LogOut, ShieldCheck, UserRound } from 'lucide-react'
import { ApiRequestError, authApi } from '../api/client'
import type { AuthAccount, AuthSession } from '../types/api'
import { Card, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { isPasswordLengthValid, useAuthConfiguration } from '../hooks/useAuthConfiguration'

export default function SecurityPage() {
  const { google_auth_available: googleAvailable, password_min_length: passwordMinLength, password_max_length: passwordMaxLength } = useAuthConfiguration()
  const [accounts, setAccounts] = useState<AuthAccount[]>([])
  const [sessions, setSessions] = useState<AuthSession[]>([])
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const passwordValid = isPasswordLengthValid(newPassword, passwordMinLength, passwordMaxLength)
  const [reauthPassword, setReauthPassword] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [grantExpiresAt, setGrantExpiresAt] = useState<number | null>(null)
  const [params, setParams] = useSearchParams()
  const googleReauthAttempted = useRef(false)
  const completingGoogleReauth = params.get('google_reauth') === '1'
  const verified = grantExpiresAt !== null && grantExpiresAt > Date.now()
  const hasPassword = accounts.some(account => account.provider === 'credential')
  const hasGoogle = accounts.some(account => account.provider === 'google')

  async function reload() {
    setLoading(true)
    try {
      const [nextAccounts, nextSessions] = await Promise.all([authApi.accounts(), authApi.sessions()])
      setAccounts(nextAccounts); setSessions(nextSessions)
    } catch { setMessage('安全信息暂时无法加载。') } finally { setLoading(false) }
  }
  useEffect(() => {
    if (completingGoogleReauth) return
    let active = true
    setLoading(true)
    void Promise.all([authApi.accounts(), authApi.reauthStatus()])
      .then(async ([nextAccounts, status]) => {
        if (!active) return
        const expiresAt = status.expires_at ? Date.parse(status.expires_at) : NaN
        const validUntil = Number.isFinite(expiresAt) && expiresAt > Date.now() ? expiresAt : null
        setAccounts(nextAccounts)
        setGrantExpiresAt(validUntil)
        if (validUntil !== null) {
          const nextSessions = await authApi.sessions()
          if (active) setSessions(nextSessions)
        }
      })
      .catch(() => { if (active) setMessage('安全信息暂时无法加载。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [completingGoogleReauth])
  useEffect(() => {
    if (grantExpiresAt === null) return
    const timer = window.setTimeout(() => {
      setGrantExpiresAt(null)
      setSessions([])
      setCurrentPassword('')
      setNewPassword('')
      setMessage('验证已过期，请重新验证后继续。')
    }, Math.max(0, grantExpiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [grantExpiresAt])
  useEffect(() => {
    if (!completingGoogleReauth || googleReauthAttempted.current) return
    googleReauthAttempted.current = true
    void authApi.completeGoogleReauth()
      .then(() => setMessage('Google reauthentication completed for 10 minutes.'))
      .catch(() => setMessage('Google reauthentication failed.'))
      .finally(() => {
        const next = new URLSearchParams(params)
        next.delete('google_reauth')
        setParams(next, { replace: true })
      })
  }, [completingGoogleReauth, params, setParams])

  async function reauth() {
    if (!reauthPassword || busy) return
    setBusy(true)
    try {
      await authApi.reauth(reauthPassword)
      const status = await authApi.reauthStatus()
      const expiresAt = status.expires_at ? Date.parse(status.expires_at) : NaN
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Reauthentication grant unavailable')
      setGrantExpiresAt(expiresAt)
      setReauthPassword('')
      setMessage('身份已验证，下面的安全设置可在 10 分钟内使用。')
      await reload()
    } catch { setMessage('重新认证失败，请检查当前密码。'); setGrantExpiresAt(null) }
    finally { setBusy(false) }
  }
  function actionError(error: unknown, fallback: string) {
    if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
      setGrantExpiresAt(null)
      setSessions([])
      setCurrentPassword('')
      setNewPassword('')
      setMessage('验证已过期，请重新验证后继续。')
    } else setMessage(fallback)
  }
  async function relockAfterChange(message: string) {
    setGrantExpiresAt(null)
    setSessions([])
    setCurrentPassword('')
    setNewPassword('')
    setMessage(message)
    try { setAccounts(await authApi.accounts()) }
    catch { setMessage(`${message} 登录方式列表暂时无法刷新。`) }
  }
  async function savePassword() {
    if (!passwordValid) return
    try {
      if (hasPassword) await authApi.changePassword({ current_password: currentPassword, new_password: newPassword })
      else await authApi.setPassword(newPassword)
      setCurrentPassword(''); setNewPassword('')
      await relockAfterChange('密码已更新，请重新验证后继续。')
    } catch (error) { actionError(error, '密码更新失败。') }
  }
  async function linkGoogle() {
    try { const result = await authApi.linkGoogle(); window.location.href = result.url }
    catch (error) { actionError(error, 'Google 绑定暂时不可用。') }
  }
  async function googleReauth() {
    try { const result = await authApi.googleReauth(); window.location.href = result.url }
    catch { setMessage('Google reauthentication is unavailable.') }
  }
  async function unlinkGoogle(accountId: string) {
    try { await authApi.unlinkGoogle(accountId); await relockAfterChange('Google 已解绑，请重新验证后继续。') }
    catch (error) { actionError(error, 'Google 解绑失败；最后一个登录方式不能移除。') }
  }

  return <div className="p-6 space-y-6 max-w-4xl">
    <div className="flex items-center gap-4 pb-4 border-b border-border">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-primary/10 border border-primary/30"><ShieldCheck className="size-5" /></div>
      <div><h1 className="text-xl font-semibold">Security</h1><p className="text-sm text-muted-foreground">Manage login methods, password and active sessions.</p></div>
    </div>
    {message && <p className="text-sm text-muted-foreground" role="status">{message}</p>}
    {loading ? <Card><p className="text-sm text-muted-foreground">Loading security settings…</p></Card> : !verified ? (
      <Card>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" /> Verify your identity</CardTitle>
        <p className="text-sm text-muted-foreground mb-3">First verify your identity to unlock login methods, password settings and active sessions for 10 minutes.</p>
        {hasPassword && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void reauth() }}><Input type="password" autoComplete="current-password" value={reauthPassword} onChange={event => setReauthPassword(event.target.value)} placeholder="Current password" aria-label="Current password" /><Button type="submit" disabled={!reauthPassword || busy}>{busy ? 'Verifying…' : 'Verify'}</Button></form>}
        {hasGoogle && googleAvailable && <Button variant="outline" className={hasPassword ? 'mt-3' : ''} onClick={() => void googleReauth()}>Verify with Google</Button>}
        {!hasPassword && !(hasGoogle && googleAvailable) && <p className="text-sm text-muted-foreground">No login method is currently available for verification. Contact the instance administrator.</p>}
      </Card>
    ) : <>
      <Card><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" /> Identity verified</CardTitle><p className="text-sm text-muted-foreground">You can now manage the settings below. This access closes automatically after 10 minutes.</p></Card>
      <Card>
        <CardTitle className="flex items-center gap-2"><UserRound className="size-4" /> Login methods</CardTitle>
        <div className="space-y-2 mt-3">{accounts.map(account => <div key={account.id} className="flex items-center justify-between border rounded-md p-3"><span>{account.provider === 'credential' ? 'Email and password' : account.provider}</span>{account.provider === 'google' && <Button variant="outline" disabled={accounts.length <= 1} onClick={() => void unlinkGoogle(account.id)}>Unlink</Button>}</div>)}
        {!hasGoogle && (googleAvailable ? <Button variant="outline" onClick={() => void linkGoogle()}>Link Google</Button> : <p className="text-sm text-muted-foreground">Google login is not configured for this instance.</p>)}</div>
      </Card>
      <Card>
        <CardTitle>Password</CardTitle>
        <div className="grid gap-3 mt-3">{hasPassword && <><Label htmlFor="current-password">Current password</Label><Input id="current-password" type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></>}<Label htmlFor="new-password">New password ({passwordMinLength}–{passwordMaxLength} characters)</Label><Input id="new-password" type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} /><Button onClick={() => void savePassword()} disabled={!passwordValid}>Save password</Button></div>
      </Card>
      <Card>
        <CardTitle>Active sessions</CardTitle>
        <div className="space-y-2 mt-3">{sessions.map(session => <div key={session.id} className="flex items-center justify-between border rounded-md p-3"><div><p className="text-sm">{session.current ? 'This browser' : session.user_agent || 'Unknown browser'}</p><p className="text-xs text-muted-foreground">{session.ip_address || 'Unknown IP'} · expires {new Date(session.expires_at).toLocaleString()}</p></div>{!session.current && <Button variant="outline" onClick={() => void authApi.revokeSession(session.id).then(reload)}>Revoke</Button>}</div>)}<Button variant="outline" onClick={() => void authApi.revokeOtherSessions().then(reload)}><LogOut className="size-4 mr-2" />Revoke other sessions</Button></div>
      </Card>
    </>}
  </div>
}
