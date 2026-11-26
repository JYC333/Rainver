import type { MyAgent, MyAgentsPage } from '@rainver/protocol'

/** The server's largest page (`parsePage`); a refresh reads a longer loaded range in several. */
export const REFRESH_PAGE = 200
/** How often a refresh starts over after the list moved between two of its reads. */
const DRIFT_RETRIES = 3

export interface MyAgentsRange {
  items: MyAgent[]
  total: number
  /** The server position after the last entry read. */
  cursor: number
  /** The revision every page of `items` carried. */
  revision: string
}

/**
 * The list from its start until `want` server positions (or its end), read in
 * server-sized pages over offset paging. Each page carries the revision of the
 * whole list as the server saw it in that page's own statement; the pages are
 * stitched only when they all carry the first page's revision, so they were cut
 * from one list and the result repeats and skips nothing, whatever moved where.
 * Otherwise the list changed between the reads and the read starts over, at
 * most `DRIFT_RETRIES` times. `cursor` is the server position after the last
 * entry read, the offset "Show more" continues from. `null` when `stale()`
 * says a newer answer owns the list, or the list kept moving: the caller keeps
 * what it shows.
 */
export async function readRange(
  read: (limit: number, offset: number) => Promise<MyAgentsPage>,
  want: number,
  stale: () => boolean,
): Promise<MyAgentsRange | null> {
  for (let attempt = 0; attempt < DRIFT_RETRIES; attempt += 1) {
    let items: MyAgent[] = []
    let total = 0
    let cursor = 0
    let revision: string | null = null
    let moved = false
    while (cursor < want) {
      const page = await read(Math.min(REFRESH_PAGE, want - cursor), cursor)
      if (stale()) return null
      if (revision !== null && page.revision !== revision) { moved = true; break }
      revision = page.revision
      total = page.total
      if (page.items.length === 0) break
      items = [...items, ...page.items]
      cursor += page.items.length
      if (cursor >= page.total) break
    }
    if (!moved && revision !== null) return { items, total, cursor, revision }
  }
  return null
}

/**
 * "Show more": the page after `loaded`. It is appended only when it carries the
 * loaded list's revision, so it continues that same list. Otherwise the list
 * moved since it was loaded (an entry added, removed or moved across the
 * pages), so appending would repeat or skip one; the loaded range and the new
 * page are read again together with `readRange` (bounded the same way) and
 * replace what is shown. `null` when `stale()` says a newer answer owns the
 * list, or the list kept moving: the caller keeps what it shows.
 */
export async function readMore(
  read: (limit: number, offset: number) => Promise<MyAgentsPage>,
  loaded: { items: MyAgent[]; cursor: number; revision: string | null },
  pageSize: number,
  stale: () => boolean,
): Promise<MyAgentsRange | null> {
  const page = await read(pageSize, loaded.cursor)
  if (stale()) return null
  if (loaded.revision !== null && page.revision === loaded.revision) {
    return { items: [...loaded.items, ...page.items], total: page.total, cursor: loaded.cursor + page.items.length, revision: page.revision }
  }
  return readRange(read, loaded.cursor + pageSize, stale)
}
