import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { authApi } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../components/ui/button'
import { isPasswordLengthValid, useAuthConfiguration } from '../hooks/useAuthConfiguration'
import { useAppTranslation } from '../i18n'
import { PublicLocaleSwitcher } from '../i18n/PublicLocaleSwitcher'

export default function RegistrationPage() {
  const { t } = useAppTranslation()
  const navigate = useNavigate()
  const { reloadUser } = useAuth()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const {
    google_auth_available: googleAvailable,
    password_min_length: passwordMinLength,
    password_max_length: passwordMaxLength,
  } = useAuthConfiguration()
  const passwordValid = isPasswordLengthValid(password, passwordMinLength, passwordMaxLength)
  const canPasswordRegister = Boolean(email.trim()) && passwordValid

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canPasswordRegister) return
    setBusy(true)
    setError('')
    try {
      const intent = await authApi.registrationIntent({ email })
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
      setError('public_auth.registration.open_disabled')
    } finally {
      setBusy(false)
    }
  }

  async function registerGoogle() {
    setBusy(true)
    setError('')
    try {
      const intent = await authApi.registrationIntent({ email })
      const result = await authApi.registerGoogle({
        intent_id: intent.intentId,
        claim_secret: intent.claimSecret,
      })
      window.location.href = result.url
    } catch {
      setError('public_auth.registration.google_unavailable')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background">
      <PublicLocaleSwitcher />
      <form onSubmit={submit} className="w-full max-w-md space-y-4 p-8 rounded-2xl border border-border bg-card">
        <h1 className="text-xl font-semibold">{t('public_auth.registration.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('public_auth.registration.subtitle')}</p>
        {error && <p className="text-sm text-destructive">{t(error)}</p>}
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder={t('public_auth.registration.display_name')}
          className="w-full h-10 px-3 rounded-lg border border-border bg-background"
        />
        <input
          value={email}
          onChange={event => setEmail(event.target.value)}
          type="email"
          required
          placeholder={t('public_auth.registration.email')}
          className="w-full h-10 px-3 rounded-lg border border-border bg-background"
        />
        <input
          value={password}
          onChange={event => setPassword(event.target.value)}
          type="password"
          placeholder={t('public_auth.registration.password_bounds', { min: passwordMinLength, max: passwordMaxLength })}
          className="w-full h-10 px-3 rounded-lg border border-border bg-background"
        />
        <Button disabled={busy || !canPasswordRegister} className="w-full h-10">
          {busy ? t('public_auth.registration.creating') : t('public_auth.registration.create_password')}
        </Button>
        {googleAvailable && (
          <Button type="button" variant="outline" disabled={busy || !email} onClick={() => void registerGoogle()} className="w-full h-10">
            {t('public_auth.registration.create_google')}
          </Button>
        )}
        <button type="button" onClick={() => navigate('/login')} className="w-full cursor-pointer text-sm text-muted-foreground">
          {t('public_auth.registration.back_login')}
        </button>
      </form>
    </div>
  )
}
