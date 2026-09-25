import { useEffect, useId, useRef, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, authApi, providersApi, type ModelProviderOut, type ProviderPresetOut, type ProviderVendorOut } from '../../api/client'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { useSpace } from '../../contexts/SpaceContext'
import { useAuth } from '../../contexts/AuthContext'
import { errMsg } from '../../lib/utils'
import type { SpaceWithMembership } from '../../types/api'
import AddProviderForm from './components/AddProviderForm'
import ProviderCard from './components/ProviderCard'
import ManagedSubscriptionsPanel from './components/ManagedSubscriptionsPanel'
import SubscriptionQuotaPolicyCard from './components/SubscriptionQuotaPolicyCard'
import type { AddProviderMode } from './types'
import { isRetrievalOnlyVendor } from './providerMetadata'

export default function ModelProvidersPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const { currentUser } = useAuth()
  const [configs, setConfigs] = useState<ModelProviderOut[]>([])
  const [spaces, setSpaces] = useState<SpaceWithMembership[]>([])
  const [presets, setPresets] = useState<ProviderPresetOut[]>([])
  const [vendors, setVendors] = useState<ProviderVendorOut[]>([])
  const [runtimeDefault, setRuntimeDefault] = useState<Awaited<ReturnType<typeof agentsApi.getSpaceRuntimeDefault>>>(null)
  const [runtimeDefaultProviderId, setRuntimeDefaultProviderId] = useState('runtime_native')
  const [runtimeDefaultModel, setRuntimeDefaultModel] = useState('')
  const [savingRuntimeDefault, setSavingRuntimeDefault] = useState(false)
  // The runtime default is one card on this page, not the page: a transient
  // failure reports itself here and leaves the Providers list readable.
  const [runtimeDefaultError, setRuntimeDefaultError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // "Could not read my role" is not "not permitted": downgrading a Space owner
  // to the read-only branch on a transient failure hid the control they own.
  const [spaceRolesUnknown, setSpaceRolesUnknown] = useState(false)
  const [addingMode, setAddingMode] = useState<AddProviderMode | null>(null)
  const loadRequestId = useRef(0)
  const headingId = useId()
  const ownedConfigs = configs.filter(config => config.manageable !== false)
  const grantedConfigs = configs.filter(config => config.manageable === false)

  useEffect(() => {
    const requestId = ++loadRequestId.current
    void loadAll(requestId)
    return () => {
      if (loadRequestId.current === requestId) loadRequestId.current += 1
    }
  }, [activeSpaceId])

  async function loadAll(requestId: number) {
    setLoading(true)
    setConfigs([])
    setSpaces([])
    setPresets([])
    setVendors([])
    try {
      if (!activeSpaceId) {
        setConfigs([])
        setSpaces([])
        setPresets([])
        setVendors([])
        return
      }
      const [providers, nextSpaces, nextPresets, nextVendors, nextRuntimeDefault] = await Promise.all([
        providersApi.list(),
        authApi.mySpaces().then(spaces => {
          if (loadRequestId.current === requestId) setSpaceRolesUnknown(false)
          return spaces
        }).catch(() => {
          if (loadRequestId.current === requestId) setSpaceRolesUnknown(true)
          return [] as SpaceWithMembership[]
        }),
        providersApi.presets().catch(() => [] as ProviderPresetOut[]),
        providersApi.vendors().catch(error => {
          if (loadRequestId.current === requestId) {
            toast.error(`Provider catalog unavailable: ${errMsg(error)}`)
          }
          return [] as ProviderVendorOut[]
        }),
        agentsApi.getSpaceRuntimeDefault().then(result => {
          if (loadRequestId.current === requestId) setRuntimeDefaultError(null)
          return result
        }).catch(error => {
          if (loadRequestId.current === requestId) setRuntimeDefaultError(errMsg(error))
          return null
        }),
      ])
      if (loadRequestId.current !== requestId) return
      setConfigs(providers)
      setSpaces(nextSpaces)
      setPresets(nextPresets)
      setVendors(nextVendors)
      applyRuntimeDefault(nextRuntimeDefault)
    } catch (error) {
      if (loadRequestId.current === requestId) toast.error(errMsg(error))
    } finally {
      if (loadRequestId.current === requestId) setLoading(false)
    }
  }

  function applyRuntimeDefault(next: Awaited<ReturnType<typeof agentsApi.getSpaceRuntimeDefault>>) {
    setRuntimeDefault(next)
    setRuntimeDefaultProviderId(next?.backend_mode === 'model_provider'
      ? next.model_provider_id ?? 'runtime_native'
      : 'runtime_native')
    setRuntimeDefaultModel(next?.model_name ?? '')
  }

  async function reloadRuntimeDefault() {
    setRuntimeDefaultError(null)
    try {
      applyRuntimeDefault(await agentsApi.getSpaceRuntimeDefault())
    } catch (error) {
      setRuntimeDefaultError(errMsg(error))
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

  const activeSpaceRole = spaces.find(space => space.id === activeSpaceId)?.role
  // With the role unknown the control is offered and the server's 403 is the
  // answer; only a known, insufficient role renders the read-only line.
  const canChangeRuntimeDefault = spaceRolesUnknown || activeSpaceRole === 'owner' || activeSpaceRole === 'admin'
  const chatProviders = configs.filter(provider =>
    provider.enabled && !isRetrievalOnlyVendor(provider.provider_type, vendors),
  )
  const currentDefaultProvider = runtimeDefault?.model_provider_id
    ? configs.find(provider => provider.id === runtimeDefault.model_provider_id) ?? null
    : null
  // The server derives this from the same grant ∧ enabled join Profile
  // admission uses, so the banner and the create that would fail agree about
  // why. Re-deriving it from the page's own provider list did not.
  const runtimeDefaultNeedsRepair = runtimeDefault?.state === 'needs_repair'

  function changeRuntimeDefaultProvider(value: string) {
    setRuntimeDefaultProviderId(value)
    const provider = chatProviders.find(candidate => candidate.id === value)
    setRuntimeDefaultModel(provider?.default_model ?? provider?.available_models[0] ?? '')
  }

  async function saveRuntimeDefault() {
    const provider = runtimeDefaultProviderId === 'runtime_native'
      ? null
      : chatProviders.find(candidate => candidate.id === runtimeDefaultProviderId) ?? null
    if (runtimeDefaultProviderId !== 'runtime_native' && (!provider || !runtimeDefaultModel.trim())) {
      toast.error('Choose an enabled chat provider and model')
      return
    }
    setSavingRuntimeDefault(true)
    try {
      const updated = await agentsApi.setSpaceRuntimeDefault(provider
        ? {
            runtime_key: 'opencode',
            backend_mode: 'model_provider',
            model_provider_id: provider.id,
            model_name: runtimeDefaultModel.trim(),
          }
        : {
            runtime_key: 'opencode',
            backend_mode: 'runtime_native',
            model_provider_id: null,
            model_name: null,
          })
      applyRuntimeDefault(updated)
      toast.success('Default for future Agent Profiles updated')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSavingRuntimeDefault(false)
    }
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
            canCreate={Boolean(activeSpaceId && vendors.length)}
            mode={addingMode}
            setMode={setAddingMode}
            presets={presets}
            vendors={vendors}
          />
          {!addingMode && <Card className="space-y-3 p-4" aria-label="OpenCode default backend">
            <div>
              <h2 className="text-sm font-medium">OpenCode backend for new Agents</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                This is an explicit Space provisioning choice. It affects future default Profiles only; existing Agents and runtime-native Profiles are never rewritten.
              </p>
            </div>
            {runtimeDefaultError && (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
                <span>The Space runtime default could not be loaded: {runtimeDefaultError}</span>
                <Button size="sm" variant="outline" onClick={() => void reloadRuntimeDefault()}>Retry</Button>
              </div>
            )}
            {runtimeDefaultNeedsRepair && (
              <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                {runtimeDefault?.state_reason ?? 'The saved default Provider is unavailable or disabled.'}
                {' '}New Agents cannot use this template until a Space owner/admin repairs it; existing Profiles are unchanged.
              </p>
            )}
            {canChangeRuntimeDefault ? (
              <>
                <div className="space-y-1.5">
                  <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Backend mode</span>
                  <Select
                    ariaLabel="OpenCode backend mode"
                    value={runtimeDefaultProviderId}
                    onChange={changeRuntimeDefaultProvider}
                    options={[
                      { value: 'runtime_native', label: 'OpenCode native account on Server Runtime' },
                      ...(runtimeDefaultNeedsRepair && runtimeDefault?.model_provider_id
                        ? [{
                            value: runtimeDefault.model_provider_id,
                            label: `${currentDefaultProvider?.name ?? 'Unavailable Provider'} (needs repair)`,
                            disabled: true,
                          }]
                        : []),
                      ...chatProviders.map(provider => ({ value: provider.id, label: provider.name })),
                    ]}
                  />
                </div>
                {runtimeDefaultProviderId !== 'runtime_native' && (
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Model</span>
                    <Input
                      aria-label="OpenCode default model"
                      value={runtimeDefaultModel}
                      onChange={event => setRuntimeDefaultModel(event.target.value)}
                      list="opencode-default-models"
                      placeholder="Enter an explicit model name"
                    />
                    <datalist id="opencode-default-models">
                      {chatProviders.find(provider => provider.id === runtimeDefaultProviderId)?.available_models.map(model => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </label>
                )}
                <p className="text-xs text-muted-foreground">
                  Server Runtime uses instance-wide native account state shared by authorized Agent runners. A Provider-backed Profile sends calls through Rainver&apos;s proxy; its upstream key is not exposed to OpenCode.
                </p>
                <Button size="sm" onClick={saveRuntimeDefault} disabled={savingRuntimeDefault || Boolean(runtimeDefaultError)}>
                  {savingRuntimeDefault ? 'Saving…' : 'Save default for future Agents'}
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Current default: {runtimeDefault?.backend_mode === 'model_provider'
                  ? `${currentDefaultProvider?.name ?? 'Unavailable Provider'} · ${runtimeDefault.model_name ?? 'model missing'}`
                  : 'OpenCode native account on Server Runtime'}. Only Space owners/admins can change it.
              </p>
            )}
          </Card>}
          {!addingMode && (
            <ManagedSubscriptionsPanel
              providers={configs}
              isInstanceAdmin={Boolean(currentUser?.is_instance_admin)}
              onChanged={addProvider}
              onDisconnected={id => setConfigs(previous => previous.filter(config => config.id !== id))}
            />
          )}
          {!addingMode && activeSpaceId && <SubscriptionQuotaPolicyCard canEdit={canChangeRuntimeDefault} />}
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
                      vendors={vendors}
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
                      vendors={vendors}
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
