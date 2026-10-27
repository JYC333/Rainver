import { useState } from 'react'
import RuntimeQuotaDetails from './RuntimeQuotaDetails'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/dialog'
import { CircleArrowUp, Loader2 } from 'lucide-react'
import { isOwnCliUpdateRuntimeKey } from '@rainver/protocol'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import type {
  Host,
  HostRuntimeUsage,
  HostRuntimeDefinitionOption,
  RuntimeAuthMethod,
  RuntimeInstallation,
} from '../../types/api'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip'

export type HostAgentLoginTarget =
  | { kind: 'configured' }
  | { kind: 'acp'; method: RuntimeAuthMethod }
  | { kind: 'cli' }
  | { kind: 'logout' }

/** Version probes often repeat the CLI name; the row already names the Agent. */
function versionLabel(version: string | null): string {
  if (!version) return 'unknown version'
  const numeric = version.match(/\bv?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0]
  return numeric?.replace(/^v/, '') ?? version
}

/** Unknown and prerelease versions cannot establish a safe stable upgrade. */
function hasOwnUpdate(current: string | null, latest: string | null | undefined): boolean {
  const installed = current?.match(/\bv?(\d+)\.(\d+)\.(\d+)(?![\d.+-])/)
  const available = latest?.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!installed || !available) return false
  for (let index = 1; index <= 3; index++) {
    const left = Number(available[index]), right = Number(installed[index])
    if (left !== right) return left > right
  }
  return false
}

function installationVersionLabel(entry: RuntimeInstallation, adapter: HostRuntimeDefinitionOption): string {
  if (entry.id === 'own') return `own · ${versionLabel(entry.version)}`
  if (entry.runtime_version) return `managed · ${versionLabel(entry.runtime_version)}`
  return adapter.reports_managed_cli_version
    ? 'managed · CLI version unavailable'
    : `managed · ${versionLabel(entry.version)}`
}

function authMethodLabel(method: RuntimeAuthMethod, loggedIn: boolean | null): string {
  return loggedIn ? `${method.name} again` : method.name
}

function authMethodAria(method: RuntimeAuthMethod, loggedIn: boolean | null, entryId: string, agentName: string, hostName: string): string {
  return `${authMethodLabel(method, loggedIn)} for ${entryId} of ${agentName} on ${hostName}`
}

export default function HostAgentRow({
  host,
  adapter,
  copies,
  installBusy,
  manageable,
  usage,
  usageBusy,
  onInstall,
  onUpdateOwn,
  onUninstall,
  onLogin,
  onRefreshUsage,
  onRollback,
  rainverPinned = false,
  provisioningFailed = false,
}: {
  host: Host
  adapter: HostRuntimeDefinitionOption
  copies: RuntimeInstallation[]
  installBusy: ReadonlySet<string>
  /**
   * Whether this viewer may change what is installed here. False for a member
   * looking at the built-in host: installing a runtime, logging a copy in or
   * out are instance-admin work, while which
   * copies exist and whether they are logged in is what everyone needs to see
   * to know whether their Run can run at all.
   */
  manageable: boolean
  /**
   * Rainver owns this copy's lifecycle (the Server Runtime's pinned OpenCode):
   * install, upgrade, rollback and remove are the provisioner's, not a
   * person's. Login and usage stay available — that account is still a login
   * someone has to do.
   */
  rainverPinned?: boolean
  /** Whether the Rainver-managed install is in its `failed` state, i.e. whether a Retry is on screen at all. */
  provisioningFailed?: boolean
  /** The cached subscription quota per installation id; absent for a runtime that has none to report. */
  usage: ReadonlyMap<string, HostRuntimeUsage>
  usageBusy: ReadonlySet<string>
  onInstall: () => void
  onUpdateOwn: () => void
  onUninstall: (entry: RuntimeInstallation) => void
  onLogin: (installation: string, target: HostAgentLoginTarget) => void
  onRefreshUsage: (installation: string) => void
  onRollback: () => void
}) {
  const [loginChoice, setLoginChoice] = useState<string | null>(null)
  return (
    <li className="flex min-w-0 flex-col items-start gap-2 rounded-md sm:flex-row sm:items-center border border-border px-2 py-1.5 text-xs" data-testid={`host-agent-${host.id}-${adapter.runtime_key}`}>
      <span className="w-28 shrink-0 truncate font-medium" title={adapter.display_name}>{adapter.display_name}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {copies.map(entry => {
          // One Log in when Rainver's managed CLI login exists. The Agent-Auth
          // handshake runs unattended afterwards: the daemon's probe and every
          // Run session authenticate with it. Do not offer that handshake as
          // a second button.
          const authMethods = entry.options?.cli_login_available ? [] : entry.options?.auth_methods ?? []
          // A CLI that holds several accounts (OpenCode) reports them by
          // provider id and kind. Its login *adds* one and its logout *removes*
          // one, so the words say that; a single-account CLI's login replaces
          // the account, which "Log in again" already says.
          const accounts = entry.accounts
          const multiAccount = accounts !== undefined
          const accountSummary = multiAccount
            ? accounts.length === 0 ? 'no accounts' : `${accounts.length} account${accounts.length === 1 ? '' : 's'}`
            : null
          // Only where a logout path exists: the server accepts one through a
          // CLI login or a logout command, both of which leave `authMethods`
          // empty. A copy signed in only by its advertised Agent Auth has
          // nothing to log out of here.
          const canLogout = (entry.logged_in === true || (multiAccount && accounts.length > 0)) && authMethods.length === 0
          const badge = (
            <Badge variant={entry.logged_in === false || (multiAccount && accounts.length === 0) ? 'warning' : 'secondary'}>
              {installationVersionLabel(entry, adapter)}
              {multiAccount ? ` · ${accountSummary}` : entry.logged_in === null ? '' : entry.logged_in ? ' · logged in' : ' · not logged in'}
            </Badge>
          )
          return <span key={entry.id} className="flex min-w-0 flex-wrap items-center gap-1">
              {multiAccount && accounts.length > 0 ? (
                // The names on hover, in the app's tooltip rather than the
                // browser's title bubble; the row itself stays one line.
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild><span tabIndex={0} className="inline-flex">{badge}</span></TooltipTrigger>
                    <TooltipContent>
                      <ul className="space-y-0.5">
                        {accounts.map(account => (
                          <li key={account.id}><span className="font-medium">{account.id}</span> · {account.kind}</li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : badge}
              {(usage.has(entry.id) || entry.reports_subscription_quota) && (
                <RuntimeQuotaDetails usage={usage.get(entry.id)} title={`${adapter.display_name} · ${entry.id}`}
                  canRefresh={manageable && Boolean(entry.reports_subscription_quota)}
                  busy={usageBusy.has(entry.id)} online={host.status === 'online'}
                  onRefresh={() => onRefreshUsage(entry.id)} />
              )}
              {manageable && host.kind === 'remote' && entry.id === 'own' && isOwnCliUpdateRuntimeKey(adapter.runtime_key) && hasOwnUpdate(entry.version, adapter.latest_own_version) && (
                <Button size="sm" variant="ghost"
                  aria-label={`Update own ${adapter.display_name} on ${host.name}`}
                  disabled={host.status !== 'online' || installBusy.has(`${adapter.runtime_key}:own-update`)}
                  onClick={onUpdateOwn}>
                  {installBusy.has(`${adapter.runtime_key}:own-update`) ? <Loader2 className="h-3 w-3 animate-spin" /> : <CircleArrowUp className="h-3 w-3" />}
                </Button>
              )}
              {manageable && !rainverPinned && entry.id !== 'own' && adapter.latest_managed_version && adapter.latest_managed_version !== entry.version && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label={`Upgrade ${adapter.display_name} on ${host.name}`}
                  title={`Upgrade ${adapter.display_name}`}
                  disabled={host.status !== 'online' || installBusy.has(adapter.runtime_key)}
                  onClick={onInstall}
                >
                  {installBusy.has(adapter.runtime_key)
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <CircleArrowUp className="h-3 w-3" />}
                </Button>
              )}
              {manageable && authMethods.length === 0 && !entry.options?.cli_login_available && entry.logged_in !== null && (
                <Button
                  size="sm"
                  variant={multiAccount ? 'outline' : entry.logged_in ? 'ghost' : 'outline'}
                  aria-label={`${multiAccount ? 'Add account to' : 'Log in'} ${entry.id} of ${adapter.display_name} on ${host.name}`}
                  disabled={host.status !== 'online'}
                  onClick={() => onLogin(entry.id, { kind: 'configured' })}
                >
                  {multiAccount ? 'Add account' : entry.logged_in ? 'Log in again' : 'Log in'}
                </Button>
              )}
              {manageable && authMethods.length > 0 && (
                <>
                  <Button size="sm" variant={entry.logged_in ? 'ghost' : 'outline'}
                    aria-label={`Log in ${entry.id} of ${adapter.display_name} on ${host.name}`}
                    disabled={host.status !== 'online'}
                    onClick={() => {
                      if (authMethods.length === 1) onLogin(entry.id, { kind: 'acp', method: authMethods[0] })
                      else setLoginChoice(entry.id)
                    }}>
                    {entry.logged_in ? 'Log in again' : 'Log in'}
                  </Button>
                  <Dialog open={loginChoice === entry.id} onOpenChange={open => setLoginChoice(open ? entry.id : null)}>
                    <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto">
                      <DialogHeader>
                        <DialogTitle>Sign in to {adapter.display_name}</DialogTitle>
                        <DialogDescription>Choose a login method for {entry.id} on {host.name}.</DialogDescription>
                      </DialogHeader>
                      <div className="mt-4 space-y-2">
                        {authMethods.map(method => (
                          <Button key={method.id} variant="outline" className="h-auto min-h-11 w-full flex-col items-start whitespace-normal py-3 text-left"
                            aria-label={authMethodAria(method, entry.logged_in, entry.id, adapter.display_name, host.name)}
                            disabled={host.status !== 'online'}
                            onClick={() => { setLoginChoice(null); onLogin(entry.id, { kind: 'acp', method }) }}>
                            <span>{authMethodLabel(method, entry.logged_in)}</span>
                            {method.description && <span className="text-xs font-normal text-muted-foreground">{method.description}</span>}
                          </Button>
                        ))}
                      </div>
                    </DialogContent>
                  </Dialog>
                </>
              )}
              {manageable && entry.options?.cli_login_available && (
                <Button
                  size="sm"
                  variant={entry.logged_in ? 'ghost' : 'outline'}
                  aria-label={`${entry.logged_in ? 'Log in again' : 'Log in'} ${entry.id} of ${adapter.display_name} on ${host.name}`}
                  disabled={host.status !== 'online'}
                  onClick={() => onLogin(entry.id, { kind: 'cli' })}
                >
                  {entry.logged_in ? 'Log in again' : 'Log in'}
                </Button>
              )}
              {manageable && canLogout && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${multiAccount ? 'Remove account from' : 'Log out'} ${entry.id} of ${adapter.display_name} on ${host.name}`}
                  disabled={host.status !== 'online'}
                  onClick={() => onLogin(entry.id, { kind: 'logout' })}
                >
                  {multiAccount ? 'Remove account' : 'Log out'}
                </Button>
              )}
              {manageable && !rainverPinned && entry.rollback_version && (
                // The previous binaries are still on the host and reuse the
                // adapter's stable managed HOME after rollback.
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Roll ${adapter.display_name} on ${host.name} back to ${entry.rollback_version}`}
                  title={`Roll back to ${entry.rollback_version}`}
                  disabled={host.status !== 'online' || installBusy.has(`${adapter.runtime_key}:rollback`)}
                  onClick={onRollback}
                >
                  {installBusy.has(`${adapter.runtime_key}:rollback`)
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : `Roll back to ${entry.rollback_version}`}
                </Button>
              )}
              {manageable && !rainverPinned && entry.id !== 'own' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${entry.id} of ${adapter.display_name} from ${host.name}`}
                  disabled={host.status !== 'online' || installBusy.has(`${adapter.runtime_key}:${entry.id}`)}
                  onClick={() => onUninstall(entry)}
                >
                  Remove
                </Button>
              )}
          </span>
        })}
        {rainverPinned && (
          // Retry lives in the provisioning panel and is shown only to an
          // instance admin looking at a failed install. Everyone else is
          // told who owns this copy.
          <span className="shrink-0 text-muted-foreground">
            Managed by Rainver{manageable && provisioningFailed ? ' — use Retry above' : ''}
          </span>
        )}
        {manageable && !rainverPinned && !copies.some(entry => entry.id !== 'own') && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Add a managed copy of ${adapter.display_name} on ${host.name}`}
            disabled={host.status !== 'online' || installBusy.has(adapter.runtime_key)}
            onClick={onInstall}
          >
            {installBusy.has(adapter.runtime_key) ? <Loader2 className="size-3 animate-spin" /> : '+ managed copy'}
          </Button>
        )}
      </span>
    </li>
  )
}
