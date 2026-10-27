import { projectReaderFromSql, projectReaderPredicateSql } from '../projects/access.js';
import { sourceItemReadableClause, sourceItemFullContentReadClause } from './sourceItemAccess.js';

export function personalMaterialClause(item: string, user: string): string {
  return `(${sourceItemReadableClause(item, user, true, { includeOversight: false })}
    AND (${item}.connection_id IS NOT NULL OR (${item}.project_id IS NULL AND ${item}.owner_user_id=${user})))`;
}

/** The Project recommendation audience uses the canonical Project gate, never
 * Space oversight, and every current reader must retain full Source access. */
export function projectReadingAudienceClause(item: string, project: string): string {
  return `NOT EXISTS(SELECT 1 ${projectReaderFromSql(`${item}.space_id`, 'audience_user', 'audience_member')}
    WHERE ${projectReaderPredicateSql(`${item}.space_id`, project, 'audience_user')}
      AND NOT ${sourceItemFullContentReadClause(item, 'audience_user.id')})`;
}

/** Bulk association projection, joined once by SourceItem instead of probing
 * an entire Project Corpus for each reading group. Project ACL is caller-owned. */
export function projectMaterialRowsSql(space: string, project: string): string {
  return `SELECT i.id AS source_item_id,'saved'::text AS kind,i.id AS reference_id,i.project_id
    FROM source_items i WHERE i.space_id=${space} AND i.project_id=${project} AND i.deleted_at IS NULL
    UNION ALL
    SELECT l.source_item_id,'source_link',l.id,l.project_id FROM project_source_item_links l
      JOIN project_source_bindings b ON b.space_id=l.space_id AND b.id=l.project_source_binding_id AND b.status='active'
      WHERE l.space_id=${space} AND l.project_id=${project} AND l.status='active'
    UNION ALL
    SELECT c.source_item_id,'corpus',c.id,c.project_id FROM project_corpus_items c
      WHERE c.space_id=${space} AND c.project_id=${project} AND c.status='active' AND c.source_item_id IS NOT NULL
    UNION ALL
    SELECT bridge.source_item_id,'corpus',c.id,c.project_id FROM project_corpus_items c
      JOIN project_corpus_item_sources bridge ON bridge.space_id=c.space_id AND bridge.corpus_item_id=c.id
      WHERE c.space_id=${space} AND c.project_id=${project} AND c.status='active'
        AND bridge.source_item_id IS DISTINCT FROM c.source_item_id`;
}
