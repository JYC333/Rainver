import { useEffect, useRef } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { Host, HostRuntimeDefinitionOption } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import HostAgents from './HostAgents'
import HostProxyAddress from './HostProxyAddress'
import ServerRuntimeProvisioningPanel from './ServerRuntimeProvisioningPanel'
import HostCliToolsSection from './cliTools/HostCliToolsSection'
import { HOST_STATUS_VARIANT, fmt, hostDisplayName, type HostProvisioning } from './hostDisplay'
import type { HostSection } from './hostLinks'

/**
 * One Host and everything about it, grouped by what a person comes to do:
 * its Agent Runtimes, its ordinary CLI tools (with the person's own tool
 * account), and its connection and management. Mount it keyed by Host:
 * switching Host unmounts it, which ends any open login there, and a Host
 * list refresh only re-renders it.
 */
export default function HostDetail({
  host, isInstanceAdmin, adapters, provisioning, provisioningLoading, sectionRequest,
  showBack, onBack, onRefresh, onAdaptersChanged, onRevoke,
}: {
  host: Host
  isInstanceAdmin: boolean
  adapters: HostRuntimeDefinitionOption[]
  provisioning: HostProvisioning | undefined
  provisioningLoading: boolean
  /** A navigation that names a group of this Host; `key` is that navigation's own. */
  sectionRequest: { section: HostSection; key: string } | null
  showBack: boolean
  onBack: () => void
  onRefresh: () => Promise<void>
  onAdaptersChanged: () => Promise<void>
  onRevoke: (hostId: string) => void
}) {
  const { t } = useAppTranslation()
  const sections = useRef<Partial<Record<HostSection, HTMLElement | null>>>({})
  // Each navigation that names a group lands on it, also within this Host.
  const requestKey = sectionRequest?.key ?? null
  const requested = sectionRequest?.section ?? null
  useEffect(() => {
    if (requested) sections.current[requested]?.scrollIntoView?.({ block: 'start' })
  }, [requested, requestKey])

  const usable = host.status !== 'revoked'
  const role = host.kind === 'server'
    ? t(isInstanceAdmin ? 'command_center.role_builtin_admin' : 'command_center.role_builtin_member')
    : t('command_center.role_owner')

  return (
    <article tabIndex={-1} aria-label={hostDisplayName(host, t('command_center.builtin_name'))} className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-3 outline-none">
      {showBack && (
        <Button size="sm" variant="ghost" className="md:hidden" onClick={onBack}>
          <ChevronLeft className="size-3.5" />{t('command_center.back_to_hosts')}
        </Button>
      )}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{hostDisplayName(host, t('command_center.builtin_name'))}</h2>
            <Badge variant={HOST_STATUS_VARIANT[host.status]}>{host.status}</Badge>
            <Badge variant="outline">{host.kind === 'server' ? t('command_center.kind_builtin') : t('command_center.kind_paired')}</Badge>
            <Badge variant="outline">{host.environment_kind ?? host.platform ?? 'unknown environment'}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(host.kind === 'server' ? 'command_center.execution_builtin' : 'command_center.execution_paired')}{' · '}
            {`${host.platform ?? '—'} / ${host.arch ?? '—'} · daemon ${host.daemon_version ?? 'unknown'} · last seen ${fmt(host.last_heartbeat_at)}`}
          </p>
          <p className="text-xs text-muted-foreground">{role}</p>
        </div>
        {host.kind === 'remote' && usable && (
          <Button size="sm" variant="destructive" onClick={() => onRevoke(host.id)}>Revoke</Button>
        )}
      </header>
      {host.status === 'revoked' && <p role="status" className="rounded-md border border-border bg-muted/40 p-2 text-xs">{t('command_center.revoked_notice')}</p>}
      {host.status === 'pending_pairing' && <p role="status" className="rounded-md border border-border bg-muted/40 p-2 text-xs">{t('command_center.pending_notice')}</p>}

      {usable && (
        <section ref={element => { sections.current.runtime = element }} aria-label={t('command_center.section_runtime')} className="space-y-1">
          <h3 className="text-xs font-semibold">{t('command_center.section_runtime')}</h3>
          <p className="text-xs text-muted-foreground">{t('command_center.section_runtime_hint')}</p>
          {host.kind === 'server' && (
            // Rainver's own bootstrap of the pinned OpenCode copy: desired
            // against active version, health, Retry. The copy's own controls
            // are its row below.
            <ServerRuntimeProvisioningPanel
              hostId={host.id}
              canRetry={isInstanceAdmin}
              status={provisioning?.status ?? null}
              error={provisioning?.error ?? null}
              loading={provisioningLoading}
              onRefresh={onRefresh}
            />
          )}
          {/* Every runtime definition, not only the dispatch-eligible ones. A
              registry agent is installable and managed here even while
              `remote_eligible` is false (hosts.md, profile isolation).
              Eligibility gates dispatch, not installation visibility. */}
          <HostAgents
            host={host}
            adapters={adapters}
            isInstanceAdmin={isInstanceAdmin}
            manageable={host.kind === 'remote' || isInstanceAdmin}
            onChanged={onAdaptersChanged}
          />
        </section>
      )}

      {usable && host.status !== 'pending_pairing' && (
        <section ref={element => { sections.current.cli = element }}>
          <HostCliToolsSection host={host} openRequest={requested === 'cli' ? requestKey : null} />
        </section>
      )}

      <section ref={element => { sections.current.connection = element }} aria-label={t('command_center.section_connection')} className="space-y-1 border-t border-border pt-2">
        <h3 className="text-xs font-semibold">{t('command_center.section_connection')}</h3>
        {host.kind === 'server' ? (
          // The built-in host is not anyone's machine: it serves every Space
          // of the instance, one isolated namespace per Run.
          <p className="text-xs text-muted-foreground">
            The instance's own execution host: every Run is isolated in its own namespace, and
            {host.max_concurrent_runs !== null && host.max_concurrent_runs !== undefined
              ? ` up to ${host.max_concurrent_runs} run${host.max_concurrent_runs === 1 ? '' : 's'} execute at once.`
              : ' its capacity is set per machine.'}
            {isInstanceAdmin ? '' : ' Installing and logging in its agents is instance-admin work.'}
          </p>
        ) : usable ? (
          <HostProxyAddress host={host} onChanged={() => { void onRefresh() }} />
        ) : null}
      </section>
    </article>
  )
}
