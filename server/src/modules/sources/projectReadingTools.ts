import type { SystemActionId } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import { getDbPool } from '../../db/pool.js';
import { HttpError, type Queryable } from '../routeUtils/common.js';
import type { RunRecord } from '../runs/repository.js';
import type { SystemActionExecutor } from '../systemActions/gateway.js';
import { assertProjectReadable } from '../projects/access.js';
import { runReadSql } from '../access/contentAccessSql.js';
import { contentDecisionFromDb } from '../access/contentAccessQuery.js';
import { ReadingService } from '../informationDigest/readingService.js';
import { ReadingRepository } from '../informationDigest/readingRepository.js';
import { ReadingPreferences } from '../informationDigest/readingPreferences.js';
import { PgReaderRepository } from '../reader/repository.js';
import { projectReadingRecords } from '../reader/readingRecords.js';
import { normalizeSourceConnectionReadGovernance } from './sourceConsent.js';
import type { SourceConnectionRow } from './sourceRepositoryRows.js';
import { assertReadingRunEgress } from './readingMethods/context.js';
import { loadSourceConnectionIdsForTargets, sourceConnectionIdsFromMetadata } from '../retrieval/sourcePolicy.js';

/** Project conversations read the same retained materials as Reading, without
 * opening documents, changing progress, starting research or asking for a grant. */
export class ProjectReadingTools {
  constructor(private readonly db: Queryable, private readonly config: ServerConfig, private readonly run: RunRecord) {}
  private get identity() { return { spaceId: this.run.space_id, userId: this.run.instructed_by_user_id! }; }

  private async scope(itemId?: string) {
    const { run, db, identity } = this;
    if (!run.project_id || !identity.userId) throw new HttpError(403, 'Project Reading requires a Project conversation');
    await assertProjectReadable(db, identity.spaceId, run.project_id, identity.userId);
    if (itemId) {
      const page = await new ReadingRepository(db).rows(identity, await new ReadingPreferences(db).enabled(identity), {
        view: 'all', limit: 1, asOf: new Date().toISOString(), anchorId: itemId, projectId: run.project_id,
      });
      if (!page.rows.some(row => row.source_item_ids.includes(itemId))) throw new HttpError(404, 'Material not found in this Project Reading');
    }
    // A private analysis must not become context for a wider Room/Run audience.
    const audience = (await db.query<{ user_id: string }>(
      `SELECT u.id AS user_id FROM users u JOIN space_memberships m ON m.user_id=u.id
       JOIN runs r ON r.space_id=m.space_id AND r.id=$2
       WHERE m.space_id=$1 AND m.status='active' AND u.status='active'
       AND ${runReadSql('u.id', 'r', { includeOversight: false })}`,
      [run.space_id, run.id],
    )).rows;
    if (!audience.some(member => member.user_id === identity.userId)) throw new HttpError(403, 'Reading conversation audience unavailable');
    return audience;
  }

  private async document(itemId: string, snapshotId?: string) {
    const audience = await this.scope(itemId);
    const type = snapshotId ? 'source_snapshot' : 'source_item';
    const id = snapshotId ?? itemId;
    if (snapshotId && !(await projectReadingRecords(this.db, this.identity, itemId, 0, this.run.project_id!, snapshotId)).items.length) {
      throw new HttpError(404, 'Reading record not found');
    }
    const reader = new PgReaderRepository(this.db, this.config);
    let result: Awaited<ReturnType<typeof reader.getDocument>> = null;
    for (const member of audience) {
      const identity = { spaceId: this.run.space_id, userId: member.user_id };
      if (await contentDecisionFromDb(this.db, identity, 'source_item', itemId, { includeOversight: false }) !== 'full') throw new HttpError(404, 'Reading material unavailable to this conversation');
      if (await contentDecisionFromDb(this.db, identity, type, id, { includeOversight: false }) !== 'full') throw new HttpError(404, 'Reading content unavailable to this conversation');
      const doc = await reader.getDocument(identity, type, id, { recordOpen: false });
      if (!doc?.artifact_id) throw new HttpError(404, 'Retained Reading body unavailable');
      if (await contentDecisionFromDb(this.db, identity, 'artifact', doc.artifact_id, { includeOversight: false }) !== 'full') throw new HttpError(404, 'Reading body unavailable to this conversation');
      if (member.user_id === this.identity.userId) result = doc;
    }
    if (!result?.artifact_id) throw new HttpError(404, 'Reading body unavailable');
    await this.egress(itemId, result.artifact_id);
    return result;
  }

  private async egress(itemId: string, artifactId: string) {
    const connections = new Set<string>();
    const item = (await this.db.query<{ connection_id: string | null }>('SELECT connection_id FROM source_items WHERE space_id=$1 AND id=$2', [this.run.space_id, itemId])).rows[0];
    if (item?.connection_id) connections.add(item.connection_id);
    const pending = [artifactId], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > 128) throw new HttpError(403, 'Reading provenance exceeds bounded inspection');
      const row = (await this.db.query<{ metadata_json: Record<string, unknown> }>('SELECT metadata_json FROM artifacts WHERE space_id=$1 AND id=$2', [this.run.space_id, id])).rows[0];
      if (!row) throw new HttpError(404, 'Reading provenance unavailable');
      for (const connection of sourceConnectionIdsFromMetadata(row.metadata_json)) connections.add(connection);
      const origins = await this.db.query<{ connection_id: string | null; original_artifact_id: string | null }>(
        `SELECT COALESCE(s.connection_id,i.connection_id) AS connection_id,o.artifact_id AS original_artifact_id
         FROM source_snapshots s LEFT JOIN source_items i ON i.space_id=s.space_id AND i.id=s.source_item_id
         LEFT JOIN source_snapshots o ON o.space_id=s.space_id AND o.id=s.original_snapshot_id
         WHERE s.space_id=$1 AND s.artifact_id=$2`, [this.run.space_id, id]);
      for (const origin of origins.rows) { if (origin.connection_id) connections.add(origin.connection_id); if (origin.original_artifact_id) pending.push(origin.original_artifact_id); }
      for (const ids of (await loadSourceConnectionIdsForTargets(this.db, this.run.space_id, 'artifact', [id])).values()) for (const connection of ids) connections.add(connection);
      const refs = row.metadata_json?.reading_history_refs;
      if (Array.isArray(refs)) for (const ref of refs) {
        if (!ref || typeof ref.artifact_id !== 'string') throw new HttpError(403, 'Invalid Reading provenance');
        pending.push(ref.artifact_id);
      }
    }
    for (const connection of connections) {
      const source = (await this.db.query<SourceConnectionRow>('SELECT * FROM source_connections WHERE space_id=$1 AND id=$2', [this.run.space_id, connection])).rows[0];
      if (!source) throw new HttpError(403, 'Reading Source unavailable');
      const allowed = normalizeSourceConnectionReadGovernance(source).consent.allowed_agent_ids;
      if (allowed.length && (!this.run.agent_id || !allowed.includes(this.run.agent_id))) throw new HttpError(403, 'Source does not allow this Agent');
      await assertReadingRunEgress(this.db, this.run, connection);
    }
  }

  async list(input: { q?: string; cursor?: string; limit?: number }) {
    await this.scope();
    const page = await new ReadingService(this.db).list(this.identity, { ...input, view: 'all', limit: input.limit ?? 10 }, this.run.project_id!);
    const items = [];
    for (const item of page.items) {
      try {
        await this.document(item.source_item_id);
        items.push({ item_id: item.source_item_id, title: item.title, source_uri: item.source_uri });
      } catch (error) { if (!(error instanceof HttpError) || ![403, 404].includes(error.statusCode)) throw error; }
    }
    return { items, next_cursor: page.next_cursor };
  }

  async records(input: { item_id: string; offset?: number }) {
    await this.document(input.item_id);
    const page = await projectReadingRecords(this.db, this.identity, input.item_id, input.offset ?? 0, this.run.project_id!);
    const items = [];
    for (const record of page.items) {
      try { await this.document(input.item_id, record.snapshot_id); items.push(record); }
      catch (error) { if (!(error instanceof HttpError) || ![403, 404].includes(error.statusCode)) throw error; }
    }
    return { item_id: input.item_id, items, next_offset: page.next_offset, truncated: page.truncated };
  }

  async read(input: { item_id: string; snapshot_id: string; offset?: number; limit?: number }) {
    const doc = await this.document(input.item_id, input.snapshot_id);
    const offset = input.offset ?? 0, end = offset + (input.limit ?? 12000);
    return { item_id: input.item_id, snapshot_id: input.snapshot_id, title: doc.title, source_uri: doc.source_uri,
      text: doc.plain_text.slice(offset, end), content_hash: doc.content_hash, provenance: doc.reading_info,
      next_offset: end < doc.plain_text.length ? end : null, truncated: end < doc.plain_text.length };
  }
}

export function registerProjectReadingTools(executors: Map<SystemActionId, SystemActionExecutor>, config: ServerConfig, run: RunRecord) {
  const service = new ProjectReadingTools(getDbPool(config.databaseUrl!), config, run);
  for (const operation of ['list', 'records', 'read'] as const) {
    const action = `project.reading.${operation}` as const;
    executors.set(action, async input => ({ modelResult: { ok: true, tool: action, ...await service[operation](input as never) }, summary: { tool_name: action, ok: true } }));
  }
}
