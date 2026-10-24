import { useEffect, useRef, useState } from 'react'
import { BookOpen, Loader2, Plus, RefreshCw, Search } from 'lucide-react'
import type { SkillPackage } from '@rainver/protocol'
import { skillsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { StatusBadge } from '../../components/ui/badge'
import { SkillPackagePanel } from './SkillPackagePanel'
import { SkillImportDialog } from './SkillImportDialog'

export default function SkillsPage() {
  const { activeSpaceId } = useSpace()
  return <SkillsLibrary key={activeSpaceId ?? ''} spaceId={activeSpaceId} />
}

function SkillsLibrary({ spaceId }: { spaceId: string | null }) {
  const { t } = useAppTranslation()
  const [packages, setPackages] = useState<SkillPackage[]>([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [importing, setImporting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController()
    return () => lifetime.current.abort()
  }, [])
  useEffect(() => {
    if (!spaceId) return
    const controller = new AbortController()
    setLoading(true); setError('')
    skillsApi.listSkillPackages({ spaceId, signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return
      setPackages(page.items); setTotal(page.total)
      setSelected(current => current && page.items.some(pkg => pkg.id === current) ? current : page.items[0]?.id ?? null)
    }).catch(error => { if (!controller.signal.aborted) setError(errMsg(error)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [spaceId, refresh])
  async function loadMore() {
    if (!spaceId || loadingMore || loading) return
    setLoadingMore(true); setError('')
    try {
      const page = await skillsApi.listSkillPackages({ spaceId, signal: lifetime.current.signal }, packages.length)
      if (!lifetime.current.signal.aborted) { setPackages(items => [...items, ...page.items.filter(pkg => !items.some(item => item.id === pkg.id))]); setTotal(page.total) }
    } catch (error) { if (!lifetime.current.signal.aborted) setError(errMsg(error)) }
    finally { if (!lifetime.current.signal.aborted) setLoadingMore(false) }
  }
  if (!spaceId) return <p className="p-6">{t('management_ui.skills.select_space')}</p>
  const filtered = packages.filter(pkg => `${pkg.package_name} ${pkg.source?.url ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const selectedPackage = filtered.find(pkg => pkg.id === selected) ?? filtered[0]
  const importButton = <Button onClick={() => setImporting(true)}><Plus className="mr-2 size-4" />{t('skill_packages.import_title')}</Button>
  return <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1"><h1 className="text-xl font-semibold tracking-tight">{t('skill_packages.title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('skill_packages.subtitle')}</p></div>
      <div className="flex items-center gap-2"><Button variant="outline" disabled={loading} onClick={() => { setRefresh(value => value + 1); setRevision(value => value + 1) }}>
        <RefreshCw className={`mr-2 size-4 ${loading ? 'animate-spin' : ''}`} />{t('management_ui.skills.refresh')}</Button>{importButton}</div>
    </header>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {loading && packages.length === 0 ? <Card className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{t('skill_packages.loading_library')}</Card>
      : packages.length === 0 && error ? null : packages.length === 0 ? <Card className="flex min-h-72 flex-col items-center justify-center px-6 py-10 text-center">
        <div className="mb-4 rounded-full bg-muted p-3"><BookOpen className="size-6 text-muted-foreground" /></div>
        <h2 className="font-medium">{t('skill_packages.empty_title')}</h2><p className="mb-5 mt-2 max-w-md text-sm text-muted-foreground">{t('skill_packages.empty_description')}</p>{importButton}
      </Card> : <div className="grid items-start gap-5 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
        <Card className="min-w-0 overflow-hidden">
          <div className="space-y-3 border-b p-3"><div className="flex items-center justify-between text-sm"><h2 className="font-medium">{t('skill_packages.library')}</h2><span className="tabular-nums text-muted-foreground">{total}</span></div>
            <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input className="pl-8" aria-label={t('skill_packages.search')} placeholder={t('skill_packages.search')} value={query} onChange={event => setQuery(event.target.value)} /></div>
          </div>
          <div className="max-h-[60dvh] overflow-y-auto p-2">
            {filtered.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('skill_packages.no_matches')}</p>}
            {filtered.map(pkg => <button type="button" key={pkg.id} aria-pressed={selectedPackage?.id === pkg.id} onClick={() => setSelected(pkg.id)}
              className={`mb-1 w-full rounded-md border px-3 py-3 text-left transition-colors ${selectedPackage?.id === pkg.id ? 'border-primary/30 bg-primary/5' : 'border-transparent hover:bg-muted/50'}`}>
              <span className="mb-2 flex items-start justify-between gap-2"><span className="min-w-0 break-words text-sm font-medium">{pkg.package_name}</span><StatusBadge status={pkg.status} label={t(`skill_packages.status_${pkg.status}`)} /></span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{String(pkg.manifest_json.package_hash ?? '').slice(0, 12)}</span>
            </button>)}
          </div>
          {packages.length < total && <div className="border-t p-2"><Button variant="ghost" className="w-full" disabled={loadingMore || loading} onClick={loadMore}>{loadingMore && <Loader2 className="mr-2 size-4 animate-spin" />}{t('skill_packages.more')}</Button></div>}
        </Card>
        {selectedPackage && <SkillPackagePanel key={`${selectedPackage.id}:${revision}`} spaceId={spaceId} packageId={selectedPackage.id} onChanged={() => setRefresh(value => value + 1)} />}
      </div>}
    {importing && <SkillImportDialog spaceId={spaceId} onClose={() => setImporting(false)} onImported={pkg => {
      setImporting(false); setSelected(pkg.id); setQuery(''); setPackages(items => [pkg, ...items.filter(item => item.id !== pkg.id)]); setRefresh(value => value + 1)
    }} />}
  </div>
}
