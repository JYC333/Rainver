import type { ReadingItem } from '@rainver/protocol'
import { safeAppPath } from '../../lib/safeHttpUrl'

export function readingHref(item: Pick<ReadingItem, 'source_item_id' | 'reader_origin'>, projectId?: string, sourceTab?: 'candidates' | 'settings' | 'research' | 'digest', date?: string) {
  let returnTo = '/library/reading'
  if (sourceTab === 'digest') {
    returnTo = projectId ? `/projects/${projectId}/sources?tab=digest${date ? `&date=${date}` : ''}` : `/library/digests${date ? `?date=${date}` : ''}`
  } else if (projectId) {
    returnTo = sourceTab === 'research' ? `/projects/${projectId}/research?tab=reading` : `/projects/${projectId}/sources${sourceTab ? `?tab=${sourceTab}` : ''}`
  }
  const query = new URLSearchParams({ from: item.reader_origin, returnTo })
  // A shared SourceItem can belong to a different Project from its edition.
  // Preserve the actual edition context rather than infer it from the document.
  if (projectId && sourceTab === 'digest') query.set('projectId', projectId)
  return `/library/items/${item.source_item_id}?${query}`
}

function validEditionDate(date: string | undefined): boolean {
  if (date === undefined) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-')) return false
  const instant = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date
}

/** Only canonical local reading destinations, never an arbitrary supplied redirect. */
export function readingReturnTo(value: string | null, projectId?: string | null): string | null {
  if (!value || safeAppPath(value) !== value || /[%#]/.test(value)) return null
  const personalEdition = /^\/library\/digests(?:\?date=(\d{4}-\d{2}-\d{2}))?$/.exec(value)
  if (personalEdition) return !projectId && validEditionDate(personalEdition[1]) ? value : null
  const projectEdition = /^\/projects\/([\w-]+)\/sources\?tab=digest(?:&date=(\d{4}-\d{2}-\d{2}))?$/.exec(value)
  if (projectEdition) {
    // Old undated entry links remain valid; dated editions bind their Project.
    const sameProject = projectId ? projectId === projectEdition[1] : projectEdition[2] === undefined
    return sameProject && validEditionDate(projectEdition[2]) ? value : null
  }
  const project = /^\/projects\/([\w-]+)\//.exec(value)
  if (projectId && project?.[1] !== projectId) return null
  return value === '/library/reading' || /^\/projects\/[\w-]+\/research\?tab=reading$/.test(value) || /^\/projects\/[\w-]+\/sources(?:\?tab=(?:candidates|settings))?$/.test(value) ? value : null
}
