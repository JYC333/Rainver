import { useState, type FormEvent } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { authApi } from '../api/client'
import { Button } from '../components/ui/button'
import { isPasswordLengthValid, useAuthConfiguration } from '../hooks/useAuthConfiguration'
import { useAppTranslation } from '../i18n'
import { PublicLocaleSwitcher } from '../i18n/PublicLocaleSwitcher'

export default function ResetPasswordPage() {
  const { t } = useAppTranslation()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { password_min_length: passwordMinLength, password_max_length: passwordMaxLength } = useAuthConfiguration()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const token = params.get('token') ?? ''
  const passwordValid = isPasswordLengthValid(password, passwordMinLength, passwordMaxLength)
  const canSubmit = Boolean(token) && passwordValid && password === confirm

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    setMessage('')
    setBusy(true)
    try {
      await authApi.completePasswordReset(token, password)
      setMessage('public_auth.reset.success')
      setTimeout(() => navigate('/login'), 700)
    } catch {
      setMessage('public_auth.reset.invalid')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background">
      <PublicLocaleSwitcher />
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 p-6 rounded-xl border border-border bg-card">
        <h1 className="text-xl font-semibold">{t('public_auth.reset.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('public_auth.reset.choose_new', { min: passwordMinLength, max: passwordMaxLength })}
        </p>
        <input
          type="password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          placeholder={t('public_auth.reset.new_password')}
          className="w-full h-10 px-3 rounded-lg border border-border bg-background"
        />
        <input
          type="password"
          value={confirm}
          onChange={event => setConfirm(event.target.value)}
          placeholder={t('public_auth.reset.confirm_password')}
          className="w-full h-10 px-3 rounded-lg border border-border bg-background"
        />
        {message && <p className="text-sm text-muted-foreground" role="status">{t(message)}</p>}
        <Button disabled={busy || !canSubmit} className="w-full h-10">
          {busy ? t('public_auth.reset.saving') : t('public_auth.reset.title')}
        </Button>
      </form>
    </div>
  )
}
