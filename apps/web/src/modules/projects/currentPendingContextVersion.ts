interface ProjectContextVersion {
  version: string
  status: 'draft' | 'in_review' | 'published' | 'archived'
}

function versionOrdinal(version: string): number {
  const match = /^v([1-9][0-9]*)$/.exec(version)
  return match ? Number(match[1]) : -1
}

/** Ignore abandoned drafts that can no longer be published after a newer
 * immutable version became active, then select the newest remaining version. */
export function currentPendingContextVersion<T extends ProjectContextVersion>(versions: T[]): T | null {
  const activeOrdinal = Math.max(
    -1,
    ...versions
      .filter(version => version.status === 'published')
      .map(version => versionOrdinal(version.version)),
  )
  return versions
    .filter(version =>
      (version.status === 'in_review' || version.status === 'draft')
      && versionOrdinal(version.version) > activeOrdinal)
    .sort((left, right) => versionOrdinal(right.version) - versionOrdinal(left.version))[0]
    ?? null
}
