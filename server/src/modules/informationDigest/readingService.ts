import {changeReadingState} from '../sources/goals/changeDelivery.js';
import type { ReadingPage, ReadingQuery, ReadingStateRequest } from '@rainver/protocol';
import { HttpError, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { assertProjectReadable } from '../projects/access.js';
import { SourceReadingStateService } from '../sources/readingState.js';
import { ReadingPreferences } from './readingPreferences.js';
import { ReadingRepository } from './readingRepository.js';
import { ReaderPositionStore } from '../reader/positions.js';

interface Cursor { fingerprint: string; space: string; user: string; view: string; q: string; project: string; topic: string; selection: string; sort: string; asOf: string; at: string; key: string }
export class ReadingService {
  constructor(private readonly db: Queryable) {}
  async list(identity: SpaceUserIdentity, input: ReadingQuery, projectId?: string): Promise<ReadingPage> {
    if (projectId) await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const enabled = await new ReadingPreferences(this.db).enabled(identity);
    if (input.topic) await assertReadingTopicVisible(this.db, identity, input.topic, projectId, enabled);
    const scope = { space: identity.spaceId, user: identity.userId, view: input.view ?? 'pending', q: input.q ?? '', project: projectId ?? '', topic: input.topic ?? '', selection: input.topic_selection ?? 'all', sort: input.sort ?? 'newest' };
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (cursor && Object.entries(scope).some(([key, value]) => cursor[key as keyof Cursor] !== value)) {
      throw new HttpError(422, 'Cursor belongs to another reading query');
    }
    const asOf = cursor?.asOf ?? new Date().toISOString();
    const result = await new ReadingRepository(this.db).rows(identity, enabled, {
      view: input.view ?? 'pending', q: input.q, projectId, asOf, before: cursor ? { at: cursor.at, key: cursor.key } : undefined, limit: (input.limit ?? 30) + 1,
      topic: input.topic, topicSelection: input.topic_selection ?? 'all', sort: input.sort ?? 'newest',
    });
    if (cursor && cursor.fingerprint !== result.fingerprint) throw new HttpError(409, 'Reading access or membership changed; reload from the first page');
    const limit = input.limit ?? 30;
    const page = result.rows.slice(0, limit);
    // The viewer's own Reader progress; private, read-only here.
    const progress = await new ReaderPositionStore(this.db).progressForSourceItems(identity, page.map(row => row.source_item_id));
    const items = page.map(row => ({
      ...row,
      reading_progress: progress.get(row.source_item_id) ?? null,
      reader_origin: projectId ? 'project' as const : readingOrigin(row),
    }));
    const last = items.at(-1);
    return {
      items, total: result.total,
      next_cursor: result.rows.length > limit && last
        ? Buffer.from(JSON.stringify({ ...scope, fingerprint: result.fingerprint, asOf, at: last.available_at, key: last.key })).toString('base64url') : null,
    };
  }
  async state(identity: SpaceUserIdentity, itemId: string, change: ReadingStateRequest, projectId?: string) {
    if (projectId) await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    if(change.topic_change_id)return changeReadingState(this.db,identity,itemId,change,projectId);
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
    if (c && c.sort === undefined) c.sort = 'newest'; // cursors issued before sorting existed
    if (!c || ['fingerprint','space','user','view','q','project','topic','selection','sort','asOf','at','key'].some(k => typeof c[k as keyof Cursor] !== 'string')
      || !Number.isFinite(Date.parse(c.asOf)) || !Number.isFinite(Date.parse(c.at)) || Date.parse(c.asOf) > Date.now()) throw new Error();
    return c;
  } catch { throw new HttpError(422, 'Invalid reading cursor'); }
}

function readingOrigin(row: {contributions: Array<{kind:string;section:string|null}>}): 'library'|'serendipity'|'project' {
  return row.contributions.some(c=>c.kind==='personal_digest' && c.section!=='serendipity') ? 'library'
    : row.contributions.some(c=>c.kind==='personal_digest') ? 'serendipity' : row.contributions.length ? 'project' : 'library';
}

/** A topic filter names a followed goal the viewer may read in this Reading
 * scope; an unknown or foreign goal is indistinguishable from a missing one. */
async function assertReadingTopicVisible(db: Queryable, identity: SpaceUserIdentity, goalId: string, projectId: string | undefined, enabled: string[]) {
  const visible = await db.query<{ project_id: string | null }>(`SELECT g.project_id FROM source_goals g WHERE g.id=$1 AND g.space_id=$2 AND g.status<>'deleted'
    AND (($3::varchar IS NOT NULL AND g.project_id=$3) OR ($3::varchar IS NULL AND ((g.project_id IS NULL AND g.owner_user_id=$4) OR g.project_id=ANY($5::varchar[]))))`,
  [goalId, identity.spaceId, projectId ?? null, identity.userId, enabled]);
  if (!visible.rows[0]) throw new HttpError(404, 'Reading topic not found');
  // The enabled list is a stored preference; Project read access is live.
  if (visible.rows[0].project_id) await assertProjectReadable(db, identity.spaceId, visible.rows[0].project_id, identity.userId).catch(() => { throw new HttpError(404, 'Reading topic not found'); });
}
