import { useEffect, useState, type FormEvent } from 'react'
import { UserPlus } from 'lucide-react'
import { authApi, ApiRequestError } from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { useAuthConfiguration } from '../../hooks/useAuthConfiguration'
import { useAppTranslation } from '../../i18n'
import type { BrowserAccount } from '../../types/api'
import { GoogleIcon } from '../GoogleIcon'
import { UserAvatar } from '../UserAvatar'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { DropdownMenuGroup, DropdownMenuItem } from '../ui/dropdown-menu'
import { Input } from '../ui/input'

type AccountsState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; accounts: BrowserAccount[]; limit: number }

/** This browser's accounts, read each time the menu opens so an account revoked elsewhere is gone. */
export function useBrowserAccounts(open: boolean): AccountsState {
  const [state, setState] = useState<AccountsState>({ status: 'loading' })
  useEffect(() => {
    if (!open) return
    let active = true
    setState({ status: 'loading' })
    authApi.browserAccounts()
      .then(result => { if (active) setState({ status: 'ready', accounts: result.accounts, limit: result.limit }) })
      .catch(() => { if (active) setState({ status: 'failed' }) })
    return () => { active = false }
  }, [open])
  return state
}

const rowClass = 'w-full rounded-none gap-2 px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground'

/**
 * The other accounts to switch to, and the entry that adds one. Items of the
 * avatar menu (`DropdownMenu`), so they share its keyboard and focus handling.
 */
export function BrowserAccountSection({ state, onAdd }: { state: AccountsState; onAdd: () => void }) {
  const { switchAccount } = useAuth()
  const { t } = useAppTranslation()
  const [switching, setSwitching] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const others = state.status === 'ready' ? state.accounts.filter(account => !account.active) : []
  const full = state.status === 'ready' && state.accounts.length >= state.limit

  async function choose(account: BrowserAccount) {
    setSwitching(account.user_id)
    setFailed(false)
    try {
      await switchAccount(account.user_id)
    } catch {
      setFailed(true)
      setSwitching(null)
    }
  }

  return (
    <DropdownMenuGroup className="border-b border-border py-1" aria-label={t('shell.accounts')}>
      {state.status === 'loading' && <p className="px-3 py-2 text-[11px] text-muted-foreground" role="status">{t('shell.accounts_loading')}</p>}
      {state.status === 'failed' && <p className="px-3 py-2 text-[11px] text-destructive" role="alert">{t('shell.accounts_failed')}</p>}
      {others.map(account => (
        <DropdownMenuItem
          key={account.user_id}
          // Stays open while switching, so progress and a refusal are seen.
          onSelect={event => { event.preventDefault(); if (switching === null) void choose(account) }}
          disabled={switching !== null}
          className={rowClass}
          title={t('shell.switch_to_account', { name: account.display_name })}
        >
          <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border">
            <UserAvatar avatarUrl={account.avatar_url} displayName={account.display_name} email={account.email} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-foreground">{account.display_name}</span>
            <span className="block truncate text-[11px]">{switching === account.user_id ? t('shell.switching_account') : account.email}</span>
          </span>
        </DropdownMenuItem>
      ))}
      {failed && <p className="px-3 py-1 text-[11px] text-destructive" role="alert">{t('shell.switch_account_failed')}</p>}
      <DropdownMenuItem onSelect={onAdd} disabled={full || switching !== null} className={rowClass}>
        <UserPlus size={13} />
        {t('shell.add_account')}
      </DropdownMenuItem>
      {full && <p className="px-3 pb-1 text-[11px] text-muted-foreground">{t('shell.account_limit')}</p>}
    </DropdownMenuGroup>
  )
}

/**
 * Signs in to an existing account beside the current one. Nothing changes in
 * the browser until it succeeds: a wrong password, or cancelling Google,
 * leaves the current account signed in and active. Mounted only while open,
 * so the shell does not read the auth configuration on every load.
 */
export function AddAccountDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { addPasswordAccount, addGoogleAccount } = useAuth()
  const { google_auth_available: googleAvailable } = useAuthConfiguration()
  const { t } = useAppTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await addPasswordAccount({ email, password, rememberMe })
    } catch (failure) {
      const code = failure instanceof ApiRequestError ? failure.code : undefined
      setError(code === 'account_limit' ? 'shell.account_limit'
        : code === 'logout_pending' ? 'login.logout_pending'
          : code === 'signed_out' ? 'login.signed_out'
            : 'login.invalid_credentials')
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader className="mb-4">
          <DialogTitle>{t('shell.add_account_title')}</DialogTitle>
          <DialogDescription>{t('shell.add_account_description')}</DialogDescription>
        </DialogHeader>
        {error && <div className="mb-3 rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">{t(error)}</div>}
        <form onSubmit={submit} className="space-y-3">
          <Input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="username" required aria-label={t('login.email')} placeholder={t('login.email')} />
          <Input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" required aria-label={t('login.password')} placeholder={t('login.password')} />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} />
            {t('login.remember')}
          </label>
          <Button type="submit" disabled={busy} className="w-full">{busy ? t('login.signing_in') : t('shell.add_account_submit')}</Button>
        </form>
        {googleAvailable && (
          <>
            <div className="my-3 flex items-center gap-2 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />{t('login.or')}<span className="h-px flex-1 bg-border" /></div>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              className="w-full gap-3 text-foreground"
              onClick={() => { setError(null); void addGoogleAccount().catch(() => setError('login.logout_pending')) }}
            >
              <GoogleIcon />
              {t('shell.add_account_google')}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
