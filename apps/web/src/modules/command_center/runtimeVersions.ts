import { hasStableUpdate } from '@rainver/protocol'

export { hasStableUpdate }

/** An update applies to the runtime as a whole. An unknown or newer copy
 * prevents an older copy from offering an update that could downgrade it. */
export function hasManagedUpdate(current: readonly (string | null)[], latest: string | null | undefined): boolean {
  return current.length > 0 && current.every(version => hasStableUpdate(version, latest))
}
