import { useState, type FormEvent } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { authApi } from '../api/client'
import { Button } from '../components/ui/button'
import { isPasswordLengthValid, useAuthConfiguration } from '../hooks/useAuthConfiguration'

export default function ResetPasswordPage() {
  const [params] = useSearchParams(); const navigate = useNavigate()
  const { password_min_length: passwordMinLength, password_max_length: passwordMaxLength } = useAuthConfiguration()
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false)
  const token = params.get('token') ?? ''
  const passwordValid = isPasswordLengthValid(password, passwordMinLength, passwordMaxLength)
  const canSubmit = Boolean(token) && passwordValid && password === confirm
  async function submit(event: FormEvent) { event.preventDefault(); if (!canSubmit) return; setMessage(''); setBusy(true); try { await authApi.completePasswordReset(token, password); setMessage('Password reset. You can sign in now.'); setTimeout(() => navigate('/login'), 700) } catch { setMessage('The reset link is invalid, expired, or already used.') } finally { setBusy(false) } }
  return <div className="min-h-screen flex items-center justify-center bg-background"><form onSubmit={submit} className="w-full max-w-sm space-y-4 p-6 rounded-xl border border-border bg-card"><h1 className="text-xl font-semibold">Reset password</h1><p className="text-sm text-muted-foreground">Choose a new password with {passwordMinLength}–{passwordMaxLength} characters.</p><input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="New password" className="w-full h-10 px-3 rounded-lg border border-border bg-background" /><input type="password" value={confirm} onChange={event => setConfirm(event.target.value)} placeholder="Confirm password" className="w-full h-10 px-3 rounded-lg border border-border bg-background" />{message && <p className="text-sm text-muted-foreground" role="status">{message}</p>}<Button disabled={busy || !canSubmit} className="w-full h-10">{busy ? 'Saving…' : 'Reset password'}</Button></form></div>
}
