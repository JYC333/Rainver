import {randomUUID} from 'node:crypto';
import {beforeEach, describe, expect, it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
import {withTransaction} from '../src/db/tx.js';
import {lockProposalTransitions} from '../src/modules/systemActions/operations/proposalTransitions.js';

/**
 * The decision closure the core owner admits: transitive `depends_on` edges
 * (core) and the Skills owner's whole-package rule for pending import reviews.
 * Real PostgreSQL; the closure must be exact — nothing outside it is coverable.
 */
const db = useTestDatabase(import.meta.filename);
let space: string, owner: string;
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); owner = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner, project: randomUUID()});
});
const proposal = async (proposalType: string, payload: Record<string, unknown>, status: 'pending' | 'accepted' = 'pending') =>
  (await insertProposalRow(db.pool, {spaceId: space, proposalType, title: proposalType, payload, rationale: 'closure', createdByUserId: owner, visibility: 'private', status})).id;

describe('proposal decision closure', () => {
  it('covers dependents transitively and pending reviews of the same Skill package, nothing else', async () => {
    const review = await proposal('skill_import_approve', {skill_package_id: 'pkg-a'});
    const sibling = await proposal('skill_import_approve', {skill_package_id: 'pkg-a'});
    const decided = await proposal('skill_import_approve', {skill_package_id: 'pkg-a'}, 'accepted');
    const otherPackage = await proposal('skill_import_approve', {skill_package_id: 'pkg-b'});
    const dependsOnSibling = await proposal('memory_create', {depends_on_proposal_id: sibling});
    const chained = await proposal('memory_create', {depends_on_proposal_id: dependsOnSibling});
    const unrelated = await proposal('memory_create', {});
    await withTransaction(db.pool, async tx => {
      const transitions = await lockProposalTransitions(tx, space, [review], true);
      expect(() => transitions.assertCovered([review, sibling, dependsOnSibling, chained])).not.toThrow();
      for (const outside of [decided, otherPackage, unrelated]) expect(() => transitions.assertCovered([outside])).toThrow();
      await transitions.finish();
    });
    // Without dependents only the roots are admitted.
    await withTransaction(db.pool, async tx => {
      const transitions = await lockProposalTransitions(tx, space, [review], false);
      expect(() => transitions.assertCovered([sibling])).toThrow();
    });
  });
});
