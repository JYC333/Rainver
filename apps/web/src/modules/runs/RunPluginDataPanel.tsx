import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentDataRead, PluginDataGrant } from '@rainver/protocol'
import { callOperation, queryOperation } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Run } from '../../types/api'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { ConfirmDialog } from '../../components/ui/dialog'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'


/**
 * The person a Run acts for sees, content-free, which plugin data its Agent
 * read on their behalf and the consents that allowed it, and revokes this
 * Run's data access in one step (ADR 0030). Hidden until there is something
 * to show; nobody else's reads are ever listed.
 */
export function RunPluginDataPanel({ run, currentUserId }: { run: Run; currentUserId: string | null }) {
  const { t } = useAppTranslation()
  const k = (key: string, values?: Record<string, unknown>) => t(`plugin_ui.run_data.${key}`, values)
  const fmt = (dt: string | null | undefined) => dt ? formatDateTime(dt) : '-'
  const owner = !!currentUserId && run.instructed_by_user_id === currentUserId
  const [reads, setReads] = useState<AgentDataRead[]>([])
  const [grants, setGrants] = useState<PluginDataGrant[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const scope = { spaceId: run.space_id }

  const load = useCallback(async () => {
    if (!owner) return
    try {
      // The server lists the consents bound to this Run and those its reads actually used: a
      // background consent (scheduled Runs) and, for a Space owner, the Space-wide personal opt-in.
      const [readResult, grantResult] = await Promise.all([
        queryOperation('agent_data_read.list', { run_id: run.id, limit: 50 }, scope),
        queryOperation('plugin_data_grant.list', { run_id: run.id }, scope),
      ])
      if (![readResult, grantResult].every(result => 'status' in result && result.status === 'succeeded')) throw new Error(k('unavailable'))
      setReads((readResult as { data: { items: AgentDataRead[] } }).data.items)
      setGrants((grantResult as { data: { items: PluginDataGrant[] } }).data.items)
      setError(null)
    } catch (cause) {
      setError(errMsg(cause))
    }
    // scope is derived from run.space_id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, run.id, run.space_id])

  useEffect(() => { void load() }, [load])

  if (!owner || (!error && reads.length === 0 && grants.length === 0)) return null
  const active = grants.filter(grant => grant.status === 'active' && grant.scope !== 'space')

  const revokeOne = async (grantId: string) => {
    setBusy(true)
    try {
      const result = await callOperation('plugin_data_grant.revoke', { grant_id: grantId }, crypto.randomUUID(), scope)
      if (!('status' in result) || result.status !== 'succeeded') throw new Error(k('failed'))
      toast.success(k('revoked_one'))
      await load()
    } catch (cause) {
      toast.error(errMsg(cause))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    setBusy(true)
    try {
      const result = await callOperation('plugin_data_grant.revoke_run', { run_id: run.id }, crypto.randomUUID(), scope)
      if (!('status' in result) || result.status !== 'succeeded') throw new Error(k('failed'))
      toast.success(result.data.revoked_grant_ids.length ? k('revoked') : k('nothing_active'))
      await load()
    } catch (cause) {
      toast.error(errMsg(cause))
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  return (
    <Card className="p-4 space-y-3" data-testid="run-plugin-data-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold"><ShieldCheck className="size-4" />{k('title')}</h2>
          <p className="text-xs text-muted-foreground">{k('hint')}</p>
        </div>
        {active.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(true)}>{k('revoke_run')}</Button>}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {grants.length > 0 && (
        <ul className="space-y-1.5">
          {grants.map(grant => (
            <li key={grant.id} className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={grant.data_class === 'sensitive' ? 'warning' : 'secondary'}>{k(`class_${grant.data_class}`)}</Badge>
              <span className="font-medium">{grant.plugin_id === 'core:gmail' ? k('source_gmail') : grant.plugin_id === 'core:gmail_digest' ? k('source_gmail_digest') : grant.plugin_id} · {k(`toolset_${grant.toolset}`)}</span>
              <StatusBadge status={grant.status} />
              <span className="text-muted-foreground">{grant.status === 'active' ? (grant.expires_at ? k('until', { time: fmt(grant.expires_at) }) : '') : grant.revoked_at ? k('revoked_at', { time: fmt(grant.revoked_at) }) : ''}</span>
              {grant.reconsent && <Badge variant="outline">{k('reconsent')}</Badge>}
              {grant.scope === 'background' && <Badge variant="outline">{k('scope_background')}</Badge>}
              {grant.scope === 'project' && <Badge variant="outline">{k('scope_project')}</Badge>}
              {grant.scope === 'space' && grant.status === 'active' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revokeOne(grant.id)}>{k('revoke_space')}</Button>}
              {grant.scope === 'background' && grant.status === 'active' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revokeOne(grant.id)}>{k('revoke_background')}</Button>}
            </li>
          ))}
        </ul>
      )}
      {reads.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {reads.map(read => (
            <li key={read.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
              <span className="flex items-center gap-2"><Badge variant={read.data_class === 'sensitive' ? 'warning' : read.data_class === 'personal' ? 'secondary' : 'muted'}>{k(`class_${read.data_class}`)}</Badge><span className="font-mono">{read.action_id}</span></span>
              <span className="text-muted-foreground">{k('records', { count: read.resource_ids.length })} · {fmt(read.accessed_at)}</span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={k('confirm_title')}
        description={k('confirm_body')}
        confirmLabel={k('confirm')}
        onConfirm={() => void revoke()}
      />
    </Card>
  )
}
