import { useEffect, useState } from 'react'
import { capabilitiesFrameworkApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { SpaceLink } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import type { CapabilityDefinition, CapabilityPackDescriptor } from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table'

export default function CapabilitiesPage() {
  const { t } = useAppTranslation()
  const { activeSpaceId } = useSpace()
  const [caps, setCaps] = useState<CapabilityDefinition[]>([])
  const [packs, setPacks] = useState<CapabilityPackDescriptor[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setCaps([]); setPacks([]); setSelected(null); setError('')
    if (activeSpaceId) void Promise.all([capabilitiesFrameworkApi.listCapabilityDefinitions(), capabilitiesFrameworkApi.listCapabilityPacks()])
      .then(([definitions, packages]) => { if (active) { setCaps(definitions); setPacks(packages) } })
      .catch(error => { if (active) setError(errMsg(error)) })
    return () => { active = false }
  }, [activeSpaceId])
  const selectedCap = caps.find(c => c.id === selected)
  return (<div className="p-6 space-y-6">
    <h1 className="text-xl font-semibold">{t('management_ui.capabilities.title')}</h1>
    <SpaceLink className="text-primary underline" to="/skills">{t('skill_packages.title')}</SpaceLink>
    {error && <p role="alert">{error}</p>}
    <Card className="p-4 space-y-3">
      <CardTitle>{t('management_ui.capabilities.skill_packs')}</CardTitle>
      {packs.map(pack => <div key={pack.id}>
        <span className="font-medium">{pack.name}</span> <Badge variant="secondary">{pack.version}</Badge>
        <p className="text-sm text-muted-foreground">{pack.description}</p>
      </div>)}
    </Card>
      {caps.length === 0
        ? <Card><p className="text-muted-foreground text-center py-10 text-sm">{t('management_ui.capabilities.no_capabilities')}</p></Card>
        : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('management_ui.capabilities.col_id')}</TableHead><TableHead>{t('management_ui.capabilities.col_name')}</TableHead>
                  <TableHead>{t('management_ui.capabilities.col_namespace')}</TableHead><TableHead>{t('management_ui.capabilities.col_version')}</TableHead>
                  <TableHead>{t('management_ui.capabilities.col_description')}</TableHead><TableHead>{t('management_ui.capabilities.col_status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {caps.map(c => (
                  <TableRow
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                    className={`cursor-pointer ${selected === c.id ? 'bg-accent/50' : ''}`}
                  >
                    <TableCell className="font-mono text-xs">{c.id}</TableCell>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">{c.namespace}</TableCell>
                    <TableCell className="text-muted-foreground">{c.version}</TableCell>
                    <TableCell className="max-w-[240px] truncate text-muted-foreground">{c.description || '—'}</TableCell>
                    <TableCell><StatusBadge status={c.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}

      {selectedCap && (
        <Card>
          <CardTitle>{t('management_ui.capabilities.definition', { id: selectedCap.id })}</CardTitle>
          <pre className="text-xs">{JSON.stringify(selectedCap, null, 2)}</pre>
        </Card>
      )}
    </div>
  )
}
