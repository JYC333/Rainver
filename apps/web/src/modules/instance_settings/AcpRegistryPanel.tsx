import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { acpAgentsApi, hostsApi, type AcpAgentOut, type AcpRegistryEntry } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { errMsg } from '../../lib/utils'
import type { HostRuntimeAdapterOption } from '../../types/api'

/**
 * The instance admin's ACP registry panel (Instance Settings, beside the
 * server-host runtime tools): which registry
 * agents this deployment allows. Enabling puts an agent in the catalog every
 * host's "Add agent…" draws from; disabling is refused while any host still
 * carries a copy. Installing on a host is the owner's, under Hosts.
 */
export default function AcpRegistryPanel() {
  const [adapters, setAdapters] = useState<HostRuntimeAdapterOption[]>([])
  const [enabled, setEnabled] = useState<AcpAgentOut[] | null>(null)
  const [registry, setRegistry] = useState<AcpRegistryEntry[] | null>(null)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void hostsApi.listRuntimeAdapters().then(result => { if (!cancelled) setAdapters(result.items) }).catch(() => {})
    void acpAgentsApi.list().then(result => { if (!cancelled) setEnabled(result.items) }).catch(error => toast.error(errMsg(error)))
    void acpAgentsApi.registry()
      .then(result => { if (!cancelled) setRegistry(result.items) })
      .catch(error => { if (!cancelled) setRegistryError(errMsg(error)) })
    return () => { cancelled = true }
  }, [])

  const enabledIds = useMemo(() => new Set((enabled ?? []).map(agent => agent.id)), [enabled])
  // A builtin adapter's own registry entry would offer the same agent twice.
  const builtinRegistryIds = useMemo(() => new Set(adapters.flatMap(adapter => adapter.registry_id ? [adapter.registry_id] : [])), [adapters])
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (registry ?? [])
      .filter(entry => !enabledIds.has(entry.id) && !builtinRegistryIds.has(entry.id))
      .filter(entry => !needle || entry.name.toLowerCase().includes(needle) || entry.id.includes(needle))
  }, [registry, enabledIds, builtinRegistryIds, query])

  async function withBusy(key: string, action: () => Promise<void>) {
    setBusy(key)
    try {
      await action()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(null)
    }
  }

  const enable = (entry: AcpRegistryEntry) => withBusy(entry.id, async () => {
    const agent = await acpAgentsApi.enable(entry.id)
    setEnabled(previous => [...(previous ?? []).filter(existing => existing.id !== agent.id), agent])
    toast.success(`${agent.name} enabled — add it to a host under Command Center → Hosts`)
  })

  const disable = (agent: AcpAgentOut) => withBusy(agent.id, async () => {
    await acpAgentsApi.disable(agent.id)
    setEnabled(previous => (previous ?? []).filter(existing => existing.id !== agent.id))
  })

  return (
    <Card className="space-y-3 p-4" data-testid="acp-registry">
      <div>
        <CardTitle className="text-sm">ACP registry</CardTitle>
        <p className="text-xs text-muted-foreground">
          Agents enabled here can be added to any host. They run at low trust on the host&apos;s own login, with no ModelProvider binding.
        </p>
      </div>

      <section className="space-y-1">
        <h3 className="text-xs font-medium">Enabled</h3>
        {enabled === null ? (
          <p className="text-xs text-muted-foreground"><Loader2 className="inline size-3 animate-spin mr-1" />Loading…</p>
        ) : enabled.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            None yet. Claude Code, Codex CLI and OpenCode need no enabling — they are always in every host&apos;s catalog.
          </p>
        ) : (
          <ul className="space-y-1">
            {enabled.map(agent => (
              <li key={agent.id} className="flex items-center justify-between gap-2 text-xs" data-testid={`registry-agent-${agent.id}`}>
                <span>
                  <span className="font-medium">{agent.name}</span>
                  <span className="ml-2 text-muted-foreground">{agent.id}@{agent.version}</span>
                  {agent.installed_on.length > 0 && (
                    <span className="ml-2 text-muted-foreground">on {agent.installed_on.map(host => host.name).join(', ')}</span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === agent.id || agent.installed_on.length > 0}
                  title={agent.installed_on.length > 0 ? `Remove it from ${agent.installed_on.map(host => host.name).join(', ')} first` : undefined}
                  onClick={() => void disable(agent)}
                >
                  Disable
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1">
        <h3 className="text-xs font-medium">Available</h3>
        {registryError ? (
          <p className="text-xs text-destructive">{registryError}</p>
        ) : registry === null ? (
          <p className="text-xs text-muted-foreground"><Loader2 className="inline size-3 animate-spin mr-1" />Loading registry…</p>
        ) : (
          <>
            <Input placeholder="Search agents" value={query} onChange={event => setQuery(event.target.value)} aria-label="Search ACP registry" />
            <ul className="max-h-64 overflow-y-auto divide-y divide-border">
              {candidates.map(entry => (
                <li key={entry.id} className="flex items-center justify-between gap-2 py-2 text-xs">
                  <div className="min-w-0">
                    <span className="font-medium">{entry.name}</span>
                    <span className="ml-2 text-muted-foreground">{entry.version} · {entry.distribution.kind}</span>
                    {entry.description && <p className="truncate text-muted-foreground">{entry.description}</p>}
                  </div>
                  <Button size="sm" variant="outline" aria-label={`Enable ${entry.name}`} disabled={busy === entry.id} onClick={() => void enable(entry)}>Enable</Button>
                </li>
              ))}
              {candidates.length === 0 && <li className="py-2 text-muted-foreground">Nothing matches.</li>}
            </ul>
          </>
        )}
      </section>
    </Card>
  )
}
