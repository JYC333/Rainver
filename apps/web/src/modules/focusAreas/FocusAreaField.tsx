import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { focusAreasApi } from '../../api/client'
import { Select } from '../../components/ui/select'
import { useSpace } from '../../contexts/SpaceContext'
import { SpaceLink } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'
import type { FocusArea } from '../../types/api'

/** Classification is navigation only; the owning endpoint checks every write. */
export function FocusAreaField({
  targetKind,
  targetId,
  focusAreaId,
  canEdit,
  onChanged,
}: {
  targetKind: 'object' | 'project'
  targetId: string
  focusAreaId: string | null | undefined
  canEdit: boolean
  onChanged: (focusAreaId: string | null) => void
}) {
  const { t } = useAppTranslation()
  const { activeSpaceId } = useSpace()
  const [areas, setAreas] = useState<FocusArea[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setAreas([])
    setFailed(false)
    if (!activeSpaceId) {
      setLoading(false)
      return () => { cancelled = true }
    }
    setLoading(true)
    // An archived Domain may still classify this item. Show its name, but
    // never offer it as a new destination (the server refuses that write).
    focusAreasApi.list(true).then((next) => {
      if (!cancelled) setAreas(next)
    }).catch(() => {
      if (!cancelled) setFailed(true)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [activeSpaceId])

  const value = focusAreaId ?? ''
  const options = [
    { value: '', label: t('focus_area.none') },
    ...areas.map((area) => ({
      value: area.id,
      label: area.archived_at ? t('focus_area.archived', { name: area.name }) : area.name,
      disabled: area.archived_at !== null,
    })),
  ]
  if (value && !areas.some((area) => area.id === value)) {
    options.push({ value, label: t('focus_area.unavailable'), disabled: true })
  }

  async function change(next: string) {
    if (next === value || !canEdit) return
    setSaving(true)
    try {
      if (targetKind === 'project') await focusAreasApi.setForProject(targetId, next || null)
      else await focusAreasApi.setForObject(targetId, next || null)
      onChanged(next || null)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t('focus_area.label')}</span>
      <Select
        ariaLabel={t('focus_area.label')}
        size="sm"
        className="w-44 max-w-full"
        options={options}
        value={value}
        onChange={(next) => { void change(next) }}
        disabled={!canEdit || loading || failed || saving || (!value && areas.every((area) => area.archived_at !== null))}
      />
      {canEdit && !loading && !failed && areas.every((area) => area.archived_at !== null) && (
        <SpaceLink to="/knowledge/domains" className="text-accent-foreground hover:underline">{t('focus_area.create')}</SpaceLink>
      )}
      {failed && <span>{t('focus_area.load_failed')}</span>}
    </div>
  )
}
