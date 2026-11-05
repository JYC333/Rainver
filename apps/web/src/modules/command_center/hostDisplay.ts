import type { Host, HostRuntimeProvisioningStatus } from '../../types/api'

export function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : 'never'
}

export const HOST_STATUS_VARIANT: Record<Host['status'], 'success' | 'muted' | 'destructive' | 'warning'> = {
  online: 'success',
  offline: 'muted',
  pending_pairing: 'warning',
  revoked: 'destructive',
}

/** Translate the built-in environment label without renaming stored Hosts. */
export function hostDisplayName(host: Host, builtinLabel: string): string {
  return host.kind === 'server' ? builtinLabel : host.name
}

export type HostProvisioning = { status: HostRuntimeProvisioningStatus | null; error: string | null }

/**
 * What the Host list can say about a Host from what is already loaded: its
 * own status, the Server's provisioning read, and its reported Runtime
 * logins. Nothing here asks a Host anything, and nothing names a person's
 * tool account, which only that Host's detail reads.
 */
export type HostProblem =
  | { key: 'offline'; time: string | null }
  | { key: 'pending' | 'revoked' | 'provisioning_failed' | 'provisioning_pending' }
  | { key: 'runtime_logged_out'; count: number }

export function hostProblems(host: Host, provisioning: HostProvisioning | undefined): HostProblem[] {
  if (host.status === 'revoked') return [{ key: 'revoked' }]
  if (host.status === 'pending_pairing') return [{ key: 'pending' }]
  const problems: HostProblem[] = []
  if (host.status === 'offline') problems.push({ key: 'offline', time: host.last_heartbeat_at ?? null })
  const state = provisioning?.status?.installation.state
  if (state === 'failed') problems.push({ key: 'provisioning_failed' })
  else if (state === 'queued' || state === 'installing') problems.push({ key: 'provisioning_pending' })
  const installations = host.capabilities_json?.installations ?? {}
  const loggedOut = Object.values(installations).flat().filter(entry => entry?.logged_in === false).length
  if (loggedOut > 0) problems.push({ key: 'runtime_logged_out', count: loggedOut })
  return problems
}
