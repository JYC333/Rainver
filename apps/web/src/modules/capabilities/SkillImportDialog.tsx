import { useEffect, useRef, useState } from 'react'
import { FileArchive, GitBranch, HardDrive, Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { SkillImportPreviewRequest, SkillImportPreviewResponse, SkillPackage } from '@rainver/protocol'
import { capabilitiesFrameworkApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { cn, errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { SkillHostSource } from './SkillHostSource'

export function SkillImportDialog({ spaceId, onClose, onImported }: { spaceId: string; onClose: () => void; onImported: (pkg: SkillPackage) => void }) {
  const { t } = useAppTranslation()
  const { userId, spaces } = useSpace()
  // Enabling for the whole Space is a Space owner's or admin's decision; others default to themselves.
  const spaceRole = spaces.find(space => space.id === spaceId)?.role
  const canEnableSpace = spaceRole === 'owner' || spaceRole === 'admin'
  const [tab, setTab] = useState('local')
  const [enableChoice, setEnableChoice] = useState<'space' | 'user' | 'none' | null>(null)
  const enableScope = enableChoice ?? (canEnableSpace ? 'space' : userId ? 'user' : 'none')
  // An import kept although its enabling review could not be filed, with the inline explanation.
  const [imported, setImported] = useState<{ pkg: SkillPackage; notice: string } | null>(null)
  const [url, setUrl] = useState('')
  const [filename, setFilename] = useState('')
  const [dragging, setDragging] = useState(false)
  const [source, setSource] = useState<SkillImportPreviewRequest | null>(null)
  const [preview, setPreview] = useState<{ source: SkillImportPreviewRequest; result: SkillImportPreviewResponse } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [closed, setClosed] = useState(false)
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController()
    return () => { lifetime.current.abort() }
  }, [])
  const version = useRef(0)
  const upload = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  function changeSource(value: SkillImportPreviewRequest | null) {
    version.current++; setSource(value); setPreview(null); setError('')
  }
  async function readUpload(files: File[]) {
    if (busy || !files.length) return
    changeSource(null); setFilename('')
    if (files.length !== 1) { setError(t('skill_packages.upload_one_file')); return }
    const file = files[0]!
    const archive = /\.zip$/i.test(file.name)
    if (!archive && !/\.md$/i.test(file.name)) { setError(t('skill_packages.upload_types')); return }
    setFilename(file.name)
    const current = version.current
    setBusy(true)
    try {
      if (file.size > (archive ? 3 * 1024 * 1024 : 256 * 1024)) {
        throw new Error(t(archive ? 'skill_packages.size_limit' : 'skill_packages.markdown_size_limit'))
      }
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(reader.error); reader.readAsDataURL(file)
      })
      if (!lifetime.current.signal.aborted && version.current === current) setSource(archive
        ? { source_type: 'upload', archive_base64: encoded }
        : { source_type: 'upload', files: [{ path: 'SKILL.md', content_base64: encoded }] })
    } catch (error) { if (!lifetime.current.signal.aborted) setError(errMsg(error)) }
    finally { if (!lifetime.current.signal.aborted) setBusy(false) }
  }
  async function previewSource() {
    if (!source) return
    const current = version.current
    setBusy(true); setError('')
    try {
      const result = await capabilitiesFrameworkApi.previewSkillImport(source, { spaceId, signal: lifetime.current.signal })
      if (!lifetime.current.signal.aborted && current === version.current) setPreview({ source, result })
    } catch (error) { if (!lifetime.current.signal.aborted) setError(errMsg(error)) }
    finally { if (!lifetime.current.signal.aborted) setBusy(false) }
  }
  async function importPreview() {
    if (!preview) return
    setBusy(true); setError('')
    try {
      const pkg = await capabilitiesFrameworkApi.importSkill({ ...preview.source, package_hash: preview.result.package_hash }, { spaceId, signal: lifetime.current.signal })
      if (lifetime.current.signal.aborted) return
      // The import is kept even when filing its enabling review fails: the
      // review alone is filed instead and the dialog explains what is left.
      let notice = ''
      if (enableScope !== 'none') {
        try {
          await capabilitiesFrameworkApi.createSkillReviewProposal(pkg.id, {
            binding: { scope_type: enableScope, scope_id: enableScope === 'user' ? userId : null, enabled: true },
          }, { spaceId })
        } catch (enableError) {
          notice = await capabilitiesFrameworkApi.createSkillReviewProposal(pkg.id, {}, { spaceId })
            .then(() => t('skill_packages.enable_not_requested', { error: errMsg(enableError) }))
            .catch(reviewError => t('skill_packages.review_not_filed', { error: errMsg(reviewError) }))
        }
      }
      if (lifetime.current.signal.aborted) return
      toast.success(t('management_ui.capabilities.imported'))
      if (notice) { setPreview(null); setImported({ pkg, notice }) } else onImported(pkg)
    } catch (error) { setPreview(null); if (!lifetime.current.signal.aborted) setError(errMsg(error)) }
    finally { if (!lifetime.current.signal.aborted) setBusy(false) }
  }
  function close() {
    setClosed(true)
    if (imported) onImported(imported.pkg)
    else onClose()
  }
  return <Dialog open={!closed} onOpenChange={open => { if (!open && !busy) close() }}>
    <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto" showClose={!busy}>
      <DialogHeader><DialogTitle>{t('skill_packages.import_title')}</DialogTitle><DialogDescription>{t('skill_packages.import_description')}</DialogDescription></DialogHeader>
      {imported ? <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{imported.notice}</p> : <Tabs value={tab} onValueChange={value => { if (!busy) { setTab(value); setUrl(''); setFilename(''); setDragging(false); dragDepth.current = 0; changeSource(null) } }}>
        <TabsList className="grid h-auto w-full grid-cols-3">
          <TabsTrigger value="local" disabled={busy}><HardDrive className="mr-1.5 size-4" />{t('skill_packages.local_cli')}</TabsTrigger>
          <TabsTrigger value="github" disabled={busy}><GitBranch className="mr-1.5 size-4" />GitHub</TabsTrigger>
          <TabsTrigger value="upload" disabled={busy}><FileArchive className="mr-1.5 size-4" />{t('skill_packages.upload_tab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="local" className="pt-3"><SkillHostSource spaceId={spaceId} disabled={busy} onSelect={changeSource} /></TabsContent>
        <TabsContent value="github" className="space-y-2 pt-3">
          <label htmlFor="skill-github-url" className="text-sm font-medium">{t('management_ui.capabilities.url_label')}</label>
          <Input id="skill-github-url" value={url} disabled={busy} placeholder="https://github.com/org/repo/tree/main/skills/example" onChange={event => {
            setUrl(event.target.value); changeSource(event.target.value.trim() ? { url: event.target.value.trim() } : null)
          }} />
          <p className="text-xs text-muted-foreground">{t('skill_packages.github_hint')}</p>
        </TabsContent>
        <TabsContent value="upload" className="pt-3" onDragEnter={event => {
          event.preventDefault(); event.stopPropagation()
          if (!busy && event.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true) }
        }} onDragOver={event => {
          event.preventDefault(); event.stopPropagation()
          event.dataTransfer.dropEffect = !busy && event.dataTransfer.types.includes('Files') ? 'copy' : 'none'
        }} onDragLeave={event => {
          event.preventDefault(); event.stopPropagation()
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (!dragDepth.current) setDragging(false)
        }} onDrop={event => {
          event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false)
          void readUpload(Array.from(event.dataTransfer.files))
        }}>
          <input ref={upload} className="sr-only" tabIndex={-1} aria-label={t('skill_packages.upload_file')} type="file" accept=".md,.zip,text/markdown,application/zip" disabled={busy}
            onChange={event => { void readUpload(Array.from(event.target.files ?? [])); event.target.value = '' }} />
          <button type="button" disabled={busy} className={cn('flex w-full flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', dragging ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/30')} onClick={() => upload.current?.click()}>
            <Upload className={cn('size-6', dragging ? 'text-primary' : 'text-muted-foreground')} /><span className="max-w-full break-all text-sm font-medium">{dragging ? t('skill_packages.drop_upload') : filename || t('skill_packages.choose_upload')}</span>
            <span className="text-xs text-muted-foreground">{t('skill_packages.upload_hint')}</span>
          </button>
          <p className="mt-2 text-xs text-muted-foreground">{t('skill_packages.upload_package_hint')}</p>
        </TabsContent>
      </Tabs>}
      {preview && <section className="mt-4 space-y-2 rounded-lg border border-border bg-muted/30 p-4" aria-label={t('skill_packages.preview_summary')}>
        <h3 className="font-medium">{preview.result.normalized_skill.name}</h3><p className="text-sm text-muted-foreground">{preview.result.normalized_skill.description}</p>
        <p className="text-xs text-muted-foreground">{t('management_ui.capabilities.files', { count: preview.result.package_files.length })} · {t('skill_packages.risk')}: {t(`skill_packages.risk_${preview.result.risk_level}`)}</p>
        <code className="block break-all text-xs text-muted-foreground">{preview.result.package_hash}</code>
        {preview.result.warnings.map(warning => <p key={warning} className="text-xs">{warning}</p>)}
        <label className="flex flex-wrap items-center gap-2 pt-2 text-sm">{t('skill_packages.enable_after_import')}
          <select className="min-w-0 rounded-md border border-border bg-background px-3 py-1.5 text-sm" disabled={busy} value={enableScope} onChange={event => setEnableChoice(event.target.value as typeof enableScope)}>
            {canEnableSpace && <option value="space">{t('skill_packages.space')}</option>}
            {userId && <option value="user">{t('skill_packages.user')}</option>}
            <option value="none">{t('skill_packages.enable_later')}</option>
          </select></label>
        <p className="text-xs text-muted-foreground">{t(enableScope === 'none' ? 'skill_packages.review_after_import' : 'skill_packages.approve_after_import')}</p>
        {!canEnableSpace && <p className="text-xs text-muted-foreground">{t('skill_packages.space_scope_admins')}</p>}
      </section>}
      {error && <p role="alert" className="mt-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">{t('skill_packages.package_limits')}</p>
        <div className="ml-auto flex gap-2">{imported ? <Button onClick={close}>{t('skill_packages.done')}</Button> : <><Button variant="outline" disabled={busy} onClick={close}>{t('skill_packages.cancel')}</Button>
          {preview ? <Button disabled={busy || !preview.result.persistable} onClick={importPreview}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}{t(enableScope === 'none' ? 'management_ui.capabilities.import' : 'skill_packages.import_and_enable')}</Button>
            : <Button disabled={busy || !source} onClick={previewSource}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}{t('management_ui.capabilities.preview')}</Button>}</>}
        </div>
      </div>
    </DialogContent>
  </Dialog>
}
