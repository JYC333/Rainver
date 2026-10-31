import type { ReadingItem } from '@rainver/protocol'
import { safeAppPath } from '../../lib/safeHttpUrl'

export function readingHref(item: Pick<ReadingItem, 'source_item_id' | 'reader_origin' | 'topic_change'>, projectId?: string, sourceTab?: 'candidates' | 'settings' | 'research' | 'digest', date?: string) {
  let returnTo = '/library/reading'
  if (sourceTab === 'digest') {
    returnTo = projectId ? `/projects/${projectId}/sources?tab=digest${date ? `&date=${date}` : ''}` : `/library/digests${date ? `?date=${date}` : ''}`
  } else if (projectId) {
    returnTo = sourceTab === 'research' ? `/projects/${projectId}/research?tab=reading` : `/projects/${projectId}/sources${sourceTab ? `?tab=${sourceTab}` : ''}`
  }
  const query = new URLSearchParams({ from: item.reader_origin, returnTo });if(item.topic_change)query.set('change',item.topic_change.id)
  // A shared SourceItem can belong to a different Project from its edition.
  // Preserve the actual edition context rather than infer it from the document.
  if (projectId && sourceTab === 'digest') query.set('projectId', projectId)
  return `/library/items/${item.source_item_id}?${query}`
}

/** Reader link that returns to an exact Reading list or topic view (scope,
 * read-state view and topic filter), validated again by readingReturnTo. */
export function readingHrefReturning(item: Pick<ReadingItem, 'source_item_id' | 'reader_origin' | 'topic_change'>, returnTo: string) {
  return readerHrefFor(item.source_item_id, item.reader_origin, returnTo, item.topic_change?.id)
}

/** The same Reader link from the ids a kept Reading list holds (see readingSequence). */
export function readerHrefFor(itemId: string, origin: ReadingItem['reader_origin'], returnTo: string, changeId?: string | null) {
  const query=new URLSearchParams({from:origin,returnTo});if(changeId)query.set('change',changeId);return `/library/items/${itemId}?${query}`
}

// q is the submitted Reading search: trimmed, at most the search field's 500
// UTF-16 units, no control characters. It is only ever read back as a filter.
const LIST_PARAMS: Record<string, RegExp> = { settings: /^reading$/,  view: /^(?:pending|read|all)$/, sort: /^oldest$/, topic: /^[\w-]{1,64}$/, topic_selection: /^(?:important|all)$/, q: /^[^\s\u0000-\u001F\u007F](?:[^\u0000-\u001F\u007F]{0,498}[^\s\u0000-\u001F\u007F])?$/ }
const TOPIC_PARAMS: Record<string, RegExp> = { selection: /^(?:important|all)$/ }
/** Only known keys with known values, each once, in a canonical encoding. */
function boundedQuery(query: string | undefined, allowed: Record<string, RegExp>): boolean {
  if (query === undefined) return true
  const params = new URLSearchParams(query)
  const keys = [...params.keys()]
  if (!keys.length || new Set(keys).size !== keys.length) return false
  if (!keys.every(key => allowed[key]?.test(params.get(key) ?? ''))) return false
  return params.toString() === query && (!params.has('topic_selection') || params.has('topic'))
}

function validEditionDate(date: string | undefined): boolean {
  if (date === undefined) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-')) return false
  const instant = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date
}

/** Only canonical local reading destinations, never an arbitrary supplied redirect. */
export function readingReturnTo(value: string | null, projectId?: string | null): string | null {
  // Percent-encoding is allowed only inside a query string, where every value is
  // decoded, checked against its key's pattern and required to re-encode
  // canonically; paths and fragments stay literal.
  if (!value || safeAppPath(value) !== value || value.includes('#') || value.split('?')[0].includes('%')) return null
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
  const list = /^(?:\/library\/reading|\/projects\/[\w-]+\/sources)(?:\?([^?]*))?$/.exec(value)
  if (list && !/[?]tab=/.test(value)) return boundedQuery(list[1], LIST_PARAMS) ? value : null
  const topic = /^(?:\/library\/reading|\/projects\/[\w-]+\/sources)\/goals\/[\w-]{1,64}(?:\?([^?]*))?$/.exec(value)
  if (topic) return boundedQuery(topic[1], TOPIC_PARAMS) ? value : null
  return value === '/library/reading' || /^\/projects\/[\w-]+\/research\?tab=reading$/.test(value) || /^\/projects\/[\w-]+\/sources(?:\?tab=(?:candidates|settings))?$/.test(value) ? value : null
}
