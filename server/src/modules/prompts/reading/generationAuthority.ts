import { isDeepStrictEqual } from 'node:util';
import type { RunRecord } from '../../runs/repository.js';
import { PgRunRepository } from '../../runs/repository.js';
import { HttpError, type Queryable, type SpaceUserIdentity } from '../../routeUtils/common.js';
import { PgConversationBackendRepository } from '../../sessions/conversationBackendRepository.js';
import { nativeProfileFingerprint } from '../../sources/goals/nativeRoute.js';
import { readingItemContext, assertReadingRunEgress } from '../../sources/index.js';
import { resolveSessionConfig } from '../../sessions/sessionConfig.js';
import { normalizeVersionScopeForWrite } from '../../evolution/assetAccess.js';
import { readingAsset } from './access.js';
import { assertClosedReadingContext } from './closedContext.js';
import { generationOf, generationVersionRefs } from './generationContract.js';
import { freezeReadingMethod } from './runtime.js';
import { sha256Json } from '../hash.js';

/** History authorization is distinct from re-execution freshness. No original body or brief enters this Run. */
export async function assertGenerationReadable(db: Queryable, identity: SpaceUserIdentity, run: RunRecord) {
  const ref = generationOf(run);
  if (!ref || run.space_id !== identity.spaceId || run.instructed_by_user_id !== identity.userId) throw new HttpError(404, 'Generation not found');
  await readingAsset(db, identity);
  const ctx = await readingItemContext(db, identity, ref.item_id, ref.project_id);
  if (ctx.projectId !== ref.project_id) throw new HttpError(403, 'Generation scope changed');
  await normalizeVersionScopeForWrite(db, identity, ref.project_id ? 'project' : 'space', ref.project_id ?? identity.spaceId);
  await assertReadingRunEgress(db, run, ctx.source?.id ?? null);
  return ctx;
}
export async function assertGenerationDispatch(db: Queryable, run: RunRecord) {
  const ref = generationOf(run);
  if (!ref) return;
  const identity = {
    spaceId: run.space_id,
    userId: run.instructed_by_user_id!
  };
  const ctx = await assertGenerationReadable(db, identity, run);
  const attempt = await new PgRunRepository(db).getLatestRunAttempt(run.space_id, run.id);
  if (attempt && attempt.attempt_number > 1) throw new HttpError(409, 'Retry generation explicitly as a new bounded Run');
  const parent = await freezeReadingMethod(db, {
    ...identity,
    projectId: ref.project_id
  }, null);
  if (ctx.authority !== ref.authority || parent.frozen.version_id !== ref.parent_version_id || parent.frozen.content_hash !== ref.parent_hash || sha256Json(run.prompt) !== ref.prompt_hash) throw new HttpError(409, 'Generation input or effective method changed; start from the current method');
  await assertClosedReadingContext(db, run.space_id, run.id, null);
  if (ref.profile_hash !== (await nativeProfileFingerprint(db, run.requested_runtime_profile_id!))) throw new HttpError(409, 'Generation execution configuration changed');
  if (!(await db.query(`SELECT id FROM agents WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND status='active'`, [run.agent_id, run.space_id, identity.userId])).rows.length) throw new HttpError(403, 'Generation Agent unavailable');
  const option = (await new PgConversationBackendRepository(db).listOptions(run.space_id, identity.userId, run.agent_id!)).find(p => p.runtime_profile_id === run.requested_runtime_profile_id && p.usable !== false);
  if (!option) throw new HttpError(409, 'Generation runtime unavailable');
  const session = await resolveSessionConfig(ref.session_config, async () => [], option.session_config_options ?? []);
  if (!isDeepStrictEqual(session.selections, ref.session_config) || !isDeepStrictEqual((run.model_override_json as {
    acp_session_config?: unknown;
  } | null)?.acp_session_config ?? [], ref.session_config)) throw new HttpError(409, 'Generation session configuration changed');
}
/** Used by generic version readers as well as the Reading workspace; never authorizes from a client marker. */
export async function readingGeneratedVersionReadable(db: Queryable, identity: SpaceUserIdentity, content: unknown) {
  const refs = generationVersionRefs(content);
  if ((content as {
    reading_generation?: unknown;
  } | null)?.reading_generation && !refs.length) return false;
  try {
    for (const id of refs) {
      const run = await new PgRunRepository(db).getRun(identity.spaceId, id);
      if (!run) return false;
      await assertGenerationReadable(db, identity, run);
    }
    return true;
  } catch (e) {
    if (e instanceof HttpError && [403, 404, 409].includes(e.statusCode)) return false;
    throw e;
  }
}
