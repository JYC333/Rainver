import { ServerCog, ShieldAlert } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { Card, CardTitle } from '../../components/ui/card'
import { InstanceRuntimeToolsPanel } from '../runtime_tools/RuntimeToolsPage'
import AcpRegistryPanel from '../runtime_tools/AcpRegistryPanel'
import { CustomSourceRunnerSettingsPanel } from './CustomSourceRunnerSettingsPanel'
import { SourceCatalogPanel } from './SourceCatalogPanel'
import { OperationsSettingsPanel } from './OperationsSettingsPanel'

export default function InstanceSettingsPage() {
  const { currentUser } = useAuth()
  const isInstanceAdmin = Boolean(currentUser?.is_instance_admin)

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <ServerCog className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Instance Settings</h1>
          <p className="text-sm text-muted-foreground">Manage server-wide configuration for this rainver instance.</p>
        </div>
      </div>

      {!isInstanceAdmin ? (
        <Card>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-3.5" /> Instance admin required
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Only the configured instance admin can view and change instance settings.
          </p>
        </Card>
      ) : (
        <>
          <OperationsSettingsPanel />
          <SourceCatalogPanel />
          <CustomSourceRunnerSettingsPanel />
          <InstanceRuntimeToolsPanel />
          <AcpRegistryPanel />
        </>
      )}
    </div>
  )
}
