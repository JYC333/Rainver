import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, ShieldAlert, Terminal } from 'lucide-react'
import { runtimeToolsApi } from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import type { RuntimeToolStatus } from '../../types/api'
import { errMsg } from '../../lib/utils'
import { Card, CardTitle } from '../../components/ui/card'
import AcpRegistryPanel from './AcpRegistryPanel'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'

export function InstanceRuntimeToolsPanel() {
  const { currentUser } = useAuth()
  const isInstanceAdmin = Boolean(currentUser?.is_instance_admin)
  const [runtimeTools, setRuntimeTools] = useState<RuntimeToolStatus[]>([])
  const [toolVersions, setToolVersions] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [installingRuntime, setInstallingRuntime] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      setRuntimeTools(await runtimeToolsApi.list())
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function install(runtime: string) {
    setInstallingRuntime(runtime)
    try {
      const version = toolVersions[runtime]?.trim()
      await runtimeToolsApi.install(runtime, { version: version || undefined, activate: true, force: true })
      toast.success('Runtime tool installed')
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setInstallingRuntime(null)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <CardTitle>Instance Runtime Tools</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Install allowlisted CLI binaries into the server-wide runtime cache.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>Refresh</Button>
      </div>
      {!isInstanceAdmin && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Runtime tool installation requires the instance admin account.
        </p>
      )}
      <div className="space-y-3">
        {runtimeTools.map(tool => (
          <div key={tool.runtime} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">{tool.label}</div>
                <div className="text-xs font-mono text-muted-foreground">{tool.package_name}</div>
              </div>
              <Badge variant={tool.installed ? 'success' : 'secondary'}>
                {tool.installed ? `active ${tool.active_version}` : 'not installed'}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              Installed: {tool.installed_versions.length > 0
                ? tool.installed_versions.map(version => version.version).join(', ')
                : 'none'}
            </div>
            {isInstanceAdmin && (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  className="sm:max-w-48 font-mono"
                  placeholder="latest"
                  value={toolVersions[tool.runtime] ?? ''}
                  onChange={e => setToolVersions(prev => ({ ...prev, [tool.runtime]: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && install(tool.runtime)}
                />
                <Button size="sm" onClick={() => install(tool.runtime)} disabled={installingRuntime === tool.runtime}>
                  {installingRuntime === tool.runtime ? <Loader2 className="size-3.5 animate-spin" /> : 'Install / Update'}
                </Button>
              </div>
            )}
            {tool.warnings.map(warning => (
              <p key={warning} className="text-xs text-amber-600">{warning}</p>
            ))}
          </div>
        ))}
      </div>
    </Card>
  )
}

export default function RuntimeToolsPage() {
  const { currentUser } = useAuth()
  const isInstanceAdmin = Boolean(currentUser?.is_instance_admin)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Terminal className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Runtime Tools</h1>
          <p className="text-sm text-muted-foreground">
            Install and update server-wide CLI runtime tools.
          </p>
        </div>
      </div>

      {!isInstanceAdmin ? (
        <Card>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-3.5" /> Instance admin required
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Runtime tool installation and updates require the configured instance admin account.
          </p>
        </Card>
      ) : (
        <>
          <InstanceRuntimeToolsPanel />
          <AcpRegistryPanel />
        </>
      )}
    </div>
  )
}
