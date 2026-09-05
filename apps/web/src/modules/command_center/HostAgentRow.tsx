import { Loader2 } from 'lucide-react'
import type { ModelProviderOut } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import type {
  Host,
  HostRuntimeAdapterOption,
  HostRuntimeProviderBinding,
  RuntimeAuthMethod,
  RuntimeInstallation,
} from '../../types/api'
import { AMBIENT_BACKEND, eligibleProviders } from './backendChoice'

export type HostAgentLoginTarget =
  | { kind: 'configured' }
  | { kind: 'acp'; method: RuntimeAuthMethod }
  | { kind: 'cli' }

/** Version probes often repeat the CLI name; the row already names the Agent. */
function versionLabel(version: string | null): string {
  if (!version) return 'unknown version'
  const numeric = version.match(/\bv?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0]
  return numeric?.replace(/^v/, '') ?? version
}

function authMethodLabel(method: RuntimeAuthMethod, loggedIn: boolean | null): string {
  return loggedIn ? `${method.name} again` : method.name
}

function authMethodAria(method: RuntimeAuthMethod, loggedIn: boolean | null, entryId: string, agentName: string, hostName: string): string {
  return `${authMethodLabel(method, loggedIn)} for ${entryId} of ${agentName} on ${hostName}`
}

export function agentAcceptsProviderBinding(adapter: HostRuntimeAdapterOption): boolean {
  return adapter.provider_binding !== false && Boolean(adapter.provider_api)
}

export default function HostAgentRow({
  host,
  adapter,
  copies,
  providers,
  binding,
  installBusy,
  providerBusy,
  onInstall,
  onUninstall,
  onLogin,
  onChooseProvider,
}: {
  host: Host
  adapter: HostRuntimeAdapterOption
  copies: RuntimeInstallation[]
  providers: ModelProviderOut[]
  binding: HostRuntimeProviderBinding | null
  installBusy: string | null
  providerBusy: boolean
  onInstall: () => void
  onUninstall: (entry: RuntimeInstallation) => void
  onLogin: (installation: string, target: HostAgentLoginTarget) => void
  onChooseProvider: (providerId: string) => void
}) {
  const providerBindingAvailable = agentAcceptsProviderBinding(adapter)
  const providerOptions = providerBindingAvailable ? eligibleProviders(providers, adapter) : []
  const staleBinding = binding && !providerOptions.some(provider => provider.id === binding.model_provider_id)

  return (
    <li className="flex min-w-0 items-center gap-2 overflow-x-auto rounded-md border border-border px-2 py-1.5 text-xs" data-testid={`host-agent-${host.id}-${adapter.adapter_type}`}>
      <span className="w-28 shrink-0 truncate font-medium" title={adapter.display_name}>{adapter.display_name}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {copies.map(entry => {
          const authMethods = entry.options?.auth_methods ?? []
          return <span key={entry.id} className="flex shrink-0 items-center gap-1">
              <Badge variant={entry.logged_in === false ? 'warning' : 'secondary'}>
                {entry.id === 'own' ? 'own' : 'managed'} · {versionLabel(entry.version)}
                {entry.logged_in === null ? '' : entry.logged_in ? ' · logged in' : ' · not logged in'}
              </Badge>
              {authMethods.length === 0 && !entry.options?.cli_login_available && entry.logged_in !== null && (
                <Button
                  size="sm"
                  variant={entry.logged_in ? 'ghost' : 'outline'}
                  aria-label={`Log in ${entry.id} of ${adapter.display_name} on ${host.name}`}
                  disabled={host.status !== 'online'}
                  onClick={() => onLogin(entry.id, { kind: 'configured' })}
                >
                  {entry.logged_in ? 'Log in again' : 'Log in'}
                </Button>
              )}
              {authMethods.map(method => (
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
              {entry.options?.cli_login_available && (
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
              {entry.id !== 'own' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${entry.id} of ${adapter.display_name} from ${host.name}`}
                  disabled={host.status !== 'online' || installBusy === `${adapter.adapter_type}:${entry.id}`}
                  onClick={() => onUninstall(entry)}
                >
                  Remove
                </Button>
              )}
          </span>
        })}
        {!copies.some(entry => entry.id !== 'own') && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Add a managed copy of ${adapter.display_name} on ${host.name}`}
            disabled={host.status !== 'online' || installBusy === adapter.adapter_type}
            onClick={onInstall}
          >
            {installBusy === adapter.adapter_type ? <Loader2 className="size-3 animate-spin" /> : '+ managed copy'}
          </Button>
        )}
      </span>
      <div className="ml-auto grid w-[22rem] shrink-0 grid-cols-[5rem_1fr] items-center gap-2">
        <span className="flex h-7 items-center justify-end whitespace-nowrap text-xs text-muted-foreground">
          Model source
        </span>
        {providerBindingAvailable ? (
          <div className="min-w-0">
            <Select
              ariaLabel={`Model source for ${adapter.display_name} on ${host.name}`}
              size="sm"
              value={binding?.model_provider_id ?? AMBIENT_BACKEND}
              disabled={providerBusy}
              onChange={onChooseProvider}
              options={[
                { value: AMBIENT_BACKEND, label: 'Agent-managed account' },
                ...providerOptions.map(provider => ({
                  value: provider.id,
                  label: provider.default_model ? `${provider.name} · ${provider.default_model}` : provider.name,
                })),
                ...(staleBinding ? [{ value: binding.model_provider_id, label: 'Unavailable provider — pick another' }] : []),
              ]}
            />
          </div>
        ) : (
          <span
            className="flex h-7 items-center whitespace-nowrap text-muted-foreground"
            title="This Agent may support its own provider settings, but ACP does not expose a generic way for Rainver to inject a ModelProvider."
          >
            Agent-managed · no Rainver override
          </span>
        )}
      </div>
    </li>
  )
}
