import { readingItemContext, readingProjectContext } from '../../sources/index.js';
import type { Queryable, SpaceUserIdentity } from '../../routeUtils/common.js';
import { sha256Json } from '../hash.js';

/** Method maintenance is scope-owned. Legacy result links keep all Source checks. */
export async function readingMethodContext(db: Queryable, identity: SpaceUserIdentity, itemId: string | null | undefined, projectId: string | null = null) {
  if (itemId) return readingItemContext(db, identity, itemId, projectId);
  const context = await readingProjectContext(db, identity, projectId);
  return {
    item: null, source: null, projectId, context,
    authority: sha256Json({ kind: 'reading_method_scope.v1', space: identity.spaceId, project: projectId }),
    contextHash: sha256Json(context),
  };
}
