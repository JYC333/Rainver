import { useEffect, useId, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { authApi, providersApi, type ModelProviderOut, type ProviderPresetOut } from '../../api/client'
import { Card } from '../../components/ui/card'
import { useSpace } from '../../contexts/SpaceContext'
import { useAuth } from '../../contexts/AuthContext'
import { errMsg } from '../../lib/utils'
import type { SpaceWithMembership } from '../../types/api'
import AddProviderForm from './components/AddProviderForm'
import ProviderCard from './components/ProviderCard'
import ManagedSubscriptionsPanel from './components/ManagedSubscriptionsPanel'
import type { AddProviderMode } from './types'

export default function ModelProvidersPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const { currentUser } = useAuth()
  const [configs, setConfigs] = useState<ModelProviderOut[]>([])
  const [spaces, setSpaces] = useState<SpaceWithMembership[]>([])
  const [presets, setPresets] = useState<ProviderPresetOut[]>([])
  const [loading, setLoading] = useState(true)
  const [addingMode, setAddingMode] = useState<AddProviderMode | null>(null)
  const headingId = useId()
  const ownedConfigs = configs.filter(config => config.manageable !== false)
  const grantedConfigs = configs.filter(config => config.manageable === false)

  useEffect(() => { loadAll() }, [activeSpaceId])

  async function loadAll() {
    setLoading(true)
    try {
      if (!activeSpaceId) {
        setConfigs([])
        setSpaces([])
        setPresets([])
        return
      }
      const [providers, nextSpaces, nextPresets] = await Promise.all([
        providersApi.list(),
        authApi.mySpaces().catch(() => [] as SpaceWithMembership[]),
        providersApi.presets().catch(() => [] as ProviderPresetOut[]),
      ])
      setConfigs(providers)
      setSpaces(nextSpaces)
      setPresets(nextPresets)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }

  async function deleteProvider(id: string) {
    await providersApi.delete(id)
    setConfigs(previous => previous.filter(config => config.id !== id))
    toast.success('Provider disabled')
  }

  function addProvider(provider: ModelProviderOut) {
    setConfigs(previous => {
      const withoutExisting = previous.filter(config => config.id !== provider.id)
      const next = provider.is_default
        ? withoutExisting.map(config => ({ ...config, is_default: false }))
        : withoutExisting
      return [provider, ...next]
    })
  }

  function patchProvider(updated: ModelProviderOut) {
    setConfigs(previous => previous.map(config => config.id === updated.id ? updated : config))
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl" id={headingId}>
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <KeyRound className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Model Providers</h1>
          <p className="text-sm text-muted-foreground">Configure chat, embedding, rerank, and runtime-compatible endpoints.</p>
          <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin mr-2" /> Loading...
        </div>
      ) : (
        <div className="space-y-4">
          <AddProviderForm
            onAdded={addProvider}
            canCreate={Boolean(activeSpaceId)}
            mode={addingMode}
            setMode={setAddingMode}
            presets={presets}
          />
          {!addingMode && (
            <ManagedSubscriptionsPanel
              providers={configs}
              isInstanceAdmin={Boolean(currentUser?.is_instance_admin)}
              onChanged={addProvider}
              onDisconnected={id => setConfigs(previous => previous.filter(config => config.id !== id))}
            />
          )}
          {!addingMode && (configs.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground p-4">
                {activeSpaceId
                  ? 'No model providers configured. Add chat, embedding, or rerank providers.'
                  : 'Select an operational space to configure providers.'}
              </p>
            </Card>
          ) : (
            <div className="space-y-5">
              {ownedConfigs.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-medium">Owned by me</h2>
                  {ownedConfigs.map(config => (
                    <ProviderCard
                      key={config.id}
                      config={config}
                      onDelete={deleteProvider}
                      onTest={id => providersApi.test(id)}
                      onPatched={patchProvider}
                      spaces={spaces}
                    />
                  ))}
                </section>
              )}
              {grantedConfigs.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-medium">Usable in this space</h2>
                  {grantedConfigs.map(config => (
                    <ProviderCard
                      key={config.id}
                      config={config}
                      onDelete={deleteProvider}
                      onTest={id => providersApi.test(id)}
                      onPatched={patchProvider}
                      spaces={spaces}
                    />
                  ))}
                </section>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
