import type {Queryable} from '../routeUtils/common.js';

/** Skill import reviews are one whole-package decision: the pending reviews of the same package as any of these Proposals. Read-only. */
export async function pendingSkillImportSiblings(db: Queryable, spaceId: string, proposalIds: readonly string[]): Promise<string[]> {
  if (!proposalIds.length) return [];
  return (await db.query<{id: string}>(`SELECT DISTINCT p.id FROM proposals parent
    JOIN proposals p ON p.space_id=parent.space_id AND p.proposal_type='skill_import_approve' AND p.status='pending'
     AND p.payload_json->>'skill_package_id'=parent.payload_json->>'skill_package_id'
   WHERE parent.space_id=$1 AND parent.id=ANY($2::varchar[]) AND parent.proposal_type='skill_import_approve'`, [spaceId, [...proposalIds]])).rows.map(row => row.id);
}

/** The Skill packages whose review lock these Proposals need. Read-only. */
export async function skillImportPackages(db: Queryable, proposalIds: readonly string[]): Promise<Array<{space_id: string; id: string}>> {
  return (await db.query<{space_id: string; id: string}>("SELECT DISTINCT space_id,payload_json->>'skill_package_id' AS id FROM proposals WHERE id=ANY($1::varchar[]) AND proposal_type='skill_import_approve' AND payload_json->>'skill_package_id' IS NOT NULL ORDER BY space_id,id", [[...proposalIds]])).rows;
}
