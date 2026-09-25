import { useEffect, useState } from 'react'
import { authApi } from '../../api/client'
import type { AdminAuthUser, RegistrationIntentAdmin } from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'

export function UsersSecurityPanel() {
  const [users, setUsers] = useState<AdminAuthUser[]>([])
  const [intents, setIntents] = useState<RegistrationIntentAdmin[]>([])
  const [message, setMessage] = useState('')
  async function load() {
    try { const [nextUsers, nextIntents] = await Promise.all([authApi.adminUsers(), authApi.adminRegistrationIntents()]); setUsers(nextUsers); setIntents(nextIntents) }
    catch { setMessage('Users and security data is unavailable.') }
  }
  useEffect(() => { void load() }, [])
  async function toggle(user: AdminAuthUser) { try { if (user.status === 'disabled') await authApi.adminEnableUser(user.id); else await authApi.adminDisableUser(user.id); await load() } catch { setMessage('The user status could not be changed.') } }
  async function resetLink(user: AdminAuthUser) { try { const result = await authApi.adminResetLink(user.id); await navigator.clipboard?.writeText(result.reset_link); setMessage(`A one-time reset link for ${user.email} was copied. Handle it as a secret.`) } catch { setMessage('A reset link could not be generated.') } }
  return <Card><CardTitle>Users &amp; Security</CardTitle><p className="text-sm text-muted-foreground mt-1">Disable accounts, issue manual reset links, and inspect pending registrations.</p>{message && <p className="text-sm text-muted-foreground mt-3" role="status">{message}</p>}<div className="divide-y mt-4">{users.map(user => <div key={user.id} className="py-3 flex items-center justify-between gap-3"><div><p className="font-medium">{user.display_name} <span className="text-muted-foreground">({user.email})</span></p><p className="text-xs text-muted-foreground">{user.status} · {user.account_count} login method(s) · {user.registration_source}</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => void resetLink(user)}>Reset link</Button><Button variant="outline" disabled={user.id === users.find(candidate => candidate.email === user.email)?.id && user.email === ''} onClick={() => void toggle(user)}>{user.status === 'disabled' ? 'Enable' : 'Disable'}</Button></div></div>)}</div><div className="border-t mt-4 pt-4"><p className="font-medium">Pending registration intents</p><p className="text-sm text-muted-foreground">{intents.filter(intent => intent.state !== 'completed').length} pending or expired records</p></div></Card>
}
