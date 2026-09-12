/**
 * An activity recording a decision on a proposal is no wider than the
 * proposal itself: applying or rolling back a private proposal is not
 * announced to the whole Space.
 */
export function proposalActivityAudience(
  proposal: { visibility: string; owner_user_id: string | null },
  actorUserId: string,
): { visibility: string; ownerUserId: string } {
  return { visibility: proposal.visibility, ownerUserId: proposal.owner_user_id ?? actorUserId };
}
