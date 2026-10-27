import type { ReadingPage, ReadingQuery, ReadingStateRequest } from '@rainver/protocol';
import { HttpError, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { assertProjectReadable } from '../projects/access.js';
import { SourceReadingStateService } from '../sources/readingState.js';
import { ReadingPreferences } from './readingPreferences.js';
import { ReadingRepository } from './readingRepository.js';

interface Cursor { fingerprint: string; space: string; user: string; view: string; q: string; project: string; asOf: string; at: string; key: string }
export class ReadingService {
  constructor(private readonly db: Queryable) {}
  async list(identity: SpaceUserIdentity, input: ReadingQuery, projectId?: string): Promise<ReadingPage> {
    if (projectId) await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const scope = { space: identity.spaceId, user: identity.userId, view: input.view, q: input.q ?? '', project: projectId ?? '' };
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (cursor && Object.entries(scope).some(([key, value]) => cursor[key as keyof Cursor] !== value)) {
      throw new HttpError(422, 'Cursor belongs to another reading query');
    }
    const asOf = cursor?.asOf ?? new Date().toISOString();
    const result = await new ReadingRepository(this.db).rows(identity, await new ReadingPreferences(this.db).enabled(identity), {
      ...input, projectId, asOf, before: cursor ? { at: cursor.at, key: cursor.key } : undefined, limit: input.limit + 1,
    });
    if (cursor && cursor.fingerprint !== result.fingerprint) throw new HttpError(409, 'Reading access or membership changed; reload from the first page');
    const items = result.rows.slice(0, input.limit).map(row => ({
      ...row,
      reader_origin: projectId ? 'project' as const : readingOrigin(row),
    }));
    const last = items.at(-1);
    return {
      items, total: result.total,
      next_cursor: result.rows.length > input.limit && last
        ? Buffer.from(JSON.stringify({ ...scope, fingerprint: result.fingerprint, asOf, at: last.available_at, key: last.key })).toString('base64url') : null,
    };
  }
  async state(identity: SpaceUserIdentity, itemId: string, change: ReadingStateRequest, projectId?: string) {
    if (projectId) await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const context = await new ReadingRepository(this.db).rows(identity, await new ReadingPreferences(this.db).enabled(identity), {
      view:'all',limit:1,asOf:new Date().toISOString(),anchorId:itemId,projectId,
    });
    const row=context.rows.find(item => item.source_item_ids.includes(itemId));
    if (!row) throw new HttpError(404,'Source item not found in this reading context');
    const origin=projectId ? 'project' : readingOrigin(row);
    // The Sources service owns identity membership, current reauthorization and
    // the only state writer. This adapter cannot pass arbitrary member IDs.
    return new SourceReadingStateService(this.db).update(identity, itemId, change, origin);
  }
}
function decodeCursor(value: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (!c || ['fingerprint','space','user','view','q','project','asOf','at','key'].some(k => typeof c[k as keyof Cursor] !== 'string')
      || !Number.isFinite(Date.parse(c.asOf)) || !Number.isFinite(Date.parse(c.at)) || Date.parse(c.asOf) > Date.now()) throw new Error();
    return c;
  } catch { throw new HttpError(422, 'Invalid reading cursor'); }
}

function readingOrigin(row: {contributions: Array<{kind:string;section:string|null}>}): 'library'|'serendipity'|'project' {
  return row.contributions.some(c=>c.kind==='personal_digest' && c.section!=='serendipity') ? 'library'
    : row.contributions.some(c=>c.kind==='personal_digest') ? 'serendipity' : row.contributions.length ? 'project' : 'library';
}
