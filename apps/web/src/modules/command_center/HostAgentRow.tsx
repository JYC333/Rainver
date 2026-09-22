import { CircleArrowUp, Loader2, RefreshCw } from 'lucide-react'
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

function installationVersionLabel(entry: RuntimeInstallation, adapter: HostRuntimeDefinitionOption): string {
  if (entry.id === 'own') return `own · ${versionLabel(entry.version)}`
  if (entry.runtime_version) return `managed · ${versionLabel(entry.runtime_version)}`
  return adapter.reports_managed_cli_version
    ? 'managed · CLI version unavailable'
    : `managed · ${versionLabel(entry.version)}`
}

/**
 * A subscription's remaining share, short enough to sit inline: "62% · 18%"
 * is session then week. Percentages are of the window *used*, so higher is
 * closer to empty — the badge turns warning past 90 so a run about to be
 * refused is visible before it is attempted.
 */
function usageLabel(usage: HostRuntimeUsage | undefined): { text: string; spent: boolean; title: string } | null {
  if (!usage) return null
  const { quota } = usage
  // A copy that could not be read is not a copy that is fine: `warning` says
  // so at a glance, with the host's own reason on hover.
  if (!quota.available) return { text: 'usage unavailable', spent: true, title: quota.error ?? 'This host has not reported a reading yet.' }
  const parts = [
    quota.session_pct === null ? null : `session ${quota.session_pct}%`,
    quota.week_pct === null ? null : `week ${quota.week_pct}%`,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return null
  const highest = Math.max(quota.session_pct ?? 0, quota.week_pct ?? 0)
  const resets = [quota.session_resets, quota.week_resets].filter((line): line is string => Boolean(line))
  return {
    text: parts.join(' · '),
    spent: highest >= 90,
    title: [...resets, `Checked ${new Date(usage.checked_at).toLocaleString()}`].join('\n'),
  }
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
  onUninstall: (entry: RuntimeInstallation) => void
  onLogin: (installation: string, target: HostAgentLoginTarget) => void
  onRefreshUsage: (installation: string) => void
  onRollback: () => void
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 overflow-x-auto rounded-md border border-border px-2 py-1.5 text-xs" data-testid={`host-agent-${host.id}-${adapter.runtime_key}`}>
      <span className="w-28 shrink-0 truncate font-medium" title={adapter.display_name}>{adapter.display_name}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {copies.map(entry => {
          // One Log in when Rainver's managed CLI login exists: that is the
          // step the person actually has to do. The Agent-Auth handshake the
          // Agent advertised alongside it runs unattended afterwards — the
          // daemon's probe and every Run session authenticate with it — so
          // offering it as a second button only looked like a duplicate.
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
          const canLogout = entry.logged_in === true || (multiAccount && accounts.length > 0)
          const quota = usageLabel(usage.get(entry.id))
          const badge = (
            <Badge variant={entry.logged_in === false || (multiAccount && accounts.length === 0) ? 'warning' : 'secondary'}>
              {installationVersionLabel(entry, adapter)}
              {multiAccount ? ` · ${accountSummary}` : entry.logged_in === null ? '' : entry.logged_in ? ' · logged in' : ' · not logged in'}
            </Badge>
          )
          return <span key={entry.id} className="flex shrink-0 items-center gap-1">
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
              {quota && (
                <Badge variant={quota.spent ? 'warning' : 'outline'} title={quota.title}>{quota.text}</Badge>
              )}
              {manageable && entry.reports_subscription_quota && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label={`Refresh usage for ${entry.id} of ${adapter.display_name} on ${host.name}`}
                  disabled={host.status !== 'online' || usageBusy.has(entry.id)}
                  onClick={() => onRefreshUsage(entry.id)}
                >
                  {usageBusy.has(entry.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
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
              {(manageable ? authMethods : []).map(method => (
                <Button
                  key={method.id}
                  size="sm"
                  variant={entry.logged_in ? 'ghost' : 'outline'}
                  aria-label={authMethodAria(method, entry.logged_in, entry.id, adapter.display_name, host.name)}
                  title={method.description ?? undefined}
                  disabled={host.status !== 'online'}
                  onClick={() => onLogin(entry.id, { kind: 'acp', method })}
                >
                  {authMethodLabel(method, entry.logged_in)}
                </Button>
              ))}
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
          // The Retry lives in the provisioning panel and only exists for an
          // instance admin looking at a failed install, so only that viewer is
          // pointed at it; everyone else is just told who owns this copy.
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
