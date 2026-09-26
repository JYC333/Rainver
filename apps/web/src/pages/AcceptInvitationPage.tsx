import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { authApi, spacesApi } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSpace } from '../contexts/SpaceContext'
import { spacePath } from '../core/navigation'
import { Button } from '../components/ui/button'
import { isPasswordLengthValid, useAuthConfiguration } from '../hooks/useAuthConfiguration'
import { useAppTranslation } from '../i18n'
import { PublicLocaleSwitcher } from '../i18n/PublicLocaleSwitcher'

/** Invitation claim tokens live in the URL fragment and are erased before any request. */
export default function AcceptInvitationPage() {
  const { t } = useAppTranslation()
  const navigate = useNavigate()
  const { currentUser, isLoading, reloadUser } = useAuth()
  const { reloadSpaces } = useSpace()
  const [token, setToken] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [intent, setIntent] = useState<{ intentId: string; claimSecret: string } | null>(null)
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const {
    google_auth_available: googleAvailable,
    password_min_length: passwordMinLength,
    password_max_length: passwordMaxLength,
  } = useAuthConfiguration()
  const passwordValid = isPasswordLengthValid(password, passwordMinLength, passwordMaxLength)

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const raw = params.get('token')
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    setToken(raw)
    if (!raw) setError('public_auth.invitation.token_missing')
  }, [])

  async function acceptExistingAccount() {
    if (!token) return
    setBusy(true)
    setError('')
    try {
      const result = await spacesApi.acceptInvitation(token)
      setToken(null)
      await reloadSpaces()
      navigate(spacePath(result.space_id, '/today'), { replace: true })
    } catch {
      setError('public_auth.invitation.existing_invalid')
    } finally {
      setBusy(false)
    }
  }

  async function claim() {
    if (!token || !email) return
    setBusy(true)
    setError('')
    try {
      const result = await authApi.registrationIntent({ email, invitation_token: token })
      setIntent({ intentId: result.intentId, claimSecret: result.claimSecret })
      setToken(null)
    } catch {
      setError('public_auth.invitation.claim_invalid')
    } finally {
      setBusy(false)
    }
  }

  async function registerGoogle() {
    if (!intent) return
    setBusy(true)
    setError('')
    try {
      const result = await authApi.registerGoogle({ intent_id: intent.intentId, claim_secret: intent.claimSecret })
      window.location.href = result.url
    } catch {
      setError('public_auth.invitation.google_unavailable')
    } finally {
      setBusy(false)
    }
  }

  async function register(event: FormEvent) {
    event.preventDefault()
    if (!intent || !passwordValid) return
    setBusy(true)
    setError('')
    try {
      await authApi.register({
        intent_id: intent.intentId,
        claim_secret: intent.claimSecret,
        email,
        password,
        name: name || undefined,
      })
      await reloadUser()
      navigate('/', { replace: true })
    } catch {
      setError('public_auth.invitation.register_failed')
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) return null

  if (currentUser) {
    return (
      <Frame>
        <h1 className="text-xl font-semibold text-foreground">{t('public_auth.invitation.join_space')}</h1>
        <p className="text-sm text-muted-foreground">{t('public_auth.invitation.accept_as', { email: currentUser.email })}</p>
        {error && <p className="text-sm text-destructive">{t(error)}</p>}
        <Button className="w-full h-10" disabled={!token || busy} onClick={() => void acceptExistingAccount()}>
          {busy ? t('public_auth.invitation.joining') : t('public_auth.invitation.join_space')}
        </Button>
      </Frame>
    )
  }

  return (
    <Frame>
      <h1 className="text-xl font-semibold text-foreground">{t('public_auth.invitation.join_rainver')}</h1>
      <p className="text-sm text-muted-foreground">{t('public_auth.invitation.create_description')}</p>
      {error && <p className="w-full rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{t(error)}</p>}
      {!intent ? (
        <div className="w-full space-y-3">
          <input
            value={email}
            onChange={event => setEmail(event.target.value)}
            type="email"
            required
            placeholder={t('public_auth.invitation.invited_email')}
            className="w-full h-10 px-3 rounded-lg border border-border bg-background"
          />
          <Button disabled={busy || !token} onClick={() => void claim()} className="w-full h-10">
            {busy ? t('public_auth.invitation.checking') : t('public_auth.invitation.create_new')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('public_auth.invitation.already_account')}</p>
          <Button variant="outline" onClick={() => navigate('/login')} className="w-full h-10">
            {t('public_auth.invitation.sign_in')}
          </Button>
        </div>
      ) : (
        <>
          <form onSubmit={register} className="w-full space-y-3">
            <input
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={t('public_auth.registration.display_name')}
              className="w-full h-10 px-3 rounded-lg border border-border bg-background"
            />
            <input
              value={password}
              onChange={event => setPassword(event.target.value)}
              type="password"
              placeholder={t('public_auth.registration.password_bounds', { min: passwordMinLength, max: passwordMaxLength })}
              className="w-full h-10 px-3 rounded-lg border border-border bg-background"
            />
            <Button disabled={busy || !passwordValid} className="w-full h-10">
              {busy ? t('public_auth.registration.creating') : t('public_auth.registration.create_password')}
            </Button>
          </form>
          {googleAvailable && (
            <Button variant="outline" disabled={busy} onClick={() => void registerGoogle()} className="w-full h-10">
              {t('public_auth.invitation.continue_google')}
            </Button>
          )}
        </>
      )}
    </Frame>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background">
      <PublicLocaleSwitcher />
      <div className="w-full max-w-md space-y-5 p-8 rounded-2xl border border-border bg-card">{children}</div>
    </div>
  )
}
