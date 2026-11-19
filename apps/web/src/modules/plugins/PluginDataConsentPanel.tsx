import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { PluginDataConsentOption, PluginDataGrant } from '@rainver/protocol'
import { callOperation, projectsApi, queryOperation } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { ConfirmDialog } from '../../components/ui/dialog'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'

/**
 * The data owner's own entry for standing plugin-data consent (ADR 0030): a
 * Space owner's Space-wide personal consent and each person's read-only
 * background consent for their own scheduled Runs. Active consents are listed
 * from the grants themselves with the tools and scope they froze, so one stays
 * revocable after its plugin is turned off, removed or upgraded; the server's
 * options only offer new consent, each confirmed against the package identity
 * it was expanded from. Per-Run sensitive consent stays with the Run's
 * authorization request. A core Project consent (ADR 0033: Gmail on-demand
 * read, daily or monitor-hit digest) is listed with its Project and purpose;
 * the Project is named only when `projectsApi.get` succeeds with
 * `current_user_can_read === true`; a limited answer or a refusal (404) shows
 * the fallback. Hidden when there is
 * nothing to show.
 */
export function PluginDataConsentPanel({ spaceId, spaceName }: { spaceId: string; spaceName: string | null }) {
  const { t } = useAppTranslation()
  const k = (key: string, values?: Record<string, unknown>) => t(`plugin_ui.data_consent.${key}`, values)
  const [options, setOptions] = useState<PluginDataConsentOption[]>([])
  const [grants, setGrants] = useState<PluginDataGrant[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PluginDataConsentOption | null>(null)
  const [busy, setBusy] = useState(false)
  /** Names of the Projects this person's Project consents are bound to; `null` when they can no longer open it. */
  const [projectNames, setProjectNames] = useState<Record<string, string | null>>({})
  const scope = { spaceId }

  const load = useCallback(async () => {
    try {
      const result = await queryOperation('plugin_data_grant.list', {}, scope)
      if (!('status' in result) || result.status !== 'succeeded') throw new Error(k('unavailable'))
      const data = (result as { data: { items: PluginDataGrant[]; consentable?: PluginDataConsentOption[] } }).data
      setOptions(data.consentable ?? [])
      setGrants(data.items)
      setError(null)
    } catch (cause) {
      // A refusal never keeps the previous options on screen.
      setOptions([])
      setGrants([])
      setError(errMsg(cause))
    }
    // scope is derived from spaceId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId])

  useEffect(() => { void load() }, [load])

  const projectIds = [...new Set(grants.flatMap(grant => grant.scope === 'project' && grant.status === 'active' && grant.project_id ? [grant.project_id] : []))]
  const projectKey = projectIds.sort().join(',')
  useEffect(() => {
    if (!projectKey) return
    let live = true
    void Promise.all(projectKey.split(',').map(async id => {
      // Only an explicit read right names it: a limited (metadata-only) answer or a refusal keeps the fallback.
      try {
        const project = await projectsApi.get(id, { spaceId })
        return [id, project.current_user_can_read === true ? project.name : null] as const
      } catch { return [id, null] as const }
    })).then(entries => { if (live) setProjectNames(Object.fromEntries(entries)) })
    return () => { live = false }
  }, [projectKey, spaceId])

  const standing = grants.filter(grant => grant.status === 'active' && grant.scope !== 'run')
  const offered = options.filter(option => !option.active_grant_id)
  if (!error && standing.length === 0 && offered.length === 0) return null

  const consent = async (option: PluginDataConsentOption) => {
    setBusy(true)
    try {
      const result = await callOperation('plugin_data_grant.create', {
        plugin_id: option.plugin_id, toolset: option.toolset, data_class: option.data_class, scope: option.scope,
        authority_hash: option.authority_hash,
        ...(option.default_expires_in_seconds ? { expires_in_seconds: option.default_expires_in_seconds } : {}),
      }, crypto.randomUUID(), scope)
      if (!('status' in result) || result.status !== 'succeeded') throw new Error(k('failed'))
      toast.success(k('granted'))
    } catch (cause) {
      // A plugin changed since review is refused; the refreshed list asks again.
      toast.error(errMsg(cause))
    } finally {
      await load()
      setBusy(false)
    }
  }

  const revoke = async (grantId: string) => {
    setBusy(true)
    try {
      const result = await callOperation('plugin_data_grant.revoke', { grant_id: grantId }, crypto.randomUUID(), scope)
      if (!('status' in result) || result.status !== 'succeeded') throw new Error(k('failed'))
      toast.success(k('revoked'))
      await load()
    } catch (cause) {
      toast.error(errMsg(cause))
    } finally {
      setBusy(false)
    }
  }

  const who = (scope: string) => scope === 'space' ? k('scope_space') : k('scope_background')
  const projectScope = (grant: PluginDataGrant) => {
    const name = grant.project_id ? projectNames[grant.project_id] : null
    return name ? k('scope_project', { project: name }) : grant.project_id && !(grant.project_id in projectNames) ? k('scope_project_loading') : k('scope_project_hidden')
  }
  const grantScope = (grant: PluginDataGrant) => grant.scope === 'project'
    ? `${projectScope(grant)}${grant.purpose ? ` · ${k(`purpose_${grant.purpose}`)}` : ''}`
    : who(grant.scope)
  const offeredExpiry = (option: PluginDataConsentOption) =>
    option.default_expires_in_seconds ? k('expires_after', { hours: Math.round(option.default_expires_in_seconds / 3600) }) : k('no_expiry')
  const CORE_NAMES: Record<string, string> = { 'core:gmail': k('core_gmail'), 'core:gmail_digest': k('core_gmail_digest') }
  const pluginName = (pluginId: string) => options.find(option => option.plugin_id === pluginId)?.plugin_name ?? CORE_NAMES[pluginId] ?? pluginId
  const labelOf = (name: string, toolset: string) => `${name} · ${t(`plugin_ui.run_data.toolset_${toolset}`)}`
  const tools = (ids: string[]) => (
    <p className="text-xs text-muted-foreground">{k('tools')} <span className="break-all font-mono">{ids.join(', ')}</span></p>
  )
  const classBadge = (dataClass: string) => <Badge variant={dataClass === 'sensitive' ? 'warning' : 'secondary'}>{t(`plugin_ui.run_data.class_${dataClass}`)}</Badge>
  const section = (title: string, rows: ReactNode) => (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="divide-y divide-border rounded-md border border-border">{rows}</ul>
    </div>
  )
  const row = 'flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-start sm:justify-between'

  return (
    <Card data-testid="plugin-data-consent-panel">
      <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-3.5" /> {k('title')}</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">{spaceName ? `${k('in_space', { space: spaceName })} ` : ''}{k('hint')}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="space-y-4">
        {standing.length > 0 && section(k('active_section'), standing.map(grant => {
          const label = labelOf(pluginName(grant.plugin_id), grant.toolset)
          const offeredNow = options.some(option => option.plugin_id === grant.plugin_id)
          return (
            <li key={grant.id} className={row}>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{label}</span>
                  {classBadge(grant.data_class)}
                  <Badge variant="success">{k('active')}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {grantScope(grant)} · {grant.expires_at ? k('until', { time: formatDateTime(grant.expires_at) }) : k('no_expiry')}
                </p>
                {tools(grant.expanded.map(tool => tool.action_id))}
                <p className="text-xs text-muted-foreground">{k('frozen', { version: grant.plugin_version })}</p>
                {!offeredNow && grant.scope !== 'project' && <p className="text-xs text-muted-foreground">{k('not_offered')}</p>}
                {grant.reconsent && <p className="text-xs text-warning">{t('plugin_ui.run_data.reconsent')}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="ghost" disabled={busy} aria-label={k('revoke_label', { label })} onClick={() => void revoke(grant.id)}>{k('revoke')}</Button>
              </div>
            </li>
          )
        }))}
        {offered.length > 0 && section(k('offered_section'), offered.map(option => {
          const label = labelOf(option.plugin_name, option.toolset)
          return (
            <li key={`${option.plugin_id}:${option.toolset}:${option.data_class}:${option.scope}`} className={row}>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{label}</span>
                  {classBadge(option.data_class)}
                </div>
                <p className="text-xs text-muted-foreground">{who(option.scope)} · {offeredExpiry(option)} · v{option.plugin_version}</p>
                {tools(option.tools.map(tool => tool.action_id))}
                {option.changes && (
                  <p className="text-xs text-warning">
                    {k('changes', { added: option.changes.added.length, removed: option.changes.removed.length, changed: option.changes.changed.length })}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" disabled={busy} aria-label={k('allow_label', { label })} onClick={() => setPending(option)}>{k('allow')}</Button>
              </div>
            </li>
          )
        }))}
      </div>
      <ConfirmDialog
        open={!!pending}
        onOpenChange={open => { if (!open) setPending(null) }}
        title={k('confirm_title')}
        description={pending ? k(pending.scope === 'space' ? 'confirm_space' : 'confirm_background', { plugin: pending.plugin_name, count: pending.tools.length, expiry: offeredExpiry(pending) }) : undefined}
        confirmLabel={k('confirm')}
        variant="default"
        onConfirm={() => { if (pending) void consent(pending) }}
      />
    </Card>
  )
}
