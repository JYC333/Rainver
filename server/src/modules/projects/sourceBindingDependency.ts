import {PgProposalRepository} from '../proposals/repository.js';
import { contentDecisionFromDb } from '../access/contentAccessQuery.js';
import { HttpError, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';

/** Binding dependencies name their own readable activation, never an arbitrary approved row. */
export async function assertSourceBindingDependency(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  channelId: string,
  dependencyId: string,
  decision=false,
): Promise<void> {
  const parent = (await db.query<{
    project_id: string | null;
    proposal_type: string;
    payload_json: Record<string, unknown> | null;
  }>('SELECT project_id,proposal_type,payload_json FROM proposals WHERE id=$1 AND space_id=$2',
    [dependencyId, identity.spaceId])).rows[0];
  if (!parent || parent.project_id !== projectId || parent.proposal_type !== 'source_channel_activation'
    || parent.payload_json?.source_channel_id !== channelId
    || (decision ? !await new PgProposalRepository(db).getVisible(identity.spaceId,identity.userId,dependencyId) : await contentDecisionFromDb(db, identity, 'proposal', dependencyId, { includeOversight: false }) !== 'full')) {
    throw new HttpError(404, 'Source activation dependency not found');
  }
}
