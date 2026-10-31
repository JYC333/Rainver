import type { ReaderSourceVersions as VersionsPage } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import { HttpError, dateIso, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { contentAccessLevelSql, contentReadSql, roomRunReadAccessSql } from '../access/contentAccessSql.js';
import { contentResourceDefinition } from '../access/contentAccessRegistry.js';
import { sourceDerivedArtifactReadableClause } from '../sources/sourceItemAccess.js';
import { PgReaderRepository } from './repository.js';

/** Browsing retained versions never changes the Source item's current pointer or read state. */
export class ReaderSourceVersions {
  private readonly reader: PgReaderRepository;
  constructor(private readonly db: Queryable, config: ServerConfig) {
    this.reader = new PgReaderRepository(db, config);
  }

  private async parent(identity: SpaceUserIdentity, itemId: string) {
    const doc = await this.reader.getDocument(identity, 'source_item', itemId, { recordOpen: false });
    if (!doc) throw new HttpError(404, 'Document not found or not accessible');
    return doc;
  }

  async list(identity: SpaceUserIdentity, itemId: string, offset: number): Promise<VersionsPage> {
    const current = await this.parent(identity, itemId);
    const full = (type: 'source_snapshot' | 'artifact', alias: string) =>
      `${contentReadSql(type, alias, '$3')} AND ${contentAccessLevelSql({ definition: contentResourceDefinition(type)!, alias, userExpr: '$3' })} = 'full'`;
    const rows = (await this.db.query<{ id: string; captured_at: Date | string; artifact_id: string }>(
      `SELECT ss.id, ss.captured_at, ss.artifact_id FROM source_snapshots ss
       JOIN artifacts a ON a.space_id = ss.space_id AND a.id = ss.artifact_id
       WHERE ss.space_id = $1 AND ss.source_item_id = $2 AND ss.snapshot_type = 'extracted'
         AND a.mime_type = 'application/json' AND ${full('source_snapshot', 'ss')} AND ${full('artifact', 'a')}
         AND ${roomRunReadAccessSql('a.run_id', 'a.space_id', '$3')}
         AND ${sourceDerivedArtifactReadableClause('a', '$3', true)}
       ORDER BY ss.captured_at DESC, ss.id DESC LIMIT 26 OFFSET $4`,
      [identity.spaceId, itemId, identity.userId, offset],
    )).rows;
    return {
      items: rows.slice(0, 25).map(row => ({ snapshot_id: row.id, captured_at: dateIso(row.captured_at)!, is_current: row.artifact_id === current.artifact_id })),
      next_offset: rows.length > 25 ? offset + 25 : null,
    };
  }

  async get(identity: SpaceUserIdentity, itemId: string, snapshotId: string) {
    await this.parent(identity, itemId);
    // Membership is checked before resolving content: another item's snapshot is never a version of this one.
    const match = (await this.db.query<{ id: string; captured_at: Date | string }>(
      `SELECT id, captured_at FROM source_snapshots WHERE space_id=$1 AND source_item_id=$2 AND id=$3 AND snapshot_type='extracted'`,
      [identity.spaceId, itemId, snapshotId],
    )).rows[0];
    const doc = match ? await this.reader.getDocument(identity, 'source_snapshot', snapshotId) : null;
    if (!doc) throw new HttpError(404, 'Version not found or not accessible');
    return { ...doc, can_annotate: false as const, version_captured_at: dateIso(match!.captured_at) };
  }
}
