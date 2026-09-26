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
import { useAppTranslation } from '../i18n'

export default function SecurityPage() {
  const { t, locale } = useAppTranslation()
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
    } catch { setMessage(t('mixed_surfaces.security.load_failed')) } finally { setLoading(false) }
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
      .catch(() => { if (active) setMessage(t('mixed_surfaces.security.load_failed')) })
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
      setMessage(t('mixed_surfaces.security.verification_expired'))
    }, Math.max(0, grantExpiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [grantExpiresAt])
  useEffect(() => {
    if (!completingGoogleReauth || googleReauthAttempted.current) return
    googleReauthAttempted.current = true
    void authApi.completeGoogleReauth()
      .then(() => setMessage(t('mixed_surfaces.security.google_reauth_complete')))
      .catch(() => setMessage(t('mixed_surfaces.security.google_reauth_failed')))
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
      setMessage(t('mixed_surfaces.security.verified_ten_minutes'))
      await reload()
    } catch { setMessage(t('mixed_surfaces.security.reauth_failed')); setGrantExpiresAt(null) }
    finally { setBusy(false) }
  }
  function actionError(error: unknown, fallback: string) {
    if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
      setGrantExpiresAt(null)
      setSessions([])
      setCurrentPassword('')
      setNewPassword('')
      setMessage(t('mixed_surfaces.security.verification_expired'))
    } else setMessage(fallback)
  }
  async function relockAfterChange(message: string) {
    setGrantExpiresAt(null)
    setSessions([])
    setCurrentPassword('')
    setNewPassword('')
    setMessage(message)
    try { setAccounts(await authApi.accounts()) }
    catch { setMessage(t('mixed_surfaces.security.methods_refresh_failed', { message })) }
  }
  async function savePassword() {
    if (!passwordValid) return
    try {
      if (hasPassword) await authApi.changePassword({ current_password: currentPassword, new_password: newPassword })
      else await authApi.setPassword(newPassword)
      setCurrentPassword(''); setNewPassword('')
      await relockAfterChange(t('mixed_surfaces.security.password_updated'))
    } catch (error) { actionError(error, t('mixed_surfaces.security.password_update_failed')) }
  }
  async function linkGoogle() {
    try { const result = await authApi.linkGoogle(); window.location.href = result.url }
    catch (error) { actionError(error, t('mixed_surfaces.security.google_link_unavailable')) }
  }
  async function googleReauth() {
    try { const result = await authApi.googleReauth(); window.location.href = result.url }
    catch { setMessage(t('mixed_surfaces.security.google_reauth_unavailable')) }
  }
  async function unlinkGoogle(accountId: string) {
    try { await authApi.unlinkGoogle(accountId); await relockAfterChange(t('mixed_surfaces.security.google_unlinked')) }
    catch (error) { actionError(error, t('mixed_surfaces.security.google_unlink_failed')) }
  }

  return <div className="p-6 space-y-6 max-w-4xl">
    <div className="flex items-center gap-4 pb-4 border-b border-border">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-primary/10 border border-primary/30"><ShieldCheck className="size-5" /></div>
      <div><h1 className="text-xl font-semibold">{t('mixed_surfaces.security.title')}</h1><p className="text-sm text-muted-foreground">{t('mixed_surfaces.security.subtitle')}</p></div>
    </div>
    {message && <p className="text-sm text-muted-foreground" role="status">{message}</p>}
    {loading ? <Card><p className="text-sm text-muted-foreground">{t('mixed_surfaces.security.loading')}</p></Card> : !verified ? (
      <Card>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" /> {t('mixed_surfaces.security.verify_title')}</CardTitle>
        <p className="text-sm text-muted-foreground mb-3">{t('mixed_surfaces.security.verify_description')}</p>
        {hasPassword && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void reauth() }}><Input type="password" autoComplete="current-password" value={reauthPassword} onChange={event => setReauthPassword(event.target.value)} placeholder={t('mixed_surfaces.security.current_password')} aria-label={t('mixed_surfaces.security.current_password')} /><Button type="submit" disabled={!reauthPassword || busy}>{busy ? t('mixed_surfaces.security.verifying') : t('mixed_surfaces.security.verify')}</Button></form>}
        {hasGoogle && googleAvailable && <Button variant="outline" className={hasPassword ? 'mt-3' : ''} onClick={() => void googleReauth()}>{t('mixed_surfaces.security.verify_google')}</Button>}
        {!hasPassword && !(hasGoogle && googleAvailable) && <p className="text-sm text-muted-foreground">{t('mixed_surfaces.security.no_method')}</p>}
      </Card>
    ) : <>
      <Card><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" /> {t('mixed_surfaces.security.identity_verified')}</CardTitle><p className="text-sm text-muted-foreground">{t('mixed_surfaces.security.verified_description')}</p></Card>
      <Card>
        <CardTitle className="flex items-center gap-2"><UserRound className="size-4" /> {t('mixed_surfaces.security.login_methods')}</CardTitle>
        <div className="space-y-2 mt-3">{accounts.map(account => <div key={account.id} className="flex items-center justify-between border rounded-md p-3"><span>{account.provider === 'credential' ? t('mixed_surfaces.security.email_password') : account.provider}</span>{account.provider === 'google' && <Button variant="outline" disabled={accounts.length <= 1} onClick={() => void unlinkGoogle(account.id)}>{t('mixed_surfaces.security.unlink')}</Button>}</div>)}
        {!hasGoogle && (googleAvailable ? <Button variant="outline" onClick={() => void linkGoogle()}>{t('mixed_surfaces.security.link_google')}</Button> : <p className="text-sm text-muted-foreground">{t('mixed_surfaces.security.google_unconfigured')}</p>)}</div>
      </Card>
      <Card>
        <CardTitle>{t('mixed_surfaces.security.password_title')}</CardTitle>
        <div className="grid gap-3 mt-3">{hasPassword && <><Label htmlFor="current-password">{t('mixed_surfaces.security.current_password')}</Label><Input id="current-password" type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></>}<Label htmlFor="new-password">{t('mixed_surfaces.security.new_password_bounds', { min: passwordMinLength, max: passwordMaxLength })}</Label><Input id="new-password" type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} /><Button onClick={() => void savePassword()} disabled={!passwordValid}>{t('mixed_surfaces.security.save_password')}</Button></div>
      </Card>
      <Card>
        <CardTitle>{t('mixed_surfaces.security.active_sessions')}</CardTitle>
        <div className="space-y-2 mt-3">{sessions.map(session => <div key={session.id} className="flex items-center justify-between border rounded-md p-3"><div><p className="text-sm">{session.current ? t('mixed_surfaces.security.this_browser') : session.user_agent || t('mixed_surfaces.security.unknown_browser')}</p><p className="text-xs text-muted-foreground">{session.ip_address || t('mixed_surfaces.security.unknown_ip')} · {t('mixed_surfaces.security.expires', { date: new Date(session.expires_at).toLocaleString(locale) })}</p></div>{!session.current && <Button variant="outline" onClick={() => void authApi.revokeSession(session.id).then(reload)}>{t('mixed_surfaces.security.revoke')}</Button>}</div>)}<Button variant="outline" onClick={() => void authApi.revokeOtherSessions().then(reload)}><LogOut className="size-4 mr-2" />{t('mixed_surfaces.security.revoke_other')}</Button></div>
      </Card>
    </>}
  </div>
}
