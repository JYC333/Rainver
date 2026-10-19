import { useState, useEffect, useCallback } from 'react'
import { ArrowRight, Download, Eye, RefreshCw, ShieldCheck, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError, capabilitiesFrameworkApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { formatBytes, formatDateTime } from '../../i18n/format'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  CapabilityDefinition,
  CapabilityPackDescriptor,
  SkillImportPreviewResponse,
  SkillPackage,
  SkillPackageFile,
} from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table'

function manifestString(manifest: Record<string, unknown>, key: string): string | null {
  const value = manifest[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function manifestNumber(manifest: Record<string, unknown>, key: string): number | null {
  const value = manifest[key]
  return typeof value === 'number' ? value : null
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function prettyBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return formatBytes(value)
}

function skillDescription(skill: SkillPackage): string | null {
  return firstString(recordValue(skill.normalized_json), ['description'])
}

function skillInstructions(skill: SkillPackage): string | null {
  return firstString(recordValue(skill.normalized_json), ['instructions_markdown', 'instructions'])
}

function skillPermissions(skill: SkillPackage): string[] {
  const normalized = recordValue(skill.normalized_json)
  const requested = stringArrayValue(normalized.requested_permissions)
  if (requested.length > 0) return requested
  return stringArrayValue(recordValue(skill.manifest_json).requested_permissions)
}

function skillDiagnostics(skill: SkillPackage): string[] {
  const normalized = recordValue(skill.normalized_json)
  return stringArrayValue(normalized.diagnostics)
}

function fileRiskFlags(file: SkillPackageFile): string[] {
  const flags = recordValue(file.risk_flags_json)
  return Object.entries(flags)
    .filter(([, value]) => value === true || (typeof value === 'string' && value.length > 0))
    .map(([key]) => key)
}

function riskVariant(risk: string): 'success' | 'warning' | 'destructive' | 'muted' {
  if (risk === 'low') return 'success'
  if (risk === 'medium') return 'warning'
  if (risk === 'high' || risk === 'critical') return 'destructive'
  return 'muted'
}

interface SkillDetailPanelProps {
  skill: SkillPackage
  onReview: (id: string) => void
  onConvert: (id: string) => void
  reviewingId: string | null
  convertingId: string | null
}

function SkillDetailPanel({ skill, onReview, onConvert, reviewingId, convertingId }: SkillDetailPanelProps) {
  const { t } = useAppTranslation()
  // The caller's own proposal for this snapshot is still waiting: asking
  // again would only return it, so the action stays disabled until decided.
  const reviewPending = skill.pending_proposal?.operation === 'skill_import_approve'
  const convertPending = skill.pending_proposal?.operation === 'install_from_skill_package'
  const manifest = recordValue(skill.manifest_json)
  const files = skill.package_files ?? []
  const permissions = skillPermissions(skill)
  const diagnostics = skillDiagnostics(skill)
  const description = skillDescription(skill)
  const instructions = skillInstructions(skill)
  const source = skill.source

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{skill.package_name}</span>
            <Badge variant={riskVariant(skill.risk_level)}>{skill.risk_level}</Badge>
            <StatusBadge status={skill.status} />
            {skill.version && <Badge variant="outline">{skill.version}</Badge>}
          </div>
          {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onReview(skill.id)}
            disabled={skill.status !== 'imported' || reviewingId === skill.id || reviewPending}
          >
            <ShieldCheck className="size-4 mr-1" />
            {reviewingId === skill.id ? t('management_ui.capabilities.creating') : reviewPending ? t('skill_packages.review_pending') : t('management_ui.capabilities.review')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onConvert(skill.id)}
            disabled={skill.status !== 'reviewed' || convertingId === skill.id || convertPending}
          >
            {convertingId === skill.id ? t('management_ui.capabilities.creating') : skill.status === 'converted' ? t('management_ui.capabilities.converted') : convertPending ? t('skill_packages.convert_pending') : t('management_ui.capabilities.convert')}
          </Button>
        </div>
      </div>
      {(reviewPending || convertPending) && (
        <p className="text-xs text-muted-foreground">{t('skill_packages.pending_hint')}</p>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.capabilities.package_root')}</div>
          <div className="text-xs font-mono truncate">{manifestString(manifest, 'package_root') ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.capabilities.package_hash')}</div>
          <div className="text-xs font-mono truncate">{manifestString(manifest, 'package_hash') ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.capabilities.source')}</div>
          <div className="text-xs truncate">{source?.url ?? source?.repo ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.capabilities.updated')}</div>
          <div className="text-xs">{formatDateTime(skill.updated_at)}</div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.capabilities.requested_permissions')}</div>
        {permissions.length === 0 ? (
          <p className="text-xs text-muted-foreground">—</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {permissions.map(permission => <Badge key={permission} variant="outline">{permission}</Badge>)}
          </div>
        )}
      </div>

      {diagnostics.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {diagnostics.map(item => <Badge key={item} variant="warning">{item}</Badge>)}
        </div>
      )}

      {instructions && (
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground mb-1">{t('management_ui.capabilities.instructions_preview')}</div>
          <pre className="text-xs whitespace-pre-wrap rounded-md border border-border bg-background/60 p-3 max-h-48 overflow-auto">
            {instructions}
          </pre>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.capabilities.package_files')}</div>
        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('management_ui.capabilities.no_files')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('management_ui.capabilities.col_path')}</TableHead>
                <TableHead>{t('management_ui.capabilities.col_kind')}</TableHead>
                <TableHead>{t('management_ui.capabilities.col_size')}</TableHead>
                <TableHead>{t('management_ui.capabilities.col_flags')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map(file => {
                const flags = fileRiskFlags(file)
                return (
                  <TableRow key={file.id}>
                    <TableCell className="font-mono text-xs max-w-[320px] truncate">{file.path}</TableCell>
                    <TableCell><Badge variant="outline">{file.kind}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{prettyBytes(file.byte_length)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {file.executable && <Badge variant="warning">{t('management_ui.capabilities.executable')}</Badge>}
                        {!file.included && <Badge variant="muted">{t('management_ui.capabilities.metadata_only')}</Badge>}
                        {flags.map(flag => <Badge key={flag} variant="warning">{flag}</Badge>)}
                        {!file.executable && flags.length === 0 && file.included && <span className="text-xs text-muted-foreground">—</span>}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

export default function CapabilitiesPage() {
  const { t } = useAppTranslation()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [caps, setCaps]           = useState<CapabilityDefinition[]>([])
  const [packs, setPacks]         = useState<CapabilityPackDescriptor[]>([])
  const [skillPackages, setSkillPackages] = useState<SkillPackage[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected]   = useState<string | null>(null)
  const [importUrl, setImportUrl] = useState('')
  const [preview, setPreview] = useState<SkillImportPreviewResponse | null>(null)
  // The URL that preview describes. Editing the field afterwards withdraws
  // the preview, so Import never sends a package nobody looked at.
  const [previewedUrl, setPreviewedUrl] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [skillDetail, setSkillDetail] = useState<SkillPackage | null>(null)
  const [skillDetailLoading, setSkillDetailLoading] = useState(false)

  /** Resolves false when the lists could not be read; the error is already shown. */
  const load = useCallback(async (): Promise<boolean> => {
    if (!activeSpaceId) {
      setCaps([])
      setPacks([])
      setSkillPackages([])
      setSelected(null)
      setSelectedSkillId(null)
      setSkillDetail(null)
      return true
    }
    try {
      const [data, packData, skillData] = await Promise.all([
        capabilitiesFrameworkApi.listCapabilityDefinitions(),
        capabilitiesFrameworkApi.listCapabilityPacks(),
        capabilitiesFrameworkApi.listSkillPackages(),
      ])
      setCaps(data)
      setPacks(packData)
      setSkillPackages(skillData.items)
      if (data.length && !selected) setSelected(data[0].id)
      if (skillData.items.length && !selectedSkillId) setSelectedSkillId(skillData.items[0].id)
      if (skillData.items.length === 0) setSelectedSkillId(null)
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    }
  }, [selected, selectedSkillId, activeSpaceId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!activeSpaceId || !selectedSkillId) {
      setSkillDetail(null)
      return
    }
    let cancelled = false
    setSkillDetailLoading(true)
    capabilitiesFrameworkApi.getSkillPackage(selectedSkillId)
      .then(detail => {
        if (!cancelled) setSkillDetail(detail)
      })
      .catch(e => {
        if (!cancelled) {
          toast.error(errMsg(e))
          setSkillDetail(null)
        }
      })
      .finally(() => {
        if (!cancelled) setSkillDetailLoading(false)
      })
    return () => { cancelled = true }
  }, [activeSpaceId, selectedSkillId])

  async function refresh() {
    if (!activeSpaceId) {
      toast.error(t('management_ui.capabilities.select_space'))
      return
    }
    setRefreshing(true)
    try {
      if (await load()) toast.success(t('management_ui.capabilities.refreshed'))
    } finally { setRefreshing(false) }
  }

  async function previewImport() {
    if (!importUrl.trim()) {
      toast.error(t('management_ui.capabilities.enter_url'))
      return
    }
    setPreviewing(true)
    const url = importUrl.trim()
    try {
      const result = await capabilitiesFrameworkApi.previewSkillImport({ url })
      setPreview(result)
      setPreviewedUrl(url)
    } catch (e) {
      toast.error(errMsg(e))
      setPreview(null)
    } finally {
      setPreviewing(false)
    }
  }

  async function importSkill() {
    if (!currentPreview?.persistable) return
    setImporting(true)
    try {
      await capabilitiesFrameworkApi.importSkill({ url: previewedUrl, package_hash: currentPreview.package_hash })
      toast.success(t('management_ui.capabilities.imported'))
      setPreview(null)
      setImportUrl('')
      await load()
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'skill_package_changed') {
        // What was previewed is not what would be imported: withdraw the
        // preview so the next Import follows a fresh look.
        setPreview(null)
        toast.error(t('skill_packages.package_changed'))
      } else {
        toast.error(errMsg(e))
      }
    } finally {
      setImporting(false)
    }
  }

  async function reviewSkill(skillPackageId: string) {
    setReviewingId(skillPackageId)
    try {
      const knownPending = skillPackages.find(item => item.id === skillPackageId)?.pending_proposal?.id
      const result = await capabilitiesFrameworkApi.createSkillReviewProposal(skillPackageId)
      toast.success(result.id === knownPending ? t('skill_packages.proposal_already_pending') : t('skill_packages.proposal_created'))
      await load()
      const detail = await capabilitiesFrameworkApi.getSkillPackage(skillPackageId)
      setSkillDetail(detail)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setReviewingId(null)
    }
  }

  async function convertSkill(skillPackageId: string) {
    setConvertingId(skillPackageId)
    try {
      const knownPending = skillPackages.find(item => item.id === skillPackageId)?.pending_proposal?.id
      const result = await capabilitiesFrameworkApi.convertSkillToCapability(skillPackageId)
      toast.success(result.id === knownPending ? t('skill_packages.proposal_already_pending') : t('skill_packages.proposal_created'))
      await load()
      const detail = await capabilitiesFrameworkApi.getSkillPackage(skillPackageId)
      setSkillDetail(detail)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setConvertingId(null)
    }
  }

  const selectedCap = caps.find(c => c.id === selected)
  const currentPreview = preview && previewedUrl === importUrl.trim() ? preview : null
  const previewScriptCount = currentPreview
    ? currentPreview.package_files.filter(file => file.kind === 'script' || file.executable).length
    : 0

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between pb-4 border-b border-border">
        <div className="flex items-center gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            <Zap className="size-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t('management_ui.capabilities.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('management_ui.capabilities.subtitle')}</p>
            <p className="text-xs text-muted-foreground">{t('management_ui.capabilities.viewing', { space: activeSpaceName ?? activeSpaceId ?? t('management_ui.capabilities.no_space') })}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
          <RefreshCw className="size-4 mr-1" />
          {refreshing ? t('management_ui.capabilities.refreshing') : t('management_ui.capabilities.refresh')}
        </Button>
      </div>

      <Card className="p-4 space-y-3">
        <div>
          <CardTitle>{t('management_ui.capabilities.skill_packs')}</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">{t('management_ui.capabilities.skill_packs_hint')}</p>
        </div>
        <div className="space-y-3">
          {packs.map(pack => (
            <div key={pack.id} className="border border-border rounded-lg p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-sm">{pack.name}</div>
                <Badge variant="secondary">{pack.version}</Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{pack.description}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {pack.artifact_types.map(type => <Badge key={type} variant="outline">{type}</Badge>)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <div>
          <CardTitle>{t('management_ui.capabilities.imported_skills')}</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">{t('management_ui.capabilities.imported_skills_hint')}</p>
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1 space-y-1.5">
            <Label>{t('management_ui.capabilities.url_label')}</Label>
            <Input
              value={importUrl}
              onChange={event => setImportUrl(event.target.value)}
              placeholder="https://github.com/org/repo/tree/main/path/to/skill"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={previewImport} disabled={previewing || !importUrl.trim()}>
              <ArrowRight className="size-4 mr-1" />
              {previewing ? t('management_ui.capabilities.previewing') : t('management_ui.capabilities.preview')}
            </Button>
            <Button onClick={importSkill} disabled={importing || !currentPreview?.persistable}>
              <Download className="size-4 mr-1" />
              {importing ? t('management_ui.capabilities.importing') : t('management_ui.capabilities.import')}
            </Button>
          </div>
        </div>

        {currentPreview && (
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-sm">{currentPreview.normalized_skill.name}</span>
              <Badge variant={riskVariant(currentPreview.risk_level)}>{currentPreview.risk_level}</Badge>
              {currentPreview.requested_permissions.map(permission => (
                <Badge key={permission} variant="outline">{permission}</Badge>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">{currentPreview.normalized_skill.description}</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">{t('management_ui.capabilities.files', { count: currentPreview.package_files.length })}</Badge>
              <Badge variant="outline">{currentPreview.package_root}</Badge>
              {previewScriptCount > 0 && <Badge variant="warning">{t('management_ui.capabilities.scripts', { count: previewScriptCount })}</Badge>}
            </div>
            <div className="font-mono text-[11px] text-muted-foreground truncate">sha256:{currentPreview.package_hash}</div>
            {currentPreview.warnings.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {currentPreview.warnings.map(warning => <Badge key={warning} variant="warning">{warning}</Badge>)}
              </div>
            )}
          </div>
        )}

        {skillPackages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('management_ui.capabilities.no_imported')}</p>
        ) : (
          <div className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('management_ui.capabilities.col_name')}</TableHead><TableHead>{t('management_ui.capabilities.col_risk')}</TableHead><TableHead>{t('management_ui.capabilities.col_status')}</TableHead>
                  <TableHead>{t('management_ui.capabilities.col_files')}</TableHead><TableHead>{t('management_ui.capabilities.updated')}</TableHead><TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skillPackages.map(skill => {
                  const fileCount = manifestNumber(skill.manifest_json, 'package_file_count')
                  const packageRoot = manifestString(skill.manifest_json, 'package_root')
                  return (
                  <TableRow
                    key={skill.id}
                    onClick={() => setSelectedSkillId(skill.id)}
                    className={`cursor-pointer ${selectedSkillId === skill.id ? 'bg-accent/50' : ''}`}
                  >
                    <TableCell>
                      <div className="font-medium">{skill.package_name}</div>
                      <div className="text-xs text-muted-foreground">{skill.id}</div>
                    </TableCell>
                    <TableCell><Badge variant={riskVariant(skill.risk_level)}>{skill.risk_level}</Badge></TableCell>
                    <TableCell><StatusBadge status={skill.status} /></TableCell>
                    <TableCell>
                      <div className="text-sm">{fileCount ?? '—'}</div>
                      <div className="text-xs text-muted-foreground max-w-[180px] truncate">{packageRoot ?? '—'}</div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(skill.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={event => {
                          event.stopPropagation()
                          setSelectedSkillId(skill.id)
                        }}
                      >
                        <Eye className="size-4 mr-1" />
                        {t('management_ui.capabilities.inspect')}
                      </Button>
                    </TableCell>
                  </TableRow>
                  )
                })}
              </TableBody>
            </Table>

            {skillDetailLoading && (
              <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground">{t('management_ui.capabilities.loading_detail')}</div>
            )}

            {!skillDetailLoading && skillDetail && (
              <SkillDetailPanel
                skill={skillDetail}
                onReview={reviewSkill}
                onConvert={convertSkill}
                reviewingId={reviewingId}
                convertingId={convertingId}
              />
            )}
          </div>
        )}
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
