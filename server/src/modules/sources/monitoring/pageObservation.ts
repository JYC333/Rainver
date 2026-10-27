import { MonitoringAdmissionError } from '../../projects/monitoringControl.js';
import type { Queryable } from '../../routeUtils/common.js';
import { withQueryableTransaction } from '../../routeUtils/common.js';
import type { SourceScanItemInput, SourceSnapshotInput } from '../extractionWorker.js';
import { normalizeUrl } from '../sourceRepositoryMappers.js';
import { enforceSourceRetentionPolicy, normalizeSourceConnectionReadGovernance } from '../sourceConsent.js';
import { sharedMonitoringItemIds } from './candidates.js';
import { pageVersion, pageChangeDocument } from './pageChanges.js';
import type { StructuredReaderContent } from '../contentParsing.js';
import { createHash } from 'node:crypto';
interface PageMaterializer {
  upsertScannedItemLocked(input: SourceScanItemInput): Promise<{
    itemId: string;
    created: boolean;
  }>;
  writeReaderDocumentArtifact(spaceId: string, itemId: string, visibility: string, title: string, document: StructuredReaderContent): Promise<string>;
  createSourceSnapshot(input: SourceSnapshotInput): Promise<string>;
}
export async function observePage(db: Queryable, input: Pick<SourceScanItemInput, 'job' | 'connection' | 'capturedAt'> & {
  raw: string;
}, materializer: (tx: Queryable) => PageMaterializer) {
  const {
    job,
    connection,
    raw,
    capturedAt
  } = input;
  const uri = normalizeUrl(connection.endpoint_url!);
  const version = pageVersion(raw, uri);
  enforceSourceRetentionPolicy(normalizeSourceConnectionReadGovernance(connection).policy, 'full_text');
  return withQueryableTransaction(db, async tx => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`source-item:${job.space_id}:${connection.project_id ?? connection.owner_user_id}:${uri}`]);
    const worker = materializer(tx);
    const previous = await tx.query<{
      id: string;
      content_hash: string | null;
      extracted_artifact_id: string | null;
    }>(`SELECT i.id,version.content_hash,version.artifact_id AS extracted_artifact_id FROM source_items i LEFT JOIN LATERAL (SELECT s.content_hash,s.artifact_id FROM source_snapshots s WHERE s.space_id=i.space_id AND s.source_item_id=i.id AND s.snapshot_type='extracted' AND s.metadata_json->>'page_version'='true' ORDER BY s.captured_at DESC,s.created_at DESC LIMIT 1) version ON true WHERE i.space_id=$1 AND i.project_id IS NOT DISTINCT FROM $2 AND i.canonical_uri=$3 AND i.deleted_at IS NULL LIMIT 1`, [job.space_id, connection.project_id, uri]);
    const old = previous.rows[0];
    if (old && connection.project_id && !(await sharedMonitoringItemIds(tx, job.space_id, connection.project_id, [old.id])).length) throw new MonitoringAdmissionError('permission_changed');
    let changeCreated = 0;
    const common = {
      job,
      connection,
      title: version.document.title ?? 'Watched page',
      sourceUri: uri,
      canonicalUri: uri,
      sourceExternalId: `page:${createHash('sha256').update(uri).digest('hex')}`,
      author: null,
      occurredAt: null,
      contentHash: version.hash,
      excerpt: version.document.plain_text.slice(0, 2048),
      metadata: {
        monitoring_page_baseline: true
      },
      capturedAt
    };
    const baseline = await worker.upsertScannedItemLocked({
      ...common,
      itemType: 'external_url'
    });
    if (!old || old.content_hash !== version.hash) {
      const artifact = await worker.writeReaderDocumentArtifact(job.space_id, baseline.itemId, connection.visibility, common.title, version.document);
      const afterId = await worker.createSourceSnapshot({
        spaceId: job.space_id,
        sourceItemId: baseline.itemId,
        connectionId: connection.id,
        snapshotType: 'extracted',
        artifactId: artifact,
        contentHash: version.hash,
        sourceUri: uri,
        captureMethod: 'connection_scan',
        trustLevel: connection.trust_level,
        sourceVisibility: connection.visibility,
        metadata: {
          page_version: true
        },
        capturedAt
      });
      await tx.query(`UPDATE source_items SET extracted_artifact_id=$3,content_state='content_saved',retention_policy='full_text' WHERE id=$1 AND space_id=$2`, [baseline.itemId, job.space_id, artifact]);
      if (old?.extracted_artifact_id) {
        const prior = await tx.query<{
          id: string;
          content: string;
        }>(`SELECT s.id,a.content FROM source_snapshots s JOIN artifacts a ON a.id=s.artifact_id AND a.space_id=s.space_id WHERE s.space_id=$1 AND s.source_item_id=$2 AND s.artifact_id=$3 AND s.snapshot_type='extracted' ORDER BY s.captured_at DESC LIMIT 1`, [job.space_id, old.id, old.extracted_artifact_id]);
        const before = prior.rows[0];
        if (!before) throw new Error('Previous page version evidence is missing');
        const priorDocument = JSON.parse(before.content) as StructuredReaderContent;
        const document = pageChangeDocument(priorDocument.plain_text, version.document);
        const change = await worker.upsertScannedItemLocked({
          ...common,
          itemType: 'document',
          title: `Page change: ${common.title}`,
          sourceUri: null,
          canonicalUri: null,
          sourceExternalId: `page_change:${createHash('sha256').update(uri).digest('hex')}:${version.hash}`,
          occurredAt: capturedAt,
          contentHash: createHash('sha256').update(`${uri}:${old.content_hash}:${version.hash}`).digest('hex'),
          excerpt: `Previous: ${priorDocument.plain_text.slice(0, 900)}\nCurrent: ${version.document.plain_text.slice(0, 900)}`,
          metadata: {
            page_uri: uri,
            page_change: {
              page_item_id: baseline.itemId,
              before_snapshot_id: before.id,
              after_snapshot_id: afterId
            },
            before_hash: old.content_hash,
            after_hash: version.hash
          }
        });
        if (change.created) {
          const changeArtifact = await worker.writeReaderDocumentArtifact(job.space_id, change.itemId, connection.visibility, `Page change: ${common.title}`, document);
          await worker.createSourceSnapshot({
            spaceId: job.space_id,
            sourceItemId: change.itemId,
            connectionId: connection.id,
            snapshotType: 'extracted',
            artifactId: changeArtifact,
            contentHash: version.hash,
            sourceUri: uri,
            captureMethod: 'connection_scan',
            trustLevel: connection.trust_level,
            sourceVisibility: connection.visibility,
            metadata: {
              before_snapshot_id: before.id,
              after_snapshot_id: afterId
            },
            capturedAt
          });
          await tx.query(`UPDATE source_items SET extracted_artifact_id=$3,content_state='content_saved',retention_policy='full_text' WHERE id=$1 AND space_id=$2`, [change.itemId, job.space_id, changeArtifact]);
        }
        changeCreated = change.created ? 1 : 0;
      }
    }
    await tx.query(`UPDATE source_backfill_segments SET window_json=window_json||'{"observation_exhausted":true}'::jsonb WHERE id=$1 AND space_id=$2`, [job.metadata_json?.source_backfill_segment_id, job.space_id]);
    await tx.query(`UPDATE extraction_jobs SET metadata_json=metadata_json||jsonb_build_object('page_observation',$3::text) WHERE id=$1 AND space_id=$2`, [job.id, job.space_id, !old?.extracted_artifact_id ? 'baseline' : old.content_hash === version.hash ? 'unchanged' : 'changed']);
    return {
      seen: 1,
      created: changeCreated,
      updated: 0,
      cursor: {}
    };
  });
}
