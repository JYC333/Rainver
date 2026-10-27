import { randomUUID } from 'node:crypto';
import type { ReadingStateRequest } from '@rainver/protocol';
import { HttpError, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { sourceItemDocumentReadableClause } from './sourceItemAccess.js';
import { readingFamilySql, readingIdentityCtesSql, readingVersionCurrentSql } from './readingIdentity.js';

/** Canonical explicit private state writer; Reader-open has separate semantics. */
export class SourceItemUserStateStore {
  constructor(private readonly db: Queryable) {}
  async upsert(
    identity: SpaceUserIdentity,
    itemId: string,
    input: {
      libraryStatus: string | null;
      readStatus: string | null;
      firstOpenedAt: string | null;
      lastOpenedAt: string | null;
      progress: Record<string, unknown> | null;
      readOrigin: "library" | "serendipity" | "project" | null;
      preserveOrigin?: boolean;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO source_item_user_states (
         id, space_id, source_item_id, user_id, library_status, read_status,
         first_opened_at, last_opened_at, read_origin, progress_json, created_at, updated_at, read_body_revision
       ) VALUES (
         $1, $2, $3, $4, COALESCE($5::varchar(32), 'new'), COALESCE($6::varchar(32), 'unread'),
         $7::timestamptz, $8::timestamptz, $11::varchar(32), COALESCE($9::jsonb, '{}'::jsonb), $10, $10,
         (SELECT reading_body_revision FROM source_items WHERE space_id=$2::varchar(36) AND id=$3::varchar(36))
       )
       ON CONFLICT (space_id, source_item_id, user_id) DO UPDATE SET
         library_status = COALESCE($5::varchar(32), source_item_user_states.library_status),
         read_status = CASE WHEN $6::varchar(32) IS NOT NULL THEN $6::varchar(32)
           WHEN NOT (SELECT ${readingVersionCurrentSql('version_item', 'source_item_user_states')} FROM source_items version_item WHERE version_item.space_id=$2 AND version_item.id=$3) THEN 'unread'
           ELSE source_item_user_states.read_status END,
         read_body_revision = EXCLUDED.read_body_revision,
         first_opened_at = COALESCE(source_item_user_states.first_opened_at, $7::timestamptz),
         last_opened_at = COALESCE($8::timestamptz, source_item_user_states.last_opened_at),
         read_origin = CASE WHEN $12::boolean THEN source_item_user_states.read_origin
           WHEN $11='library' THEN 'library' ELSE COALESCE(source_item_user_states.read_origin,$11::varchar(32)) END,
         progress_json = source_item_user_states.progress_json || COALESCE($9::jsonb, '{}'::jsonb),
         updated_at = $10`,
      [
        randomUUID(),
        identity.spaceId,
        itemId,
        identity.userId,
        input.libraryStatus,
        input.readStatus,
        input.firstOpenedAt,
        input.lastOpenedAt,
        input.readStatus !== null
          ? JSON.stringify({ ...input.progress, reading_state_at: now })
          : input.progress ? JSON.stringify(input.progress) : null,
        now,
        input.readOrigin,
        input.preserveOrigin ?? false,
      ],
    );
  }
}

export class SourceReadingStateService {
  constructor(private readonly db: Queryable) {}
  /** Server resolves and authorizes equivalent revisions; client supplies one
   * item, never a list. Sorted locks serialize overlapping group mutations.
   * Copies neither fabricate opens nor replace existing origins; the anchor
   * origin is resolved by the authenticated reading-context service.
   */
  async update(identity: SpaceUserIdentity, itemId: string, change: ReadingStateRequest, anchorOrigin: "library" | "serendipity" | "project" = "project") {
    return withQueryableTransaction(this.db, async tx => {
      const store = new SourceItemUserStateStore(tx);
      const anchor = await tx.query<{ key: string; canonical_uri: string | null; reading_initial_hash: string | null }>(
        `SELECT ${readingFamilySql("i")} AS key,i.canonical_uri,i.reading_initial_hash FROM source_items i
         WHERE i.space_id=$1 AND i.id=$2 AND i.deleted_at IS NULL
           AND ${sourceItemDocumentReadableClause("i", "$3", { includeOversight: false })}`,
        [identity.spaceId, itemId, identity.userId]);
      if (!anchor.rows[0]) throw new HttpError(404, "Source item not found");
      const key = anchor.rows[0].key;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`reading-state:${identity.spaceId}:${identity.userId}:${anchor.rows[0].canonical_uri ?? itemId}`]);
      const candidates = await tx.query<{ id: string; reading_key: string }>(
        `WITH candidates AS MATERIALIZED (
          SELECT i.*,${readingFamilySql("i")} AS family_key FROM source_items i WHERE i.space_id=$1 AND i.deleted_at IS NULL
            AND (i.id=$4 OR i.canonical_uri=$5)
            AND ${sourceItemDocumentReadableClause("i", "$3", { includeOversight: false })}
          ORDER BY i.id FOR SHARE OF i
        ), ${readingIdentityCtesSql('candidates', 'resolved')}
        SELECT i.id,i.reading_key FROM resolved i WHERE i.id<>$4 OR i.family_key=$2`,
        [identity.spaceId,key,identity.userId,itemId,anchor.rows[0].canonical_uri]);
      const current = candidates.rows.find(row => row.id===itemId);
      const members = candidates.rows.filter(row => row.reading_key===current?.reading_key);
      // Recheck the anchor after taking the identity lock: content may change.
      if (!members.some(row => row.id === itemId)) throw new HttpError(409, "Source content changed; reload before updating reading state");
      for (const member of members) {
        await store.upsert(identity, member.id, {
          libraryStatus: null, readStatus: change.read_status ?? null,
          firstOpenedAt: null, lastOpenedAt: null,
          readOrigin: change.read_status === undefined ? null : member.id === itemId ? anchorOrigin : "project",
          preserveOrigin: member.id !== itemId,
          progress: change.dismissed === undefined ? null : { reading_dismissed: change.dismissed },
        });
      }
      return { updated: members.length };
    });
  }
}
