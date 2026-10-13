import type { ProviderDeployment, ProviderVendorOut } from '../../../api/client'

/**
 * Where a self-hostable Provider actually runs. Only an owner/admin's
 * explicit "trusted local" declaration makes it a local egress destination;
 * a hosted vendor has no choice to make and shows nothing here.
 */
export default function ProviderDeploymentSelect({
  providerType,
  vendors,
  value,
  onChange,
  disabled,
}: {
  providerType: string
  vendors: readonly ProviderVendorOut[]
  value: ProviderDeployment
  onChange: (value: ProviderDeployment) => void
  disabled?: boolean
}) {
  if (!vendors.find(vendor => vendor.id === providerType)?.self_hostable) return null
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Deployment</label>
      <select
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value as ProviderDeployment)}
        className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
        aria-label="Deployment"
      >
        <option value="cloud">Cloud or unknown (content leaves this instance)</option>
        <option value="trusted_local">Trusted local service (runs inside this network, no cloud models)</option>
      </select>
      <p className="text-[11px] text-muted-foreground">
        A trusted local declaration is a Space owner/admin statement. It counts only for an endpoint inside this
        network and for models the service does not forward to a hosted vendor.
      </p>
    </div>
  )
}
