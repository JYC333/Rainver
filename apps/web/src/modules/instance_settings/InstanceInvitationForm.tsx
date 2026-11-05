import { useState, type FormEvent } from 'react'
import { authApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { OneTimeLink } from '../../components/OneTimeLink'
import { useAppTranslation } from '../../i18n'

export function InstanceInvitationForm() {
  const { t } = useAppTranslation()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [invitation, setInvitation] = useState<{ email: string; link: string } | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !email.trim()) return
    setBusy(true)
    setError(false)
    setInvitation(null)
    try {
      const result = await authApi.adminInvite(email.trim())
      setInvitation({ email: result.invited_email, link: `${window.location.origin}/invitations/claim#token=${encodeURIComponent(result.token)}` })
      setEmail('')
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return <section className="mt-4 space-y-3" aria-label={t('management_ui.instance_invite.title')}>
    <p className="text-sm font-medium">{t('management_ui.instance_invite.title')}</p>
    <p className="text-sm text-muted-foreground">{t('management_ui.instance_invite.description')}</p>
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => void submit(event)}>
      <label className="min-w-0 flex-1 space-y-1 text-sm">
        <span>{t('management_ui.instance_invite.email')}</span>
        <Input type="email" required maxLength={256} autoComplete="off" value={email} disabled={busy} onChange={event => setEmail(event.target.value)} />
      </label>
      <Button type="submit" size="sm" disabled={busy || !email.trim()}>{t(busy ? 'management_ui.instance_invite.creating' : 'management_ui.instance_invite.generate')}</Button>
    </form>
    {error && <p className="text-sm text-destructive" role="alert">{t('management_ui.instance_invite.failed')}</p>}
    {invitation && <OneTimeLink link={invitation.link} label={t('management_ui.instance_invite.link', { email: invitation.email })} onDismiss={() => setInvitation(null)} />}
  </section>
}
