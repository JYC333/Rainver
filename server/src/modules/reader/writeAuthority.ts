import { lockReaderDocumentClosure, type ReaderReleaseRef } from './provenance.js';
import { assertDocumentReadable } from './repository.js';
import { contentDecisionFromDb } from '../access/contentAccessQuery.js';
import { HttpError, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { lockDocumentVersion } from './documentVersionLock.js';
import { canonical } from '../systemActions/operations/repository.js';

/** Discovery is not authorization. Hold the document, its retained Source body,
 * consent/audience and annotation until the canonical writer commits. A changed
 * target after waiting is a conflict, never permission to follow another root. */
export async function lockReaderWriteTarget(db: Queryable, identity: SpaceUserIdentity, input: {
  document_type?: unknown; document_id?: unknown; annotation_id?: string; comment_id?: string; thread_id?: string;
}): Promise<void> {
  const discover = async () => {
    let annotation = input.annotation_id;
    let thread = input.thread_id;
    if (input.comment_id) thread = (await db.query<{thread_id:string}>('SELECT thread_id FROM reader_comments WHERE space_id=$1 AND id=$2', [identity.spaceId,input.comment_id])).rows[0]?.thread_id;
    if (thread) annotation = (await db.query<{annotation_id:string}>('SELECT annotation_id FROM reader_comment_threads WHERE space_id=$1 AND id=$2', [identity.spaceId,thread])).rows[0]?.annotation_id;
    const target = annotation ? (await db.query<{document_type:string;document_id:string}>('SELECT document_type,document_id FROM reader_annotations WHERE space_id=$1 AND id=$2',[identity.spaceId,annotation])).rows[0] : { document_type: input.document_type, document_id: input.document_id };
    if (!target || typeof target.document_type !== 'string' || typeof target.document_id !== 'string') throw new HttpError(404,'Document not found');
    if ((input.comment_id || input.thread_id || input.annotation_id) && !annotation) throw new HttpError(404,'Annotation not found');
    const type = target.document_type, id = target.document_id;
    let project: string | null = null;
    if (type === 'research_report') project = (await db.query<{project_id:string}>('SELECT project_id FROM project_research_reports WHERE space_id=$1 AND id=$2',[identity.spaceId,id])).rows[0]?.project_id ?? null;
    const refs: ReaderReleaseRef[] = [];
    if (type === 'source_item' || type === 'source_snapshot') {
      refs.push({object_type:type,object_id:id});
      // Pin every retained body the current resolver might choose, not just
      // the item's preferred pointer. The rediscovery detects a new fallback.
      if (type === 'source_item') {
        const item = (await db.query<{extracted_artifact_id:string|null}>('SELECT extracted_artifact_id FROM source_items WHERE space_id=$1 AND id=$2',[identity.spaceId,id])).rows[0];
        if (item?.extracted_artifact_id) refs.push({object_type:'artifact',object_id:item.extracted_artifact_id});
        const snapshots = (await db.query<{id:string;artifact_id:string|null}>("SELECT id,artifact_id FROM source_snapshots WHERE space_id=$1 AND source_item_id=$2 AND snapshot_type='extracted' ORDER BY id",[identity.spaceId,id])).rows;
        for (const snapshot of snapshots) { refs.push({object_type:'source_snapshot',object_id:snapshot.id}); if (snapshot.artifact_id) refs.push({object_type:'artifact',object_id:snapshot.artifact_id}); }
      } else {
        const snapshot = (await db.query<{artifact_id:string|null}>('SELECT artifact_id FROM source_snapshots WHERE space_id=$1 AND id=$2',[identity.spaceId,id])).rows[0];
        if (snapshot?.artifact_id) refs.push({object_type:'artifact',object_id:snapshot.artifact_id});
      }
    } else if (type === 'research_notebook') refs.push({object_type:'space_object',object_id:id});
    else if (type !== 'research_report') throw new HttpError(400,'Unsupported document type');
    return {type,id,project,annotation:annotation??null,thread:thread??null,refs};
  };
  // A body rewrite committed while this writer waited moves the same root's
  // retained-body pointers: pin the new closure once (locks only accumulate),
  // so the writer judges the current version instead of failing. Any other
  // lineage change, or a second move, is a conflict.
  let before = await discover();
  for (let attempt = 0; ; attempt++) {
    await lockReaderDocumentClosure(db,identity,before.refs,before.type==='research_report'?[before.id]:[]);
    await lockDocumentVersion(db,identity.spaceId,before.type,before.id);
    if (before.annotation) {
      await db.query('SELECT id FROM reader_annotations WHERE space_id=$1 AND id=$2 FOR UPDATE',[identity.spaceId,before.annotation]);
      await db.query("SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_type='reader_annotation' AND resource_id=$2 ORDER BY id FOR SHARE",[identity.spaceId,before.annotation]);
    }
    if (before.thread) await db.query('SELECT id FROM reader_comment_threads WHERE space_id=$1 AND id=$2 FOR UPDATE',[identity.spaceId,before.thread]);
    if (input.comment_id) await db.query('SELECT id FROM reader_comments WHERE space_id=$1 AND id=$2 FOR UPDATE',[identity.spaceId,input.comment_id]);
    const after = await discover();
    if (canonical(before) === canonical(after)) break;
    const root = (t: typeof before) => canonical({type:t.type,id:t.id,project:t.project,annotation:t.annotation,thread:t.thread});
    if (attempt > 0 || root(before) !== root(after)) throw new HttpError(409,'Reader target changed; read again');
    before = after;
  }
  await assertDocumentReadable(db,identity,before.type,before.id);
  if (before.annotation) {
    // An archived annotation has no readable body for anyone, but its author
    // may still restore it (the Reader's Undo); the canonical writer enforces
    // authorship and the document gate above. Everyone else needs `full` now.
    const own = (await db.query("SELECT id FROM reader_annotations WHERE space_id=$1 AND id=$2 AND created_by_user_id=$3 AND status='archived'",[identity.spaceId,before.annotation,identity.userId])).rows.length > 0;
    if (!own && await contentDecisionFromDb(db,identity,'reader_annotation',before.annotation,{includeOversight:false}) !== 'full') throw new HttpError(404,'Annotation not found');
  }
}
