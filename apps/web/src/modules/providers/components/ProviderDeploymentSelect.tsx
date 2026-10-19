import type { ProviderDeployment, ProviderVendorOut } from '../../../api/client'
import { useAppTranslation } from '../../../i18n'

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
  const { t } = useAppTranslation()
  if (!vendors.find(vendor => vendor.id === providerType)?.self_hostable) return null
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t('management_ui.provider_deployment.label')}</label>
      <select
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value as ProviderDeployment)}
        className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
        aria-label={t('management_ui.provider_deployment.label')}
      >
        <option value="cloud">{t('management_ui.provider_deployment.cloud')}</option>
        <option value="trusted_local">{t('management_ui.provider_deployment.trusted_local')}</option>
      </select>
      <p className="text-[11px] text-muted-foreground">
        {t('management_ui.provider_deployment.hint')}
      </p>
    </div>
  )
}
