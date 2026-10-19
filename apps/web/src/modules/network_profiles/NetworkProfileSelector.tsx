import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { networkProfilesApi } from '../../api/client'
import type { NetworkProfileOut } from '../../types/api'
import { useAppTranslation } from '../../i18n'

export default function NetworkProfileSelector({
  value,
  onChange,
  disabled = false,
  className = '',
}: {
  value: string | null | undefined
  onChange: (value: string | null) => void
  disabled?: boolean
  className?: string
}) {
  const { t } = useAppTranslation()
  const [profiles, setProfiles] = useState<NetworkProfileOut[]>([])
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setProfiles(await networkProfilesApi.list())
    } catch {
      setProfiles([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value || null)}
        disabled={disabled || loading}
        className="flex h-9 min-w-0 flex-1 rounded-md border border-border bg-input px-3 text-sm"
      >
        <option value="">{t('management_ui.network_profiles.direct')}</option>
        {profiles.map(profile => (
          <option key={profile.id} value={profile.id} disabled={!profile.enabled}>
            {profile.enabled ? profile.name : t('management_ui.network_profiles.name_disabled', { name: profile.name })}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
        onClick={load}
        disabled={disabled || loading}
        title={t('management_ui.network_profiles.refresh')}
      >
        <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
      </button>
    </div>
  )
}
