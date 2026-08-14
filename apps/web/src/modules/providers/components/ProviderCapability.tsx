import type { ProviderType, ProviderVendorOut } from '../../../api/client'
import { Badge } from '../../../components/ui/badge'
import { modelFieldCopy, providerCapabilities } from '../providerMetadata'
import type { AddProviderMode } from '../types'

export function ProviderCapabilityBadges({
  providerType,
  vendors,
  mode,
}: {
  providerType: ProviderType | string
  vendors: readonly ProviderVendorOut[]
  mode?: AddProviderMode
}) {
  const capabilities = providerCapabilities(providerType, vendors, mode)
  if (capabilities.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {capabilities.map(capability => (
        <Badge key={capability.key} variant={capability.variant} className="text-[10px]">
          {capability.label}
        </Badge>
      ))}
    </div>
  )
}

export function ProviderCapabilityNotice({
  providerType,
  vendors,
  mode,
}: {
  providerType: ProviderType | string
  vendors: readonly ProviderVendorOut[]
  mode?: AddProviderMode
}) {
  const capabilities = providerCapabilities(providerType, vendors, mode)
  const copy = modelFieldCopy(providerType, mode)
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/60 px-3 py-2">
      <ProviderCapabilityBadges providerType={providerType} vendors={vendors} mode={mode} />
      <p className="text-xs text-muted-foreground">{copy.help}</p>
      {capabilities.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {capabilities.map(capability => `${capability.label}: ${capability.detail}`).join(' ')}
        </p>
      )}
    </div>
  )
}
