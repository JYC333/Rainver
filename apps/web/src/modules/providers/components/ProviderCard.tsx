import { useState } from 'react'
import ProviderDeploymentSelect from './ProviderDeploymentSelect'
import { AlertCircle, CheckCircle, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { providersApi, type ModelProviderOut, type ProviderVendorOut, type ProviderDeployment } from '../../../api/client'
import type { SpaceWithMembership } from '../../../types/api'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card, CardTitle } from '../../../components/ui/card'
import { Input } from '../../../components/ui/input'
import { errMsg } from '../../../lib/utils'
import NetworkProfileSelector from '../../network_profiles/NetworkProfileSelector'
import {
  inferProviderModelMode,
  modelFieldCopy,
  isRetrievalOnlyVendor,
} from '../providerMetadata'
import { ProviderCapabilityBadges, ProviderCapabilityNotice } from './ProviderCapability'
import { useAppTranslation } from '../../../i18n'

export default function ProviderCard({
  config,
  onDelete,
  onTest,
  onPatched,
  spaces,
  vendors,
}: {
  config: ModelProviderOut
  onDelete: (id: string) => void
  onTest: (id: string) => Promise<{ success: boolean; message: string }>
  onPatched: (updated: ModelProviderOut) => void
  spaces: SpaceWithMembership[]
  vendors: readonly ProviderVendorOut[]
}) {
  const { t } = useAppTranslation()
  const [deleting, setDeleting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(config.name)
  const [editDefaultModel, setEditDefaultModel] = useState(config.default_model ?? '')
  const [editModels, setEditModels] = useState(config.available_models.join(', '))
  const [editBaseUrl, setEditBaseUrl] = useState(config.base_url ?? '')
  const [editClaudeCompatibleBaseUrl, setEditClaudeCompatibleBaseUrl] = useState(config.claude_compatible_base_url ?? '')
  const [editOpenAiCompatibleBaseUrl, setEditOpenAiCompatibleBaseUrl] = useState(config.openai_compatible_base_url ?? '')
  const [editDeployment, setEditDeployment] = useState<ProviderDeployment>(config.deployment)
  const [editNetworkProfileId, setEditNetworkProfileId] = useState<string | null>(config.network_profile_id ?? null)
  const [editApiKey, setEditApiKey] = useState('')
  const [editEnabled, setEditEnabled] = useState(config.enabled)
  const [saving, setSaving] = useState(false)
  const [grantSpaceId, setGrantSpaceId] = useState('')
  const [granting, setGranting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const inferredMode = inferProviderModelMode(config)
  const modelCopy = modelFieldCopy(config.provider_type, inferredMode)
  const showBridgeUrls = !isRetrievalOnlyVendor(config.provider_type, vendors)

  async function handleSave() {
    if (!editBaseUrl.trim()) {
      toast.error(t('workspace_ui.providers.card.base_url_required'))
      return
    }
    setSaving(true)
    try {
      const updated = await providersApi.patch(config.id, {
        name: editName,
        default_model: editDefaultModel.trim() || null,
        available_models: editModels.split(',').map(model => model.trim()).filter(Boolean),
        base_url: editBaseUrl.trim(),
        deployment: editDeployment,
        network_profile_id: editNetworkProfileId,
        claude_compatible_base_url: showBridgeUrls ? editClaudeCompatibleBaseUrl.trim() || null : null,
        openai_compatible_base_url: showBridgeUrls ? editOpenAiCompatibleBaseUrl.trim() || null : null,
        api_key: editApiKey.trim() || undefined,
        enabled: editEnabled,
      })
      onPatched(updated)
      setEditing(false)
      setEditApiKey('')
      toast.success(t('workspace_ui.providers.card.updated'))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  async function grantProvider() {
    if (!grantSpaceId) return
    setGranting(true)
    try {
      await providersApi.grant(config.id, { space_id: grantSpaceId, enabled: true })
      toast.success(t('workspace_ui.providers.card.granted'))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setGranting(false)
    }
  }

  if (editing) {
    return (
      <Card>
        <div className="space-y-3 p-4">
          <ProviderCapabilityNotice providerType={config.provider_type} vendors={vendors} mode={inferredMode} />
          <Input value={editName} onChange={event => setEditName(event.target.value)} placeholder={t('workspace_ui.providers.card.name_placeholder')} />
          <Input value={editBaseUrl} onChange={event => setEditBaseUrl(event.target.value)} placeholder={t('workspace_ui.providers.card.base_url_placeholder')} className="font-mono text-sm" />
          {showBridgeUrls && (
            <>
              <Input value={editClaudeCompatibleBaseUrl} onChange={event => setEditClaudeCompatibleBaseUrl(event.target.value)} placeholder={t('workspace_ui.providers.card.claude_url_placeholder')} className="font-mono text-sm" />
              <Input value={editOpenAiCompatibleBaseUrl} onChange={event => setEditOpenAiCompatibleBaseUrl(event.target.value)} placeholder={t('workspace_ui.providers.card.openai_url_placeholder')} className="font-mono text-sm" />
            </>
          )}
          <ProviderDeploymentSelect providerType={config.provider_type} vendors={vendors} value={editDeployment} onChange={setEditDeployment} />
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t('workspace_ui.providers.card.network_label')}</label>
            <NetworkProfileSelector value={editNetworkProfileId} onChange={setEditNetworkProfileId} />
          </div>
          <Input type="password" value={editApiKey} onChange={event => setEditApiKey(event.target.value)} placeholder={t('workspace_ui.providers.card.api_key_placeholder')} className="font-mono text-sm" />
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{modelCopy.defaultLabel}</label>
            <Input value={editDefaultModel} onChange={event => setEditDefaultModel(event.target.value)} placeholder={modelCopy.defaultPlaceholder} className="font-mono text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{modelCopy.availableLabel}</label>
            <Input value={editModels} onChange={event => setEditModels(event.target.value)} placeholder={modelCopy.availablePlaceholder} className="font-mono text-sm" />
            <p className="text-xs text-muted-foreground">{modelCopy.help}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={editEnabled} onChange={event => setEditEnabled(event.target.checked)} />
            {t('workspace_ui.providers.card.enabled')}
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>{t('workspace_ui.providers.card.save')}</Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>{t('workspace_ui.providers.card.cancel')}</Button>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <CardTitle>{config.name}</CardTitle>
          {config.is_default && <Badge variant="default" className="text-[10px]">{t('workspace_ui.providers.card.default_badge')}</Badge>}
          {config.manageable === false && <Badge variant="muted" className="text-[10px]">{t('workspace_ui.providers.card.granted_badge')}</Badge>}
          {!config.enabled && <Badge variant="muted" className="text-[10px]">{t('workspace_ui.providers.card.disabled_badge')}</Badge>}
          {config.has_subscription ? (
            <Badge variant="muted" className="text-[10px]">{t('workspace_ui.providers.card.subscription_badge')}</Badge>
          ) : config.has_api_key ? (
            <Badge variant="muted" className="text-[10px]">{t('workspace_ui.providers.card.api_key_set')}</Badge>
          ) : (
            <Badge variant="muted" className="text-[10px]">{t('workspace_ui.providers.card.no_api_key')}</Badge>
          )}
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">{config.provider_type}</span>
      </div>
      <div className="mb-3">
        <ProviderCapabilityBadges providerType={config.provider_type} vendors={vendors} />
      </div>
      {config.base_url && (
        <p className="text-xs font-mono text-muted-foreground mb-2 truncate">{config.base_url}</p>
      )}
      {config.claude_compatible_base_url && (
        <p className="text-xs font-mono text-muted-foreground mb-2 truncate">{t('workspace_ui.providers.card.claude_url', { url: config.claude_compatible_base_url })}</p>
      )}
      {config.openai_compatible_base_url && (
        <p className="text-xs font-mono text-muted-foreground mb-2 truncate">{t('workspace_ui.providers.card.openai_url', { url: config.openai_compatible_base_url })}</p>
      )}
      <p className="text-xs mb-2">
        {t('workspace_ui.providers.card.network')} <span className="font-mono">{config.network_profile_id ? t('workspace_ui.providers.card.network_profile', { id: config.network_profile_id.slice(0, 8) }) : t('workspace_ui.providers.card.network_direct')}</span>
        {config.deployment === 'trusted_local' && <span className="ml-2">· {t('workspace_ui.providers.card.trusted_local')}</span>}
      </p>
      {config.default_model && (
        <p className="text-xs mb-2">{modelCopy.defaultLabel}: <span className="font-mono">{config.default_model}</span></p>
      )}
      <div className="flex flex-wrap gap-1 mb-3">
        {config.available_models.map(model => (
          <Badge key={model} variant="muted" className="text-[10px] font-mono">{model}</Badge>
        ))}
      </div>
      {isRetrievalOnlyVendor(config.provider_type, vendors) && (
        <p className="text-xs text-muted-foreground mb-3">{modelCopy.help}</p>
      )}
      {testResult && (
        <div className={`text-xs mb-3 p-2 rounded-md ${testResult.success ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-500'}`}>
          {testResult.success ? <CheckCircle className="size-3 inline mr-1" /> : <AlertCircle className="size-3 inline mr-1" />}
          {testResult.message}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={async () => { setTesting(true); try { setTestResult(await onTest(config.id)) } catch (error) { setTestResult({ success: false, message: errMsg(error) }) } finally { setTesting(false) } }} disabled={testing}>
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : t('workspace_ui.providers.card.test')}
        </Button>
        {config.manageable !== false && (
          <>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>{t('workspace_ui.providers.card.edit')}</Button>
            <Button size="sm" variant="outline" onClick={async () => { setDeleting(true); try { await onDelete(config.id) } catch (error) { toast.error(errMsg(error)) } finally { setDeleting(false) } }} disabled={deleting} className="text-red-500" aria-label={t('workspace_ui.providers.card.delete')}>
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            </Button>
          </>
        )}
      </div>
      {config.manageable !== false && spaces.length > 0 && (
        <div className="flex gap-2 pt-3 mt-3 border-t border-border">
          <select
            value={grantSpaceId}
            onChange={event => setGrantSpaceId(event.target.value)}
            className="flex h-8 flex-1 rounded-md border border-border bg-input px-2 text-xs"
          >
            <option value="">{t('workspace_ui.providers.card.grant_placeholder')}</option>
            {spaces.map(space => (
              <option key={space.id} value={space.id}>{space.name}</option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={grantProvider} disabled={!grantSpaceId || granting}>
            {granting ? <Loader2 className="size-3.5 animate-spin" /> : t('workspace_ui.providers.card.grant')}
          </Button>
        </div>
      )}
    </Card>
  )
}
