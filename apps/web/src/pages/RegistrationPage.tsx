import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { authApi } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../components/ui/button'
import { isPasswordLengthValid, useAuthConfiguration } from '../hooks/useAuthConfiguration'

export default function RegistrationPage() {
  const navigate = useNavigate(); const { reloadUser } = useAuth()
  const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const { google_auth_available: googleAvailable, password_min_length: passwordMinLength, password_max_length: passwordMaxLength } = useAuthConfiguration()
  const passwordValid = isPasswordLengthValid(password, passwordMinLength, passwordMaxLength)
  const canPasswordRegister = Boolean(email.trim()) && passwordValid
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canPasswordRegister) return; setBusy(true); setError('')
    try {
      const intent = await authApi.registrationIntent({ email })
      await authApi.register({ intent_id: intent.intentId, claim_secret: intent.claimSecret, email, password, name: name || undefined })
      await reloadUser(); navigate('/', { replace: true })
    } catch { setError('Open registration is disabled. The first account must use INSTANCE_ADMIN_EMAIL, and later accounts require an invitation.') }
    finally { setBusy(false) }
  }
  async function registerGoogle() {
    setBusy(true); setError('')
    try { const intent = await authApi.registrationIntent({ email }); const result = await authApi.registerGoogle({ intent_id: intent.intentId, claim_secret: intent.claimSecret }); window.location.href = result.url }
    catch { setError('Google registration is unavailable. The first account still requires the configured admin email.') }
    finally { setBusy(false) }
  }
  return <div className="min-h-screen flex items-center justify-center bg-background"><form onSubmit={submit} className="w-full max-w-md space-y-4 p-8 rounded-2xl border border-border bg-card"><h1 className="text-xl font-semibold">Create the first account</h1><p className="text-sm text-muted-foreground">Bootstrap is limited to the configured instance administrator.</p>{error && <p className="text-sm text-destructive">{error}</p>}<input value={name} onChange={e => setName(e.target.value)} placeholder="Display name (optional)" className="w-full h-10 px-3 rounded-lg border border-border bg-background" /><input value={email} onChange={e => setEmail(e.target.value)} type="email" required placeholder="Email" className="w-full h-10 px-3 rounded-lg border border-border bg-background" /><input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder={`Password (${passwordMinLength}–${passwordMaxLength} characters)`} className="w-full h-10 px-3 rounded-lg border border-border bg-background" /><Button disabled={busy || !canPasswordRegister} className="w-full h-10">{busy ? 'Creating account…' : 'Create with password'}</Button>{googleAvailable && <Button type="button" variant="outline" disabled={busy || !email} onClick={() => void registerGoogle()} className="w-full h-10">Create with Google</Button>}<button type="button" onClick={() => navigate('/login')} className="w-full cursor-pointer text-sm text-muted-foreground">Back to sign in</button></form></div>
}
