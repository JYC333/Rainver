import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { authApi } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../components/ui/button'
import { useAuthConfiguration } from '../hooks/useAuthConfiguration'
import { useAppTranslation } from '../i18n'
import { PublicLocaleSwitcher } from '../i18n/PublicLocaleSwitcher'

/* ── Aperture A mark (inline, no deps) ────────────────────────────────────── */
function ApertureMark({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" style={{ flexShrink: 0 }}>
      <rect width="512" height="512" rx="96" fill="var(--card)" />
      <rect x="80" y="80" width="352" height="352" rx="48" fill="var(--background)" stroke="var(--border)" strokeWidth="8" />
      <path d="M 176 360 L 232 184 Q 256 132 280 184 L 336 360"
        fill="none" stroke="var(--primary)" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="212" y1="288" x2="300" y2="288" stroke="var(--primary)" strokeWidth="44" strokeLinecap="round" />
      <circle cx="256" cy="288" r="18" fill="var(--accent-foreground)" />
    </svg>
  )
}

const ERROR_MESSAGE_KEYS: Record<string, string> = {
  csrf: 'login.csrf',
  google_failed: 'login.google_failed',
  incomplete_profile: 'login.incomplete_profile',
}

export default function LoginPage() {
  const { t } = useAppTranslation()
  const { currentUser, isLoading, reloadUser } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const {
    google_auth_available: googleAuthAvailable,
    bootstrap_registration_available: bootstrapRegistrationAvailable,
  } = useAuthConfiguration()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [registrationCompleting, setRegistrationCompleting] = useState(false)
  const attemptedRegistration = useRef<string | null>(null)

  // Redirect to the page the user was trying to reach (or home)
  const from = (location.state as { from?: Location })?.from?.pathname ?? '/'

  // If already logged in, go to original destination
  useEffect(() => {
    if (!isLoading && currentUser) navigate(from, { replace: true })
  }, [isLoading, currentUser, navigate, from])

  useEffect(() => {
    const registrationId = params.get('registration')
    if (!registrationId || attemptedRegistration.current === registrationId) return
    attemptedRegistration.current = registrationId
    setRegistrationCompleting(true)
    void authApi.completeRegistration({ intent_id: registrationId })
      .then(async () => { await reloadUser(); navigate(from, { replace: true }) })
      .catch(() => {
        setFormError('login.registration_failed')
        const next = new URLSearchParams(params)
        next.delete('registration')
        setParams(next, { replace: true })
      })
      .finally(() => setRegistrationCompleting(false))
  }, [params, reloadUser, navigate, from, setParams])

  const error = params.get('error')
  const errorMsg = error ? t(ERROR_MESSAGE_KEYS[error] ?? 'login.unknown_error') : null

  async function signIn(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFormError('')
    try {
      await authApi.passwordLogin({ email, password, rememberMe })
      await reloadUser()
      navigate(from, { replace: true })
    } catch {
      setFormError('login.invalid_credentials')
    } finally {
      setBusy(false)
    }
  }

  async function requestReset() {
    setResetSent(false)
    try { await authApi.requestPasswordReset(email) } catch { /* avoid revealing whether the address exists */ }
    setResetSent(true)
  }

  if (isLoading || registrationCompleting) return null

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background">
      <PublicLocaleSwitcher />
      <div
        className="flex flex-col items-center gap-8 p-10 rounded-2xl border border-border"
        style={{ background: 'var(--card)', minWidth: 340, maxWidth: 400 }}
      >
        {/* Brand */}
        <div className="flex flex-col items-center gap-3">
          <ApertureMark size={56} />
          <div className="text-center">
            <h1 className="text-xl font-bold tracking-tight text-foreground">rainver</h1>
            <p className="text-sm text-muted-foreground mt-1">{t('login.continue')}</p>
          </div>
        </div>

        {(errorMsg || formError) && (
          <div className="w-full text-sm px-3 py-2.5 rounded-lg border text-destructive">{formError ? t(formError) : errorMsg}</div>
        )}

        <form onSubmit={signIn} className="w-full space-y-3">
          <input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="email" required placeholder={t('login.email')} className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm" />
          <input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" required placeholder={t('login.password')} className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm" />
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} /> {t('login.remember')}</label>
          <Button type="submit" disabled={busy} className="w-full h-10">{busy ? t('login.signing_in') : t('login.sign_in')}</Button>
          <button type="button" onClick={() => void requestReset()} className="w-full cursor-pointer text-xs text-muted-foreground underline">{t('login.forgot_password')}</button>
        </form>
        {resetSent && <p className="w-full text-xs text-muted-foreground" role="status">{t('login.reset_sent')}</p>}

        <div className="w-full flex items-center gap-2 text-xs text-muted-foreground"><span className="h-px bg-border flex-1" />{t('login.or')}<span className="h-px bg-border flex-1" /></div>

        {/* Google sign in */}
        {googleAuthAvailable ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => authApi.googleLogin(params.get('redirect') ?? undefined)}
            className="w-full h-10 gap-3 text-foreground"
          >
            <GoogleIcon />
            {t('login.sign_in_google')}
          </Button>
        ) : (
          <div className="w-full text-center space-y-2">
            <div
              className="text-sm px-3 py-2.5 rounded-lg border"
              style={{
                background: 'color-mix(in oklch, var(--warning) 10%, transparent)',
                borderColor: 'color-mix(in oklch, var(--warning) 30%, transparent)',
                color: 'var(--warning)',
              }}
            >
              {t('login.google_unconfigured')}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('login.google_setup', { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET', envFile: '.env' })}
            </p>
          </div>
        )}

        {bootstrapRegistrationAvailable && (
          <button type="button" onClick={() => navigate('/register')} className="cursor-pointer text-xs text-muted-foreground underline">{t('login.setup_admin')}</button>
        )}
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  )
}
