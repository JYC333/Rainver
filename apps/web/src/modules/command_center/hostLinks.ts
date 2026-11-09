/** A Host's place in Command Center, for a caller that knows which Host it means. */
export type HostSection = 'runtime' | 'cli' | 'connection'

export function commandCenterHostPath(hostId: string, section?: HostSection): string {
  const params = new URLSearchParams({ host: hostId })
  if (section) params.set('section', section)
  return `/command-center?${params.toString()}`
}

export function hostSectionParam(value: string | null): HostSection | null {
  return value === 'runtime' || value === 'cli' || value === 'connection' ? value : null
}

export function commandCenterRuntimePath(target: { host_id: string; runtime_key: string; installation: string }): string {
  const params = new URLSearchParams({ host: target.host_id, section: 'runtime', runtime: target.runtime_key, installation: target.installation })
  return `/command-center?${params.toString()}`
}
