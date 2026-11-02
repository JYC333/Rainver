import { HttpError, type Queryable, type SpaceUserIdentity } from '../../routeUtils/common.js';
import { resolvePrompt } from '../resolver.js';
import { promptProvenanceOf, type PromptProvenance } from '../provenance.js';
import { readingStrategy } from './runtime.js';
export const REVISION_METHOD_KEY = 'prompt.revision.method';
export interface FrozenRevisionMethod extends PromptProvenance { text: string }
/** Initialization belongs to explicit catalog sync; never invent a read-time fallback. */
export async function resolveRevisionMethod(db: Queryable, identity: SpaceUserIdentity, projectId: string | null): Promise<FrozenRevisionMethod> {
  let resolved;
  try { resolved = await resolvePrompt(db, { ...identity, projectId, assetKey: REVISION_METHOD_KEY }); }
  catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) throw new HttpError(409, 'Initialize the prompt revision method through explicit catalog initialization', {code:'revision_method_not_initialized',detail:'Initialize the prompt revision method through explicit Reading catalog initialization.'});
    throw error;
  }
  const row = (await db.query(`SELECT content_json FROM evolvable_asset_versions WHERE id=$1`, [resolved.version_id])).rows[0];
  if (resolved.validation_errors.length || readingStrategy(row?.content_json) !== resolved.rendered_text) throw new HttpError(409, 'Revision method must be a bounded plain-text strategy');
  return { ...promptProvenanceOf(resolved), text: resolved.rendered_text! };
}
/** A deployment change alone does not rewrite immutable historical input. */
export async function assertRevisionMethod(db: Queryable, frozen: FrozenRevisionMethod) {
  const row = (await db.query(`SELECT v.content_hash,v.content_json FROM evolvable_asset_versions v JOIN evolvable_assets a ON a.id=v.asset_id WHERE v.id=$1 AND a.asset_key=$2`, [frozen.version_id, REVISION_METHOD_KEY])).rows[0];
  if (!row || row.content_hash !== frozen.content_hash || readingStrategy(row.content_json) !== frozen.text) throw new HttpError(409, 'Frozen revision method unavailable or changed');
}
