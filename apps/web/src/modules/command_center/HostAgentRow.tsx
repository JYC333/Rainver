import { useAppTranslation } from '../../i18n'
import { useEffect, useRef, useState } from 'react'
import HostRuntimeVersions from './HostRuntimeVersions'
import { hasManagedUpdate, hasStableUpdate } from './runtimeVersions'
import RuntimeAccountLink from './RuntimeAccountLink'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/dialog'
import { CircleArrowUp, Loader2 } from 'lucide-react'
import { ANTIGRAVITY_OWN_UPDATE_RUNTIME, isOwnCliUpdateRuntimeKey } from '@rainver/protocol'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import type {
  Host,
  HostRuntimeUsage,
  HostRuntimeDefinitionOption,
  RuntimeAuthMethod,
  RuntimeInstallation,
} from '../../types/api'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'

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
  onInstall,
  onUpdateOwn,
  onUninstall,
  onLogin,
  targetInstallation,
  managedCopyVersion,
  onRollback,
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
  /** The cached subscription quota per installation id; absent for a runtime that has none to report. */
  usage: ReadonlyMap<string, HostRuntimeUsage>
  onInstall: () => void
  onUpdateOwn: () => void
  onUninstall: (entry: RuntimeInstallation) => void
  onLogin: (installation: string, target: HostAgentLoginTarget) => void
  targetInstallation?: string
  managedCopyVersion?: string
  onRollback: () => void
}) {
  const { t } = useAppTranslation()
  const nativeCli = isOwnCliUpdateRuntimeKey(adapter.runtime_key)
  const antigravityOwn = adapter.runtime_key === ANTIGRAVITY_OWN_UPDATE_RUNTIME
  const ownLatest = antigravityOwn ? adapter.latest_managed_version : adapter.latest_own_version
  const managed = copies.filter(copy => copy.id !== 'own')
  const managedLatest = nativeCli ? adapter.latest_own_version : adapter.latest_managed_version
  const canUpgradeManaged = hasManagedUpdate(
    managed.map(copy => nativeCli ? copy.runtime_version ?? null : copy.version),
    managedLatest,
  )
  const [loginChoice, setLoginChoice] = useState<string | null>(null)
  const targetRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    targetRef.current?.scrollIntoView?.({ block: 'center' })
    targetRef.current?.focus({ preventScroll: true })
  }, [targetInstallation])
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
          // OpenCode model choices use provider/model IDs. Count provider IDs,
          // including providers configured outside the CLI credential store.
          const providers = new Set<string>()
          if (adapter.runtime_key === 'opencode') {
            for (const account of accounts ?? []) providers.add(account.id)
            for (const option of entry.options?.config_options ?? []) {
              if (option.category !== 'model' || option.type !== 'select') continue
              for (const choice of option.options) {
                const slash = choice.value.indexOf('/')
                if (slash > 0 && slash < choice.value.length - 1) providers.add(choice.value.slice(0, slash))
              }
            }
          }
          const providerSummary = providers.size > 0
            ? t('management_ui.host_catalog.provider_count', { count: providers.size })
            : null
          const accountSummary = accounts?.length
            ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}`
            : null
          const summary = providerSummary ?? (multiAccount
            ? accountSummary
            : entry.logged_in === null ? null : entry.logged_in ? 'logged in' : 'not logged in')
          // Only where a logout path exists: the server accepts one through a
          // CLI login or a logout command, both of which leave `authMethods`
          // empty. A copy signed in only by its advertised Agent Auth has
          // nothing to log out of here.
          const canLogout = (entry.logged_in === true || (multiAccount && accounts.length > 0)) && authMethods.length === 0
          const badge = (
            <Badge variant={!providerSummary && !multiAccount && entry.logged_in === false ? 'warning' : 'secondary'}>
              {installationVersionLabel(entry, adapter)}
              {summary && ` · ${summary}`}
            </Badge>
          )
          return <span key={entry.id} ref={entry.id === targetInstallation ? targetRef : undefined} tabIndex={entry.id === targetInstallation ? -1 : undefined}
            data-runtime-installation={entry.id} data-recovery-target={entry.id === targetInstallation || undefined}
            className="flex min-w-0 flex-wrap items-center gap-1 rounded-md data-[recovery-target=true]:ring-2 data-[recovery-target=true]:ring-primary data-[recovery-target=true]:ring-offset-2 data-[recovery-target=true]:ring-offset-background">
              {multiAccount || providerSummary ? (
                <Popover>
                  <PopoverTrigger asChild><button type="button" className="inline-flex">{badge}</button></PopoverTrigger>
                  <PopoverContent align="start" className="w-64" aria-label={t('management_ui.host_catalog.provider_details')}>
                    {providerSummary && (
                      <ul className="mb-1 max-h-40 max-w-64 space-y-0.5 overflow-auto break-all">
                        {[...providers].sort().map(provider => <li key={provider}>{provider}</li>)}
                      </ul>
                    )}
                    {multiAccount && (accounts.length === 0 ? (
                      <p>{t('management_ui.host_catalog.no_cli_accounts')}</p>
                    ) : (
                      <ul className="space-y-0.5">
                        {accounts.map(account => (
                          <li key={account.id}><span className="font-medium">{account.id}</span> · {account.kind}</li>
                        ))}
                      </ul>
                    ))}
                  </PopoverContent>
                </Popover>
              ) : badge}
              {(usage.has(entry.id) || entry.reports_subscription_quota) && (
                <RuntimeAccountLink usage={entry.logged_in === false ? undefined : usage.get(entry.id)} hostId={host.id} runtimeKey={adapter.runtime_key} installation={entry.id} />
              )}
              {manageable && host.kind === 'remote' && entry.id === 'own' && (nativeCli || antigravityOwn) && hasStableUpdate(entry.version, ownLatest) && (
                <Button size="sm" variant="ghost"
                  aria-label={`Update own ${adapter.display_name} on ${host.name}`}
                  aria-busy={installBusy.has(`${adapter.runtime_key}:own-update`)}
                  title={antigravityOwn && !host.capabilities_json?.antigravity_own_updates ? t('management_ui.host_catalog.upgrade_host_required') : undefined}
                  disabled={host.status !== 'online' || (antigravityOwn && !host.capabilities_json?.antigravity_own_updates)}
                  onClick={onUpdateOwn}>
                  {installBusy.has(`${adapter.runtime_key}:own-update`) ? <Loader2 className="h-3 w-3 animate-spin" /> : <CircleArrowUp className="h-3 w-3" />}
                </Button>
              )}
              {manageable && entry === managed[0] && canUpgradeManaged && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label={`Upgrade ${adapter.display_name} on ${host.name}`}
                  title={nativeCli && !host.capabilities_json?.managed_cli_updates ? t('management_ui.host_catalog.upgrade_host_required') : `Upgrade ${adapter.display_name}`}
                  aria-busy={installBusy.has(adapter.runtime_key)}
                  disabled={host.status !== 'online' || (nativeCli && !host.capabilities_json?.managed_cli_updates)}
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
              {manageable && entry.id !== 'own' && <HostRuntimeVersions
                name={adapter.display_name} host={host.name} current={nativeCli ? entry.runtime_version ?? null : entry.version} previous={nativeCli && !host.capabilities_json?.managed_cli_updates ? null : entry.rollback_version}
                busy={installBusy.has(`${adapter.runtime_key}:rollback`)} online={host.status==='online'} onRollback={onRollback}/>}
              {manageable && entry.id !== 'own' && !(host.kind === 'server' && adapter.runtime_key === 'opencode') && (
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
        {manageable && !copies.some(entry => entry.id !== 'own') && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Add a managed copy of ${adapter.display_name} on ${host.name}`}
            disabled={host.status !== 'online' || installBusy.has(adapter.runtime_key)}
            onClick={onInstall}
          >
            {installBusy.has(adapter.runtime_key) ? <Loader2 className="size-3 animate-spin" /> : managedCopyVersion ? t('management_ui.host_catalog.managed_copy_version', { version: managedCopyVersion }) : '+ managed copy'}
          </Button>
        )}
      </span>
    </li>
  )
}
