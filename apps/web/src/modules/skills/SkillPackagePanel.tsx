import { useEffect, useState } from 'react'
import type { SkillBinding, SkillBindingRequest, SkillPackage, SkillPackageContent } from '@rainver/protocol'
import { ApiRequestError, agentsApi, skillsApi, projectsApi, proposalsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { SpaceLink } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'

export function SkillPackagePanel({ spaceId, packageId, onChanged }: { spaceId: string; packageId: string; onChanged: () => void }) {
  const { t } = useAppTranslation()
  const { userId, spaces } = useSpace()
  // Space-wide scope decisions are a Space owner's or admin's; others are offered their own scopes.
  const spaceRole = spaces.find(space => space.id === spaceId)?.role
  const canEnableSpace = spaceRole === 'owner' || spaceRole === 'admin'
  const [pkg, setPackage] = useState<SkillPackage | null>(null)
  const [content, setContent] = useState<SkillPackageContent | null>(null)
  const [contentError, setContentError] = useState('')
  const [needsReimport, setNeedsReimport] = useState(false)
  const [bindings, setBindings] = useState<SkillBinding[]>([])
  const [filePath, setFilePath] = useState('SKILL.md')
  const [scopeChoice, setScope] = useState<SkillBindingRequest['scope_type'] | null>(null)
  const scope = scopeChoice ?? (canEnableSpace ? 'space' : 'user')
  const [scopeId, setScopeId] = useState('')
  const [targets, setTargets] = useState<Array<{ id: string; name: string }>>([])
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The caller's other pending review, which must be decided before asking for a different one.
  const [conflict, setConflict] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const options = { spaceId, signal: controller.signal }
    void skillsApi.getSkillPackage(packageId, options).then(setPackage).catch(error => { if (!controller.signal.aborted) setError(errMsg(error)) })
    void skillsApi.getSkillContent(packageId, options).then(setContent).catch(error => {
      if (!controller.signal.aborted) { setContentError(errMsg(error)); setNeedsReimport(error instanceof ApiRequestError && error.status === 409) }
    })
    void skillsApi.listSkillBindings(packageId, options).then(setBindings).catch(error => { if (!controller.signal.aborted) setError(errMsg(error)) })
    return () => controller.abort()
  }, [spaceId, packageId, reload])
  useEffect(() => {
    let active = true
    setTargets([]); setScopeId('')
    const read = scope === 'agent' ? agentsApi.list({}, { spaceId })
      : scope === 'project' ? projectsApi.list({ limit: 100 }, { spaceId }).then(page => page.items) : Promise.resolve([])
    void read.then(items => { if (active) setTargets(items.map(item => ({ id: item.id, name: item.name }))) })
      .catch(error => { if (active) setError(errMsg(error)) })
    return () => { active = false }
  }, [scope, spaceId])
  const reviewed = pkg?.status === 'reviewed'
  const builtin = pkg?.source?.source_type === 'builtin'
  const awaitingReview = !builtin && pkg?.status === 'imported'
  /** `enabled: null` files a review alone; otherwise an unreviewed package is reviewed and bound by one approval. */
  async function propose(enabled: boolean | null) {
    setBusy(true); setError(''); setConflict(false)
    try {
      const binding = enabled === null ? undefined
        : { scope_type: scope, scope_id: scope === 'space' ? null : scope === 'user' ? userId : scopeId, enabled }
      const proposal = reviewed && binding
        ? await skillsApi.createSkillBindingProposal(packageId, binding, { spaceId })
        : await skillsApi.createSkillReviewProposal(packageId, binding ? { binding } : {}, { spaceId })
      setPending(proposal.id)
      if (!reviewed) setPackage(await skillsApi.getSkillPackage(packageId, { spaceId }))
      onChanged()
    } catch (error) {
      const pendingProposal = error instanceof ApiRequestError && error.status === 409 && error.code === 'skill_review_pending'
        ? error.payload?.proposal_id : undefined
      if (typeof pendingProposal === 'string') { setPending(pendingProposal); setConflict(true) }
      else setError(errMsg(error))
    }
    finally { setBusy(false) }
  }
  async function decide(proposalId: string, accept: boolean) {
    setBusy(true); setError('')
    try {
      if (accept) await proposalsApi.accept(proposalId, { spaceId })
      else await proposalsApi.reject(proposalId, { spaceId })
      setPending(null); setConflict(false); setReload(value => value + 1); onChanged()
    } catch (error) { setError(errMsg(error)) }
    finally { setBusy(false) }
  }
  if (!pkg) return <Card className="p-4">{error || t('management_ui.skills.loading_detail')}</Card>
  const file = content?.files.find(file => file.path === filePath)
  let text: string | null = null
  if (file) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(file.content_base64), char => char.charCodeAt(0)))
      if (text.includes('\0')) text = null
    } catch { /* Binary files remain in the package; the text viewer does not decode them. */ }
  }
  const pendingId = pending ?? pkg.pending_proposal?.id ?? null
  const scopes = (reviewed ? (['space', 'user', 'project', 'agent'] as const) : (['space', 'user', 'agent'] as const))
    .filter(value => value !== 'space' || canEnableSpace)
  const origin = pkg.source?.metadata_json?.origin
  const sourceLabel = builtin ? t('skill_packages.builtin_source') : pkg.source?.source_type === 'github' ? 'GitHub'
    : origin === 'cli_global' ? t('skill_packages.local_cli')
      : pkg.source?.source_type === 'upload' ? t('skill_packages.uploaded_package') : t('skill_packages.local_source')
  const version = pkg.source?.commit_sha ?? pkg.version
  return <Card className="min-w-0 p-4 space-y-4">
    <div><h2 className="break-words text-lg font-semibold">{pkg.package_name}</h2>
      <p className="text-xs break-all text-muted-foreground">{sourceLabel}{version ? ` · ${version}` : ''}</p>
      {pkg.source?.url && <p className="break-all text-xs text-muted-foreground">{pkg.source.url}</p>}
      <p className="font-mono text-xs break-all">{String(pkg.manifest_json.package_hash ?? '')}</p>
    </div>
    <p className="text-sm text-muted-foreground">{t('skill_packages.compatibility')}</p>
    {pendingId ? <div role="status" className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <p className="text-sm font-medium">{t('skill_packages.pending_title')}</p>
      <p className="text-xs text-muted-foreground">{t(conflict ? 'skill_packages.pending_other_request' : 'skill_packages.pending_description')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => decide(pendingId, true)}>{t('skill_packages.approve')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(pendingId, false)}>{t('skill_packages.reject')}</Button>
        <SpaceLink className="text-xs text-primary underline" to={`/proposals/${pendingId}`}>{t('skill_packages.proposal_details')}</SpaceLink>
      </div>
    </div> : awaitingReview && <p role="status" className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{t('skill_packages.review_before_enable')}</p>}
    {builtin && <p className="text-sm text-muted-foreground">{t('skill_packages.builtin_description')}</p>}
    {contentError && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{needsReimport && !builtin && t('skill_packages.reimport')} {contentError}</p>}
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">{t('skill_packages.scope')}</h3>
      {bindings.map(binding => <p className="text-xs" key={binding.id}>
        {binding.project_id ? t('skill_packages.project') : binding.agent_id ? t('skill_packages.agent') : binding.user_id ? t('skill_packages.user') : t('skill_packages.space')}
        {(binding.project_id ?? binding.agent_id) && <> · <span className="break-all font-mono">{binding.project_id ?? binding.agent_id}</span></>}{' · '}{binding.enabled ? t('skill_packages.enabled') : t('skill_packages.disabled')}
      </p>)}
      <div className="flex flex-wrap gap-2">
        <select className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm" disabled={busy} aria-label={t('skill_packages.scope')} value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
          {scopes.map(value => <option key={value} value={value}>{t(`skill_packages.${value}`)}</option>)}
        </select>
        {(scope === 'project' || scope === 'agent') && <select className="min-w-0 max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm" disabled={busy} aria-label={t(`skill_packages.${scope}`)} value={scopeId} onChange={event => setScopeId(event.target.value)}>
          <option value="">{t('skill_packages.choose_scope')}</option>{targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
        </select>}
        {(reviewed ? [true, false] : awaitingReview ? [true] : []).map(enabled => <Button key={String(enabled)} variant={reviewed ? 'outline' : 'default'} disabled={busy || !!pendingId || !content || (scope === 'user' && !userId) || ((scope === 'project' || scope === 'agent') && !scopeId)} onClick={() => propose(enabled)}>
          {!reviewed ? t('skill_packages.review_and_enable') : enabled ? t('skill_packages.enable') : t('skill_packages.disable')}
        </Button>)}
        {awaitingReview && <Button variant="ghost" disabled={busy || !!pendingId} onClick={() => propose(null)}>{t('skill_packages.review_only')}</Button>}
      </div>
      {!reviewed && !builtin && <p className="text-xs text-muted-foreground">{t('skill_packages.project_after_review')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    {content && <div className="space-y-2 border-t border-border pt-4">
      <label className="block space-y-2 text-sm">{t('management_ui.skills.package_files')}<select className="mt-2 block w-full min-w-0 rounded-md border border-border bg-background p-2 text-sm" value={filePath} onChange={event => setFilePath(event.target.value)}>
        {content.files.map(file => <option key={file.path}>{file.path}</option>)}
      </select></label>
      {text === null ? <p className="text-sm text-muted-foreground">{t('skill_packages.binary')}</p>
        : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{text}</pre>}
    </div>}
  </Card>
}
