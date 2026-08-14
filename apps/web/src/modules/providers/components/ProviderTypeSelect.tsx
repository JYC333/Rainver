import type { ProviderType, ProviderVendorOut } from '../../../api/client'
import { providerTypeOptionsForMode } from '../providerMetadata'
import type { AddProviderMode } from '../types'

export default function ProviderTypeSelect({
  value,
  mode,
  vendors,
  onChange,
}: {
  value: ProviderType
  mode: AddProviderMode
  vendors: readonly ProviderVendorOut[]
  onChange: (v: ProviderType) => void
}) {
  return (
    <select
      value={value}
      onChange={event => onChange(event.target.value as ProviderType)}
      className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
    >
      {providerTypeOptionsForMode(mode, vendors).map(type => (
        <option key={type.value} value={type.value}>{type.label}</option>
      ))}
    </select>
  )
}
